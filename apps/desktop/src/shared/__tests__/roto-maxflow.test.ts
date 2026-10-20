import { describe, expect, it } from 'vitest';
import { GridGraph } from '../roto/maxflow';
import { rng } from '../roto/image';

/** Edmonds–Karp on an explicit graph: the reference the grid solver is checked against. */
function referenceMaxFlow(w: number, h: number, edges: Float32Array, src: Float64Array, snk: Float64Array): { flow: number; source: Uint8Array } {
  const n = w * h + 2;
  const S = w * h;
  const T = w * h + 1;
  const cap = new Map<number, number>();
  const adj: number[][] = Array.from({ length: n }, () => []);
  const key = (a: number, b: number) => a * n + b;
  const add = (a: number, b: number, c: number) => {
    if (!cap.has(key(a, b))) {
      adj[a]!.push(b);
      adj[b]!.push(a);
      cap.set(key(b, a), cap.get(key(b, a)) ?? 0);
    }
    cap.set(key(a, b), (cap.get(key(a, b)) ?? 0) + c);
  };
  for (let p = 0; p < w * h; p += 1) {
    add(S, p, src[p]!);
    add(p, T, snk[p]!);
    const x = p % w;
    if (x < w - 1) {
      add(p, p + 1, edges[p * 4]!);
      add(p + 1, p, edges[p * 4]!);
    }
    if (p + w < w * h) {
      add(p, p + w, edges[p * 4 + 2]!);
      add(p + w, p, edges[p * 4 + 2]!);
    }
  }
  let flow = 0;
  for (;;) {
    const prev = new Int32Array(n).fill(-1);
    prev[S] = S;
    const q = [S];
    while (q.length && prev[T]! < 0) {
      const a = q.shift()!;
      for (const b of adj[a]!) if (prev[b]! < 0 && (cap.get(key(a, b)) ?? 0) > 1e-9) {
        prev[b] = a;
        q.push(b);
      }
    }
    if (prev[T]! < 0) break;
    let f = Infinity;
    for (let v = T; v !== S; v = prev[v]!) f = Math.min(f, cap.get(key(prev[v]!, v))!);
    for (let v = T; v !== S; v = prev[v]!) {
      cap.set(key(prev[v]!, v), cap.get(key(prev[v]!, v))! - f);
      cap.set(key(v, prev[v]!), (cap.get(key(v, prev[v]!)) ?? 0) + f);
    }
    flow += f;
  }
  const seen = new Uint8Array(n);
  const q = [S];
  seen[S] = 1;
  while (q.length) {
    const a = q.shift()!;
    for (const b of adj[a]!) if (!seen[b] && (cap.get(key(a, b)) ?? 0) > 1e-9) {
      seen[b] = 1;
      q.push(b);
    }
  }
  return { flow, source: seen.subarray(0, w * h) };
}

describe('Boykov–Kolmogorov max-flow on a grid', () => {
  it('matches Edmonds–Karp on random grids, and its cut costs the flow', () => {
    const rand = rng(42);
    for (let trial = 0; trial < 60; trial += 1) {
      const w = 2 + Math.floor(rand() * 9);
      const h = 2 + Math.floor(rand() * 9);
      const g = new GridGraph(w, h);
      const src = new Float64Array(w * h);
      const snk = new Float64Array(w * h);
      for (let p = 0; p < w * h; p += 1) {
        src[p] = rand() < 0.5 ? Math.round(rand() * 10) : 0;
        snk[p] = rand() < 0.5 ? Math.round(rand() * 10) : 0;
        g.addTerminal(p, src[p]!, snk[p]!);
        g.setEdge(p, 0, Math.round(rand() * 6));
        g.setEdge(p, 2, Math.round(rand() * 6));
      }
      const edges = g.cap.slice();
      const ref = referenceMaxFlow(w, h, edges, src, snk);
      const flow = g.solve();
      expect(flow).toBeCloseTo(ref.flow, 4);
      // The cut found costs exactly the flow.
      const side = g.sourceSide();
      let cut = 0;
      for (let p = 0; p < w * h; p += 1) {
        cut += side[p] ? snk[p]! : src[p]!;
        const x = p % w;
        if (x < w - 1 && side[p] !== side[p + 1]) cut += edges[p * 4]!;
        if (p + w < w * h && side[p] !== side[p + w]) cut += edges[p * 4 + 2]!;
      }
      expect(cut).toBeCloseTo(ref.flow, 4);
    }
  });

  it('separates two hard seeds along the weakest edges', () => {
    const w = 20;
    const h = 10;
    const g = new GridGraph(w, h);
    for (let p = 0; p < w * h; p += 1) {
      const x = p % w;
      g.setEdge(p, 0, x === 11 ? 0.1 : 5);
      g.setEdge(p, 2, 5);
      if (x === 0) g.addTerminal(p, 1e9, 0);
      if (x === w - 1) g.addTerminal(p, 0, 1e9);
    }
    g.solve();
    const side = g.sourceSide();
    for (let p = 0; p < w * h; p += 1) expect(side[p]).toBe(p % w <= 11 ? 1 : 0);
  });
});
