import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { COMP_NODES, COMP_NODE_H, COMP_NODE_TYPES, COMP_NODE_W, compOutputKind, type CompDocument, type CompNode, type CompNodeType, type CompProblem } from '@vcvfx/domain';

/**
 * The node graph editor (master spec §14; addendum 13 §7), in plain React and
 * SVG: nodes as boxes with their inputs on the top edge and their output on
 * the bottom (as Nuke draws them), connections as curves from an output down
 * into an input.
 *
 *  - drag a node to move it (several when selected); drag the background to
 *    pan; the wheel zooms about the pointer; F frames everything;
 *  - drag from a node's output onto an input (or onto a node: its first free
 *    input) to connect; drag a connected input away to move or drop it;
 *  - Tab (or the + button) opens a searchable menu of nodes, inserted after
 *    the selected one as Nuke does; Delete removes, D bypasses, 1 and 2 put
 *    the selected node in the viewer's A and B, L lays the graph out, ⌘/Ctrl+Z
 *    undoes.
 *
 * It only reports what the artist did; the workspace turns each into a
 * logged domain mutation.
 */

export interface GraphEditorProps {
  doc: Pick<CompDocument, 'nodes' | 'edges'>;
  selected: readonly string[];
  viewer: { a: string | null; b: string | null };
  problems: readonly CompProblem[];
  disabled: boolean;
  onSelect(ids: string[]): void;
  onMove(moves: { id: string; x: number; y: number }[]): void;
  onConnect(edge: { from: string; to: string; input: string }): void;
  onDisconnect(to: string, input: string): void;
  onAdd(type: CompNodeType, at: { x: number; y: number } | null): void;
  onDelete(ids: string[]): void;
  onBypass(ids: string[]): void;
  onViewer(slot: 'a' | 'b', id: string): void;
  onLayout(): void;
  onUndo(): void;
  canUndo: boolean;
}

const KIND_COLOUR = { rgb: '#6aa8ff', alpha: '#e8e8e8', rgba: '#f2a33a' } as const;
const CATEGORY_COLOUR: Record<string, string> = { Image: '#3a4f6b', Module: '#5b4a2a', Merge: '#2f5a4a', Colour: '#5a3550', Filter: '#3d4f2e', Transform: '#4a3f63', Channel: '#3f4a4f', Utility: '#3a3d44' };

/** Where input `i` of `n` inputs sits on the node's top edge (graph units, from the node's left). */
export function inputX(i: number, n: number): number {
  return n <= 1 ? COMP_NODE_W / 2 : 18 + (i * (COMP_NODE_W - 36)) / (n - 1);
}

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; origin: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'link'; from: string; at: { x: number; y: number }; detach?: { to: string; input: string } }
  | { kind: 'pan'; start: { x: number; y: number }; view: { x: number; y: number } }
  | null;

