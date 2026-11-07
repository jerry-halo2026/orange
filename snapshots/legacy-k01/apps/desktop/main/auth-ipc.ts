import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import { authChannels } from '../auth-contract.ts';
import { createDesktopAuth, readSupabaseConfig } from './auth.ts';

export function installAuthIpc(window: BrowserWindow, rendererPath: string) {
  const expected = pathToFileURL(rendererPath).href;
  const auth = createDesktopAuth(readSupabaseConfig(process.env));
  const allowed = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (event.sender !== window.webContents || !frame || frame !== window.webContents.mainFrame) return false;
    try {
      const url = new URL(frame.url);
      url.hash = '';
      return url.href === expected;
    } catch { return false; }
  };
  const check = (event: IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new Error('Authentication request rejected');
  };

  ipcMain.handle(authChannels.state, event => { check(event); return auth.getState(); });
  ipcMain.handle(authChannels.signIn, (event, value: unknown) => { check(event); return auth.signIn(value); });
  ipcMain.handle(authChannels.signOut, event => { check(event); return auth.signOut(); });
  window.once('closed', () => {
    for (const channel of Object.values(authChannels)) ipcMain.removeHandler(channel);
  });
}
