import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESULT_BYTES, resultBytes, utf8Tail } from '../src/output.ts';
import { SubscriptionManager } from '../src/subscriptions.ts';
import { setup, update } from './helpers.ts';

test('capture budgets its complete wire response and preserves a valid Unicode tail', async () => {
  const text = '\u0001"\\한글😀'.repeat(200_000) + 'FINAL😀';
  const { client } = setup(args => args[3] === 'dump-screen' ? text : undefined);
  const output = await client.capture('terminal_1', { ansi: true });
  assert.equal(output.truncated, true);
  assert.ok(output.text.endsWith('FINAL😀'));
  assert.ok(!output.text.includes('\ufffd'));
  assert.ok(resultBytes(output) <= MAX_RESULT_BYTES);
  assert.equal(utf8Tail('a😀', 3), '');
  assert.equal(utf8Tail('a😀', 4), '😀');
});

test('a 6MiB pane update remains readable within a normal MCP transport budget', async t => {
  const { client, children } = setup();
  const manager = new SubscriptionManager(client);
  t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  children[0]!.update(update('x'.repeat(6 * 1024 * 1024) + 'END'));
  const output = await manager.readEvents(sub.subscription_id, 0);
  assert.equal(output.events.length, 1);
  const event = output.events[0]!;
  assert.equal(event.event, 'pane_update');
  if (event.event !== 'pane_update') return;
  assert.equal(event.truncated, true);
  assert.ok(event.original_bytes! > 6 * 1024 * 1024);
  assert.ok(event.viewport.at(-1)!.endsWith('END'));
  assert.ok(resultBytes(output) <= MAX_RESULT_BYTES);
  assert.equal(output.gap, false);
});

test('byte pagination resumes without dropping or duplicating event sequences', async t => {
  const { client, children } = setup();
  const manager = new SubscriptionManager(client);
  t.after(() => manager.dispose());
  const sub = await manager.subscribe(['terminal_1']);
  for (let i = 0; i < 16; i++) children[0]!.update(update('"\\한글😀'.repeat(8000) + i));
  let cursor = 0;
  const sequences: number[] = [];
  let pages = 0;
  for (;;) {
    const output = await manager.readEvents(sub.subscription_id, cursor);
    assert.ok(resultBytes(output) <= MAX_RESULT_BYTES);
    assert.equal(output.gap, false);
    assert.ok(output.events.length > 0);
    sequences.push(...output.events.map(event => event.sequence));
    cursor = output.next_cursor;
    pages++;
    if (!output.has_more) break;
  }
  assert.ok(pages > 1);
  assert.deepEqual(sequences, Array.from({ length: 16 }, (_, i) => i + 1));
});
