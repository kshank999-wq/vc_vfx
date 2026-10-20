/**
 * Fetch the ffmpeg and ffprobe that ship inside the installer (addendum 03,
 * addendum 05).
 *
 *   node scripts/fetch-ffmpeg.mjs darwin-arm64 darwin-x64   # before electron-builder --mac
 *   node scripts/fetch-ffmpeg.mjs win32-x64                 # before electron-builder --win
 *   node scripts/fetch-ffmpeg.mjs                           # this machine only (development)
 *
 * Shipped targets get the LGPL builds this repository makes itself
 * (scripts/build-ffmpeg-lgpl.sh, run by .github/workflows/ffmpeg-lgpl.yml and
 * published as a GitHub release here). VC VFX is proprietary, so it must not
 * ship a GPL ffmpeg. Each file is pinned by the SHA-256 of the file as
 * installed (binaries decompressed), so an installer can only ever contain
 * exactly those bytes; until the release's SHA256SUMS are copied into
 * LGPL_PINNED, packaging refuses rather than guess.
 *
 * linux-x64 is for development and CI only (VC VFX does not ship for Linux).
 * It uses the LGPL build too once pinned, and until then the GPL static build
 * from ffmpeg-static b6.1.1 — fine for running tests, never shipped.
 *
 * Files land in resources/ffmpeg/<platform>-<arch>/, which electron-builder.yml
 * copies to the app's Resources/ffmpeg for the arch it is building.
 *
 * Mirror: set FFMPEG_BINARIES_URL to a folder with the same file names.
 * Already-present files with the right hash are kept.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** The release the ffmpeg-lgpl workflow published. */
export const LGPL_RELEASE = 'ffmpeg-lgpl-n7.1-1';
const LGPL_BASE = `https://github.com/kshank999-wq/vc_vfx/releases/download/${LGPL_RELEASE}`;

/**
 * SHA-256 of each LGPL file as installed, from the release's SHA256SUMS.
 * null until the workflow has run and the sums are copied here.
 */
export const LGPL_PINNED = {
  'darwin-arm64': null,
  'darwin-x64': null,
  'win32-x64': null,
  'linux-x64': null,
};

/** Development/CI only: GPL static build, never packaged. */
const DEV_GPL_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const DEV_GPL_PINNED = {
  'linux-x64': {
    ffmpeg: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
    ffprobe: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d',
    LICENSE: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    README: '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537',
  },
};

/** Where a target's files come from and what they must hash to. */
function sourceFor(target) {
  const mirror = process.env.FFMPEG_BINARIES_URL?.replace(/\/+$/, '');
  const lgpl = LGPL_PINNED[target];
  if (lgpl) return { base: mirror || LGPL_BASE, pins: lgpl, licence: 'LGPL' };
  if (DEV_GPL_PINNED[target]) return { base: mirror || DEV_GPL_BASE, pins: DEV_GPL_PINNED[target], licence: 'GPL (development only)' };
  if (target in LGPL_PINNED) {
    throw new Error(
      `No pinned LGPL ffmpeg for ${target} yet. Run the "Build LGPL ffmpeg" workflow (tag ${LGPL_RELEASE}), ` +
        'then copy the release SHA256SUMS into LGPL_PINNED in scripts/fetch-ffmpeg.mjs.',
    );
  }
  throw new Error(`Unknown target ${target}. Known: ${Object.keys(LGPL_PINNED).join(', ')}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'ffmpeg');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** curl is on every CI image (Windows included) and honours HTTPS_PROXY. */
function download(url) {
  return execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--max-time', '600', url], { maxBuffer: 512 * 1024 * 1024 });
}

function fetchTarget(target) {
  const { base: BASE, pins, licence } = sourceFor(target);
  console.log(`${target}: ${licence} ffmpeg from ${BASE}`);
  const dir = join(root, target);
  mkdirSync(dir, { recursive: true });
  const exe = target.startsWith('win32') ? '.exe' : '';
  const files = [
    { name: `ffmpeg${exe}`, url: `${BASE}/ffmpeg-${target}.gz`, pin: pins.ffmpeg, gz: true, mode: 0o755 },
    { name: `ffprobe${exe}`, url: `${BASE}/ffprobe-${target}.gz`, pin: pins.ffprobe, gz: true, mode: 0o755 },
    { name: 'LICENSE.txt', url: `${BASE}/${target}.LICENSE`, pin: pins.LICENSE, gz: false, mode: 0o644 },
    { name: 'README.txt', url: `${BASE}/${target}.README`, pin: pins.README, gz: false, mode: 0o644 },
  ];
  for (const f of files) {
    const path = join(dir, f.name);
    if (existsSync(path) && sha256(readFileSync(path)) === f.pin) {
      chmodSync(path, f.mode);
      console.log(`${target}/${f.name}: present`);
      continue;
    }
    const raw = download(f.url);
    const body = f.gz ? gunzipSync(raw) : raw;
    const got = sha256(body);
    if (got !== f.pin) throw new Error(`${f.url}: SHA-256 ${got} is not the pinned ${f.pin}. Nothing was written.`);
    const tmp = `${path}.part`;
    writeFileSync(tmp, body, { mode: f.mode });
    rmSync(path, { force: true });
    renameSync(tmp, path);
    chmodSync(path, f.mode);
    console.log(`${target}/${f.name}: ${(body.length / 1e6).toFixed(1)} MB, verified`);
  }
}

const targets = process.argv.slice(2);
for (const target of targets.length ? targets : [`${process.platform}-${process.arch}`]) fetchTarget(target);
