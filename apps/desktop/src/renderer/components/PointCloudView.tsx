import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';

/**
 * The 3D view of a camera track (addendum 06 §9): LiDAR / survey points, the
 * solved track points, the camera path and the current frame's frustum, in
 * the Y-up scene. Plain WebGL2 (no three.js: a few hundred lines, no bundle
 * weight). Orbit with the left button, pan with the right button or Shift,
 * zoom with the wheel; a click picks the nearest point (cloud or track).
 */

export interface CloudLayer {
  id: string;
  /** Scene positions, xyz. */
  positions: Float32Array;
  colors: Uint8Array | null;
  /** Points of this layer can be picked. */
  pickable: boolean;
  size: number;
}

export interface PointCloudViewProps {
  clouds: CloudLayer[];
  /** Track points (scene), their ids and colours. */
  tracks: { positions: Float32Array; ids: Int32Array; colors: Uint8Array } | null;
  /** Camera positions and camera→scene rotations (graphics convention), per solved frame. */
  cameras: { position: number[]; rotation: number[]; frame: number }[];
  currentFrame: number;
  /** Horizontal field of view of the camera, degrees, and its aspect, for the frustum. */
  fovDeg: number;
  aspect: number;
  /** Highlighted points (scene), e.g. correspondences. */
  marks: { position: number[]; color: [number, number, number]; label: string }[];
  onPick?(pick: { layer: string; index: number; position: number[] } | { layer: 'tracks'; id: number; position: number[] }): void;
  /** Changes when the scene changes so the view re-frames itself. */
  frameKey: string;
  /** What a click can pick (default both): e.g. only the cloud once a feature is chosen for a correspondence. */
  pickOnly?: 'clouds' | 'tracks';
}

type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = norm([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!]);
  const x = norm(crossV(up, z));
  const y = crossV(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]!;
  m[4] = x[1]!;
  m[8] = x[2]!;
  m[1] = y[0]!;
  m[5] = y[1]!;
  m[9] = y[2]!;
  m[2] = z[0]!;
  m[6] = z[1]!;
  m[10] = z[2]!;
  m[12] = -(x[0]! * eye[0]! + x[1]! * eye[1]! + x[2]! * eye[2]!);
  m[13] = -(y[0]! * eye[0]! + y[1]! * eye[1]! + y[2]! * eye[2]!);
  m[14] = -(z[0]! * eye[0]! + z[1]! * eye[1]! + z[2]! * eye[2]!);
  m[15] = 1;
  return m;
}

function mulM(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  return o;
}

const norm = (v: number[]) => {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / n, v[1]! / n, v[2]! / n];
};
const crossV = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

