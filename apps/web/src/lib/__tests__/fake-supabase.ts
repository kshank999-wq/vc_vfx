import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A small in-memory stand-in for the Supabase client, covering the calls the
 * commerce path makes. The unique constraints that make fulfilment and the
 * webhook idempotent are enforced here too, so a test that passes against
 * this fake is testing the rule Postgres enforces.
 */

export interface FakeRow {
  [key: string]: unknown;
  id: string;
}

export interface FakeState {
  profiles: FakeRow[];
  orders: FakeRow[];
  licenses: FakeRow[];
  device_activations: FakeRow[];
  stripe_webhook_events: FakeRow[];
  authUsers: Array<{ id: string; email: string }>;
  writes: Array<{ table: string; operation: 'insert' | 'upsert' | 'update' }>;
}

type Table = Exclude<keyof FakeState, 'authUsers' | 'writes'>;

/** Unique columns per table, as the migration declares them. */
const UNIQUE: Partial<Record<Table, string[][]>> = {
  orders: [['stripe_checkout_session_id']],
  licenses: [['order_id'], ['serial']],
  device_activations: [['license_id', 'device_fingerprint']],
  stripe_webhook_events: [['id']],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let sequence = 0;
export const nextId = (): string => {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
};

type Filter = (row: FakeRow) => boolean;
type Result = { data: unknown; error: Error | null; count?: number | null };

class FakeQuery {
  private filters: Filter[] = [];
  private pending: { operation: 'insert' | 'upsert' | 'update'; row: Record<string, unknown>; onConflict?: string } | null =
    null;

  constructor(
    private readonly state: FakeState,
    private readonly table: Table,
  ) {}

  private get rows(): FakeRow[] {
    return this.state[this.table];
  }

  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  ilike(column: string, value: string): this {
    this.filters.push((row) => typeof row[column] === 'string' && (row[column] as string).toLowerCase() === value.toLowerCase());
    return this;
  }

  insert(row: Record<string, unknown>): this {
    this.state.writes.push({ table: this.table, operation: 'insert' });
    this.pending = { operation: 'insert', row };
    return this;
  }
  upsert(row: Record<string, unknown>, options?: { onConflict?: string }): this {
    this.state.writes.push({ table: this.table, operation: 'upsert' });
    this.pending = { operation: 'upsert', row, ...(options?.onConflict ? { onConflict: options.onConflict } : {}) };
    return this;
  }
  update(row: Record<string, unknown>): this {
    this.state.writes.push({ table: this.table, operation: 'update' });
    this.pending = { operation: 'update', row };
    return this;
  }

  private matches(row: FakeRow): boolean {
    return this.filters.every((f) => f(row));
  }

  private violation(candidate: Record<string, unknown>, except?: FakeRow): Error | null {
    for (const columns of UNIQUE[this.table] ?? []) {
      const clash = this.rows.find(
        (row) => row !== except && columns.every((c) => candidate[c] !== undefined && candidate[c] !== null && row[c] === candidate[c]),
      );
      if (clash) return new Error(`duplicate key value violates unique constraint (${this.table}.${columns.join(',')})`);
    }
    return null;
  }

  /** Apply a pending write; returns affected rows. */
  private commit(): { rows: FakeRow[]; error: Error | null } | null {
    if (!this.pending) return null;
    const { operation, row, onConflict } = this.pending;
    this.pending = null;

    if (operation === 'update') {
      const targets = this.rows.filter((candidate) => this.matches(candidate));
      for (const target of targets) Object.assign(target, row);
      return { rows: targets, error: null };
    }

    if (operation === 'upsert' && onConflict) {
      const columns = onConflict.split(',');
      const existing = this.rows.find((candidate) => columns.every((c) => candidate[c] === row[c]));
      if (existing) {
        Object.assign(existing, row);
        return { rows: [existing], error: null };
      }
    }

    const fresh = { id: nextId(), ...row } as FakeRow;
    const error = this.violation(fresh);
    if (error) return { rows: [], error };
    this.rows.push(fresh);
    return { rows: [fresh], error: null };
  }

  private resolveMany(): Result {
    const committed = this.commit();
    if (committed) return { data: committed.error ? null : committed.rows.map(clone), error: committed.error };
    const found = this.rows.filter((row) => this.matches(row));
    return { data: found.map(clone), error: null, count: found.length };
  }

  async single(): Promise<Result> {
    const result = this.resolveMany();
    const rows = (result.data as FakeRow[] | null) ?? [];
    if (result.error) return { data: null, error: result.error };
    return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: new Error('no rows returned') };
  }

  async maybeSingle(): Promise<Result> {
    const result = this.resolveMany();
    if (result.error) return { data: null, error: result.error };
    return { data: ((result.data as FakeRow[] | null) ?? [])[0] ?? null, error: null };
  }

  then<T>(resolve: (value: Result) => T): T {
    return resolve(this.resolveMany());
  }
}

export interface FakeSupabase {
  client: SupabaseClient;
  state: FakeState;
}

export const createFakeSupabase = (seed: Partial<FakeState> = {}): FakeSupabase => {
  const state: FakeState = {
    profiles: seed.profiles ?? [],
    orders: seed.orders ?? [],
    licenses: seed.licenses ?? [],
    device_activations: seed.device_activations ?? [],
    stripe_webhook_events: seed.stripe_webhook_events ?? [],
    authUsers: seed.authUsers ?? [],
    writes: [],
  };

  const client = {
    from: (table: string) => new FakeQuery(state, table as Table),
    auth: {
      admin: {
        createUser: async ({ email }: { email: string }) => {
          if (state.authUsers.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
            return { data: { user: null }, error: new Error('User already registered') };
          }
          const user = { id: nextId(), email };
          state.authUsers.push(user);
          // The signup trigger mirrors the email onto the profile.
          state.profiles.push({ id: user.id, email });
          return { data: { user }, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;

  return { client, state };
};
