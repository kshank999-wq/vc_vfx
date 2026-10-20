import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { JobProgress, MenuCommand, VcvfxApi } from '../shared/bridge';

/**
 * The only bridge between the renderer and the operating system: one
 * explicit channel per method, no generic invoke. Main validates every
 * argument again.
 */

const api: VcvfxApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  openHandoffDialog: () => ipcRenderer.invoke('file:open-handoff'),
  openProjectDialog: () => ipcRenderer.invoke('file:open-project-dialog'),
  openProjectPath: (path) => ipcRenderer.invoke('file:open-project-path', path),
  saveProject: (input) => ipcRenderer.invoke('file:save-project', input),
  setDocumentState: (input) => ipcRenderer.invoke('window:document-state', input),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseOutputRoot: (input) => ipcRenderer.invoke('settings:choose-output-root', input),
  printShotList: (input) => ipcRenderer.invoke('print:shot-list', input),
  verifySources: (input) => ipcRenderer.invoke('job:verify', input),
  packageShot: (input) => ipcRenderer.invoke('job:package', input),
  detectFfmpeg: () => ipcRenderer.invoke('ffmpeg:detect'),
  generateSequence: (input) => ipcRenderer.invoke('job:sequence', input),
  probeSources: (input) => ipcRenderer.invoke('job:probe', input),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  onProgress: (listener) => {
    const wrapped = (_event: IpcRendererEvent, progress: JobProgress) => listener(progress);
    ipcRenderer.on('job:progress', wrapped);
    return () => ipcRenderer.removeListener('job:progress', wrapped);
  },
  revealPath: (path) => ipcRenderer.invoke('shell:reveal', path),
  accountStatus: () => ipcRenderer.invoke('account:status'),
  requestSignInCode: (email) => ipcRenderer.invoke('account:request-code', email),
  verifySignInCode: (email, code) => ipcRenderer.invoke('account:verify-code', { email, code }),
  signOut: () => ipcRenderer.invoke('account:sign-out'),
  licenceStanding: (recheck) => ipcRenderer.invoke('licence:standing', recheck),
  activateLicence: () => ipcRenderer.invoke('licence:activate'),
  openExternal: (link) => ipcRenderer.invoke('shell:open-external', link),
  onMenu: (listener) => {
    const wrapped = (_event: IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on('menu:command', wrapped);
    return () => ipcRenderer.removeListener('menu:command', wrapped);
  },
};

contextBridge.exposeInMainWorld('vcvfx', api);
