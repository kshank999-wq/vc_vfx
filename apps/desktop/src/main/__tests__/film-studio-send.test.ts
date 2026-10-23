import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_HANDOFF, buildFilmStudioStatus, createProject, parseHandoff, recordStatusSend, serializeProject } from '@vcvfx/domain';
import { filmStudioOrigin, keyHint, redact, sendFilmStudioStatus, uploadKeyProblem, type FetchLike } from '../film-studio-send';
// VC Film Studio's own reader, vendored verbatim for the domain's contract tests.
import { readVfxStatus } from '../../../../../packages/domain/src/__tests__/fixtures/film-studio-vfx-status';

/**
 * The sender against a stand-in for Film Studio's POST /api/vfx/status that
 * answers exactly as Film Studio's route does (lib/vfx-receive.ts at
 * 618a180): each refusal's status and words, the success body's shape.
 */

const KEY = 'vcvfx_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH';

/** Film Studio's refusals, word for word (lib/vfx-receive.ts, lib/vfx-upload.ts, lib/vfx-status.ts). */
const REFUSALS: Record<string, { status: number; body: Record<string, unknown> }> = {
  'no-key': { status: 401, body: { ok: false, error: 'No upload key was sent. Make one on Film Studio’s data desk (From VC VFX → Send from VC VFX) and paste it into VC VFX’s Project settings → VC Film Studio.' } },
  'bad-key': { status: 401, body: { ok: false, error: 'Film Studio does not recognise that upload key, or it has been revoked. Make a new one on the data desk (From VC VFX → Send from VC VFX) and paste it into VC VFX’s Project settings → VC Film Studio.' } },
  'too-large': { status: 413, body: { ok: false, error: 'That is far too large to be a VFX status report from VC VFX. Nothing was changed.' } },
  'bad-shape': {
    status: 400,
    body: {
      ok: false,
      error: 'This VFX status report could not be read: shots[0].status.key should be one of not_started, ready_for_prep, processing, needs_review, needs_correction, prep_approved, packaged, delivered (it is "done"). Nothing was changed. Export it again from VC VFX; if it happens again, send the file to whoever looks after VC VFX.',
      issues: ['shots[0].status.key should be one of not_started, ready_for_prep, processing, needs_review, needs_correction, prep_approved, packaged, delivered (it is "done")'],
    },
  },
  'other-production': { status: 409, body: { ok: false, error: 'This report is for “Night Shift”, but the key belongs to “DEMO — THE COPPER LINE”. In VC VFX set Project settings → VC Film Studio → Production to “DEMO — THE COPPER LINE”, or use the key made on the right production’s data desk.' } },
  'no-production': { status: 502, body: { ok: false, error: 'Film Studio could not read the production: connection refused. Nothing was changed; try again in a minute.' } },
  'write-refused': { status: 500, body: { ok: false, error: 'Nothing was written — Film Studio refused the report: deadlock detected. Sending again is safe.' } },
};

let server: Server;
let origin = '';
let mode = 'ok';
const received: { auth: string | undefined; type: string | undefined; body: string; path: string }[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, type: req.headers['content-type'], body, path: req.url ?? '' });
      if (mode === 'hang') return; // never answers
      if (mode === 'html') {
        res.writeHead(404, { 'content-type': 'text/html' });
        return void res.end('<html><body>Not found</body></html>');
      }
      if (mode === 'echo-key') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: false, error: `Something went wrong with ${req.headers.authorization}` }));
      }
      const refusal = REFUSALS[mode];
      if (refusal) {
        res.writeHead(refusal.status, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(refusal.body));
      }
      // Success, shaped as Film Studio answers it — after reading the report with Film Studio's reader.
      const read = readVfxStatus(body);
      if (!read.ok) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: false, error: read.why, issues: read.issues }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          production: 'Night Shift',
          says: `${read.doc.shots.length} shots received: 0 ready to hand off, ${read.doc.shots.length} not started.`,
          warnings: ['Scene 12A is not in this production: its shots are shown unlinked.'],
          report: 'b0c1d2e3',
          stale: false,
          summary: { shots: read.doc.shots.length, readyToHandOff: 0, delivered: 0, inReview: 0, needsCorrection: 0, inProgress: 0, notStarted: read.doc.shots.length },
          linked: { scenes: 3, days: 0 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const project = () => {
  const r = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
  if (!r.ok) throw new Error('sample');
  return createProject(r.handoff, '/Volumes/D/handoff.json', 'dit', new Date('2026-10-19T12:00:00Z'));
};
const doc = buildFilmStudioStatus(project(), { generatedAt: new Date('2026-10-20T08:00:00Z'), appVersion: '0.1.0', operator: 'Ruth' });
const nodeFetch: FetchLike = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, text: () => r.text() };
};
const send = (o: { origin?: string; timeoutMs?: number; fetch?: FetchLike } = {}) =>
  sendFilmStudioStatus({ origin: o.origin ?? origin, key: KEY, body: JSON.stringify(doc), shots: doc.shots.length, readyToHandOff: doc.summary.readyToHandOff, fetch: o.fetch ?? nodeFetch, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });

