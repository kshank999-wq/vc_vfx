/**
 * The browser preview's camera-tracking shot (src/renderer/assets/track-sample).
 *
 *   node <vite-node> scripts/make-track-sample.ts [path/to/ffmpeg]
 *
 * (vite-node ships with vitest; packages/domain must be built first.)
 *
 * The synthetic room of the camera tests (shared/camera/render.ts), rendered
 * through the sample project's 020_010 lens — 25 mm on the VENICE 2 film back,
 * 2 % long, as a real lens is against its engraving — on a truck-and-pan move:
 * 48 frames at 640 × 360, JPEG. And a "LiDAR scan" of the same room in
 * survey coordinates (Z-up, metres, scaled, turned and far from the origin),
 * as a binary PLY. Everything the preview's Track workspace runs on.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAMPLE_HANDOFF, createProject, focalPixels, newCamTrackDocument, parseHandoff } from '@vcvfx/domain';
import { roomScene, renderScene, sampleSurface } from '../src/shared/camera/render';
import { cameraPath } from '../src/shared/camera/synthetic';
import { rodrigues } from '../src/shared/camera/geometry';
import { applySim } from '../src/shared/camera/align';
import { filmBackOf } from '../src/shared/camera/commands';

export const TRACK_SAMPLE = { width: 640, height: 360, frames: 48, seed: 5, path: 'pan' as const };

const ffmpeg = process.argv[2] || 'ffmpeg';
const out = resolve(__dirname, '..', 'src', 'renderer', 'assets', 'track-sample');
const work = mkdtempSync(join(tmpdir(), 'vcvfx-track-'));
const { width: W, height: H, frames: N } = TRACK_SAMPLE;

const h = parseHandoff(JSON.stringify(SAMPLE_HANDOFF));
if (!h.ok) throw new Error('sample handoff');
const project = createProject(h.handoff, 'sample', 'Sample', new Date('2026-10-20T00:00:00Z'));
const doc = newCamTrackDocument(project, '020_010');
const fb = filmBackOf(doc);
const slate = doc.lens.focalMm ?? 25;
const f = focalPixels(slate, fb.width, W) * 1.02;
const intr = { f, cx: (W - 1) / 2, cy: (H - 1) / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
console.log(`film back ${fb.width} mm (${doc.camera?.label ?? 'nominal'}), slate ${slate} mm → true focal ${f.toFixed(2)} px`);

const quads = roomScene(TRACK_SAMPLE.seed);
const path = cameraPath(TRACK_SAMPLE.path, N, 9);

mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) rmSync(join(out, name));
path.forEach((p, i) => {
  const img = renderScene(quads, { width: W, height: H, intr, R: p.R, t: p.t, supersample: 2 });
  const head = Buffer.from(`P6\n${W} ${H}\n255\n`);
  writeFileSync(join(work, `f${String(i + 1).padStart(3, '0')}.ppm`), Buffer.concat([head, Buffer.from(img.data)]));
});
execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', join(work, 'f%03d.ppm'), '-q:v', '7', join(out, 'f%03d.jpg')]);

// The scan: the room ×1.7 (scene units to metres), turned, moved, stored Z-up.
const LIDAR = { s: 1.7, R: rodrigues([0, 0.6, 0]), t: [1250.4, 3.2, -880.7] };
const s = sampleSurface(quads, 0.27, 21);
const n = s.points.length / 3;
const headPly = Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment VC VFX synthetic scan of the preview room (Z-up, metres)\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`);
const body = Buffer.alloc(n * 15);
for (let i = 0; i < n; i += 1) {
  const p = applySim(LIDAR, [s.points[3 * i]!, s.points[3 * i + 1]!, s.points[3 * i + 2]!]);
  // Y-up scene (y down in the render's world, so flip) → Z-up survey.
  // float32 keeps ~0.1 mm this far from the origin.
  const o = i * 15;
  body.writeFloatLE(p[0]!, o);
  body.writeFloatLE(p[2]!, o + 4);
  body.writeFloatLE(-p[1]!, o + 8);
  body[o + 12] = s.colors[3 * i]!;
  body[o + 13] = s.colors[3 * i + 1]!;
  body[o + 14] = s.colors[3 * i + 2]!;
}
writeFileSync(join(out, 'scan.ply'), Buffer.concat([headPly, body]));
rmSync(work, { recursive: true, force: true });

const total = readdirSync(out).reduce((a, name) => a + statSync(join(out, name)).size, 0);
console.log(`${N} frames + scan (${n} points): ${(total / 1024).toFixed(0)} KiB in ${out}`);
