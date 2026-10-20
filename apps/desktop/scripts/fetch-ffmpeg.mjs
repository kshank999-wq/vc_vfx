/**
 * Fetch the ffmpeg and ffprobe that ship inside the installer (addendum 03).
 *
 *   node scripts/fetch-ffmpeg.mjs darwin-arm64 darwin-x64   # before electron-builder --mac
 *   node scripts/fetch-ffmpeg.mjs win32-x64                 # before electron-builder --win
 *   node scripts/fetch-ffmpeg.mjs                           # this machine only (development)
 *
 * The binaries are the static builds the `ffmpeg-static` npm package installs
 * (release b6.1.1 of github.com/eugeneware/ffmpeg-static: macOS builds from
 * osxexperts.net, Windows from gyan.dev, Linux from johnvansickle.com), pinned
 * here by SHA-256 of the decompressed file, so an installer can only ever
 * contain exactly these bytes. They land in resources/ffmpeg/<platform>-<arch>/,
 * which electron-builder.yml copies to the app's Resources/ffmpeg for the arch
 * it is building — both macOS arches from one job, which per-platform npm
 * packages cannot do (pnpm installs only the host's).
 *
 * Why not an npm dependency: the only per-platform npm packages with the
 * binary in the tarball (@ffmpeg-installer/*) carry a 2018 ffmpeg 4.1 with no
 * EXR encoder; and a dependency would put ~250 MB into every workspace
 * install, including the website's.
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

const RELEASE = 'b6.1.1';
const BASE = (process.env.FFMPEG_BINARIES_URL || `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`).replace(/\/+$/, '');

/** SHA-256 of each file as installed (binaries decompressed). */
export const PINNED = {
  'darwin-arm64': {
    ffmpeg: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
    ffprobe: 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64',
    LICENSE: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2',
    README: '05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a',
  },
  'darwin-x64': {
    ffmpeg: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
    ffprobe: 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0',
    LICENSE: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
    README: 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36',
  },
  'win32-x64': {
    ffmpeg: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    ffprobe: '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4',
    LICENSE: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    README: 'a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311',
  },
  // Development and CI on Linux only; VC VFX does not ship for Linux.
  'linux-x64': {
    ffmpeg: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
    ffprobe: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d',
    LICENSE: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    README: '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537',
  },
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'ffmpeg');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** curl is on every CI image (Windows included) and honours HTTPS_PROXY. */
function download(url) {
  return execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--max-time', '600', url], { maxBuffer: 512 * 1024 * 1024 });
}

function fetchTarget(target) {
  const pins = PINNED[target];
  if (!pins) throw new Error(`No pinned ffmpeg for ${target}. Known: ${Object.keys(PINNED).join(', ')}`);
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