const VS = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat4 uMvp;
uniform float uSize;
out vec3 vCol;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
  gl_PointSize = uSize;
  vCol = aCol;
}`;
const FS = `#version 300 es
precision mediump float;
in vec3 vCol;
uniform bool uRound;
out vec4 color;
void main() {
  if (uRound) {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
  }
  color = vec4(vCol, 1.0);
}`;

interface Buffers {
  pos: WebGLBuffer;
  col: WebGLBuffer;
  count: number;
}

export interface SceneFit {
  target: number[];
  dist: number;
  yaw: number;
  pitch: number;
  /** The content's centre and robust radius (80th percentile), to tell when it has moved. */
  centre: number[];
  radius: number;
}

/**
 * Where to look from to see the scene: the cameras, the track points and (a
 * sample of) the clouds, between the camera path and the points, from behind
 * the cameras and a little above, far enough for the 80th-percentile radius
 * (so stray points do not shrink the view).
 */
export function fitScene(clouds: readonly Pick<CloudLayer, 'positions'>[], tracks: { positions: Float32Array } | null, cameras: readonly { position: number[]; rotation: number[] }[]): SceneFit | null {
  const pts: number[] = [];
  const sample = (pos: Float32Array, max: number) => {
    const step = 3 * Math.max(1, Math.floor(pos.length / 3 / max));
    for (let i = 0; i + 2 < pos.length; i += step) if (Number.isFinite(pos[i]!) && Number.isFinite(pos[i + 1]!) && Number.isFinite(pos[i + 2]!)) pts.push(pos[i]!, pos[i + 1]!, pos[i + 2]!);
  };
  for (const c of cameras) pts.push(c.position[0]!, c.position[1]!, c.position[2]!);
  if (tracks) sample(tracks.positions, 2000);
  // Clouds count, but a dense scan should not outweigh the solve.
  const solved = pts.length / 3;
  for (const c of clouds) sample(c.positions, solved ? Math.max(200, Math.min(1500, solved)) : 3000);
  if (!pts.length) return null;
  const n = pts.length / 3;
  const median = [0, 1, 2].map((k) => {
    const v = Array.from({ length: n }, (_, i) => pts[3 * i + k]!).sort((a, b) => a - b);
    return v[Math.floor(n / 2)]!;
  });
  const cams = cameras.length ? [0, 1, 2].map((k) => cameras.reduce((a, c) => a + c.position[k]!, 0) / cameras.length) : median;
  const centre = median.map((v, k) => 0.6 * v + 0.4 * cams[k]!);
  const radii = Array.from({ length: n }, (_, i) => Math.hypot(pts[3 * i]! - centre[0]!, pts[3 * i + 1]! - centre[1]!, pts[3 * i + 2]! - centre[2]!)).sort((a, b) => a - b);
  const radius = Math.max(1e-6, radii[Math.floor(0.8 * (n - 1))] ?? 1);
  let yaw = 0.7;
  if (cameras.length) {
    const dir = [0, 0, 0];
    for (const c of cameras) for (let k = 0; k < 3; k += 1) dir[k]! -= c.rotation[3 * k + 2]!;
    if (Math.hypot(dir[0]!, dir[2]!) > 1e-6) yaw = Math.atan2(-dir[0]!, -dir[2]!);
  }
  return { target: centre, dist: Math.max(1e-3, Math.min(radius * 2.2, 1e7)), yaw, pitch: 0.45, centre, radius };
}

/** The content has left the view (moved by more than the view's reach) or changed size by more than 4×. */
export function needsReframe(last: SceneFit | null, next: SceneFit, view: { target: number[]; dist: number }): boolean {
  if (!last) return true;
  const moved = Math.hypot(next.centre[0]! - view.target[0]!, next.centre[1]! - view.target[1]!, next.centre[2]! - view.target[2]!);
  if (moved > Math.max(view.dist, next.radius * 2)) return true;
  const ratio = next.radius / last.radius;
  return ratio > 4 || ratio < 0.25;
}

export function PointCloudView(props: PointCloudViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<{ gl: WebGL2RenderingContext; prog: WebGLProgram; loc: { pos: number; col: number; mvp: WebGLUniformLocation; size: WebGLUniformLocation; round: WebGLUniformLocation } } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const view = useRef({ target: [0, 0, 0], dist: 20, yaw: 0.6, pitch: 0.35 });
  const [, setTick] = useState(0);
  const drag = useRef<{ x: number; y: number; mode: 'orbit' | 'pan'; moved: boolean } | null>(null);
  const buffers = useRef(new Map<string, Buffers>());
  const mvpRef = useRef<Mat4 | null>(null);

  // Set up GL once.
  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl2', { antialias: true });
    if (!canvas || !gl) {
      setUnsupported(true);
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setUnsupported(true);
      return;
    }
    glRef.current = { gl, prog, loc: { pos: gl.getAttribLocation(prog, 'aPos'), col: gl.getAttribLocation(prog, 'aCol'), mvp: gl.getUniformLocation(prog, 'uMvp')!, size: gl.getUniformLocation(prog, 'uSize')!, round: gl.getUniformLocation(prog, 'uRound')! } };
  }, []);

  const upload = useCallback((key: string, pos: Float32Array, col: Float32Array) => {
    const g = glRef.current;
    if (!g) return;
    const { gl } = g;
    let b = buffers.current.get(key);
    if (!b) {
      b = { pos: gl.createBuffer()!, col: gl.createBuffer()!, count: 0 };
      buffers.current.set(key, b);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    b.count = pos.length / 3;
  }, []);

  // Clouds and tracks into buffers when they change.
  useEffect(() => {
    for (const c of props.clouds) {
      const col = new Float32Array(c.positions.length);
      if (c.colors) for (let i = 0; i < col.length; i += 1) col[i] = c.colors[i]! / 255;
      else col.fill(0.7);
      upload(`cloud:${c.id}`, c.positions, col);
    }
    for (const key of [...buffers.current.keys()]) if (key.startsWith('cloud:') && !props.clouds.some((c) => `cloud:${c.id}` === key)) buffers.current.delete(key);
    if (props.tracks) {
      const col = new Float32Array(props.tracks.colors.length);
      for (let i = 0; i < col.length; i += 1) col[i] = props.tracks.colors[i]! / 255;
      upload('tracks', props.tracks.positions, col);
    } else buffers.current.delete('tracks');
    setTick((t) => t + 1);
  }, [props.clouds, props.tracks, upload]);

  // Frame the scene: on request (frameKey), and whenever the content moves out
  // of view or changes size a lot — e.g. a LiDAR-constrained solve or an
  // alignment puts the scene in the scan's coordinates, far from the origin.
  const lastFit = useRef<SceneFit | null>(null);
  const frameAll = useCallback(() => {
    const fit = fitScene(props.clouds, props.tracks, props.cameras);
    if (!fit) return;
    lastFit.current = fit;
    view.current = { target: fit.target, dist: fit.dist, yaw: fit.yaw, pitch: fit.pitch };
    setTick((t) => t + 1);
  }, [props.clouds, props.tracks, props.cameras]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => frameAll(), [props.frameKey]);
  useEffect(() => {
    const fit = fitScene(props.clouds, props.tracks, props.cameras);
    if (fit && needsReframe(lastFit.current, fit, view.current)) frameAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.clouds, props.tracks, props.cameras]);
  // F frames everything (as in most 3D packages).
  const frameRef = useRef(frameAll);
  frameRef.current = frameAll;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('.modal')) return;
      frameRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Draw.
  useEffect(() => {
    const g = glRef.current;
    const canvas = canvasRef.current;
    if (!g || !canvas) return;
    const { gl, prog, loc } = g;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.07, 0.08, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const v = view.current;
    const eye = [v.target[0]! + v.dist * Math.cos(v.pitch) * Math.sin(v.yaw), v.target[1]! + v.dist * Math.sin(v.pitch), v.target[2]! + v.dist * Math.cos(v.pitch) * Math.cos(v.yaw)];
    const mvp = mulM(perspective((50 * Math.PI) / 180, w / h, v.dist / 1000, v.dist * 100), lookAt(eye, v.target, [0, 1, 0]));
    mvpRef.current = mvp;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(loc.mvp, false, mvp);
    const draw = (b: Buffers, mode: number, size: number, round: boolean) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
      gl.enableVertexAttribArray(loc.pos);
      gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.col);
      gl.enableVertexAttribArray(loc.col);
      gl.vertexAttribPointer(loc.col, 3, gl.FLOAT, false, 0, 0);
      gl.uniform1f(loc.size, size * dpr);
      gl.uniform1i(loc.round, round ? 1 : 0);
      gl.drawArrays(mode, 0, b.count);
    };
    for (const c of props.clouds) {
      const b = buffers.current.get(`cloud:${c.id}`);
      if (b) draw(b, gl.POINTS, c.size, false);
    }
    const tb = buffers.current.get('tracks');
    if (tb) draw(tb, gl.POINTS, 4, true);
    // Camera path, frustum, marks: small, rebuilt each draw.
    const lines: number[] = [];
    const lcol: number[] = [];
    for (let i = 1; i < props.cameras.length; i += 1) {
      lines.push(...props.cameras[i - 1]!.position, ...props.cameras[i]!.position);
      lcol.push(0.95, 0.75, 0.2, 0.95, 0.75, 0.2);
    }
    const cur = props.cameras.find((c) => c.frame === props.currentFrame) ?? props.cameras[0];
    if (cur) {
      const R = cur.rotation;
      const s = v.dist * 0.06;
      const ax = (x: number, y: number, z: number) => [cur.position[0]! + s * (R[0]! * x + R[1]! * y + R[2]! * z), cur.position[1]! + s * (R[3]! * x + R[4]! * y + R[5]! * z), cur.position[2]! + s * (R[6]! * x + R[7]! * y + R[8]! * z)];
      const tx = Math.tan((props.fovDeg * Math.PI) / 360);
      const ty = tx / props.aspect;
      const corners = [ax(-tx, ty, -1), ax(tx, ty, -1), ax(tx, -ty, -1), ax(-tx, -ty, -1)];
      for (let k = 0; k < 4; k += 1) {
        lines.push(...cur.position, ...corners[k]!, ...corners[k]!, ...corners[(k + 1) % 4]!);
        lcol.push(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1);
      }
      // "Up" tick on the frustum.
      lines.push(...ax(0, ty, -1), ...ax(0, ty * 1.4, -1));
      lcol.push(0.4, 0.8, 1, 0.4, 0.8, 1);
    }
    // Axes at the origin.
    const a = v.dist * 0.08;
    lines.push(0, 0, 0, a, 0, 0, 0, 0, 0, 0, a, 0, 0, 0, 0, 0, 0, a);
    lcol.push(0.9, 0.3, 0.3, 0.9, 0.3, 0.3, 0.3, 0.9, 0.3, 0.3, 0.9, 0.3, 0.3, 0.5, 1, 0.3, 0.5, 1);
    upload('lines', Float32Array.from(lines), Float32Array.from(lcol));
    draw(buffers.current.get('lines')!, gl.LINES, 1, false);
    if (props.marks.length) {
      upload('marks', Float32Array.from(props.marks.flatMap((m) => m.position)), Float32Array.from(props.marks.flatMap((m) => m.color)));
      gl.disable(gl.DEPTH_TEST);
      draw(buffers.current.get('marks')!, gl.POINTS, 10, true);
    }
  });

  const toScreen = (p: number[], w: number, h: number): [number, number, number] | null => {
    const m = mvpRef.current;
    if (!m) return null;
    const x = m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!;
    const y = m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!;
    const wv = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
    if (wv <= 0) return null;
    return [((x / wv + 1) / 2) * w, ((1 - y / wv) / 2) * h, wv];
  };

  // For UI automation (screenshots, end-to-end scripts): where a layer's point is on the canvas, in CSS pixels.
  useEffect(() => {
    const canvas = canvasRef.current as (HTMLCanvasElement & { screenOf?: (layer: string, index: number) => [number, number] | null; layers?: () => unknown }) | null;
    if (!canvas) return;
    canvas.layers = () => ({ tracks: props.tracks, clouds: props.clouds.map((c) => ({ id: c.id, positions: c.positions })), cameras: props.cameras.map((c) => ({ frame: c.frame, position: c.position, rotation: c.rotation })) });
    canvas.screenOf = (layer, index) => {
      const c = layer === 'tracks' ? props.tracks : props.clouds.find((x) => x.id === layer);
      if (!c || 3 * index + 2 >= c.positions.length) return null;
      const s = toScreen([c.positions[3 * index]!, c.positions[3 * index + 1]!, c.positions[3 * index + 2]!], canvas.clientWidth, canvas.clientHeight);
      return s ? [s[0], s[1]] : null;
    };
  });

  const pick = (cx: number, cy: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !props.onPick) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    let best: { d: number; z: number; layer: string; index: number; id?: number; position: number[] } | null = null;
    const consider = (layer: string, index: number, p: number[], id?: number) => {
      const s = toScreen(p, w, h);
      if (!s) return;
      const d = Math.hypot(s[0] - cx, s[1] - cy);
      if (d > 10) return;
      // Prefer the nearest on screen, then the nearest in depth.
      if (!best || d + s[2] * 1e-6 < best.d + best.z * 1e-6) best = { d, z: s[2], layer, index, ...(id !== undefined ? { id } : {}), position: p };
    };
    if (props.tracks && props.pickOnly !== 'clouds') for (let i = 0; i < props.tracks.ids.length; i += 1) consider('tracks', i, [props.tracks.positions[3 * i]!, props.tracks.positions[3 * i + 1]!, props.tracks.positions[3 * i + 2]!], props.tracks.ids[i]!);
    for (const c of props.pickOnly === 'tracks' ? [] : props.clouds) {
      if (!c.pickable) continue;
      for (let i = 0; i < c.positions.length / 3; i += 1) consider(c.id, i, [c.positions[3 * i]!, c.positions[3 * i + 1]!, c.positions[3 * i + 2]!]);
    }
    const b = best as { layer: string; index: number; id?: number; position: number[] } | null;
    if (!b) return;
    if (b.layer === 'tracks' && b.id !== undefined) props.onPick({ layer: 'tracks', id: b.id, position: b.position });
    else props.onPick({ layer: b.layer, index: b.index, position: b.position });
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, mode: e.button === 2 || e.shiftKey ? 'pan' : 'orbit', moved: false };
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const v = view.current;
    if (d.mode === 'orbit') {
      v.yaw -= dx * 0.008;
      v.pitch = Math.max(-1.5, Math.min(1.5, v.pitch + dy * 0.008));
    } else {
      const k = v.dist * 0.0015;
      const right = [Math.cos(v.yaw), 0, -Math.sin(v.yaw)];
      const up = [-Math.sin(v.pitch) * Math.sin(v.yaw), Math.cos(v.pitch), -Math.sin(v.pitch) * Math.cos(v.yaw)];
      for (let i = 0; i < 3; i += 1) v.target[i] = v.target[i]! - right[i]! * dx * k + up[i]! * dy * k;
    }
    setTick((t) => t + 1);
  };
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && e.button === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      pick(e.clientX - r.left, e.clientY - r.top);
    }
  };
  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    view.current.dist *= Math.exp(e.deltaY * 0.001);
    setTick((t) => t + 1);
  };

  return (
    <div className="cloud-view">
      <canvas ref={canvasRef} className="cloud-canvas" aria-label="3D view" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
      {unsupported ? <p className="viewer-message">The 3D view needs WebGL 2, which this display does not offer.</p> : null}
      <button type="button" className="cloud-frame-all small" onClick={frameAll} title="Frame everything: the cameras, the track points and the clouds (F)">
        Frame all <kbd>F</kbd>
      </button>
      <div className="cloud-legend small">
        <span>
          <i style={{ background: '#f2c033' }} /> camera path
        </span>
        <span>
          <i style={{ background: '#fff' }} /> frame {props.currentFrame}
        </span>
        {props.marks.length ? (
          <span>
            <i style={{ background: '#ff5f56' }} /> {props.marks.length} correspondence{props.marks.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="muted">drag to orbit · right-drag or Shift to pan · wheel to zoom · click to pick · F to frame all</span>
      </div>
    </div>
  );
}
