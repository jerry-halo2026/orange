import { isTrustedShellUrl } from './shell-trust.ts';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import { studioChannels, isStudioInvocationArgs, isStudioState, type StudioState } from '../studio-contract.ts';
import type { createStudioController } from './studio-host.ts';

export function installStudioIpc(window: BrowserWindow, rendererPath: string, controller: ReturnType<typeof createStudioController>) {
  const expected = pathToFileURL(rendererPath).href;
  const failed = (): StudioState => ({ kind: 'closed', error: 'failed' });
  const allowed = (event: IpcMainInvokeEvent, args: unknown[]) => !window.isDestroyed() &&
    event.sender === window.webContents && !!event.senderFrame &&
    event.senderFrame === window.webContents.mainFrame && isTrustedShellUrl(event.senderFrame.url, expected) && isStudioInvocationArgs(args);
  for (const [channel, method] of [
    [studioChannels.state, 'getState'], [studioChannels.open, 'open'], [studioChannels.close, 'close'],
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<StudioState> => {
      if (!allowed(event, args)) return failed();
      try { const result = await controller[method](); return isStudioState(result) ? result : failed(); }
      catch { return failed(); }
    });
  }
  window.once('closed', () => {
    for (const channel of Object.values(studioChannels)) ipcMain.removeHandler(channel);
    void controller.dispose();
  });
}
