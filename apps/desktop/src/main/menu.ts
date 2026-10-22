import { app, dialog, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { basename } from 'node:path';
import type { MenuCommand } from '../shared/bridge';
import { SITE_URL } from './config';
import { readSettings } from './settings';
import { checkForUpdatesInteractive } from './updater';

/**
 * The application menu. Commands that act on the open project are sent to
 * the renderer (`menu:command`), which owns the document; app-level ones
 * (About, website, updates) are handled here.
 */

export async function buildMenu(getWindow: () => BrowserWindow | null, isDevelopment: boolean): Promise<void> {
  const isMac = process.platform === 'darwin';
  const send = (command: MenuCommand) => () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('menu:command', command);
  };
  const about = () => {
    const window = getWindow();
    const options = {
      type: 'info' as const,
      message: 'VC VFX',
      detail: `Version ${app.getVersion()}\nVFX preparation and handoff for independent productions.\n${SITE_URL.replace(/^https?:\/\//, '')}\n\nIncludes FFmpeg (GNU LGPL v2.1), run as a separate program; its licence, source and build details are in the app's ffmpeg folder and at ${SITE_URL.replace(/^https?:\/\//, '')}/download.`,
    };
    void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  };
  const { recent } = await readSettings();

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'VC VFX',
            submenu: [
              { label: 'About VC VFX', click: about },
              { type: 'separator' },
              { label: 'Account…', click: send('account') },
              { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open VCDIT Handoff…', accelerator: 'CmdOrCtrl+O', click: send('open-handoff') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+Shift+O', click: send('open-project') },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map((path) => ({ label: basename(path), sublabel: path, click: send(`open-recent:${path}`) }))
            : [{ label: 'No recent projects', enabled: false }],
        },
        { label: 'Open Sample Project', click: send('open-sample') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Verify Sources…', click: send('verify') },
        { type: 'separator' },
        { label: 'Print Shot List…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { label: 'Export Shot List PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: send('export-pdf') },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: 'Account…', click: send('account') },
              { label: 'Settings…', accelerator: 'Ctrl+,', click: send('settings') },
              { type: 'separator' },
              { role: 'quit' },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // The module tabs (addendum 08). The renderer owns these keys, so the
        // browser preview has them too; the menu shows them without registering.
        ...(
          [
            ['Shots', 'show-shots', '1'],
            ['Plates', 'show-plates', '2'],
            ['Roto', 'show-roto', '3'],
            ['Key', 'show-key', '4'],
            ['Clean Plate', 'show-cleanplate', '5'],
            ['Sky & BG', 'show-isolate', '6'],
            ['Textures', 'show-texture', null],
            ['Comp', 'show-comp', '7'],
            ['Camera Track', 'show-camera', '8'],
            ['2D Track', 'show-track2d', '9'],
            ['Deliver', 'show-deliver', '0'],
          ] as const
          // Eleven tabs, ten digits: Textures (the least used) has none (renderer/modules.ts MODULE_DIGITS).
        ).map(([label, command, digit]) => ({ label, ...(digit ? { accelerator: `CmdOrCtrl+${digit}`, registerAccelerator: false } : {}), click: send(command) })),
        { type: 'separator' },
        { label: 'Previous Shot', accelerator: 'CmdOrCtrl+Up', registerAccelerator: false, click: send('previous-shot') },
        { label: 'Next Shot', accelerator: 'CmdOrCtrl+Down', registerAccelerator: false, click: send('next-shot') },
        { type: 'separator' },
        ...(isDevelopment ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] satisfies MenuItemConstructorOptions[]) : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Show the Tour', click: send('show-tour') },
        { type: 'separator' },
        { label: 'VC VFX Website', click: () => void shell.openExternal(SITE_URL) },
        { label: 'Check for Updates…', click: () => void checkForUpdatesInteractive(getWindow()) },
        ...(isMac ? [] : ([{ type: 'separator' }, { label: 'About VC VFX', click: about }] satisfies MenuItemConstructorOptions[])),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
