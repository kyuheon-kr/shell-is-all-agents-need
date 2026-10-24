import { readFileSync } from 'node:fs';
import { sessionName } from './errors.ts';

export interface DiscoveryOptions {
  platform?: string;
  parentPid?: number;
  uid?: number;
  read?: (path: string) => string;
}

/** Recover only the nearest ancestor's session name when a host filters its child env. */
export function discoverAncestorSession(options: DiscoveryOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return undefined;
  const read = options.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const visited = new Set<number>();
  let pid = options.parentPid ?? process.ppid;
  // The host can be PID 1 in a PID namespace. Inspect it before stopping at 0.
  for (let depth = 0; depth < 32 && pid > 0 && !visited.has(pid); depth++) {
    visited.add(pid);
    let status: string;
    try { status = read(`/proc/${pid}/status`); } catch { return undefined; }
    const owner = /^Uid:\s+(\d+)\s+(\d+)/mu.exec(status);
    if (!owner || Number(owner[1]) !== uid || Number(owner[2]) !== uid) return undefined;
    try {
      // Never forward or log other environment entries.
      const entry = read(`/proc/${pid}/environ`).split('\0').find(value => value.startsWith('ZELLIJ_SESSION_NAME='));
      if (entry !== undefined) {
        const name = entry.slice('ZELLIJ_SESSION_NAME='.length);
        try { return sessionName(name); } catch { return undefined; }
      }
    } catch {
      // A host may protect its environment; an accessible ancestor shell can still identify it.
    }
    const parent = /^PPid:\s+(\d+)/mu.exec(status);
    if (!parent) return undefined;
    pid = Number(parent[1]);
    if (!Number.isSafeInteger(pid)) return undefined;
  }
  return undefined;
}
