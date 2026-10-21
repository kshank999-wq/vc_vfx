import { it } from 'vitest';
import { greenScreenScene } from '../key/synthetic';
import { detectShotScreen, shotScreenModel, ShotKeyer } from '../key/engine';
import { pullPush } from '../key/cleanplate';
import { regions, sceneIO, settingsFor, LUMA_AP1 } from './key-helpers';

it('probe', async () => {
  const scene = greenScreenScene({ kind: 'green', frames: 12, spill: Number(process.env.SPILL ?? 1) });
  const io = sceneIO(scene);
  const det = await detectShotScreen(io, [0, 4, 8], null);
  const s = settingsFor('green', det.rgb);
  const model = await shotScreenModel(io, s, 0, 11);
  const keyer = new ShotKeyer(s, model);
  const f = 2;
  const img = await io.frame(f);
  const out = await keyer.keyAt(io, f, img, { pxScale: 1, luma: LUMA_AP1, foreground: true });
  const truth = scene.alpha(f);
  const fgT = scene.foreground(f);
  const S = scene.screen(f);
  const w = scene.width, h = scene.height;
  const r = regions(truth, w, h);
  // estimated F from core
  const weights = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) weights[i] = out.core[i] ? 1 : 0;
  const Fh = pullPush(img.data, weights, w, h, 3);
  const unmix = (F: (i: number) => number[], Sx: (i: number) => number[]) => (i: number) => {
    const Fi = F(i), Si = Sx(i), P = [img.data[3 * i]!, img.data[3 * i + 1]!, img.data[3 * i + 2]!];
    const d = [Fi[0]! - Si[0]!, Fi[1]! - Si[1]!, Fi[2]! - Si[2]!];
    const dd = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
    return Math.min(1, Math.max(0, ((P[0]! - Si[0]!) * d[0]! + (P[1]! - Si[1]!) * d[1]! + (P[2]! - Si[2]!) * d[2]!) / dd));
  };
  const trueF = (i: number) => { const a = Math.max(1e-6, truth[i]!); return [fgT[3 * i]! / a, fgT[3 * i + 1]! / a, fgT[3 * i + 2]! / a]; };
  const hatF = (i: number) => [Fh[3 * i]!, Fh[3 * i + 1]!, Fh[3 * i + 2]!];
  const trueS = (i: number) => [S[3 * i]!, S[3 * i + 1]!, S[3 * i + 2]!];
  const modelS = (i: number) => [out.screen[3 * i]!, out.screen[3 * i + 1]!, out.screen[3 * i + 2]!];
  const groups: Record<string, number[]> = { hair: [], arm: [], body: [] };
  const cx = w * (0.42 + 0.1 * Math.sin(2 * Math.PI * f / 12));
  for (const i of r.edge) { const x = i % w, y = (i - x) / w; if (y < h * 0.14 + 34 * h / 270) groups.hair!.push(i); else if (x > cx + 30 * h / 270) groups.arm!.push(i); else groups.body!.push(i); }
  const mae = (idx: number[], fn: (i: number) => number) => (idx.reduce((s2, i) => s2 + Math.abs(fn(i) - truth[i]!), 0) / Math.max(1, idx.length)).toFixed(3);
  for (const [g, idx] of Object.entries(groups)) {
    console.log(g, idx.length, 'final', mae(idx, (i) => out.alpha[i]!), 'raw', mae(idx, (i) => Math.min(1, Math.max(0, out.raw[i]!))), 'unmix trueF trueS', mae(idx, unmix(trueF, trueS)), 'unmix trueF modelS', mae(idx, unmix(trueF, modelS)), 'unmix hatF modelS', mae(idx, unmix(hatF, modelS)));
  }
  // model vs true screen error
  let e = 0; for (let i = 0; i < w * h; i++) e += Math.abs(out.screen[3 * i + 1]! - S[3 * i + 1]!) / S[3 * i + 1]!;
  console.log('screen model rel err G', (e / (w * h)).toFixed(4));
}, 60000);
