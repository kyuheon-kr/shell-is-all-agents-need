import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { integer, ZellijError } from './errors.ts';
import { runWindowsConsole } from './windows-console.ts';
import { prepareWindowsRename } from './windows-pipes.ts';

export interface RunOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }
export function controlTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.SHELL_IS_ALL_AGENTS_NEED_TIMEOUT_MS;
  if (value !== undefined && !/^\d+$/u.test(value)) throw new ZellijError('INVALID_ARGUMENT', 'SHELL_IS_ALL_AGENTS_NEED_TIMEOUT_MS must be a nonnegative integer; 0 disables the CLI deadline');
  return integer(value === undefined ? 10_000 : Number(value), 'SHELL_IS_ALL_AGENTS_NEED_TIMEOUT_MS', 0, 2_147_483_647);
}
export interface Runner {
  run(args: string[], options?: RunOptions): Promise<string>;
  stream(args: string[]): ChildProcessWithoutNullStreams;
  prepareSessionRename?(previous: string, next: string, signal?: AbortSignal): Promise<() => Promise<void>>;
}

export function createRunner(binary = 'zellij', env: NodeJS.ProcessEnv = process.env): Runner {
  const defaultTimeout = controlTimeout(env);
  // Do not inherit a caller pane ID: all targets are explicit; stale IDs can affect placement.
  const childEnv = { ...env };
  // MCP hosts can filter XDG_RUNTIME_DIR from their child environment. Zellij
  // then searches a different socket directory and reports live sessions as exited.
  if (!childEnv.XDG_RUNTIME_DIR && process.platform === 'linux' && process.getuid) {
    const uid = process.getuid();
    const runtimeDir = `/run/user/${uid}`;
    try {
      const stat = lstatSync(runtimeDir);
      if (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o777) === 0o700) {
        childEnv.XDG_RUNTIME_DIR = runtimeDir;
      }
    } catch {
      // Systems without a standard per-user runtime directory keep Zellij's defaults.
    }
  }
  for (const key of Object.keys(childEnv)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (name === 'ZELLIJ_PANE_ID' || name === 'ZELLIJ_SESSION_NAME') delete childEnv[key];
  }
  // All session targets are explicit too. A stale inherited name can mask an
  // exited session as "current" in Zellij's session listing.
  const stream = (args: string[]) => spawn(binary, args, {
    env: childEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stream,
    ...(process.platform === 'win32' ? { prepareSessionRename: (previous: string, next: string, signal?: AbortSignal) => prepareWindowsRename(previous, next, childEnv, signal) } : {}),
    run(args, options = {}) {
      const timeoutMs = integer(options.timeoutMs ?? defaultTimeout, 'timeoutMs', 0, 2_147_483_647);
      if (process.platform === 'win32' && args[0] === 'attach' && args.includes('--create-background')) {
        return runWindowsConsole(binary, args, childEnv, { ...options, timeoutMs });
      }
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(new ZellijError('CANCELLED', 'Operation cancelled'));
        const child = stream(args);
        child.stdin.end();
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        };
        const stop = (error: ZellijError) => {
          if (settled) return;
          settled = true;
          cleanup();
          // A grandchild can inherit stdout/stderr after the CLI exits. Waiting
          // for close would defeat cancellation; release our pipe ends instead.
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
            killTimer.unref();
          }
          reject(new ZellijError(error.code, error.message, {
            partial_stdout: Buffer.concat(out).toString('utf8').slice(-4096),
            partial_stderr: Buffer.concat(err).toString('utf8').slice(-4096),
          }));
        };
        const abort = () => stop(new ZellijError('CANCELLED', 'Operation cancelled'));
        const timer = timeoutMs === 0 ? undefined : setTimeout(() => stop(new ZellijError('TIMEOUT', `Zellij CLI timed out after ${timeoutMs}ms`)), timeoutMs);
        const collect = (target: Buffer[], chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
            stop(new ZellijError('RESOURCE_LIMIT', 'Zellij output exceeded the byte limit'));
          } else target.push(chunk);
        };
        child.stdout.on('data', chunk => collect(out, chunk));
        child.stderr.on('data', chunk => collect(err, chunk));
        child.once('exit', () => { if (killTimer) clearTimeout(killTimer); });
        child.on('error', (error: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new ZellijError(error.code === 'ENOENT' ? 'BINARY_NOT_FOUND' : 'CLI_ERROR',
            error.code === 'ENOENT' ? `Zellij binary not found: ${binary}` : error.message));
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();
          const stdout = Buffer.concat(out).toString('utf8');
          if (code !== 0) {
            const stderr = Buffer.concat(err).toString('utf8').trim();
            return reject(new ZellijError('CLI_ERROR', stderr || stdout.trim() || `Zellij exited: ${code ?? signal}`));
          }
          resolve(stdout);
        });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    },
  };
}
