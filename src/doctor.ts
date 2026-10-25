import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCliConfig } from './cli.ts';
import type { Config } from './config.ts';
import { inspectCurrentSession } from './discovery.ts';
import type { DiscoveryResult } from './discovery.ts';
import { controlTimeout, createRunner } from './runner.ts';
import type { Runner } from './runner.ts';
import { ZellijClient } from './zellij.ts';
import { version } from './version.ts';

interface WindowsComponents { powershell: boolean; helpers: boolean; node_pty: boolean }
interface DoctorDependencies {
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  discover?: () => DiscoveryResult; runner?: Runner;
  windows?: () => Promise<WindowsComponents>;
}

async function windowsComponents(env: NodeJS.ProcessEnv): Promise<WindowsComponents> {
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const system = process.arch === 'ia32' && env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
  let native = false;
  try { await import('node-pty'); native = true; } catch {}
  return { powershell: existsSync(join(root, system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
    helpers: ['WindowsProcesses.cs', 'WindowsPipes.cs', 'discover-windows.ps1', 'windows-pipes.ps1']
      .every(name => existsSync(fileURLToPath(new URL(`../native/${name}`, import.meta.url)))), node_pty: native };
}

export async function diagnose(args: string[] = [], dependencies: DoctorDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const checks: { name: string; status: 'ok' | 'warning' | 'error'; message: string }[] = [];
  const nextSteps: string[] = [];
  const add = (name: string, status: 'ok' | 'warning' | 'error', message: string) => checks.push({ name, status, message });
  add('node', Number(process.versions.node.split('.')[0]) >= 24 ? 'ok' : 'error', process.versions.node);
  const discovery = dependencies.discover?.() ?? inspectCurrentSession(env);
  let config: Config | undefined;
  try {
    const parsed = readCliConfig(args, env, () => discovery.session);
    if (!('config' in parsed)) throw new Error('Use --doctor with session options only');
    config = parsed.config;
    add('configuration', 'ok', 'Session options are valid');
  } catch (error) { add('configuration', 'error', String(error)); }
  let timeout: number | null = null;
  try { timeout = controlTimeout(env); add('control_timeout', 'ok', timeout === 0 ? 'Disabled; cancellation remains available' : `${timeout}ms`); }
  catch (error) { add('control_timeout', 'error', String(error)); }
  if (!config?.allowedSessions.size) {
    add('session_scope', 'error', discovery.source === 'ambiguous' ? 'Clients advertise multiple sessions; no session was selected' : 'No allowed session is available');
    nextSteps.push('Run inside Zellij, or configure --allowed-sessions dev,work --session dev in the same OS/WSL environment.');
  } else add('session_scope', 'ok', `${config.allowedSessions.size} allowed session(s)`);
  if (config && timeout !== null) {
    let foundVersion = '';
    const runner = dependencies.runner ?? createRunner(config.binary, env);
    const probe: Runner = { ...runner, run: async () => {
      foundVersion = (await runner.run(['--version'], { timeoutMs: 5000, maxBytes: 64 * 1024 })).trim();
      return foundVersion;
    } };
    try {
      await new ZellijClient(config, probe).checkVersion();
      add('zellij', 'ok', `${config.binary}: ${foundVersion}`);
      if (config.defaultSession) {
        try { await new ZellijClient(config, runner).requireSession(config.defaultSession); add('session_running', 'ok', config.defaultSession); }
        catch (error) { add('session_running', 'warning', String(error)); nextSteps.push('Start the configured session, or use create_session for its allowed name.'); }
      } else nextSteps.push('Set --session to choose a default, or pass session explicitly to tools.');
    } catch (error) { add('zellij', 'error', String(error)); nextSteps.push('Install Zellij 0.45.1+ on PATH, or set SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN.'); }
  }
  if (platform === 'win32') {
    const components = await (dependencies.windows ?? (() => windowsComponents(env)))();
    for (const [name, available] of Object.entries(components)) add(name, available ? 'ok' : 'error', available ? 'Available' : 'Missing or could not load');
    if (!components.node_pty) nextSteps.push('Keep optional dependencies enabled; on npm 12+, reinstall with npm install -g --allow-scripts=node-pty shell-is-all-agents-need.');
    if (!components.powershell || !components.helpers) nextSteps.push('Use native Windows Node and Windows PowerShell, and reinstall the complete npm package.');
  }
  return { ok: !checks.some(check => check.status === 'error'), version, platform,
    discovery, sessions: { default: config?.defaultSession ?? null, allowed: [...(config?.allowedSessions ?? [])] },
    control_timeout_ms: timeout, checks, next_steps: nextSteps };
}
