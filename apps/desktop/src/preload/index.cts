/**
 * Narrow, typed bridge exposed to the sandboxed renderer (spec 036 T013). The renderer can
 * ask for a folder and read runtime status; it never sees secrets, paths it did not pick,
 * or Node APIs.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type RuntimeStatusListener = (status: unknown) => void;

contextBridge.exposeInMainWorld('samDesktop', {
  selectProjectFolder: (): Promise<unknown> => ipcRenderer.invoke('sam:select-project-folder'),
  getRuntimeStatus: (): Promise<unknown> => ipcRenderer.invoke('sam:runtime-status'),
  refreshPrerequisites: (): Promise<unknown> => ipcRenderer.invoke('sam:refresh-prerequisites'),
  onRuntimeStatus: (listener: RuntimeStatusListener): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: unknown): void => listener(status);
    ipcRenderer.on('sam:runtime-status', handler);
    return () => ipcRenderer.removeListener('sam:runtime-status', handler);
  },
});
