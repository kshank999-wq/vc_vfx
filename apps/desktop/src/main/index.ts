import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_EXTENSION } from '@vcvfx/domain';
import { restoreSession } from './cloud';
import { registerIpcHandlers } from './ipc';
import { startStandingRefresh } from './license';
import { buildMenu } from './menu';
import { FRAME_SCHEME, FrameCache, resolveFrameUrl } from './frame-cache';

// The viewer's frames come from the frame cache through this scheme, never
// file:// (addendum 03). Privileged: treated as secure and standard, so the
// renderer's CSP can name it in img-src. Must be registered before ready.
protocol.registerSchemesAsPrivileged([{ scheme: FRAME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/**
 * Electron main process. Windows and macOS run the same shell; only window
 * chrome and lifecycle conventions differ.
 */

let mainWindow: BrowserWindow | null = null;
const isDevelopment = !app.isPackaged;

/** A `.vcvfx` the OS asked us to open before the renderer was ready. */
let pendingOpen: string | null = process.argv.find((a) => a.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`)) ?? null;

const openInRenderer = (path: string) => {
  if (mainWindow && !mainWindow.webContents.isLoading()) mainWindow.webContents.send('menu:command', `open-recent:${path}`);
  else pendingOpen = path;
};

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'VC VFX',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer is untrusted: no Node, isolated context, OS sandbox on.
      // The preload needs only contextBridge and ipcRenderer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpen) {
      mainWindow?.webContents.send('menu:command', `open-recent:${pendingOpen}`);
      pendingOpen = null;
    }
  });
  // External links open in the browser, never inside the app window; the app
  // window never navigates away from its own bundle.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDevelopment && devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const file = argv.find((a) => a.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`));
    if (file) openInRenderer(file);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS: double-clicking a .vcvfx in Finder.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    openInRenderer(path);
  });

  app.setAboutPanelOptions({ applicationName: 'VC VFX', applicationVersion: app.getVersion(), website: 'https://vc-vfx.com' });

  void app.whenReady().then(async () => {
    const frameCache = new FrameCache({ dir: join(app.getPath('userData'), 'Frame Cache') });
    protocol.handle(FRAME_SCHEME, async (request) => {
      const file = resolveFrameUrl(request.url, frameCache.dir);
      if (!file) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
      if (!response || !response.ok) return new Response('Not found', { status: 404 });
      return new Response(response.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
    });
    registerIpcHandlers(() => mainWindow, isDevelopment, frameCache);
    await buildMenu(() => mainWindow, isDevelopment);
    createWindow();
    // Restoring a stored session must not delay the window.
    void restoreSession()
      .catch(() => undefined)
      .finally(() => startStandingRefresh());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
