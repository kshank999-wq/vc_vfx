import type { LicenceStanding, Settings, VcvfxApi } from '../../shared/bridge';

/** An in-memory `window.vcvfx` for renderer tests. */
export function stubBridge(overrides: Partial<VcvfxApi> = {}, standing: LicenceStanding | null = { status: 'active', expiresAt: null, checkedAt: new Date().toISOString() }): VcvfxApi {
  let settings: Settings = { operatorName: 'Prep Artist', ffmpegPath: '', outputRoots: {}, recent: [] };
  const noop = () => () => undefined;
  return {
    appInfo: async () => ({ version: '0.1.0', siteUrl: 'https://vc-vfx.com', cloudConfigured: false, platform: 'darwin' }),
    openHandoffDialog: async () => ({ ok: true, data: null }),
    openProjectDialog: async () => ({ ok: true, data: null }),
    openProjectPath: async () => ({ ok: false, error: 'none' }),
    saveProject: async () => ({ ok: true, data: null }),
    setDocumentState: async () => undefined,
    getSettings: async () => settings,
    setSettings: async (patch) => (settings = { ...settings, ...patch }),
    chooseOutputRoot: async () => ({ ok: true, data: null }),
    printShotList: async () => ({ ok: true, data: { path: null } }),
    verifySources: async () => ({ ok: true, data: [] }),
    packageShot: async () => ({ ok: false, error: 'not in tests' }),
    detectFfmpeg: async () => ({ found: false, path: null, version: null }),
    generateSequence: async () => ({ ok: false, error: 'not in tests' }),
    cancelJob: async () => undefined,
    onProgress: noop,
    revealPath: async () => undefined,
    accountStatus: async () => ({ configured: false, signedIn: false, email: null, displayName: null }),
    requestSignInCode: async () => ({ ok: true, data: null }),
    verifySignInCode: async () => ({ ok: false, error: 'offline' }),
    signOut: async () => undefined,
    licenceStanding: async () => standing,
    activateLicence: async () => ({ ok: false, error: 'offline' }),
    openExternal: async () => undefined,
    onMenu: noop,
    ...overrides,
  };
}
