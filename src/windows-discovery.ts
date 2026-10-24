import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sessionName } from './errors.ts';

export interface WindowsProcess {
  pid: number;
  parentPid: number;
  isClient: boolean;
  session: string | null;
  serverSocket?: string | null;
  startTime?: string | null;
}

/** The helper checks token SIDs before inspecting a process and emits only
 * session metadata. It runs once at startup, never through a command shell. */
export function readWindowsProcesses(parentPid = process.ppid): WindowsProcess[] {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  // Sysnative reaches the 64-bit helper from 32-bit Node on 64-bit Windows.
  const system = process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
  const executable = join(root, system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('../native/discover-windows.ps1', import.meta.url));
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-AncestorPid', String(parentPid)], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];
  try {
    const rows: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''));
    if (!Array.isArray(rows) || !rows.every(isWindowsProcess)) return [];
    return rows;
  } catch { return []; }
}

function isWindowsProcess(value: unknown): value is WindowsProcess {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.pid) && (row.pid as number) > 0
    && Number.isSafeInteger(row.parentPid) && (row.parentPid as number) >= 0
    && typeof row.isClient === 'boolean' && (row.session === null || typeof row.session === 'string')
    && (row.serverSocket === undefined || row.serverSocket === null || typeof row.serverSocket === 'string')
    && (row.startTime === undefined || row.startTime === null || (typeof row.startTime === 'string' && /^\d+$/u.test(row.startTime)));
}

export function discoverWindowsSession(
  parentPid = process.ppid,
  snapshot: () => WindowsProcess[] = () => readWindowsProcesses(parentPid),
): string | undefined {
  let rows: WindowsProcess[];
  try { rows = snapshot(); } catch { return undefined; }
  const processes = new Map(rows.map(row => [row.pid, row]));
  const valid = (value: string | null) => {
    if (!value) return undefined;
    try { return sessionName(value); } catch { return undefined; }
  };
  const visited = new Set<number>();
  let pid = parentPid;
  for (let depth = 0; depth < 32 && pid > 0 && !visited.has(pid); depth++) {
    visited.add(pid);
    const row = processes.get(pid);
    if (!row) break;
    if (row.session !== null) {
      const name = valid(row.session);
      if (name) return name;
      break;
    }
    pid = row.parentPid;
  }
  const sessions = new Set(rows.filter(row => row.isClient).map(row => valid(row.session)).filter(name => name !== undefined));
  return sessions.size === 1 ? sessions.values().next().value : undefined;
}
