import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { readWindowsProcesses } from './windows-discovery.ts';
import { ZellijError } from './errors.ts';
import { setTimeout as delay } from 'node:timers/promises';

function request(control: string, alias: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(`\\\\.\\pipe\\${control}`);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const abort = () => failed(new ZellijError('CANCELLED', 'Operation cancelled'));
    const timer = setTimeout(() => failed(new ZellijError('TIMEOUT', 'Windows session pipe alias timed out')), 10_000);
    socket.once('error', failed);
    socket.once('connect', () => {
      const body = Buffer.from(alias);
      const header = Buffer.alloc(4); header.writeInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.once('data', data => {
      cleanup();
      if (data[0] === 0) resolveRequest();
      else reject(new ZellijError('ALREADY_EXISTS', 'The Windows pipe for the requested session name is already in use'));
    });
    socket.once('end', () => failed(new ZellijError('CLI_ERROR', 'Windows session pipe helper disconnected')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Capture the original endpoint before Zellij renames the session marker. The
 * helper is restricted to this user, survives host restart, and exits with the
 * original server. No terminal or session process is restarted. */
export async function prepareWindowsRename(previous: string, next: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (signal?.aborted) throw new ZellijError('CANCELLED', 'Operation cancelled');
  const root = realpathSync.native(env.ZELLIJ_SOCKET_DIR || join(tmpdir(), 'zellij'));
  const candidates: { path: string; pid: number }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^contract_version_\d+$/u.test(entry.name)) continue;
    const path = resolve(root, entry.name, previous);
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (/^\d+$/u.test(value) && Number.isSafeInteger(Number(value))) candidates.push({ path, pid: Number(value) });
    } catch {}
  }
  const processes = readWindowsProcesses();
  const servers = candidates.flatMap(marker => {
    const row = processes.find(row => row.pid === marker.pid && row.serverSocket && row.startTime
      && dirname(row.serverSocket).toLowerCase() === dirname(marker.path).toLowerCase());
    return row ? [{ marker, row }] : [];
  });
  if (servers.length !== 1) throw new ZellijError('CLI_ERROR', 'Cannot identify the same-user Windows Zellij server for session rename');
  const { marker, row } = servers[0]!;
  const alias = join(dirname(marker.path), next);
  const control = `shell-agents-zellij-${row.pid}-${row.startTime}`;
  // Validate the manager before changing the session. Its original endpoint
  // needs no alias, so a failed rename never reserves the requested name.
  try {
    await request(control, row.serverSocket!, signal);
    return () => request(control, alias);
  }
  catch (error) {
    // Only a missing manager permits startup. Never hide cancellation, pipe
    // collisions, or an existing manager's rejection by starting another one.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const system = process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
  const executable = join(systemRoot, system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('../native/windows-pipes.ps1', import.meta.url));
  await new Promise<void>((ready, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ServerPid', String(row.pid), '-Started', row.startTime!, '-SourcePipe', row.serverSocket!, '-ControlPipe', control], {
      // DETACHED_PROCESS gives Windows PowerShell invalid console handles.
      // Unref and release the pipes after startup instead; Windows children
      // continue running independently when their parent process exits.
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let errors = ''; let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); child.stdout.destroy(); child.stderr.destroy(); child.unref(); };
    const failed = (error: Error) => {
      if (settled) return;
      settled = true; cleanup(); child.kill(); reject(error);
    };
    const abort = () => failed(new ZellijError('CANCELLED', 'Operation cancelled'));
    const timer = setTimeout(() => failed(new ZellijError('TIMEOUT', 'Windows pipe helper startup timed out')), 15_000);
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.stdout.on('data', data => {
      output = (output + data).slice(-4000);
        if (/(?:^|\r?\n)STARTED \d+\r?\n/u.test(output)) { settled = true; cleanup(); ready(); }
    });
    child.once('error', failed);
    child.once('close', code => { if (!settled) failed(new ZellijError('CLI_ERROR', errors.trim() || `Windows pipe helper exited: ${code}; ${output.trim()}`)); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await request(control, row.serverSocket!, signal); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new ZellijError('TIMEOUT', 'Windows pipe worker did not become ready');
      if (signal?.aborted) throw new ZellijError('CANCELLED', 'Operation cancelled');
      await delay(100);
    }
  }
  // Complete transport repair even if cancellation arrives after Zellij has
  // committed the rename; leaving the new session unreachable is unsafe.
  return () => request(control, alias);
}
