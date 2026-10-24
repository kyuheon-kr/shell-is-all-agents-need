import { fail, sessionName } from './errors.ts';
import { discoverCurrentSession } from './discovery.ts';

export interface Config {
  binary: string;
  defaultSession?: string;
  allowedSessions: ReadonlySet<string>;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const current = env.ZELLIJ_SESSION_NAME || undefined;
  const allowed = new Set((env.SHELL_IS_ALL_AGENTS_NEED_SESSIONS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  if (current) allowed.add(current);
  for (const name of allowed) sessionName(name);
  const defaultSession = env.SHELL_IS_ALL_AGENTS_NEED_SESSION || current;
  if (defaultSession && !allowed.has(sessionName(defaultSession))) {
    fail('ACCESS_DENIED', 'SHELL_IS_ALL_AGENTS_NEED_SESSION must be the current session or appear in SHELL_IS_ALL_AGENTS_NEED_SESSIONS');
  }
  return { binary: env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN || 'zellij', defaultSession, allowedSessions: allowed };
}

/** Startup discovery stays separate from deterministic explicit configuration parsing. */
export function readRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  discover: () => string | undefined = discoverCurrentSession,
): Config {
  // Additional sessions do not replace the session hosting this process.
  // Keep an explicit default, but always include the detected current session.
  if (env.ZELLIJ_SESSION_NAME) return readConfig(env);
  const current = discover();
  return readConfig(current ? { ...env, ZELLIJ_SESSION_NAME: current } : env);
}

export class SessionScope {
  private defaultSession?: string;
  private readonly allowed: ReadonlySet<string>;
  constructor(config: Config) {
    this.defaultSession = config.defaultSession;
    this.allowed = new Set(config.allowedSessions);
  }
  resolve(session?: string): string {
    const result = session ?? this.defaultSession;
    if (!result) fail('NO_DEFAULT_SESSION', 'No current Zellij session was detected. Pass --allowed-sessions a,b,c (optionally --session b), or configure SHELL_IS_ALL_AGENTS_NEED_SESSION and SHELL_IS_ALL_AGENTS_NEED_SESSIONS');
    sessionName(result);
    if (!this.allowed.has(result)) fail('ACCESS_DENIED', `Session '${result}' is not allowed`);
    return result;
  }
  allows(session: string): boolean { return this.allowed.has(session); }
  list(): string[] { return [...this.allowed]; }
  renamed(previous: string, next: string): void {
    if (this.defaultSession === previous) this.defaultSession = next;
  }
}
