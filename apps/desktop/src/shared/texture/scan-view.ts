import type { TexturePlane } from '@vcvfx/domain';
import { downsampleTo, type PointCloud } from '../camera/lidar';
import type { TextureScanView } from './bridge-types';
import { toCanonical } from './geometry';

/**
 * The scan as the Textures tab's 3D view draws it (addendum 12 §1): at most
 * `maxPoints` points (voxel-downsampled), in the canonical Y-up frame the
 * point-cloud view uses, each tagged with the plane it lies on (within
 * `threshold` of it, inside its extent), with where the panorama was and the
 * regions' patches.
 */
export function scanViewOf(
  cloud: PointCloud,
  o: { up: 'y' | 'z'; planes: readonly TexturePlane[]; threshold: number; panorama: ArrayLike<number> | null; patches: { regionId: string; corners: ArrayLike<number>[] }[]; maxPoints?: number },
): Omit<TextureScanView, 'built'> {
  const { cloud: c } = downsampleTo(cloud, o.maxPoints ?? 150_000);
  const origin = toCanonical(c.origin, o.up);
  const n = c.count;
  const positions = new Float32Array(3 * n);
  const planeOf = o.planes.length ? new Uint8Array(n) : null;
  for (let i = 0; i < n; i += 1) {
    const p = [c.positions[3 * i]!, c.positions[3 * i + 1]!, c.positions[3 * i + 2]!];
    const q = toCanonical(p, o.up);
    positions[3 * i] = q[0];
    positions[3 * i + 1] = q[1];
    positions[3 * i + 2] = q[2];
    if (planeOf) {
      const X = [p[0]! + c.origin[0], p[1]! + c.origin[1], p[2]! + c.origin[2]];
      for (let k = 0; k < o.planes.length && k < 254; k += 1) {
        const pl = o.planes[k]!;
        const dist = pl.normal[0] * X[0]! + pl.normal[1] * X[1]! + pl.normal[2] * X[2]! - pl.d;
        if (Math.abs(dist) > o.threshold) continue;
        const r = [X[0]! - pl.centroid[0], X[1]! - pl.centroid[1], X[2]! - pl.centroid[2]];
        const u = r[0]! * pl.axisU[0] + r[1]! * pl.axisU[1] + r[2]! * pl.axisU[2];
        const v = r[0]! * pl.axisV[0] + r[1]! * pl.axisV[1] + r[2]! * pl.axisV[2];
        if (u < pl.extent.u0 - o.threshold || u > pl.extent.u1 + o.threshold || v < pl.extent.v0 - o.threshold || v > pl.extent.v1 + o.threshold) continue;
        planeOf[i] = k + 1;
        break;
      }
    }
  }
  const rel = (p: ArrayLike<number>): [number, number, number] => {
    const q = toCanonical(p, o.up);
    return [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
  };
  return {
    positions,
    colors: c.colors,
    origin,
    planeOf,
    planeIds: o.planes.map((p) => p.id),
    panorama: o.panorama ? rel(o.panorama) : null,
    patches: o.patches.map((x) => ({ regionId: x.regionId, corners: x.corners.map(rel) })),
  };
}
