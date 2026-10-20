import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SyntheticScene } from '../../shared/roto/synthetic';

/** The roto worker, bundled once per test run (the app gets it from electron-vite as out/main/roto-worker.js). */
let built: Promise<string> | null = null;
export function workerBundle(): Promise<string> {
  built ??= (async () => {
    const { build } = await import('vite');
    const out = await mkdtemp(join(tmpdir(), 'vcvfx-worker-'));
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      build: {
        ssr: resolve(__dirname, '../roto/worker.ts'),
        outDir: out,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { output: { format: 'cjs', entryFileNames: 'roto-worker.js' } },
      },
    });
    return join(out, 'roto-worker.js');
  })();
  return built;
}

/** Encode a synthetic scene as a clip with ffmpeg (ProRes 4444, as VCDIT hands it over). */
export function encodeScene(ffmpeg: string, scene: SyntheticScene, file: string, frames = scene.frames): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${scene.width}x${scene.height}`, '-r', '24', '-i', 'pipe:0', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuv444p10le', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(err))));
    for (let n = 0; n < frames; n += 1) child.stdin.write(Buffer.from(scene.render(n).data));
    child.stdin.end();
  });
}
