import { stripVTControlCharacters } from 'node:util';
import { ZellijError } from './errors.ts';
import type { RunOptions } from './runner.ts';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** node-pty's native resolver neither appends .exe nor reliably handles a
 * relative executable or the final PATH entry. Resolve without invoking a shell. */
export function resolveWindowsExecutable(binary: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const directories = win32.isAbsolute(binary) || /[/\\]/u.test(binary)
    ? [cwd]
    : [cwd, ...(env[pathKey ?? 'PATH'] ?? '').split(';').filter(Boolean).map(value => value.replace(/^"(.*)"$/u, '$1'))];
  const names = win32.extname(binary) ? [binary] : [binary, `${binary}.exe`, `${binary}.com`];
  for (const directory of directories) {
    for (const name of names) {
      const path = win32.resolve(directory, name);
      try { if (statSync(path).isFile()) return path; } catch {}
    }
  }
  // Preserve the asynchronous BINARY_NOT_FOUND behavior of the normal runner.
  return binary;
}

/** Zellij's Windows background-session bootstrap requires valid console
 * handles. An isolated ConPTY supplies them without opening a visible window
 * or attaching the MCP host to the new session. Other commands use pipes. */
export async function runWindowsConsole(binary: string, args: string[], env: NodeJS.ProcessEnv, options: RunOptions): Promise<string> {
  let spawn: typeof import('node-pty').spawn;
  try { ({ spawn } = await import('node-pty')); }
  catch { throw new ZellijError('BINARY_NOT_FOUND', 'Windows session creation requires node-pty; reinstall with optional dependencies enabled'); }
  if (options.signal?.aborted) throw new ZellijError('CANCELLED', 'Operation cancelled');
  return new Promise((resolve, reject) => {
    let terminal: ReturnType<typeof spawn>;
    try { terminal = spawn(resolveWindowsExecutable(binary, env), args, { env, cols: 160, rows: 50, name: 'xterm-256color', useConpty: true }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new ZellijError(/file not found|cannot find|ENOENT/iu.test(message) ? 'BINARY_NOT_FOUND' : 'CLI_ERROR', message));
      return;
    }
    let output = '';
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      data.dispose(); exit.dispose();
    };
    const stop = (error: ZellijError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { terminal.kill(); } catch {}
      reject(error);
    };
    const abort = () => stop(new ZellijError('CANCELLED', 'Operation cancelled'));
    const data = terminal.onData(chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) stop(new ZellijError('RESOURCE_LIMIT', 'Zellij output exceeded the byte limit'));
      else output += chunk;
    });
    const exit = terminal.onExit(event => {
      if (settled) return;
      settled = true;
      cleanup();
      // node-pty's Windows output worker otherwise keeps the host alive after
      // the bootstrap CLI exits. The detached Zellij server has its own console.
      try { terminal.kill(); } catch {}
      const text = stripVTControlCharacters(output);
      if (event.exitCode !== 0) reject(new ZellijError('CLI_ERROR', text.trim() || `Zellij exited: ${event.exitCode}`));
      else resolve(text);
    });
    const timer = setTimeout(() => stop(new ZellijError('TIMEOUT', 'Zellij CLI timed out')), options.timeoutMs ?? 10_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
