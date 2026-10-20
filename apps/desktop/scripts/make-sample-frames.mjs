/**
 * The browser preview's stand-in frames (src/renderer/assets/sample-frames).
 *
 *   node scripts/make-sample-frames.mjs [path/to/ffmpeg]
 *
 * A synthetic scene-linear scene (sky, a sun at 8× white moving across it,
 * ground, a grey ramp and colour patches) is encoded to ARRI LogC4 / AWG4 as a 10-bit DPX "camera" sequence, then shown exactly
 * as the desktop viewer would: raw and through the Rec.709 (approx.) view,
 * for the source and for ACEScg EXR plates made from it with the plate
 * conversion. Five frames of each: 20 small JPEGs. Built with the domain's
 * own transforms (packages/domain must be built first).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSFERS, VIEW_LINEAR_MAX, colorTransform, cube1D, decodeCube, viewDisplayCurve, viewTransform } from '@vcvfx/domain';

const ffmpeg = process.argv[2] || 'ffmpeg';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'src', 'renderer', 'assets', 'sample-frames');
const work = mkdtempSync(join(tmpdir(), 'vcvfx-sample-'));
const W = 640;
const H = 360;
const FRAMES = 48;
const PICK = [0, 12, 24, 36, 47];

const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] });
const mixer = (m) => {
  const max = Math.max(...m.map(Math.abs));
  let s = 1;
  while (max / s > 2) s *= 2;
  const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  const f = [`colorchannelmixer=${names.map((n, i) => `${n}=${(m[i] / s).toFixed(10)}`).join(':')}`];
  for (let k = s; k > 1; k /= 2) f.push('colorchannelmixer=rr=2:gg=2:bb=2');
  return f;
};

// The "camera": a scene-linear Rec.709 scene — sky, a moving sun at 8× white,
// ground, a log grey ramp and colour patches — through AWG4 into LogC4, 10-bit DPX.
const toCamera = colorTransform('linear_rec709', 'arri_logc4_awg4');
const P = W * H;
const frames = [];
const patches = [[0.18, 0.18, 0.18], [0.41, 0.06, 0.04], [0.08, 0.26, 0.06], [0.04, 0.07, 0.32], [0.46, 0.3, 0.21], [0.62, 0.5, 0.06], [0.9, 0.9, 0.9], [0.03, 0.03, 0.03]];
for (let n = 0; n < FRAMES; n += 1) {
  const buf = new Float32Array(P * 3);
  const sunX = W * (0.18 + (0.6 * n) / (FRAMES - 1));
  const sunY = H * (0.3 - 0.08 * Math.sin((Math.PI * n) / (FRAMES - 1)));
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = y / H;
      let rgb;
      if (v < 0.58) {
        const t = v / 0.58;
        rgb = [0.12 + 0.5 * t, 0.2 + 0.38 * t, 0.42 + 0.12 * t];
        const d = Math.hypot(x - sunX, y - sunY);
        const glow = 1.6 * Math.exp(-d / 40);
        rgb = rgb.map((c, i) => c + glow * [1, 0.85, 0.6][i]);
        if (d < 18) rgb = [8, 7.4, 6.2];
      } else {
        const t = (v - 0.58) / 0.42;
        rgb = [0.09 - 0.05 * t, 0.075 - 0.045 * t, 0.06 - 0.04 * t];
        // Ripples on the ground, so frames differ.
        const ripple = 0.012 * Math.sin(x / 9 + n * 0.5 + 40 * t);
        rgb = rgb.map((c) => c + ripple);
      }
      // A log grey ramp, 12 stops (0.002 … 8), and a row of patches.
      if (v > 0.66 && v < 0.72) {
        const g = Math.pow(2, (x / W) * 12 - 9);
        rgb = [g, g, g];
      }
      if (v > 0.78 && v < 0.92) {
        const cell = Math.floor((x / W) * patches.length);
        const inX = (x / W) * patches.length - cell;
        if (inX > 0.08 && inX < 0.92) rgb = patches[cell];
      }
      const cam = toCamera.matrix;
      const lin = [0, 1, 2].map((r) => cam[r * 3] * rgb[0] + cam[r * 3 + 1] * rgb[1] + cam[r * 3 + 2] * rgb[2]);
      const code = lin.map((c) => TRANSFERS.logc4.fromLinear(c));
      // gbrpf32le planes: G, B, R.
      buf[y * W + x] = code[1];
      buf[P + y * W + x] = code[2];
      buf[2 * P + y * W + x] = code[0];
    }
  }
  frames.push(Buffer.from(buf.buffer));
}
mkdirSync(join(work, 'cam'));
execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${W}x${H}`, '-r', '24', '-i', '-', '-vf', 'zscale=filter=point,format=gbrp10le', '-c:v', 'dpx', '-pix_fmt', 'gbrp10le', '-start_number', '0', 'cam/A001C001_%07d.dpx'], { cwd: work, input: Buffer.concat(frames), maxBuffer: 1 << 30 });

// Plates: the plate conversion, LogC4 / AWG4 → ACEScg, half-float EXR.
const toPlates = colorTransform('arri_logc4_awg4', 'acescg');
writeFileSync(join(work, 'decode_logc4.cube'), decodeCube(toPlates));
mkdirSync(join(work, 'plates'));
run(['-framerate', '24', '-start_number', '0', '-i', 'cam/A001C001_%07d.dpx', '-vf', ['zscale=filter=point', 'format=gbrpf32le', 'lut1d=file=decode_logc4.cube:interp=linear', ...mixer(toPlates.matrix)].join(','), '-c:v', 'exr', '-pix_fmt', 'gbrpf32le', '-format', 'half', '-start_number', '1001', 'plates/S_plate_v001.%04d.exr']);

// The viewer's views.
writeFileSync(join(work, 'tone.cube'), cube1D(viewDisplayCurve, { size: 65536, domainMin: 0, domainMax: VIEW_LINEAR_MAX, title: 'view' }));
const viewFilters = (encoding, view) => {
  const v = viewTransform(encoding, view);
  const f = [];
  if (v.decode || v.matrix || v.tone) f.push('zscale=filter=point', 'format=gbrpf32le');
  if (v.decode) {
    writeFileSync(join(work, `view_${v.decode}.cube`), cube1D(TRANSFERS[v.decode].toLinear, { size: 4096, title: 'view decode' }));
    f.push(`lut1d=file=view_${v.decode}.cube:interp=linear`);
  }
  if (v.matrix) f.push(...mixer(v.matrix));
  if (v.tone) f.push('lut1d=file=tone.cube:interp=linear');
  return f;
};
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [layer, pattern, start, encoding] of [
  ['source', 'cam/A001C001_%07d.dpx', 0, 'arri_logc4_awg4'],
  ['plates', 'plates/S_plate_v001.%04d.exr', 1001, 'acescg'],
]) {
  for (const view of ['raw', 'rec709']) {
    PICK.forEach((k, i) => {
      run(['-f', 'image2', '-start_number', String(start + k), '-i', pattern, '-frames:v', '1', '-vf', [...viewFilters(encoding, view), 'format=yuvj444p'].join(','), '-c:v', 'mjpeg', '-q:v', '5', '-update', '1', join(out, `${layer}-${view}-${i + 1}.jpg`)]);
    });
  }
}
rmSync(work, { recursive: true, force: true });
console.log(readdirSync(out).length, 'frames in', out);
