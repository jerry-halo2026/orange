import { contextBridge, ipcRenderer } from 'electron';
import { authChannels, type DesktopAuthBridge, type LoginInput } from '../auth-contract.ts';

const auth: DesktopAuthBridge = {
  getState: () => ipcRenderer.invoke(authChannels.state),
  signIn: (input: LoginInput) => ipcRenderer.invoke(authChannels.signIn, input),
  signOut: () => ipcRenderer.invoke(authChannels.signOut),
};
contextBridge.exposeInMainWorld('orangeAuth', Object.freeze(auth));

import { studioChannels, isStudioState, isStudioInvocationArgs, type DesktopStudioBridge, type StudioState } from '../studio-contract.ts';
const studioCall = (channel: string) => async (...args: unknown[]): Promise<StudioState> => {
  const failed: StudioState = { kind: 'closed', error: 'failed' };
  if (!isStudioInvocationArgs(args)) return failed;
  try {
    const result: unknown = await ipcRenderer.invoke(channel);
    // Reconstruct only public data, never relay unexpected native fields.
    return isStudioState(result) ? { kind: result.kind, error: result.error } as StudioState : failed;
  } catch { return failed; }
};
const studio: DesktopStudioBridge = {
  getState: studioCall(studioChannels.state), open: studioCall(studioChannels.open), close: studioCall(studioChannels.close),
};
contextBridge.exposeInMainWorld('orangeStudio', Object.freeze(studio));
