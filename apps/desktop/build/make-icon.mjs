// Placeholder app icons for VC VFX: a dark rounded tile with an amber "VFX"
// wordmark, rendered from SVG at 1024px with Playwright's Chromium.
//
//   NODE_PATH=$(npm root -g) node build/make-icon.mjs
//
// icon.png is square-filled (Windows draws icons square); icon-mac.png sits
// the tile inside transparent margins the way macOS Dock icons expect.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));

const svg = (inset, radius) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2029"/><stop offset="1" stop-color="#0f1115"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${1024 - inset * 2}" height="${1024 - inset * 2}" rx="${radius}" fill="url(#bg)"/>
  <rect x="${inset + 6}" y="${inset + 6}" width="${1024 - inset * 2 - 12}" height="${1024 - inset * 2 - 12}" rx="${radius - 6}" fill="none" stroke="#2b303b" stroke-width="6"/>
  <text x="512" y="590" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="${inset ? 270 : 320}" letter-spacing="8" fill="#f2a33a">VFX</text>
  <rect x="${inset ? 300 : 262}" y="660" width="${inset ? 424 : 500}" height="16" rx="8" fill="#f2a33a" opacity="0.55"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
for (const [name, inset, radius] of [
  ['icon.png', 0, 200],
  ['icon-mac.png', 100, 185],
]) {
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(inset, radius)}</body></html>`);
  await page.locator('svg').screenshot({ path: join(here, name), omitBackground: true });
}
await browser.close();
console.log('wrote icon.png and icon-mac.png');
