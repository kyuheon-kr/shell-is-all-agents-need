import { parseArgs } from 'node:util';
import { readConfig, readRuntimeConfig } from './config.ts';
import type { Config } from './config.ts';
import { fail, sessionName } from './errors.ts';

export const help = `Usage: shell-is-all-agents-need [options]

  --allowed-sessions a,b,c  Allow exactly these sessions; default to the first
  --session name            Choose a default from the allowed sessions
  --help                    Show this help

Example:
  codex mcp add shell-is-all-agents-need -- shell-is-all-agents-need --allowed-sessions a,b,c

Without session options, use environment configuration and automatic discovery.
`;

export function readCliConfig(args: string[], env: NodeJS.ProcessEnv = process.env): { help: true } | { config: Config } {
  const { values } = parseArgs({ args, options: {
    'allowed-sessions': { type: 'string' },
    session: { type: 'string' },
    help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) return { help: true };
  if (values['allowed-sessions'] === undefined && values.session === undefined) {
    return { config: readRuntimeConfig(env) };
  }
  // Explicit CLI scope must not be broadened by inherited or discovered sessions.
  const sessions = values['allowed-sessions'] ?? env.SHELL_IS_ALL_AGENTS_NEED_SESSIONS;
  if (!sessions?.trim()) fail('INVALID_ARGUMENT', '--allowed-sessions must contain at least one session');
  const names = sessions.split(',').map(name => name.trim());
  for (const name of names) sessionName(name);
  const target = values.session ?? names[0]!;
  sessionName(target);
  if (!names.includes(target)) fail('ACCESS_DENIED', '--session must appear in --allowed-sessions');
  return { config: readConfig({
    SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN: env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN,
    SHELL_IS_ALL_AGENTS_NEED_SESSIONS: names.join(','),
    SHELL_IS_ALL_AGENTS_NEED_SESSION: target,
  }) };
}
