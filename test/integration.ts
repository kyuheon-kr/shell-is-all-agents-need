import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.ts';
import { createRunner } from '../src/runner.ts';
import { ZellijClient } from '../src/zellij.ts';
import { ZellijError } from '../src/errors.ts';
import { SubscriptionManager } from '../src/subscriptions.ts';

test('real Zellij: background session, tabs, panes, I/O, subscriptions and lifecycle', { timeout: 60_000 }, async t => {
  const runner = createRunner(process.env.SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN);
  const name = `shell-is-all-agents-need-test-${randomUUID().slice(0, 8)}`;
  const renamed = `${name}-renamed`;
  const config = readConfig({ SHELL_IS_ALL_AGENTS_NEED_SESSIONS: `${name},${renamed}`, SHELL_IS_ALL_AGENTS_NEED_SESSION: name });
  const client = new ZellijClient(config, runner);
  try { await client.checkVersion(); }
  catch (error) {
    if (error instanceof ZellijError && error.code === 'BINARY_NOT_FOUND') {
      t.skip('Zellij is not installed; set SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN to Zellij >= 0.45.1'); return;
    }
    throw error;
  }
  const manager = new SubscriptionManager(client);
  t.after(async () => {
    manager.dispose();
    for (const session of [name, renamed]) {
      try { await client.closeSession(session); }
      catch (error) { if (!(error instanceof ZellijError && error.code === 'NOT_FOUND')) throw error; }
    }
  });
  await client.createSession(name);
  const tabs = await client.listTabs();
  assert.ok(tabs.tabs.length > 0);
  // Explicit interactive sh makes the test independent of the user's preferred shell.
  const tab = await client.createTab({ name: 'integration', command: ['sh', '-i'] });
  let panes = await client.listPanes(name, tab.tab_id);
  const left = panes.panes.find(p => p.is_plugin === false)!;
  assert.ok(left);
  const right = await client.createPane(tab.tab_id, { name: 'shared', direction: 'right', command: ['sh', '-i'] });
  panes = await client.listPanes(name, tab.tab_id);
  assert.equal(panes.panes.filter(p => p.is_plugin === false).length, 2);
  const sub = await manager.subscribe([right.pane_id]);
  let cursor = 0;
  const initial = await manager.readEvents(sub.subscription_id, cursor, 100, 3000);
  assert.ok(initial.events.some(event => event.event === 'pane_update' && event.is_initial));
  cursor = initial.next_cursor;
  const waiting = manager.readEvents(sub.subscription_id, cursor, 100, 3000);
  const marker = `SHELL_IS_ALL_AGENTS_NEED_${randomUUID().replaceAll('-', '')}`;
  await client.sendText(right.pane_id, `printf '%s\\n' '${marker}'`, true);
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
  await client.renameSession(renamed);
  assert.equal(client.scope.resolve(), renamed);
  assert.ok((await client.listSessions()).sessions.includes(renamed));
  await client.closeSession();
});
