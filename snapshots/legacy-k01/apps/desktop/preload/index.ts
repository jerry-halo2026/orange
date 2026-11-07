import { contextBridge, ipcRenderer } from 'electron';
import { authChannels, type DesktopAuthBridge, type LoginInput } from '../auth-contract.ts';

const auth: DesktopAuthBridge = {
  getState: () => ipcRenderer.invoke(authChannels.state),
  signIn: (input: LoginInput) => ipcRenderer.invoke(authChannels.signIn, input),
  signOut: () => ipcRenderer.invoke(authChannels.signOut),
};
contextBridge.exposeInMainWorld('orangeAuth', Object.freeze(auth));
