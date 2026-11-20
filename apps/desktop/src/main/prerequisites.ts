/**
 * First-run host prerequisite checks (spec 036 T014): Docker Desktop with Linux containers
 * and, on Windows, WSL2. Results use the contract's LocalRuntimeHealth vocabulary.
 */
import { spawn } from 'node:child_process';

export interface LocalPrerequisites {
  dockerDesktop: 'ready' | 'stopped' | 'unavailable';
  wsl2: 'ready' | 'unavailable';
  message?: string;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  missing: boolean;
}

export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export const PREREQUISITE_DEFAULTS = { commandTimeoutMs: 15_000 } as const;

export const runCommand: RunCommand = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => child.kill(), PREREQUISITE_DEFAULTS.commandTimeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, missing: error.code === 'ENOENT' });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, missing: false });
    });
  });

export async function probePrerequisites(
  options: { platform?: NodeJS.Platform; run?: RunCommand } = {}
): Promise<LocalPrerequisites> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const messages: string[] = [];

  let wsl2: LocalPrerequisites['wsl2'] = 'ready';
  if (platform === 'win32') {
    const status = await run('wsl.exe', ['--status']);
    if (status.code !== 0) {
      wsl2 = 'unavailable';
      messages.push('WSL2 is not installed or not enabled. Run "wsl --install" and restart.');
    }
  }

  let dockerDesktop: LocalPrerequisites['dockerDesktop'];
  const docker = await run('docker', ['info', '--format', '{{.OSType}}']);
  if (docker.missing) {
    dockerDesktop = 'unavailable';
    messages.push('Docker Desktop is not installed. Install it with the WSL2 backend.');
  } else if (docker.code !== 0) {
    dockerDesktop = 'stopped';
    messages.push('Docker Desktop is not running. Start Docker Desktop and retry.');
  } else if (docker.stdout.trim() !== 'linux') {
    dockerDesktop = 'stopped';
    messages.push('Docker Desktop is using Windows containers. Switch to Linux containers.');
  } else {
    dockerDesktop = 'ready';
  }

  return { dockerDesktop, wsl2, ...(messages.length ? { message: messages.join(' ') } : {}) };
}
