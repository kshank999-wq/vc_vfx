import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    // Node by default; renderer tests opt into jsdom with a docblock.
    environment: 'node',
    // Real-media tests (ffmpeg) share the machine with the solver tests; 5 s is too tight under that load.
    testTimeout: 20_000,
  },
});
