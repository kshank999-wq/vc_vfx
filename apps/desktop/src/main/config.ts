/** Build-time configuration, baked in by electron.vite.config.ts. */
export const SUPABASE_URL = process.env['MAIN_VITE_SUPABASE_URL'] ?? '';
export const SUPABASE_ANON_KEY = process.env['MAIN_VITE_SUPABASE_ANON_KEY'] ?? '';
export const SITE_URL = (process.env['MAIN_VITE_SITE_URL'] || 'https://vc-vfx.com').replace(/\/+$/, '');
export const isCloudConfigured = (): boolean => SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
