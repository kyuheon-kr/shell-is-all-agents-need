import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ZellijError } from './errors.ts';

export interface RunOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }
export interface Runner {
  run(args: string[], options?: RunOptions): Promise<string>;
  stream(args: string[]): ChildProcessWithoutNullStreams;
}

export function createRunner(binary = 'zellij', env: NodeJS.ProcessEnv = process.env): Runner {
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
  delete childEnv.ZELLIJ_PANE_ID;
  // All session targets are explicit too. A stale inherited name can mask an
  // exited session as "current" in Zellij's session listing.
  delete childEnv.ZELLIJ_SESSION_NAME;
  const stream = (args: string[]) => spawn(binary, args, {
    env: childEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stream,
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(new ZellijError('CANCELLED', 'Operation cancelled'));
        const child = stream(args);
        child.stdin.end();
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let bytes = 0;
        let failure: ZellijError | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: ZellijError) => {
          failure ??= error;
          child.kill('SIGTERM');
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
          killTimer.unref();
        };
        const abort = () => stop(new ZellijError('CANCELLED', 'Operation cancelled'));
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop(new ZellijError('TIMEOUT', 'Zellij CLI timed out')), options.timeoutMs ?? 10_000);
        const collect = (target: Buffer[], chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
            stop(new ZellijError('RESOURCE_LIMIT', 'Zellij output exceeded the byte limit'));
          } else target.push(chunk);
        };
        child.stdout.on('data', chunk => collect(out, chunk));
        child.stderr.on('data', chunk => collect(err, chunk));
        const cleanup = () => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          options.signal?.removeEventListener('abort', abort);
        };
        child.on('error', (error: NodeJS.ErrnoException) => {
          cleanup();
          reject(new ZellijError(error.code === 'ENOENT' ? 'BINARY_NOT_FOUND' : 'CLI_ERROR',
            error.code === 'ENOENT' ? `Zellij binary not found: ${binary}` : error.message));
        });
        child.on('close', (code, signal) => {
          cleanup();
          if (failure) return reject(failure);
          const stdout = Buffer.concat(out).toString('utf8');
          if (code !== 0) {
            const stderr = Buffer.concat(err).toString('utf8').trim();
            return reject(new ZellijError('CLI_ERROR', stderr || stdout.trim() || `Zellij exited: ${code ?? signal}`));
          }
          resolve(stdout);
        });
      });
    },
  };
}
