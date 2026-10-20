/// <reference types="vite/client" />
import type { VcvfxApi } from '../shared/bridge';

declare global {
  /** Set by vite.preview.config.ts: the commit and time of a browser-preview build. */
  const __PREVIEW_BUILD__: string | undefined;
  interface Window {
    vcvfx: VcvfxApi;
  }
}
export {};
