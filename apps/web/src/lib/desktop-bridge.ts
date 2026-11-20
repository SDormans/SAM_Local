/**
 * Bridge exposed by the SAM desktop app's preload script (spec 036). Absent in browsers,
 * so hosted SAM never shows desktop-only UI.
 */
export interface SelectedProjectFolder {
  path: string;
  name: string;
}

export interface DesktopRuntimeStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  url?: string;
  error?: string;
}

export interface SamDesktopBridge {
  selectProjectFolder(): Promise<SelectedProjectFolder | null>;
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>;
  refreshPrerequisites(): Promise<unknown>;
  onRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void): () => void;
}

declare global {
  interface Window {
    samDesktop?: SamDesktopBridge;
  }
}

export function getDesktopBridge(): SamDesktopBridge | null {
  return typeof window !== 'undefined' && window.samDesktop ? window.samDesktop : null;
}