describe('sending to VC Film Studio', () => {
  it('POSTs the report to /api/vfx/status with the key as a bearer token, and passes on Film Studio’s answer', async () => {
    mode = 'ok';
    const out = await send();
    const last = received.at(-1)!;
    expect(last).toMatchObject({ path: '/api/vfx/status', auth: `Bearer ${KEY}`, type: 'application/json' });
    expect(JSON.parse(last.body).format).toBe('vc-film-studio.vfx-status/1');
    expect(out).toEqual({
      kind: 'sent',
      url: origin,
      shots: 5,
      readyToHandOff: 0,
      says: '5 shots received: 0 ready to hand off, 5 not started.',
      warnings: ['Scene 12A is not in this production: its shots are shown unlinked.'],
      stale: false,
      report: 'b0c1d2e3',
      production: 'Night Shift',
      summary: { shots: 5, readyToHandOff: 0, delivered: 0, inReview: 0, needsCorrection: 0, inProgress: 0, notStarted: 5 },
    });
  });

  for (const [name, refusal] of Object.entries(REFUSALS)) {
    it(`shows Film Studio’s ${refusal.status} refusal (${name}) verbatim`, async () => {
      mode = name;
      const out = await send();
      expect(out).toEqual({ kind: 'refused', url: origin, shots: 5, status: refusal.status, error: refusal.body['error'], issues: refusal.body['issues'] ?? [] });
    });
  }

  it('says when the answer is not Film Studio’s at all (a wrong address)', async () => {
    mode = 'html';
    const out = await send();
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.status).toBe(404);
    expect(out.error).toMatch(/answered HTTP 404, but not as VC Film Studio does\. Check the address/);
  });

  it('offline: says it was not sent and nothing was queued', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const out = await send({ origin: `http://127.0.0.1:${port}` });
    expect(out.kind).toBe('not_sent');
    if (out.kind !== 'not_sent') return;
    expect(out.error).toMatch(/^Not sent: VC Film Studio could not be reached at http:\/\/127\.0\.0\.1:\d+ \(.+\); this computer may be offline\. Nothing was queued/);
    expect(out.error).toContain('Export for VC Film Studio…');
  });

  it('gives up after the timeout, and says so', async () => {
    mode = 'hang';
    const out = await send({ timeoutMs: 300 });
    expect(out).toMatchObject({ kind: 'not_sent' });
    if (out.kind === 'not_sent') expect(out.error).toMatch(/did not answer within 0 seconds|did not answer within 1 seconds/);
  });

  it('never lets the key out: not in an answer, nor in the project log', async () => {
    mode = 'echo-key';
    const out = await send();
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.kind === 'refused' && out.error).toBe('Something went wrong with Bearer [upload key]');
    const logged = recordStatusSend(project(), out, 'Ruth', new Date());
    expect(serializeProject(logged)).not.toContain(KEY);
    const thrown = await send({ fetch: async () => Promise.reject(new Error(`socket closed for ${KEY}`)) });
    expect(JSON.stringify(thrown)).not.toContain(KEY);
  });
});

describe('the address and the key', () => {
  it('makes an origin of what was typed, https only (or this computer)', () => {
    expect(filmStudioOrigin('www.vcfilmstudio.com/')).toEqual({ ok: true, origin: 'https://www.vcfilmstudio.com' });
    expect(filmStudioOrigin('https://www.vcfilmstudio.com/api/vfx/status')).toEqual({ ok: true, origin: 'https://www.vcfilmstudio.com' });
    expect(filmStudioOrigin('http://localhost:3000')).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(filmStudioOrigin('http://www.vcfilmstudio.com').ok).toBe(false);
    expect(filmStudioOrigin('https://me:pw@www.vcfilmstudio.com').ok).toBe(false);
    expect(filmStudioOrigin('').ok).toBe(false);
  });

  it('tells a VC VFX key from a DIT key and from rubbish', () => {
    expect(uploadKeyProblem(KEY)).toBeNull();
    expect(uploadKeyProblem('vcdit_0123456789abcdef')).toMatch(/VC DIT upload key/);
    expect(uploadKeyProblem('hello')).toMatch(/starts with “vcvfx_”/);
    expect(uploadKeyProblem('vcvfx_abc')).toMatch(/not complete/);
    expect(keyHint(KEY)).toBe('vcvfx_…EFGH');
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe('a [upload key] b [upload key]');
  });
});
