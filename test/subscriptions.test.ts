import test from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionManager } from '../src/subscriptions.ts';
import { ZellijError } from '../src/errors.ts';
import { setup, update } from './helpers.ts';

test('subscription binds explicit session/panes, deduplicates IDs and includes optional initial scrollback', async t => {
  const { client, calls } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1', 'terminal_1', 'plugin_1'], undefined, 50);
  assert.equal(sub.cursor, 0);
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'subscribe', '--format', 'json', '--pane-id', 'terminal_1', '--pane-id', 'plugin_1', '--scrollback', '50']);
});

test('NDJSON survives split chunks and split Unicode; cursor reads are replayable', async t => {
  const { client, children } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']); const child = children[0]!;
  const value = { ...update('한글', 'terminal_1', true), scrollback: ['before'] };
  const data = Buffer.from(JSON.stringify(value) + '\n');
  const split = data.indexOf(Buffer.from('한')) + 1;
  child.stdout.write(data.subarray(0, split)); child.stdout.write(data.subarray(split));
  child.update(update('next'));
  const first = await manager.readEvents(sub.subscription_id, 0, 1);
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0], { ...value, sequence: 1, received_at: first.events[0]!.received_at });
  assert.deepEqual(await manager.readEvents(sub.subscription_id, 0, 1), first);
  const next = await manager.readEvents(sub.subscription_id, first.next_cursor);
  assert.equal(next.next_cursor, 2); assert.equal(next.gap, false);
  assert.equal((next.events[0] as { viewport: string[] }).viewport[0], 'next');
});

test('event eviction reports a gap and resumes at the oldest retained sequence', async t => {
  const { client, children } = setup(); const manager = new SubscriptionManager(client, { maxEvents: 2 }); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  for (let i = 0; i < 4; i++) children[0]!.update(update(String(i)));
  const result = await manager.readEvents(sub.subscription_id, 0);
  assert.equal(result.gap, true); assert.equal(result.first_available_cursor, 2);
  assert.deepEqual(result.events.map(e => e.sequence), [3, 4]); assert.equal(result.next_cursor, 4);
});

test('byte eviction can drop an oversized event but still advances the cursor and wakes readers', async t => {
  const { client, children } = setup(); const manager = new SubscriptionManager(client, { maxBytes: 1 }); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  const read = manager.readEvents(sub.subscription_id, 0, 100, 1_000);
  children[0]!.update(update());
  const result = await read;
  assert.equal(result.gap, true); assert.equal(result.next_cursor, 1); assert.equal(result.events.length, 0);
});

test('long reads do not block input to another pane', async t => {
  const { client, children, calls } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  const pending = manager.readEvents(sub.subscription_id, 0, 100, 1_000);
  await client.sendText('terminal_2', 'work');
  assert.equal(calls.at(-1)!.at(-1), 'work');
  children[0]!.update(update('done'));
  assert.equal((await pending).events.length, 1);
});

test('timeout returns no events and cancellation rejects without stopping the collector', async t => {
  const { client } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  assert.equal((await manager.readEvents(sub.subscription_id, 0, 100, 5)).events.length, 0);
  const controller = new AbortController();
  const pending = manager.readEvents(sub.subscription_id, 0, 100, 1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof ZellijError && e.code === 'CANCELLED');
  assert.equal((await manager.readEvents(sub.subscription_id, 0)).status, 'running');
  await assert.rejects(manager.readEvents(sub.subscription_id, 0, 100, 0, controller.signal), /cancelled/);
});

test('closure preserves final events and returns immediately after stream completion', async t => {
  const { client, children } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']); const child = children[0]!;
  child.stdout.write(JSON.stringify(update('final')) + '\n' + JSON.stringify({ event: 'pane_closed', pane_id: 'terminal_1' }));
  child.close();
  const result = await manager.readEvents(sub.subscription_id, 0, 100, 30_000);
  assert.equal(result.status, 'closed'); assert.equal(result.events.at(-1)!.event, 'pane_closed');
});

test('CLI failure, malformed NDJSON and invalid event identity are observable errors', async t => {
  const { client, children } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const first = await manager.subscribe(['terminal_1']);
  children[0]!.stderr.write('session disappeared'); children[0]!.close(2);
  assert.match((await manager.readEvents(first.subscription_id, 0)).error!.message, /session disappeared/);
  for (const input of ['no-json\n', JSON.stringify(update('wrong', 'terminal_99')) + '\n', '{"event":"pane_update","pane_id":"terminal_1"}\n']) {
    const sub = await manager.subscribe(['terminal_1']);
    const child = children.at(-1)!; child.stdout.write(input);
    const result = await manager.readEvents(sub.subscription_id, 0);
    assert.equal(result.status, 'error'); assert.equal(result.error!.code, 'INVALID_OUTPUT');
    assert.deepEqual(child.kills, ['SIGTERM']);
  }
});

test('unsubscribe is idempotent, wakes readers, frees capacity and does not close panes', async t => {
  const { client, children, calls } = setup(); const manager = new SubscriptionManager(client, { maxSubscriptions: 1 }); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  await assert.rejects(manager.subscribe(['terminal_2']), /limit/);
  const pending = manager.readEvents(sub.subscription_id, 0, 100, 30_000);
  manager.unsubscribe(sub.subscription_id); manager.unsubscribe(sub.subscription_id);
  assert.equal((await pending).status, 'stopped');
  await assert.rejects(manager.readEvents(sub.subscription_id, 0), /does not exist/);
  assert.deepEqual(children[0]!.kills, ['SIGTERM']);
  assert.equal(calls.some(args => args[3] === 'close-pane'), false);
  await manager.subscribe(['terminal_2']);
});

test('cursor and limits are validated, shutdown rejects new collectors, session rename updates metadata', async t => {
  const { client } = setup(); const manager = new SubscriptionManager(client); t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  await assert.rejects(manager.readEvents(sub.subscription_id, 1), /ahead/);
  await assert.rejects(manager.readEvents(sub.subscription_id, -1), /cursor/);
  await assert.rejects(manager.readEvents(sub.subscription_id, 0, 0), /limit/);
  await assert.rejects(manager.readEvents(sub.subscription_id, 0, 1, 30_001), /timeout_ms/);
  manager.renamedSession('dev', 'next');
  assert.equal((await manager.readEvents(sub.subscription_id, 0)).session, 'next');
  manager.dispose();
  await assert.rejects(manager.subscribe(['terminal_1']), /shutting down/);
});

test('unsubscribe releases inherited pipe handles even after the collector process exits', async () => {
  const { client, children } = setup();
  const manager = new SubscriptionManager(client);
  const sub = await manager.subscribe(['terminal_1']);
  const child = children[0]!;
  // exitCode can be set before close when inherited streams remain open.
  child.exitCode = 0;
  const pending = manager.readEvents(sub.subscription_id, 0, 100, 30_000);
  manager.unsubscribe(sub.subscription_id);
  assert.equal((await pending).status, 'stopped');
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
  assert.deepEqual(child.kills, []);
  manager.dispose();
});
