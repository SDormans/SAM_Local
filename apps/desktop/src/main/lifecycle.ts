/**
 * Close decision (spec 036 FR-022/T016). With active work the user chooses; the default is
 * a graceful stop, background operation is explicit, and the result is verified against the
 * supervised service state rather than assumed.
 */
import type { ServiceState, SupervisorStatus } from './service-supervisor.js';

export type CloseChoice = 'stop' | 'background' | 'cancel';

export const CLOSE_PROMPT = {
  title: 'SAM is still working',
  message: 'An agent is still running. What should SAM do?',
  detail:
    'Stopping ends the running work gracefully. Keeping it running leaves SAM active in the background until you stop it from the tray.',
  buttons: ['Stop work and quit', 'Keep running in background', 'Cancel'],
  defaultId: 0,
  cancelId: 2,
} as const;

export function choiceFromResponse(response: number): CloseChoice {
  return response === 1 ? 'background' : response === 2 ? 'cancel' : 'stop';
}

export interface CloseContext {
  activeWorkCount: () => Promise<number>;
  ask: () => Promise<number>;
  stopServices: () => Promise<SupervisorStatus>;
  enterBackground: () => void;
  quit: () => void;
  showError: (message: string) => void;
}

export interface CloseOutcome {
  choice: CloseChoice;
  finalState?: ServiceState;
}

export async function handleCloseRequest(context: CloseContext): Promise<CloseOutcome> {
  let active: number;
  try {
    active = await context.activeWorkCount();
  } catch {
    // Unknown state counts as active: never silently drop running work.
    active = 1;
  }
  const choice = active > 0 ? choiceFromResponse(await context.ask()) : 'stop';
  if (choice === 'cancel') return { choice };
  if (choice === 'background') {
    context.enterBackground();
    return { choice, finalState: 'running' };
  }
  const status = await context.stopServices();
  if (status.state !== 'stopped') {
    context.showError(
      status.error ??
        'SAM could not confirm that local services stopped; they may still be running.'
    );
    return { choice, finalState: status.state };
  }
  context.quit();
  return { choice, finalState: 'stopped' };
}
