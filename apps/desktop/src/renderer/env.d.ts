/// <reference types="vite/client" />
import type { VcvfxApi } from '../shared/bridge';

declare global {
  interface Window {
    vcvfx: VcvfxApi;
  }
}
export {};
