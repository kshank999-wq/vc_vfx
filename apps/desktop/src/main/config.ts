/** Build-time configuration, baked in by electron.vite.config.ts. */
/** "offline" at build time switches sign-in off (electron.vite.config.ts). */
const unlessOffline = (value: string | undefined): string => (value && value !== 'offline' ? value : '');
export const SUPABASE_URL = unlessOffline(process.env['MAIN_VITE_SUPABASE_URL']);
export const SUPABASE_ANON_KEY = unlessOffline(process.env['MAIN_VITE_SUPABASE_ANON_KEY']);
export const SITE_URL = (process.env['MAIN_VITE_SITE_URL'] || 'https://vc-vfx.com').replace(/\/+$/, '');
export const isCloudConfigured = (): boolean => SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
