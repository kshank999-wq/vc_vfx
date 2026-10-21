import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The live vc-vfx.com Supabase project. Both values are public by design
// (the anon key only reaches what row-level security allows), so a build
// with no MAIN_VITE_* overrides — CI included — can sign in and activate.
// Set MAIN_VITE_SUPABASE_URL / MAIN_VITE_SUPABASE_ANON_KEY to point a build
// elsewhere; set them to "offline" to build with sign-in switched off.
const VCVFX_SUPABASE_URL = 'https://qfwnrfdsdxtolwbzruep.supabase.co';
const VCVFX_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmd25yZmRzZHh0b2x3YnpydWVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NDMxNTUsImV4cCI6MjEwODAxOTE1NX0.wivZ0KvVNe7ixfWhx4FImNlVf3yHeCXT7td-Y3Gj8lA';

export default defineConfig(({ mode }) => {
  // Supabase's URL and anon key are public values, but they are baked in at
  // build time rather than read from the machine the app runs on. A build
  // without them is a complete offline application in read-only licence mode:
  // it opens, browses, verifies and prints, and sign-in explains why it is off.
  const env = loadEnv(mode, __dirname, 'MAIN_VITE_');
  const buildEnv = {
    'process.env.MAIN_VITE_SUPABASE_URL': JSON.stringify(env['MAIN_VITE_SUPABASE_URL'] || VCVFX_SUPABASE_URL),
    'process.env.MAIN_VITE_SUPABASE_ANON_KEY': JSON.stringify(env['MAIN_VITE_SUPABASE_ANON_KEY'] || VCVFX_SUPABASE_ANON_KEY),
    'process.env.MAIN_VITE_SITE_URL': JSON.stringify(env['MAIN_VITE_SITE_URL'] || 'https://vc-vfx.com'),
  };

  return {
    main: {
      // The domain is bundled into main (it is ESM and pure); everything else
      // in node_modules is loaded at runtime.
      plugins: [externalizeDepsPlugin({ exclude: ['@vcvfx/domain'] })],
      define: buildEnv,
      build: {
        // The roto worker thread is its own entry (out/main/roto-worker.js; addendum 04).
        // The camera-tracking worker likewise (out/main/camera-worker.js; addendum 06).
        rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), 'roto-worker': resolve(__dirname, 'src/main/roto/worker.ts'), 'camera-worker': resolve(__dirname, 'src/main/camera/worker.ts') } },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react()],
      resolve: {
        alias: { '@renderer': resolve(__dirname, 'src/renderer'), '@shared': resolve(__dirname, 'src/shared') },
      },
      build: {
        rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
      },
    },
  };
});
