import type { LightEstimate, LightSpec, Range } from '@vcvfx/domain';
import { DEG, dirOf, levelToCamera } from './geometry';

/**
 * Drawing the rig (addendum 14 §6), shared by the viewer's overlays and the
 * printed report so they always agree:
 *  - on the frame: from the subject's centre, an arrow towards where the
 *    light is (its direction seen in the picture's plane; dashed when it is
 *    behind the subject), inside the cone of its range;
 *  - top view: the subject in the middle, the camera below; azimuth round the
 *    subject (0° towards the camera, +90° to frame right), the range a wedge;
 *  - side view: elevation from the subject's horizon, the range an arc.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A level-frame direction as seen in the picture: the 2-D direction from the subject (y down) and whether it is behind. */
export function screenDir(azDeg: number, elDeg: number, tilt: { pitchDeg: number; rollDeg: number }): { dx: number; dy: number; behind: boolean; along: number } {
  const c = levelToCamera(tilt, dirOf(azDeg, elDeg));
  return { dx: c[0], dy: -c[1], behind: c[2] < -0.05, along: Math.hypot(c[0], c[1]) };
}

/** The arrow's tip and its range cone's outline on the frame (pixels). */
export function frameArrow(light: { azimuthDeg: number; elevationDeg: number }, ranges: { azimuth: Range; elevation: Range } | null, centre: Pt, length: number, tilt: { pitchDeg: number; rollDeg: number }): { tip: Pt; behind: boolean; cone: Pt[] } {
  const d = screenDir(light.azimuthDeg, light.elevationDeg, tilt);
  const k = length * Math.max(0.25, d.along);
  const n = Math.hypot(d.dx, d.dy) || 1;
  const tip = { x: centre.x + (d.dx / n) * k, y: centre.y + (d.dy / n) * k };
  const cone: Pt[] = [];
  if (ranges) {
    const steps = 10;
    const az0 = ranges.azimuth.low;
    const az1 = ranges.azimuth.high;
    const el0 = Math.max(-89, ranges.elevation.low);
    const el1 = Math.min(89, ranges.elevation.high);
    const at = (az: number, el: number) => {
      const q = screenDir(az, el, tilt);
      const m = Math.hypot(q.dx, q.dy) || 1;
      const kk = length * Math.max(0.25, q.along);
      return { x: centre.x + (q.dx / m) * kk, y: centre.y + (q.dy / m) * kk };
    };
    cone.push(centre);
    for (let i = 0; i <= steps; i += 1) cone.push(at(az0 + ((az1 - az0) * i) / steps, el1));
    for (let i = steps; i >= 0; i -= 1) cone.push(at(az0 + ((az1 - az0) * i) / steps, el0));
  }
  return { tip, behind: d.behind, cone };
}

/** Top view: where a light sits (radius r), and its azimuth wedge between radii r0 and r1. y grows towards the camera (down the page). */
export function topPoint(azDeg: number, r: number, centre: Pt): Pt {
  return { x: centre.x + Math.sin(azDeg * DEG) * r, y: centre.y + Math.cos(azDeg * DEG) * r };
}

export function wedgePath(a0: number, a1: number, r0: number, r1: number, centre: Pt, map: (a: number, r: number, c: Pt) => Pt = topPoint): string {
  const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 6));
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = a0 + ((a1 - a0) * i) / steps;
    outer.push(map(a, r1, centre));
    inner.push(map(a, r0, centre));
  }
  const f = (p: Pt) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  return `M${outer.map(f).join(' L')} L${inner.reverse().map(f).join(' L')} Z`;
}

/** Side view: elevation on a half-circle (0° = level, to the right; 90° = straight up). Lights behind the subject (|az| > 90°) on the left. */
export function sidePoint(azDeg: number, elDeg: number, r: number, centre: Pt): Pt {
  const side = Math.abs(azDeg) > 90 ? -1 : 1;
  return { x: centre.x + side * Math.cos(elDeg * DEG) * r, y: centre.y - Math.sin(elDeg * DEG) * r };
}

/** Radius on the diagrams for a distance (metres): log-ish so 0.5 m and 30 m both fit; infinite on the outer ring. */
export function diagramRadius(distanceM: number | null, inner: number, outer: number): number {
  if (distanceM === null) return outer;
  const t = Math.max(0, Math.min(1, Math.log(1 + distanceM) / Math.log(1 + 30)));
  return inner + (outer - inner) * t;
}

/** The inverse of the top view: an azimuth and distance from a point on the diagram (for dragging). */
export function topToAzimuth(p: Pt, centre: Pt): number {
  return Math.atan2(p.x - centre.x, p.y - centre.y) / DEG;
}

export function radiusToDistance(r: number, inner: number, outer: number): number {
  const t = Math.max(0, Math.min(1, (r - inner) / (outer - inner)));
  return Math.max(0.1, Math.exp(t * Math.log(31)) - 1);
}

/** Colour per role, for the diagrams and overlays. */
export const ROLE_COLOURS: Record<LightSpec['role'], string> = {
  key: '#ffb347',
  sun: '#ffd34a',
  fill: '#7fb6ff',
  rim: '#d38cff',
  back: '#ff8fd1',
  practical: '#ff7a45',
  background: '#7fe0b2',
  ambient: '#9aa4b1',
  sky: '#8fd0ff',
};

export const estimateRanges = (e: LightEstimate | null) => (e ? { azimuth: e.azimuth, elevation: e.elevation } : null);
