/**
 * Min-cut / max-flow on a 4-connected pixel grid, by the Boykov–Kolmogorov
 * algorithm ("An Experimental Comparison of Min-Cut/Max-Flow Algorithms for
 * Energy Minimization in Vision", PAMI 2004) — search trees grown from both
 * terminals, reused between augmentations, with the timestamp/distance
 * heuristic for adoption. Pure TypeScript on typed arrays (addendum 04).
 *
 * Node p is pixel (x, y) = (p % w, ⌊p / w⌋). Edge capacities are stored per
 * node and direction: 0 → +x, 1 → −x, 2 → +y, 3 → −y; the reverse of
 * direction d is d ^ 1. Terminal capacities are kept as one signed residual
 * per node: positive from the source, negative to the sink.
 */

const TERMINAL = 4;
const NONE = -1;
const FREE = 0;
const SOURCE = 1;
const SINK = 2;

export class GridGraph {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  /** Residual capacity of the edge leaving node p in direction d, at p * 4 + d. */
  readonly cap: Float32Array;
  /** Residual terminal capacity: > 0 from the source, < 0 to the sink. */
  readonly tr: Float64Array;
  private flowOffset = 0;
  private tree: Uint8Array;
  private parent: Int8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.cap = new Float32Array(this.n * 4);
    this.tr = new Float64Array(this.n);
    this.tree = new Uint8Array(this.n);
    this.parent = new Int8Array(this.n);
  }

  /** Neighbour of p in direction d, or −1 off the grid. */
  neighbour(p: number, d: number): number {
    const w = this.w;
    switch (d) {
      case 0:
        return p % w === w - 1 ? -1 : p + 1;
      case 1:
        return p % w === 0 ? -1 : p - 1;
      case 2:
        return p + w >= this.n ? -1 : p + w;
      default:
        return p - w < 0 ? -1 : p - w;
    }
  }

  /** An undirected edge of capacity c between p and its neighbour in direction d (0 or 2). */
  setEdge(p: number, d: number, c: number): void {
    const q = this.neighbour(p, d);
    if (q < 0) return;
    this.cap[p * 4 + d] = c;
    this.cap[q * 4 + (d ^ 1)] = c;
  }

  /** Add capacities from the source and to the sink (the cost of labelling p sink-side and source-side). */
  addTerminal(p: number, source: number, sink: number): void {
    const before = this.tr[p]!;
    // Store the net residual; the common part is flow that always runs.
    const s = (before > 0 ? before : 0) + source;
    const t = (before < 0 ? -before : 0) + sink;
    const common = Math.min(s, t);
    this.flowOffset += common;
    this.tr[p] = s - t;
  }

  /** Solve; returns the max-flow value. Afterwards `isSource` gives the cut. */
  solve(): number {
    const { n, cap, tr } = this;
    const tree = this.tree;
    const parent = this.parent;
    const ts = new Int32Array(n);
    const dist = new Int32Array(n);
    const queue = new Int32Array(n + 1);
    const inQueue = new Uint8Array(n);
    let qHead = 0;
    let qTail = 0;
    let qSize = 0;
    const push = (p: number) => {
      if (inQueue[p]) return;
      inQueue[p] = 1;
      queue[qTail] = p;
      qTail = qTail === n ? 0 : qTail + 1;
      qSize += 1;
    };
    const pop = (): number => {
      const p = queue[qHead]!;
      qHead = qHead === n ? 0 : qHead + 1;
      qSize -= 1;
      inQueue[p] = 0;
      return p;
    };
    const orphans: number[] = [];
    let flow = this.flowOffset;
    let time = 0;

    for (let p = 0; p < n; p += 1) {
      if (tr[p]! > 0) {
        tree[p] = SOURCE;
        parent[p] = TERMINAL;
        dist[p] = 1;
        push(p);
      } else if (tr[p]! < 0) {
        tree[p] = SINK;
        parent[p] = TERMINAL;
        dist[p] = 1;
        push(p);
      } else {
        tree[p] = FREE;
        parent[p] = NONE;
      }
    }

    let current = -1;
    for (;;) {
      // Growth: look for a path from the source tree to the sink tree.
      let s = -1;
      let t = -1;
      let dirST = -1;
      while (current >= 0 || qSize > 0) {
        const p = current >= 0 ? current : pop();
        current = -1;
        if (tree[p] === FREE) continue;
        const tp = tree[p]!;
        for (let d = 0; d < 4; d += 1) {
          const q = this.neighbour(p, d);
          if (q < 0) continue;
          const c = tp === SOURCE ? cap[p * 4 + d]! : cap[q * 4 + (d ^ 1)]!;
          if (c <= 0) continue;
          const tq = tree[q]!;
          if (tq === FREE) {
            tree[q] = tp;
            parent[q] = d ^ 1;
            ts[q] = ts[p]!;
            dist[q] = dist[p]! + 1;
            push(q);
          } else if (tq !== tp) {
            if (tp === SOURCE) {
              s = p;
              t = q;
              dirST = d;
            } else {
              s = q;
              t = p;
              dirST = d ^ 1;
            }
            break;
          } else if (ts[q]! <= ts[p]! && dist[q]! > dist[p]!) {
            // A shorter way to the terminal: re-hang q under p.
            parent[q] = d ^ 1;
            ts[q] = ts[p]!;
            dist[q] = dist[p]! + 1;
          }
        }
        if (s >= 0) {
          // p may have more to give: come back to it first.
          current = p;
          break;
        }
      }
      if (s < 0) break;
      time += 1;

      // Augmentation: the bottleneck, then push it.
      let f = cap[s * 4 + dirST]!;
      let x = s;
      while (parent[x] !== TERMINAL) {
        const d = parent[x]!;
        const y = this.neighbour(x, d);
        const c = cap[y * 4 + (d ^ 1)]!;
        if (c < f) f = c;
        x = y;
      }
      if (tr[x]! < f) f = tr[x]!;
      x = t;
      while (parent[x] !== TERMINAL) {
        const d = parent[x]!;
        const y = this.neighbour(x, d);
        const c = cap[x * 4 + d]!;
        if (c < f) f = c;
        x = y;
      }
      if (-tr[x]! < f) f = -tr[x]!;

      cap[s * 4 + dirST]! -= f;
      cap[t * 4 + (dirST ^ 1)]! += f;
      x = s;
      while (parent[x] !== TERMINAL) {
        const d = parent[x]!;
        const y = this.neighbour(x, d);
        cap[y * 4 + (d ^ 1)]! -= f;
        cap[x * 4 + d]! += f;
        if (cap[y * 4 + (d ^ 1)]! <= 0) {
          parent[x] = NONE;
          orphans.push(x);
        }
        x = y;
      }
      tr[x]! -= f;
      if (tr[x]! <= 0) {
        parent[x] = NONE;
        orphans.push(x);
      }
      x = t;
      while (parent[x] !== TERMINAL) {
        const d = parent[x]!;
        const y = this.neighbour(x, d);
        cap[x * 4 + d]! -= f;
        cap[y * 4 + (d ^ 1)]! += f;
        if (cap[x * 4 + d]! <= 0) {
          parent[x] = NONE;
          orphans.push(x);
        }
        x = y;
      }
      tr[x]! += f;
      if (tr[x]! >= 0) {
        parent[x] = NONE;
        orphans.push(x);
      }
      flow += f;

      // Adoption: find each orphan a new parent in its tree, or free it.
      while (orphans.length) {
        const p = orphans.pop()!;
        const tp = tree[p]!;
        let best = -1;
        let dmin = Infinity;
        for (let d = 0; d < 4; d += 1) {
          const q = this.neighbour(p, d);
          if (q < 0 || tree[q] !== tp) continue;
          const c = tp === SOURCE ? cap[q * 4 + (d ^ 1)]! : cap[p * 4 + d]!;
          if (c <= 0) continue;
          // Does q still reach a terminal?
          let j = q;
          let dd = 0;
          let valid = false;
          for (;;) {
            if (ts[j] === time) {
              dd += dist[j]!;
              valid = true;
              break;
            }
            const a = parent[j]!;
            dd += 1;
            if (a === TERMINAL) {
              ts[j] = time;
              dist[j] = 1;
              valid = true;
              break;
            }
            if (a === NONE) break;
            j = this.neighbour(j, a);
          }
          if (!valid) continue;
          if (dd < dmin) {
            best = d;
            dmin = dd;
          }
          for (j = q; ts[j] !== time; j = this.neighbour(j, parent[j]!)) {
            ts[j] = time;
            dist[j] = dd;
            dd -= 1;
          }
        }
        if (best >= 0) {
          parent[p] = best;
          ts[p] = time;
          dist[p] = dmin + 1;
          continue;
        }
        // No way back: p leaves its tree; its neighbours may grow into it again.
        for (let d = 0; d < 4; d += 1) {
          const q = this.neighbour(p, d);
          if (q < 0 || tree[q] !== tp) continue;
          const c = tp === SOURCE ? cap[q * 4 + (d ^ 1)]! : cap[p * 4 + d]!;
          if (c > 0) push(q);
          const a = parent[q]!;
          if (a !== NONE && a !== TERMINAL && this.neighbour(q, a) === p) {
            parent[q] = NONE;
            orphans.push(q);
          }
        }
        tree[p] = FREE;
      }
    }
    return flow;
  }

  /** After `solve`: true for nodes on the source side of the minimum cut. */
  isSource(p: number): boolean {
    return this.tree[p] === SOURCE;
  }

  /** The source side as a 0/1 array. */
  sourceSide(): Uint8Array {
    const out = new Uint8Array(this.n);
    for (let p = 0; p < this.n; p += 1) out[p] = this.tree[p] === SOURCE ? 1 : 0;
    return out;
  }
}
