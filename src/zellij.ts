import { stripVTControlCharacters } from 'node:util';
import { SessionScope } from './config.ts';
import type { Config } from './config.ts';
import { fail, integer, literal, paneId, ZellijError } from './errors.ts';
import type { Runner } from './runner.ts';

export type Metadata = Record<string, unknown>;
export interface Pane extends Metadata { pane_id: string }
export interface Tab extends Metadata { tab_id: number }
export interface CreateOptions {
  name?: string; cwd?: string; command?: string[]; focus?: boolean;
}

function records(text: string): Metadata[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('INVALID_OUTPUT', 'Zellij returned invalid JSON'); }
  if (!Array.isArray(value) || !value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    fail('INVALID_OUTPUT', 'Expected a JSON array of Zellij metadata');
  }
  return value as Metadata[];
}

function createArgs(options: CreateOptions): string[] {
  const result: string[] = [];
  if (options.name !== undefined) result.push('--name', literal(options.name, 'name'));
  if (options.cwd !== undefined) result.push('--cwd', literal(options.cwd, 'cwd'));
  if (!options.focus) result.push('--no-focus');
  if (options.command !== undefined) {
    if (!options.command.length) fail('INVALID_ARGUMENT', 'command must contain an executable');
    result.push('--', ...options.command.map((arg, i) => literal(arg, 'command argument', i > 0)));
  }
  return result;
}

export class ZellijClient {
  readonly scope: SessionScope;
  readonly runner: Runner;
  private readonly inputQueues = new Map<string, Promise<unknown>>();
  constructor(config: Config, runner: Runner) {
    this.scope = new SessionScope(config);
    this.runner = runner;
  }

  async checkVersion(): Promise<void> {
    const text = await this.runner.run(['--version']);
    const match = /\b(\d+)\.(\d+)\.(\d+)([^\s]*)/u.exec(text);
    if (!match) fail('INVALID_OUTPUT', 'Cannot parse Zellij version');
    const [, major, minor, patch, suffix] = match;
    const version = [Number(major), Number(minor), Number(patch)];
    if (suffix || (version[0] === 0 && (version[1]! < 45 || (version[1] === 45 && version[2]! < 1)))) {
      fail('UNSUPPORTED_VERSION', `Zellij 0.45.1 or newer is required; found ${text.trim()}`);
    }
  }

  private async activeSessions(signal?: AbortSignal): Promise<string[]> {
    try {
      // --short also prints resurrectable (exited) sessions and hides their status.
      const output = stripVTControlCharacters(await this.runner.run(['list-sessions', '--no-formatting'], { signal }));
      return output.split(/\r?\n/u).filter(line => line.trim()).flatMap(line => {
        const match = /^(.*) \[Created [^\r\n]* ago\]\s*(\(current\)|\(EXITED - attach to resurrect\))?\s*$/u.exec(line);
        if (!match) fail('INVALID_OUTPUT', 'Cannot parse Zellij session status');
        return match[2] === '(EXITED - attach to resurrect)' ? [] : [match[1]!];
      });
    } catch (error) {
      if (error instanceof ZellijError && error.code === 'CLI_ERROR' && /no (?:active )?(?:zellij )?sessions? (?:found|running)/iu.test(error.message)) return [];
      throw error;
    }
  }

  async listSessions(_signal?: AbortSignal): Promise<{ sessions: string[] }> {
    return { sessions: this.scope.list() };
  }

  async requireSession(session?: string, signal?: AbortSignal): Promise<string> {
    const target = this.scope.resolve(session);
    if (!(await this.activeSessions(signal)).includes(target)) fail('NOT_FOUND', `Session '${target}' is not running`);
    return target;
  }

  async createSession(name: string, signal?: AbortSignal): Promise<{ session: string }> {
    const target = this.scope.resolve(name);
    if ((await this.activeSessions(signal)).includes(target)) fail('ALREADY_EXISTS', `Session '${target}' already exists`);
    // Background creation has no foreground attach and does not need a controlling TTY.
    await this.runner.run(['attach', '--create-background', target], { signal });
    return { session: target };
  }