export function GraphEditor(p: GraphEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: -40, y: -40, k: 1 });
  const [box, setBox] = useState({ w: 800, h: 300 });
  const [drag, setDrag] = useState<Drag>(null);
  const [live, setLive] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; at: { x: number; y: number } | null } | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBox({ w: Math.max(100, el.clientWidth), h: Math.max(80, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = (n: CompNode) => live?.get(n.id) ?? { x: n.x, y: n.y };
  const fit = () => {
    if (!p.doc.nodes.length) return setView({ x: -40, y: -40, k: 1 });
    const xs = p.doc.nodes.map((n) => n.x);
    const ys = p.doc.nodes.map((n) => n.y);
    const x0 = Math.min(...xs) - 40;
    const y0 = Math.min(...ys) - 40;
    const x1 = Math.max(...xs) + COMP_NODE_W + 40;
    const y1 = Math.max(...ys) + COMP_NODE_H + 40;
    const k = Math.max(0.25, Math.min(1.4, Math.min(box.w / (x1 - x0), box.h / (y1 - y0))));
    setView({ x: (x0 + x1) / 2 - box.w / 2 / k, y: (y0 + y1) / 2 - box.h / 2 / k, k });
  };
  // Frame the graph once it is there (and when the editor's size first settles).
  useEffect(() => {
    if (!fitted.current && p.doc.nodes.length && box.w > 100) {
      fitted.current = true;
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.doc.nodes.length, box.w, box.h]);

  const toGraph = (clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: view.x + (clientX - r.left) / view.k, y: view.y + (clientY - r.top) / view.k };
  };
  const nodeAt = (g: { x: number; y: number }) => [...p.doc.nodes].reverse().find((n) => {
    const q = pos(n);
    return g.x >= q.x && g.x <= q.x + COMP_NODE_W && g.y >= q.y - 8 && g.y <= q.y + COMP_NODE_H + 8;
  });
  const inputAt = (g: { x: number; y: number }): { node: CompNode; input: string } | null => {
    for (const n of p.doc.nodes) {
      const q = pos(n);
      const ins = COMP_NODES[n.type].inputs;
      for (let i = 0; i < ins.length; i += 1) {
        const ix = q.x + inputX(i, ins.length);
        if (Math.abs(g.x - ix) <= 11 && Math.abs(g.y - q.y) <= 11) return { node: n, input: ins[i]!.name };
      }
    }
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    wrapRef.current?.focus();
    setMenu(null);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const g = toGraph(e.clientX, e.clientY);
    const target = (e.target as Element).closest('[data-port]');
    if (target && !p.disabled) {
      const id = target.getAttribute('data-node')!;
      if (target.getAttribute('data-port') === 'out') return setDrag({ kind: 'link', from: id, at: g });
      // An input: pick its connection up (move it to another input, or drop it).
      const input = target.getAttribute('data-input')!;
      const edge = p.doc.edges.find((x) => x.to === id && x.input === input);
      if (edge) return setDrag({ kind: 'link', from: edge.from, at: g, detach: { to: id, input } });
      return;
    }
    const hit = nodeAt(g);
    if (hit) {
      const sel = e.shiftKey ? (p.selected.includes(hit.id) ? p.selected.filter((x) => x !== hit.id) : [...p.selected, hit.id]) : p.selected.includes(hit.id) ? [...p.selected] : [hit.id];
      if (!e.shiftKey && !p.selected.includes(hit.id)) p.onSelect(sel);
      else if (e.shiftKey) p.onSelect(sel);
      if (p.disabled) return;
      const origin = new Map(p.doc.nodes.filter((n) => sel.includes(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
      return setDrag({ kind: 'move', start: g, origin, moved: false });
    }
    if (!e.shiftKey) p.onSelect([]);
    setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, view: { x: view.x, y: view.y } });
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    if (drag.kind === 'pan') return setView((v) => ({ ...v, x: drag.view.x - (e.clientX - drag.start.x) / v.k, y: drag.view.y - (e.clientY - drag.start.y) / v.k }));
    const g = toGraph(e.clientX, e.clientY);
    if (drag.kind === 'link') return setDrag({ ...drag, at: g });
    const dx = g.x - drag.start.x;
    const dy = g.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    const next = new Map<string, { x: number; y: number }>();
    for (const [id, o] of drag.origin) next.set(id, { x: Math.round(o.x + dx), y: Math.round(o.y + dy) });
    setLive(next);
    if (!drag.moved) setDrag({ ...drag, moved: true });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === 'move') {
      if (d.moved && live) p.onMove([...live].map(([id, q]) => ({ id, ...q })));
      setLive(null);
      return;
    }
    if (d.kind !== 'link') return;
    const g = toGraph(e.clientX, e.clientY);
    const port = inputAt(g);
    let target: { to: string; input: string } | null = port ? { to: port.node.id, input: port.input } : null;
    if (!target) {
      const n = nodeAt(g);
      if (n && n.id !== d.from) {
        const ins = COMP_NODES[n.type].inputs;
        const free = ins.find((i) => !p.doc.edges.some((x) => x.to === n.id && x.input === i.name)) ?? ins[0];
        if (free) target = { to: n.id, input: free.name };
      }
    }
    if (d.detach && (!target || target.to !== d.detach.to || target.input !== d.detach.input)) p.onDisconnect(d.detach.to, d.detach.input);
    if (target && !(d.detach && target.to === d.detach.to && target.input === d.detach.input)) p.onConnect({ from: d.from, ...target });
  };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const g = toGraph(e.clientX, e.clientY);
    const k = Math.max(0.2, Math.min(2.5, view.k * Math.exp(-e.deltaY * 0.0015)));
    setView({ k, x: g.x - (g.x - view.x) * (view.k / k), y: g.y - (g.y - view.y) * (view.k / k) });
  };

  const openMenu = (at: { x: number; y: number } | null) => {
    if (p.disabled) return;
    const r = wrapRef.current?.getBoundingClientRect();
    const sx = at && r ? (at.x - view.x) * view.k : (r?.width ?? 300) / 2 - 130;
    const sy = at && r ? (at.y - view.y) * view.k : 24;
    setMenu({ x: Math.max(4, Math.min((r?.width ?? 300) - 268, sx)), y: Math.max(4, Math.min((r?.height ?? 200) - 60, sy)), at });
  };
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (p.canUndo && !p.disabled) p.onUndo();
      return;
    }
    if (mod || e.altKey) return;
    const sel = p.selected;
    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        openMenu(lastPointer.current);
        break;
      case 'Delete':
      case 'Backspace':
        if (sel.length && !p.disabled) {
          e.preventDefault();
          p.onDelete([...sel]);
        }
        break;
      case 'd':
      case 'D':
        if (sel.length && !p.disabled) p.onBypass([...sel]);
        break;
      case '1':
      case '2':
        if (sel.length) p.onViewer(e.key === '1' ? 'a' : 'b', sel[sel.length - 1]!);
        break;
      case 'f':
      case 'F':
        fit();
        break;
      case 'l':
      case 'L':
        if (!p.disabled) p.onLayout();
        break;
      case 'Escape':
        setMenu(null);
        break;
    }
  };

  const problemsBy = useMemo(() => {
    const m = new Map<string, CompProblem>();
    for (const x of p.problems) if (x.node && x.severity !== 'info' && !m.has(x.node)) m.set(x.node, x);
    return m;
  }, [p.problems]);
  const unused = useMemo(() => new Set(p.problems.filter((x) => x.severity === 'info' && x.node).map((x) => x.node!)), [p.problems]);
  const byId = new Map(p.doc.nodes.map((n) => [n.id, n]));
  const kindOf = useMemo(() => new Map(p.doc.nodes.map((n) => [n.id, compOutputKind(p.doc, n.id)])), [p.doc]);

  const edgePath = (x0: number, y0: number, x1: number, y1: number) => {
    const dy = Math.max(30, Math.abs(y1 - y0) / 2);
    return `M${x0},${y0} C${x0},${y0 + dy} ${x1},${y1 - dy} ${x1},${y1}`;
  };
  const dragLink = drag?.kind === 'link' ? drag : null;

  return (
    <div
      ref={wrapRef}
      className="comp-graph"
      tabIndex={0}
      role="application"
      aria-label="Node graph: Tab adds a node, Delete removes, D bypasses, 1 and 2 view, F frames, L lays out"
      onKeyDown={onKeyDown}
      onPointerMove={(e) => (lastPointer.current = toGraph(e.clientX, e.clientY))}
    >
      <svg
        ref={svgRef}
        className="comp-graph-svg"
        width={box.w}
        height={box.h}
        viewBox={`${view.x} ${view.y} ${box.w / view.k} ${box.h / view.k}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={(e) => {
          if (!nodeAt(toGraph(e.clientX, e.clientY))) openMenu(toGraph(e.clientX, e.clientY));
        }}
      >
        <defs>
          <pattern id="comp-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="rgba(255,255,255,0.04)" />
          </pattern>
        </defs>
        <rect x={view.x - 4000} y={view.y - 4000} width={box.w / view.k + 8000} height={box.h / view.k + 8000} fill="url(#comp-grid)" />
        {p.doc.edges.map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const a = pos(from);
          const b = pos(to);
          const ins = COMP_NODES[to.type].inputs;
          const i = ins.findIndex((x) => x.name === e.input);
          const hidden = dragLink?.detach && dragLink.detach.to === e.to && dragLink.detach.input === e.input;
          if (hidden) return null;
          const kind = kindOf.get(from.id);
          return (
            <g key={`${e.to}.${e.input}`} className="comp-edge">
              <path d={edgePath(a.x + COMP_NODE_W / 2, a.y + COMP_NODE_H, b.x + inputX(i, ins.length), b.y)} stroke={kind ? KIND_COLOUR[kind] : '#888'} />
              <text x={b.x + inputX(i, ins.length) + 6} y={b.y - 8} className="comp-edge-label">
                {ins[i]?.label}
              </text>
            </g>
          );
        })}
        {dragLink ? (() => {
          const from = byId.get(dragLink.from);
          if (!from) return null;
          const a = pos(from);
          return <path className="comp-edge-drag" d={edgePath(a.x + COMP_NODE_W / 2, a.y + COMP_NODE_H, dragLink.at.x, dragLink.at.y)} />;
        })() : null}
        {p.doc.nodes.map((n) => {
          const q = pos(n);
          const info = COMP_NODES[n.type];
          const sel = p.selected.includes(n.id);
          const problem = problemsBy.get(n.id);
          const kind = kindOf.get(n.id);
          const cls = ['comp-node', sel ? 'on' : '', n.disabled ? 'bypassed' : '', problem?.severity === 'error' ? 'error' : problem ? 'warning' : '', unused.has(n.id) ? 'unused' : ''].filter(Boolean).join(' ');
          return (
            <g key={n.id} className={cls} transform={`translate(${q.x},${q.y})`} data-node-id={n.id} data-name={n.name}>
              <title>{`${n.name} (${info.label})${problem ? ` — ${problem.message}` : ''}${n.disabled ? ' — bypassed (D)' : ''}`}</title>
              <rect className="comp-node-body" width={COMP_NODE_W} height={COMP_NODE_H} rx={5} fill={CATEGORY_COLOUR[info.category]} />
              <text className="comp-node-name" x={COMP_NODE_W / 2} y={15} textAnchor="middle">
                {n.name.length > 17 ? `${n.name.slice(0, 16)}…` : n.name}
              </text>
              <text className="comp-node-type" x={COMP_NODE_W / 2} y={28} textAnchor="middle">
                {info.label}
                {n.type === 'merge' ? ` · ${String(n.params['operation'] ?? 'over')}` : ''}
              </text>
              {n.disabled ? <line className="comp-node-bypass" x1={6} y1={COMP_NODE_H - 6} x2={COMP_NODE_W - 6} y2={6} /> : null}
              {p.viewer.a === n.id || p.viewer.b === n.id ? (
                <g className="comp-node-view">
                  <rect x={COMP_NODE_W - 4} y={-9} width={p.viewer.a === n.id && p.viewer.b === n.id ? 30 : 17} height={16} rx={3} />
                  <text x={COMP_NODE_W + 4.5} y={3} textAnchor="middle">
                    {p.viewer.a === n.id ? '1' : '2'}
                  </text>
                  {p.viewer.a === n.id && p.viewer.b === n.id ? (
                    <text x={COMP_NODE_W + 17} y={3} textAnchor="middle">
                      2
                    </text>
                  ) : null}
                </g>
              ) : null}
              {info.inputs.map((input, i) => {
                const connected = p.doc.edges.some((x) => x.to === n.id && x.input === input.name);
                return (
                  <g key={input.name} data-port="in" data-node={n.id} data-input={input.name} className={`comp-port in${connected ? ' connected' : ''}${input.optional ? ' optional' : ''}`}>
                    <circle cx={inputX(i, info.inputs.length)} cy={0} r={6} />
                    <circle cx={inputX(i, info.inputs.length)} cy={0} r={12} className="comp-port-hit" />
                  </g>
                );
              })}
              <g data-port="out" data-node={n.id} className="comp-port out">
                <circle cx={COMP_NODE_W / 2} cy={COMP_NODE_H} r={6} fill={kind ? KIND_COLOUR[kind] : '#666'} />
                <circle cx={COMP_NODE_W / 2} cy={COMP_NODE_H} r={12} className="comp-port-hit" />
              </g>
            </g>
          );
        })}
      </svg>
      <div className="comp-graph-tools">
        <button type="button" className="small" onClick={() => openMenu(null)} disabled={p.disabled} title="Add a node (Tab)">
          + Node
        </button>
        <button type="button" className="small" onClick={() => p.onLayout()} disabled={p.disabled || !p.doc.nodes.length} title="Lay the graph out (L)">
          Layout
        </button>
        <button type="button" className="small" onClick={fit} title="Frame the whole graph (F)">
          Fit
        </button>
        <button type="button" className="small" onClick={() => p.onUndo()} disabled={p.disabled || !p.canUndo} title="Undo the last change to the graph (⌘/Ctrl+Z)">
          Undo
        </button>
      </div>
      <div className="comp-graph-legend" aria-hidden="true">
        <span>
          <i style={{ background: KIND_COLOUR.rgb }} /> colour
        </span>
        <span>
          <i style={{ background: KIND_COLOUR.rgba }} /> colour + alpha
        </span>
        <span>
          <i style={{ background: KIND_COLOUR.alpha }} /> matte
        </span>
      </div>
      {menu ? <AddMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onPick={(t) => {
        setMenu(null);
        p.onAdd(t, menu.at);
        wrapRef.current?.focus();
      }} /> : null}
    </div>
  );
}

/** The searchable add-node menu (Tab), grouped by category; Enter takes the first match. */
export function AddMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick(t: CompNodeType): void; onClose(): void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return COMP_NODE_TYPES.filter((t) => !s || COMP_NODES[t].label.toLowerCase().includes(s) || COMP_NODES[t].category.toLowerCase().includes(s) || COMP_NODES[t].blurb.toLowerCase().includes(s)).sort((a, b) => {
      const ia = COMP_NODES[a].label.toLowerCase().startsWith(s) ? 0 : 1;
      const ib = COMP_NODES[b].label.toLowerCase().startsWith(s) ? 0 : 1;
      return ia - ib;
    });
  }, [q]);
  useEffect(() => setActive(0), [q]);
  return (
    <div className="comp-add-menu" style={{ left: x, top: y }} role="dialog" aria-label="Add a node">
      <input
        autoFocus
        type="search"
        placeholder="Add a node… (type to search)"
        aria-label="Search nodes"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter' && list[active]) onPick(list[active]!);
        }}
      />
      <ul role="listbox" aria-label="Nodes">
        {list.map((t, i) => (
          <li key={t} role="option" aria-selected={i === active}>
            <button type="button" className={i === active ? 'on' : undefined} onMouseEnter={() => setActive(i)} onClick={() => onPick(t)}>
              <span className="comp-add-name">{COMP_NODES[t].label}</span>
              <span className="comp-add-cat">{COMP_NODES[t].category}</span>
              <span className="comp-add-blurb">{COMP_NODES[t].blurb}</span>
            </button>
          </li>
        ))}
        {!list.length ? <li className="muted">No node matches “{q}”.</li> : null}
      </ul>
    </div>
  );
}
