import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The browser preview (docs/deployment.md, "Browser preview"): the renderer
 * built by plain Vite, with no Electron anywhere in the process, so the
 * website's build can produce it. `src/renderer/preview.tsx` installs the
 * browser bridge where the preload would have put `window.vcvfx`. Output goes
 * to out/preview; apps/web/scripts/build-preview.mjs copies it into the site.
 */
const buildLabel = (): string => {
  const sha = process.env['VERCEL_GIT_COMMIT_SHA'] ?? process.env['GITHUB_SHA'];
  const short = sha
    ? sha.slice(0, 7)
    : (() => {
        try {
          return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        } catch {
          return 'local';
        }
      })();
  return `${short} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // Served at vc-vfx.com/preview. Absolute asset paths, so the page works at
  // the bare path, which is the one Next serves (it strips a trailing slash).
  base: '/preview/',
  plugins: [react()],
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer'), '@shared': resolve(__dirname, 'src/shared') },
  },
  define: { __PREVIEW_BUILD__: JSON.stringify(buildLabel()) },
  build: {
    outDir: resolve(__dirname, 'out/preview'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/preview.html') } },
  },
});
