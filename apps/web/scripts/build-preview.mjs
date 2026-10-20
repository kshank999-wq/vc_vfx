/**
 * Build the desktop renderer for the browser and put it under public/preview,
 * so the site serves it at /preview (docs/deployment.md, "Browser preview").
 *
 * Runs as part of `build`, after the domain is compiled and before
 * `next build`. It fails loudly: a site without the preview is still a site,
 * but a preview that silently went stale would defeat its purpose, so a
 * failed renderer build fails the deployment.
 *
 * It runs through pnpm's filter from the workspace root rather than from the
 * desktop folder, so it uses the desktop package's own Vite and React plugin
 * (devDependencies the workspace install links for every package).
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const web = resolve(import.meta.dirname, '..');
const root = resolve(web, '..', '..');
const built = resolve(root, 'apps', 'desktop', 'out', 'preview');
const target = resolve(web, 'public', 'preview');

execSync('pnpm --filter @vcvfx/desktop build:preview', { cwd: root, stdio: 'inherit' });

if (!existsSync(resolve(built, 'preview.html'))) {
  throw new Error(`Preview build produced no preview.html in ${built}`);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(built, target, { recursive: true });
// The page is the directory's index; Vite named it after its source file.
renameSync(resolve(target, 'preview.html'), resolve(target, 'index.html'));
console.log(`Browser preview copied to ${target}`);
