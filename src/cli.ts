import { parseArgs } from 'node:util';
import { readRuntimeConfig } from './config.ts';
import type { Config } from './config.ts';
import { discoverCurrentSession } from './discovery.ts';
import { fail, sessionName } from './errors.ts';

export const help = `Usage: shell-is-all-agents-need [options]

  --allowed-sessions a,b,c  Allow these plus the detected current session; default to the first
  --session name            Choose a default from the allowed sessions
  --doctor                  Print read-only JSON diagnostics and exit
  --help                    Show this help

Example:
  codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need --allowed-sessions a,b,c

The detected current session is always allowed.
Without session options, use environment configuration and automatic discovery.
`;

export function readCliConfig(args: string[], env: NodeJS.ProcessEnv = process.env, discover: () => string | undefined = discoverCurrentSession): { help: true } | { doctor: true; args: string[] } | { config: Config } {
  const { values } = parseArgs({ args, options: {
    'allowed-sessions': { type: 'string' },
    session: { type: 'string' },
    help: { type: 'boolean' },
    doctor: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) return { help: true };
  if (values.doctor) return { doctor: true, args: args.filter(arg => arg !== '--doctor' && arg !== '--doctor=true') };
  if (values['allowed-sessions'] === undefined && values.session === undefined) {
    return { config: readRuntimeConfig(env, discover) };
  }
  // CLI lists replace environment lists; the detected current session is always added.
  const sessions = values['allowed-sessions'] ?? env.SHELL_IS_ALL_AGENTS_NEED_SESSIONS;
  if (!sessions?.trim()) fail('INVALID_ARGUMENT', '--allowed-sessions must contain at least one session');
  const names = sessions.split(',').map(name => name.trim());
  for (const name of names) sessionName(name);
  const target = values.session ?? names[0]!;
  sessionName(target);
  if (!names.includes(target)) fail('ACCESS_DENIED', '--session must appear in --allowed-sessions');
  return { config: readRuntimeConfig({
    ZELLIJ_SESSION_NAME: env.ZELLIJ_SESSION_NAME,
    SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN: env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN,
    SHELL_IS_ALL_AGENTS_NEED_SESSIONS: names.join(','),
    SHELL_IS_ALL_AGENTS_NEED_SESSION: target,
  }, discover) };
}
