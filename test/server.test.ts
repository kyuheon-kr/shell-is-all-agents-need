import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.ts';
import { setup, update } from './helpers.ts';

test('MCP handshake, schemas, structured errors and concurrent read/input calls', async t => {
  try {
    import.meta.resolve('@modelcontextprotocol/server');
    import.meta.resolve('@modelcontextprotocol/client');
    import.meta.resolve('zod/v4');
  } catch {
    t.skip('MCP SDK/Zod dependencies are not installed; run npm install');
    return;
  }
  const { Client } = await import('@modelcontextprotocol/client');
  const { createServer } = await import('../src/server.ts');
  const fixture = setup();
  const application = createServer(readConfig({ ZELLIJ_SESSION_NAME: 'dev' }), fixture.runner);
  // A minimal in-memory transport avoids subprocess stdio and exercises real SDK dispatch.
  class Transport {
    peer!: Transport;
    onmessage?: (message: unknown) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    closed = false;
    async start() {}
    async send(message: unknown) { queueMicrotask(() => this.peer.onmessage?.(message)); }
    async close() {
      if (this.closed) return;
      this.closed = true; this.onclose?.();
      if (!this.peer.closed) { this.peer.closed = true; this.peer.onclose?.(); }
    }
  }
  const left = new Transport(); const right = new Transport();
  left.peer = right; right.peer = left;
  const host = new Client({ name: 'shell-is-all-agents-need-test', version: '1.0.0' });
  t.after(async () => { application.subscriptions.dispose(); await host.close(); await application.server.close(); });
  await application.server.connect(left);
  await host.connect(right);
  const tools = await host.listTools();
  assert.equal(tools.tools.length, 21);
  assert.equal(tools.tools.find(tool => tool.name === 'capture')?.annotations?.readOnlyHint, true);
  const sessions = await host.callTool({ name: 'list_sessions', arguments: {} });
  assert.deepEqual(sessions.structuredContent, { sessions: ['dev'] });
  const denied = await host.callTool({ name: 'capture', arguments: { pane_id: 'terminal_1', session: 'other' } });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'ACCESS_DENIED');
  const invalid = await host.callTool({ name: 'capture', arguments: { pane_id: 'terminal_1', unexpected: true } });
  assert.equal(invalid.isError, true);
  const subscribed = await host.callTool({ name: 'subscribe', arguments: { pane_ids: ['terminal_1'] } });
  const sub = subscribed.structuredContent as { subscription_id: string; cursor: number };
  const pending = host.callTool({ name: 'read_events', arguments: { subscription_id: sub.subscription_id, cursor: sub.cursor, timeout_ms: 1000 } });
  const sent = await host.callTool({ name: 'send_text', arguments: { pane_id: 'terminal_2', text: 'hi', enter: true } });
  assert.notEqual(sent.isError, true);
  fixture.children[0]!.update(update('observed'));
  const read = await pending;
  assert.equal((read.structuredContent as { events: unknown[] }).events.length, 1);
  await host.callTool({ name: 'unsubscribe', arguments: { subscription_id: sub.subscription_id } });
  assert.deepEqual(fixture.children[0]!.kills, ['SIGTERM']);
});
