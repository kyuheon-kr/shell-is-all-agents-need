import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.ts';
import { createRunner } from '../src/runner.ts';
import type { Runner } from '../src/runner.ts';
import { ZellijClient } from '../src/zellij.ts';
import { ZellijError } from '../src/errors.ts';
import { SubscriptionManager } from '../src/subscriptions.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnPty } from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(50);
  }
  throw new Error('Zellij metadata did not become ready within 5 seconds');
}

test('real Zellij: background session, tabs, panes, I/O, subscriptions and lifecycle', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shell-agents-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = process.platform === 'win32'
    ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NoExit']
    : ['sh', '-i'];
  await writeFile(join(directory, 'config.kdl'), `default_shell ${JSON.stringify(command[0])}\nshow_startup_tips false\nshow_release_notes false\n`);
  const env = { ...process.env, ZELLIJ_CONFIG_DIR: directory };
  delete env.ZELLIJ_SESSION_NAME;
  delete env.ZELLIJ_PANE_ID;
  const baseRunner = createRunner(process.env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN, env);
  const runner: Runner = {
    ...baseRunner,
    async run(args, options) {
      try { return await baseRunner.run(args, options); }
      catch (error) { console.error('Zellij command failed:', args); throw error; }
    },
  };
  const name = `shell-is-all-agents-need-test-${randomUUID().slice(0, 8)}`;
  const renamed = `${name}-renamed`;
  const renamedAgain = `${name}-again`;
  const config = readConfig({ SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN: process.env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN,
    SHELL_IS_ALL_AGENTS_NEED_SESSIONS: `${name},${renamed},${renamedAgain}`, SHELL_IS_ALL_AGENTS_NEED_SESSION: name });
  const client = new ZellijClient(config, runner);
  try { await client.checkVersion(); }
  catch (error) {
    if (!process.env.CI && error instanceof ZellijError && error.code === 'BINARY_NOT_FOUND') {
      t.skip('Zellij is not installed; set SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN to Zellij >= 0.45.1'); return;
    }
    throw error;
  }
  const manager = new SubscriptionManager(client);
  t.after(async () => {
    manager.dispose();
    for (const session of [name, renamed, renamedAgain]) {
      try { await client.closeSession(session); }
      catch (error) { if (!(error instanceof ZellijError && error.code === 'NOT_FOUND')) throw error; }
    }
  });
  try {
    await client.createSession(name);
    // Real terminal dimensions are needed for new-tab layouts in Zellij 0.45.1.
    // Keep a test client in its own PTY; never attach to the developer's terminal.
    const terminal = spawnPty(config.binary, ['attach', name], {
      name: 'xterm-256color', cols: 160, rows: 50, cwd: process.cwd(), env,
    });
    let terminalOutput = '';
    terminal.onData(data => { terminalOutput = (terminalOutput + data).slice(-4000); });
    t.after(() => { try { terminal.kill(); } catch {} });
    const tabs = await waitFor(() => client.listTabs(), result => result.tabs.length > 0).catch(async error => {
      t.diagnostic(`Terminal output: ${terminalOutput}`);
      t.diagnostic(`Session listing: ${await runner.run(['list-sessions', '--no-formatting'])}`);
      throw error;
    });
    assert.ok(tabs.tabs.length > 0);
    // Explicit shells avoid depending on the user's preferred shell or Unix tools.
    const tab = await client.createTab({ name: 'integration', command });
    let panes = await waitFor(() => client.listPanes(name, tab.tab_id), result => result.panes.some(p => p.is_plugin === false));
    const left = panes.panes.find(p => p.is_plugin === false)!;
    assert.ok(left);
    const right = await client.createPane(tab.tab_id, { name: 'shared', direction: 'right', command });
    panes = await client.listPanes(name, tab.tab_id);
    assert.equal(panes.panes.filter(p => p.is_plugin === false).length, 2);
    const sub = await manager.subscribe([right.pane_id]);
    let cursor = 0;
    const initial = await manager.readEvents(sub.subscription_id, cursor, 100, 3000);
    assert.ok(initial.events.some(event => event.event === 'pane_update' && event.is_initial));
    cursor = initial.next_cursor;
    const waiting = manager.readEvents(sub.subscription_id, cursor, 100, 3000);
    const marker = `SHELL_IS_ALL_AGENTS_NEED_${randomUUID().replaceAll('-', '')}`;
    await client.sendText(right.pane_id, `echo '${marker}'`, true);
    await client.sendText(left.pane_id, 'echo independent', true);
    let seen = (await waiting).events.some(event => event.event === 'pane_update' && event.viewport.join('\n').includes(marker));
    for (let i = 0; !seen && i < 50; i++) {
      seen = (await client.capture(right.pane_id)).text.includes(marker);
      if (!seen) await delay(50);
    }
    assert.equal(seen, true);
    await client.paneAction('rename', right.pane_id, undefined, { name: 'renamed-pane' });
    await client.paneAction('resize', right.pane_id, undefined, { resize: 'increase', direction: 'left' });
    await client.paneAction('focus', left.pane_id);
    await client.tabAction('rename', tab.tab_id, undefined, 'renamed-tab');
    await client.tabAction('focus', tab.tab_id);
    await client.sendKeys(right.pane_id, ['Ctrl c']);
    await client.paneAction('close', right.pane_id);
    let closed = false;
    for (let i = 0; !closed && i < 10; i++) {
      const result = await manager.readEvents(sub.subscription_id, cursor, 100, 500);
      cursor = result.next_cursor;
      closed = result.events.some(event => event.event === 'pane_closed');
    }
    assert.equal(closed, true);
    manager.unsubscribe(sub.subscription_id);
    await client.tabAction('close', tab.tab_id);
    if (process.platform === 'win32') {
      const configUrl = new URL('../src/config.ts', import.meta.url).href;
      const runnerUrl = new URL('../src/runner.ts', import.meta.url).href;
      const clientUrl = new URL('../src/zellij.ts', import.meta.url).href;
      const source = `
        import assert from 'node:assert/strict';
        import {readConfig} from ${JSON.stringify(configUrl)};
        import {createRunner} from ${JSON.stringify(runnerUrl)};
        import {ZellijClient} from ${JSON.stringify(clientUrl)};
        const config = readConfig(${JSON.stringify({ SHELL_IS_ALL_AGENTS_NEED_SESSIONS: `${name},${renamed}`, SHELL_IS_ALL_AGENTS_NEED_SESSION: name })});
        const client = new ZellijClient(config, createRunner(process.env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN));
        await client.renameSession(${JSON.stringify(renamed)});
        assert.equal(client.scope.resolve(), ${JSON.stringify(renamed)});
      `;
      // The host that creates the compatibility pipes must be able to exit.
      // Subsequent commands come from this separate, still-running host.
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env, timeout: 30_000 });
      client.scope.renamed(name, renamed);
    } else await client.renameSession(renamed);
    assert.equal(client.scope.resolve(), renamed);
    assert.ok((await client.listSessions()).sessions.includes(renamed));
    const remaining = (await client.listPanes()).panes.find(pane => pane.is_plugin === false)!;
    assert.ok(remaining);
    const renamedSubscription = await manager.subscribe([remaining.pane_id]);
    const renamedInitial = await manager.readEvents(renamedSubscription.subscription_id, 0, 100, 3000);
    assert.ok(renamedInitial.events.some(event => event.event === 'pane_update' && event.is_initial));
    await client.sendText(remaining.pane_id, 'echo renamed-session-input', true);
    assert.equal(typeof (await client.capture(remaining.pane_id)).text, 'string');
    manager.unsubscribe(renamedSubscription.subscription_id);
    await client.renameSession(renamedAgain);
    assert.ok((await client.listPanes()).panes.some(pane => pane.is_plugin === false));
    terminal.kill();
    await client.closeSession();
  } catch (error) {
    console.error(error);
    throw error;
  }
});