  async renameSession(name: string, session?: string, signal?: AbortSignal): Promise<{ session: string }> {
    const next = this.scope.resolve(name);
    const previous = await this.requireSession(session, signal);
    if (previous === next) return { session: next };
    if ((await this.activeSessions(signal)).includes(next)) fail('ALREADY_EXISTS', `Session '${next}' already exists`);
    await this.action(previous, ['rename-session', '--', next], signal);
    this.scope.renamed(previous, next);
    return { session: next };
  }

  async closeSession(session?: string, signal?: AbortSignal): Promise<{ session: string }> {
    const target = await this.requireSession(session, signal);
    await this.runner.run(['kill-session', target], { signal });
    return { session: target };
  }

  private action(session: string, args: string[], signal?: AbortSignal): Promise<string> {
    return this.runner.run(['--session', session, 'action', ...args], { signal });
  }

  async listTabs(session?: string, signal?: AbortSignal): Promise<{ session: string; tabs: Tab[] }> {
    const target = await this.requireSession(session, signal);
    const tabs = records(await this.action(target, ['list-tabs', '--all', '--json'], signal)).map(row => {
      const id = row.tab_id ?? row.id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) fail('INVALID_OUTPUT', 'Tab has no stable tab ID');
      return { ...row, tab_id: id };
    });
    return { session: target, tabs };
  }

  async listPanes(session?: string, tabId?: number, signal?: AbortSignal): Promise<{ session: string; panes: Pane[] }> {
    if (tabId !== undefined) integer(tabId, 'tab_id');
    const target = await this.requireSession(session, signal);
    const panes = records(await this.action(target, ['list-panes', '--all', '--json'], signal)).map((row): Pane => {
      const raw = row.pane_id ?? row.id;
      const id = typeof raw === 'string' && /^(terminal|plugin)_\d+$/u.test(raw)
        ? raw
        : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
          ? `${row.is_plugin === true || row.type === 'plugin' ? 'plugin' : 'terminal'}_${raw}`
          : fail('INVALID_OUTPUT', 'Pane has no typed pane ID');
      return { ...row, pane_id: id };
    }).filter(row => tabId === undefined || row.tab_id === tabId);
    return { session: target, panes };
  }

  private async requireTab(tabId: number, session?: string, signal?: AbortSignal): Promise<string> {
    integer(tabId, 'tab_id');
    const result = await this.listTabs(session, signal);
    if (!result.tabs.some(tab => tab.tab_id === tabId)) fail('NOT_FOUND', `Tab ${tabId} does not exist in '${result.session}'`);
    return result.session;
  }

  async requirePanes(ids: string[], session?: string, signal?: AbortSignal): Promise<string> {
    if (!ids.length) fail('INVALID_ARGUMENT', 'At least one pane ID is required');
    ids.forEach(paneId);
    const result = await this.listPanes(session, undefined, signal);
    for (const id of ids) {
      if (!result.panes.some(pane => pane.pane_id === id)) fail('NOT_FOUND', `Pane ${id} does not exist in '${result.session}'`);
    }
    return result.session;
  }

  async createTab(options: CreateOptions, session?: string, signal?: AbortSignal): Promise<{ session: string; tab_id: number }> {
    const args = createArgs(options);
    const target = await this.requireSession(session, signal);
    const output = (await this.action(target, ['new-tab', ...args], signal)).trim();
    if (!/^\d+$/u.test(output)) fail('INVALID_OUTPUT', 'Zellij did not return a tab ID');
    return { session: target, tab_id: integer(Number(output), 'tab_id') };
  }

  async createPane(tabId: number, options: CreateOptions & { direction?: 'right' | 'down' }, session?: string, signal?: AbortSignal): Promise<{ session: string; pane_id: string }> {
    if (options.direction !== undefined && !['right', 'down'].includes(options.direction)) fail('INVALID_ARGUMENT', 'direction must be right or down');
    const args = ['new-pane', '--tab-id', String(integer(tabId, 'tab_id'))];
    if (options.direction) args.push('--direction', options.direction);
    args.push(...createArgs(options));
    const target = await this.requireTab(tabId, session, signal);
    const output = (await this.action(target, args, signal)).trim();
    if (!/^terminal_\d+$/u.test(output)) fail('INVALID_OUTPUT', 'Zellij did not return a terminal pane ID');
    return { session: target, pane_id: output };
  }

  async tabAction(operation: 'rename' | 'close' | 'focus', tabId: number, session?: string, name?: string, signal?: AbortSignal): Promise<{ session: string; tab_id: number }> {
    const args = operation === 'rename'
      ? ['rename-tab-by-id', String(integer(tabId, 'tab_id')), '--', literal(name!, 'name')]
      : [operation === 'close' ? 'close-tab-by-id' : 'go-to-tab-by-id', String(integer(tabId, 'tab_id'))];
    const target = await this.requireTab(tabId, session, signal);
    await this.action(target, args, signal);
    return { session: target, tab_id: tabId };
  }

  async paneAction(operation: 'rename' | 'close' | 'focus' | 'resize', id: string, session?: string,
    options: { name?: string; direction?: 'left' | 'right' | 'up' | 'down'; resize?: 'increase' | 'decrease' } = {}, signal?: AbortSignal): Promise<{ session: string; pane_id: string }> {
    paneId(id);
    let args: string[];
    switch (operation) {
      case 'rename': args = ['rename-pane', '--pane-id', id, '--', literal(options.name!, 'name')]; break;
      case 'close': args = ['close-pane', '--pane-id', id]; break;
      case 'focus': args = ['focus-pane-id', id]; break;
      case 'resize': {
        if (options.direction && !['left', 'right', 'up', 'down'].includes(options.direction)) fail('INVALID_ARGUMENT', 'Invalid resize direction');
        const resize = options.resize ?? 'increase';
        if (!['increase', 'decrease'].includes(resize)) fail('INVALID_ARGUMENT', 'Invalid resize operation');
        args = ['resize', '--pane-id', id, resize];
        if (options.direction) args.push(options.direction);
        break;
      }
    }
    const target = await this.requirePanes([id], session, signal);
    await this.action(target, args, signal);
    return { session: target, pane_id: id };
  }

  private async input<T>(session: string, id: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = JSON.stringify([session, id]);
    const previous = this.inputQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (signal?.aborted) fail('CANCELLED', 'Operation cancelled');
      return work();
    });
    this.inputQueues.set(key, next);
    try { return await next; }
    finally { if (this.inputQueues.get(key) === next) this.inputQueues.delete(key); }
  }

  async sendText(id: string, text: string, enter = false, session?: string, signal?: AbortSignal): Promise<{ session: string; pane_id: string }> {
    paneId(id); literal(text, 'text', true);
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) fail('INVALID_ARGUMENT', 'text must not exceed 64KiB of UTF-8');
    const target = this.scope.resolve(session);
    return this.input(target, id, async () => {
      await this.requirePanes([id], target, signal);
      if (text.length) await this.action(target, ['paste', '--pane-id', id, '--', text], signal);
      if (enter) await this.action(target, ['send-keys', '--pane-id', id, '--', 'Enter'], signal);
      return { session: target, pane_id: id };
    }, signal);
  }

  async sendKeys(id: string, keys: string[], session?: string, signal?: AbortSignal): Promise<{ session: string; pane_id: string }> {
    paneId(id);
    if (!keys.length) fail('INVALID_ARGUMENT', 'keys cannot be empty');
    keys.forEach(key => literal(key, 'key'));
    const target = this.scope.resolve(session);
    return this.input(target, id, async () => {
      await this.requirePanes([id], target, signal);
      await this.action(target, ['send-keys', '--pane-id', id, '--', ...keys], signal);
      return { session: target, pane_id: id };
    }, signal);
  }

  async capture(id: string, options: { scrollback?: boolean; lines?: number; ansi?: boolean } = {}, session?: string, signal?: AbortSignal) {
    const limit = integer(options.lines ?? 200, 'lines', 1, 10_000);
    const target = await this.requirePanes([id], session, signal);
    const args = ['dump-screen', '--pane-id', id];
    if (options.scrollback) args.push('--full');
    if (options.ansi) args.push('--ansi');
    let text = await this.action(target, args, signal);
    if (!options.ansi) text = stripVTControlCharacters(text);
    const lines = text.replace(/\n$/u, '').split('\n');
    return { session: target, pane_id: id, text: lines.slice(-limit).join('\n'), truncated: lines.length > limit };
  }
}
