import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Runner, RunOptions } from '../src/runner.ts';
import { readConfig } from '../src/config.ts';
import { ZellijClient } from '../src/zellij.ts';

export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills: string[] = [];
  kill(signal = 'SIGTERM') {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
  update(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
  close(code = 0) { this.exitCode = code; this.emit('close', code, null); }
}

export function setup(override?: (args: string[], options?: RunOptions) => string | Promise<string> | undefined) {
  const calls: string[][] = [];
  const children: FakeChild[] = [];
  const runner: Runner = {
    async run(args, options) {
      calls.push(args);
      const result = await override?.(args, options);
      if (result !== undefined) return result;
      if (args[0] === '--version') return 'zellij 0.45.1\n';
      if (args[0] === 'list-sessions') return 'dev [Created 1s ago] \nother [Created 2s ago] \n';
      switch (args[3]) {
        case 'list-tabs': return JSON.stringify([{ tab_id: 8, position: 0, name: 'work' }]);
        case 'list-panes': return JSON.stringify([
          { id: 1, is_plugin: false, tab_id: 8, title: 'shell', is_focused: true },
          { id: 2, is_plugin: false, tab_id: 8, title: 'worker' },
          { id: 1, is_plugin: true, tab_id: 8, title: 'status' },
        ]);
        case 'new-tab': return '9\n';
        case 'new-pane': return 'terminal_3\n';
        case 'dump-screen': return 'hello\nworld\n';
        default: return '';
      }
    },
    stream(args) {
      calls.push(args);
      const child = new FakeChild(); children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  };
  const config = readConfig({ ZELLIJ_SESSION_NAME: 'dev', SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'other,next,new' });
  return { calls, children, runner, client: new ZellijClient(config, runner) };
}

export const update = (text = 'hello', id = 'terminal_1', initial = false) => ({
  event: 'pane_update', pane_id: id, viewport: [text], scrollback: null, is_initial: initial,
});
