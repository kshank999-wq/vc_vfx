/**
 * onnxruntime-node for the SAM 2 roto engine (addendum 04).
 *
 *   node scripts/fetch-onnxruntime.mjs [platform-arch …]
 *
 * Downloads onnxruntime-node and onnxruntime-common at a pinned version from
 * the npm registry, checks each tarball against its pinned SHA-512 (the
 * registry's own `dist.integrity`), and unpacks them into
 * resources/onnxruntime/node_modules/, keeping only the native binaries for
 * the platforms asked for (default: this machine's). Nothing is committed;
 * electron-builder copies resources/onnxruntime beside app.asar
 * (electron-builder.yml), where main/roto/sam2-ort.ts loads it.
 *
 * It is not a workspace dependency on purpose: its package holds binaries for
 * every platform (~190 MB), which every `pnpm install` — the website's on
 * Vercel included — would otherwise download. Install scripts are not run
 * (they only fetch optional CUDA libraries for Linux).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.20.1';
const PACKAGES = {
  'onnxruntime-node': 'sha512-di/I4HDXRw+FLgq+TyHmQEDd3cEp9iFFZm0r4uJ1Wd7b/WE1VXtKWo8yemex347c6GNF/3Pv86ZfPhIWxORr0w==',
  'onnxruntime-common': 'sha512-YiU0s0IzYYC+gWvqD1HzLc46Du1sXpSiwzKb63PACIJr6LfL27VsXSXQvt68EzD3V0D5Bc0vyJTjmMxp0ylQiw==',
};
const registry = (process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'resources', 'onnxruntime', 'node_modules');
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [`${process.platform}-${process.arch}`];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const work = join(tmpdir(), `vcvfx-ort-${process.pid}`);
mkdirSync(work, { recursive: true });

for (const [name, integrity] of Object.entries(PACKAGES)) {
  const url = `${registry}/${name}/-/${name}-${VERSION}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (got !== integrity) throw new Error(`${name}@${VERSION} does not match its pinned SHA-512 (got ${got})`);
  const tgz = join(work, `${name}.tgz`);
  writeFileSync(tgz, bytes);
  const dest = join(out, name);
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);
  console.log(`${name}@${VERSION}: ${(bytes.length / 1e6).toFixed(1)} MB, integrity ok`);
}

// Keep only the binaries for the targets asked for (and never the CUDA/TensorRT providers).
const bin = join(out, 'onnxruntime-node', 'bin', 'napi-v3');
for (const platform of readdirSync(bin)) {
  for (const arch of readdirSync(join(bin, platform))) {
    const dir = join(bin, platform, arch);
    if (!targets.includes(`${platform}-${arch}`)) rmSync(dir, { recursive: true, force: true });
    else for (const f of readdirSync(dir)) if (/providers_(cuda|tensorrt)/.test(f)) rmSync(join(dir, f), { force: true });
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`onnxruntime-node ${VERSION} for ${targets.join(', ')} in ${out}`);
