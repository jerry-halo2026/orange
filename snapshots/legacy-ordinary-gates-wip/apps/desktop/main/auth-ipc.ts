import { isTrustedShellUrl } from './shell-trust.ts';
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
      return isTrustedShellUrl(frame.url, expected);
    } catch { return false; }
  };
  const check = (event: IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new Error('Authentication request rejected');
  };

  ipcMain.handle(authChannels.state, (event, ...args: unknown[]) => { check(event); if (args.length) throw new Error('Authentication request rejected'); return auth.getState(); });
  ipcMain.handle(authChannels.signIn, (event, ...args: unknown[]) => { check(event); if (args.length !== 1) throw new Error('Authentication request rejected'); return auth.signIn(args[0]); });
  ipcMain.handle(authChannels.signOut, (event, ...args: unknown[]) => { check(event); if (args.length) throw new Error('Authentication request rejected'); return auth.signOut(); });
  window.once('closed', () => {
    for (const channel of Object.values(authChannels)) ipcMain.removeHandler(channel);
    auth.dispose();
  });
  return auth;
}
