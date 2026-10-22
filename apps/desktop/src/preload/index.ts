import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AiRunEvent, JobProgress, MenuCommand, VcvfxApi } from '../shared/bridge';

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
  viewerSources: (input) => ipcRenderer.invoke('viewer:sources', input),
  viewerFrame: (input) => ipcRenderer.invoke('viewer:frame', input),
  rotoSession: (input) => ipcRenderer.invoke('roto:session', input),
  rotoFrame: (input) => ipcRenderer.invoke('roto:frame', input),
  rotoRun: (input) => ipcRenderer.invoke('job:roto-run', input),
  rotoMask: (input) => ipcRenderer.invoke('roto:mask', input),
  rotoExport: (input) => ipcRenderer.invoke('job:roto-export', input),
  rotoModel: (input) => ipcRenderer.invoke('job:roto-model', input),
  keySession: (input) => ipcRenderer.invoke('key:session', input),
  keyDetect: (input) => ipcRenderer.invoke('job:key-detect', input),
  keyFrame: (input) => ipcRenderer.invoke('key:frame', input),
  keySample: (input) => ipcRenderer.invoke('key:sample', input),
  keyProcess: (input) => ipcRenderer.invoke('job:key-process', input),
  keyMatch: (input) => ipcRenderer.invoke('key:match', input),
  keySeedRoto: (input) => ipcRenderer.invoke('key:seed-roto', input),
  keyExport: (input) => ipcRenderer.invoke('job:key-export', input),
  keyChooseBackground: () => ipcRenderer.invoke('key:choose-background'),
  cleanPlateSession: (input) => ipcRenderer.invoke('cleanplate:session', input),
  cleanPlateFrame: (input) => ipcRenderer.invoke('cleanplate:frame', input),
  cleanPlateBuild: (input) => ipcRenderer.invoke('job:cleanplate-build', input),
  cleanPlateExport: (input) => ipcRenderer.invoke('job:cleanplate-export', input),
  isolateSession: (input) => ipcRenderer.invoke('isolate:session', input),
  isolateFrame: (input) => ipcRenderer.invoke('isolate:frame', input),
  isolateBuild: (input) => ipcRenderer.invoke('job:isolate-build', input),
  isolateExport: (input) => ipcRenderer.invoke('job:isolate-export', input),
  textureSession: (input) => ipcRenderer.invoke('texture:session', input),
  textureChoose: (input) => ipcRenderer.invoke('texture:choose', input),
  textureIngest: (input) => ipcRenderer.invoke('job:texture-ingest', input),
  textureImage: (input) => ipcRenderer.invoke('texture:image', input),
  textureScan: (input) => ipcRenderer.invoke('texture:scan', input),
  textureBuild: (input) => ipcRenderer.invoke('job:texture-build', input),
  textureExport: (input) => ipcRenderer.invoke('job:texture-export', input),
  compSession: (input) => ipcRenderer.invoke('comp:session', input),
  compFrame: (input) => ipcRenderer.invoke('comp:frame', input),
  compRender: (input) => ipcRenderer.invoke('job:comp-render', input),
  compExport: (input) => ipcRenderer.invoke('job:comp-export', input),
  lightingSession: (input) => ipcRenderer.invoke('lighting:session', input),
  lightingChoose: (input) => ipcRenderer.invoke('lighting:choose', input),
  lightingIngest: (input) => ipcRenderer.invoke('job:lighting-ingest', input),
  lightingFrame: (input) => ipcRenderer.invoke('lighting:frame', input),
  lightingImage: (input) => ipcRenderer.invoke('lighting:image', input),
  lightingAnalyse: (input) => ipcRenderer.invoke('job:lighting-analyse', input),
  lightingExport: (input) => ipcRenderer.invoke('job:lighting-export', input),
  lightingAiReview: (input) => ipcRenderer.invoke('job:lighting-ai-review', input),
  trackSession: (input) => ipcRenderer.invoke('track:session', input),
  trackFrame: (input) => ipcRenderer.invoke('track:frame', input),
  trackView: (input) => ipcRenderer.invoke('track:view', input),
  trackCommand: (input) => ipcRenderer.invoke('job:track-command', input),
  chooseLidarFile: () => ipcRenderer.invoke('track:choose-lidar'),
  saveCalibrationTarget: (input) => ipcRenderer.invoke('track:calibration-target', input),
  aiTrackRun: (input) => ipcRenderer.invoke('ai:track-run', input),
  aiTrackAck: (ack) => ipcRenderer.invoke('ai:track-ack', ack),
  aiTrackCancel: (runId) => ipcRenderer.invoke('ai:track-cancel', runId),
  onAiEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, e: AiRunEvent) => listener(e);
    ipcRenderer.on('ai:event', wrapped);
    return () => ipcRenderer.removeListener('ai:event', wrapped);
  },
  aiAllowance: () => ipcRenderer.invoke('ai:allowance'),
  aiFrames: (input) => ipcRenderer.invoke('ai:frames', input),
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
  signInWithPassword: (email, password) => ipcRenderer.invoke('account:sign-in-password', { email, password }),
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
