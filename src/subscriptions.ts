import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fail, integer, ZellijError } from './errors.ts';
import type { ZellijClient } from './zellij.ts';
import { MAX_EVENT_BYTES, MAX_RESULT_BYTES, resultBytes, utf8Tail } from './output.ts';

export type PaneEvent = {
  event: 'pane_update'; pane_id: string; viewport: string[];
  scrollback: string[] | null; is_initial: boolean; truncated?: boolean; original_bytes?: number;
} | { event: 'pane_closed'; pane_id: string };
export type OutputEvent = PaneEvent & { sequence: number; received_at: string };
type Status = 'running' | 'closed' | 'stopped' | 'error';
interface Subscription {
  id: string; session: string; child: ChildProcessWithoutNullStreams;
  events: { value: OutputEvent; bytes: number }[];
  bytes: number; sequence: number; status: Status; error?: { code: string; message: string };
  wake: Set<() => void>; killTimer?: ReturnType<typeof setTimeout>;
}
export interface SubscriptionLimits { maxEvents?: number; maxBytes?: number; maxSubscriptions?: number }

function boundedEvent(value: OutputEvent): OutputEvent {
  if (value.event !== 'pane_update' || resultBytes(value) <= MAX_EVENT_BYTES) return value;
  const originalBytes = Buffer.byteLength(JSON.stringify(value));
  for (let budget = 64 * 1024; budget >= 1; budget = Math.floor(budget / 2)) {
    const clipped = { ...value, viewport: utf8Tail(value.viewport.join('\n'), budget).split('\n'),
      scrollback: value.scrollback === null ? null : utf8Tail(value.scrollback.join('\n'), budget).split('\n'),
      truncated: true, original_bytes: originalBytes };
    if (resultBytes(clipped) <= MAX_EVENT_BYTES) return clipped;
  }
  throw new ZellijError('RESOURCE_LIMIT', 'Pane update metadata exceeds its byte budget');
}

function parseEvent(line: string, ids: ReadonlySet<string>): PaneEvent {
  let value: unknown;
  try { value = JSON.parse(line); } catch { fail('INVALID_OUTPUT', 'Invalid subscription NDJSON'); }
  if (!value || typeof value !== 'object') fail('INVALID_OUTPUT', 'Invalid subscription event');
  const row = value as Record<string, unknown>;
  if (typeof row.pane_id !== 'string' || !ids.has(row.pane_id)) fail('INVALID_OUTPUT', 'Unexpected pane in subscription event');
  if (row.event === 'pane_closed') return { event: row.event, pane_id: row.pane_id };
  const lines = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
  if (row.event !== 'pane_update' || !lines(row.viewport) || !(row.scrollback === null || lines(row.scrollback)) || typeof row.is_initial !== 'boolean') {
    fail('INVALID_OUTPUT', 'Invalid pane_update fields');
  }
  return { event: row.event, pane_id: row.pane_id, viewport: row.viewport, scrollback: row.scrollback, is_initial: row.is_initial };
}

export class SubscriptionManager {
  private readonly client: ZellijClient;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxSubscriptions: number;
  private disposed = false;

  constructor(client: ZellijClient, limits: SubscriptionLimits = {}) {
    this.client = client;
    this.maxEvents = integer(limits.maxEvents ?? 1_000, 'maxEvents', 1);
    this.maxBytes = integer(limits.maxBytes ?? 8 * 1024 * 1024, 'maxBytes', 1);
    this.maxSubscriptions = integer(limits.maxSubscriptions ?? 64, 'maxSubscriptions', 1);
  }

  async subscribe(paneIds: string[], session?: string, scrollbackLines = 0, signal?: AbortSignal) {
    integer(scrollbackLines, 'scrollback_lines', 0, 10_000);
    if (this.disposed) fail('CANCELLED', 'Subscription manager is shutting down');
    const ids = new Set(paneIds);
    const target = await this.client.requirePanes([...ids], session, signal);
    if (signal?.aborted || this.disposed) fail('CANCELLED', 'Operation cancelled');
    if (this.subscriptions.size >= this.maxSubscriptions) fail('RESOURCE_LIMIT', 'Unsubscribe an existing subscription before creating another (limit 64 by default)');
    const args = ['--session', target, 'subscribe', '--format', 'json'];
    for (const id of ids) args.push('--pane-id', id);
    if (scrollbackLines > 0) args.push('--scrollback', String(scrollbackLines));
    const child = this.client.runner.stream(args);
    child.stdin.end();
    const sub: Subscription = {
      id: randomUUID(), session: target, child, events: [], bytes: 0,
      sequence: 0, status: 'running', wake: new Set(),
    };
    this.subscriptions.set(sub.id, sub);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderr = '';
    const notify = () => { for (const wake of [...sub.wake]) wake(); };
    const failed = (error: ZellijError) => {
      if (sub.status !== 'running') return;
      sub.status = 'error';
      sub.error = { code: error.code, message: error.message };
      this.stopChild(sub);
      notify();
    };
    const append = (line: string) => {
      if (!line.trim() || sub.status !== 'running') return;
      try {
        const value = boundedEvent({ ...parseEvent(line, ids), sequence: ++sub.sequence, received_at: new Date().toISOString() });
        const bytes = Buffer.byteLength(JSON.stringify(value));
        sub.events.push({ value, bytes });
        sub.bytes += bytes;
        while (sub.events.length > this.maxEvents || sub.bytes > this.maxBytes) {
          sub.bytes -= sub.events.shift()!.bytes;
        }
        notify();
      } catch (error) {
        failed(error instanceof ZellijError ? error : new ZellijError('INVALID_OUTPUT', String(error)));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (sub.status !== 'running') return;
      pending += decoder.write(chunk);
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
          failed(new ZellijError('RESOURCE_LIMIT', 'Subscription event exceeded 8MiB'));
          return;
        }
        append(line);
        if (sub.status !== 'running') return;
      }
      if (Buffer.byteLength(pending) > 8 * 1024 * 1024) failed(new ZellijError('RESOURCE_LIMIT', 'Subscription event exceeded 8MiB'));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failed(new ZellijError(error.code === 'ENOENT' ? 'BINARY_NOT_FOUND' : 'CLI_ERROR', error.message));
    });
    child.on('close', (code, closeSignal) => {
      if (sub.killTimer) clearTimeout(sub.killTimer);
      if (sub.status !== 'running') return;
      pending += decoder.end();
      if (pending.trim()) append(pending);
      if (sub.status !== 'running') return;
      if (code !== 0) {
        sub.status = 'error';
        sub.error = { code: 'CLI_ERROR', message: stderr.trim() || `Subscription exited: ${code ?? closeSignal}` };
      } else sub.status = 'closed';
      notify();
    });
    return { subscription_id: sub.id, session: target, pane_ids: [...ids], cursor: 0 };
  }

  async readEvents(id: string, cursor: number, limit = 100, timeoutMs = 0, signal?: AbortSignal) {
    integer(cursor, 'cursor'); integer(limit, 'limit', 1, 1_000); integer(timeoutMs, 'timeout_ms', 0, 30_000);
    const sub = this.subscriptions.get(id);
    if (!sub) fail('NOT_FOUND', 'Subscription does not exist; create a new subscription after MCP restart');
    if (cursor > sub.sequence) fail('INVALID_ARGUMENT', 'Cursor is ahead of this subscription');
    if (signal?.aborted) fail('CANCELLED', 'Read cancelled');
    if (sub.sequence <= cursor && sub.status === 'running' && timeoutMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer); sub.wake.delete(wake); signal?.removeEventListener('abort', abort);
        };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new ZellijError('CANCELLED', 'Read cancelled')); };
        const timer = setTimeout(wake, timeoutMs);
        sub.wake.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const first = sub.events[0]?.value.sequence ?? sub.sequence + 1;
    const events: OutputEvent[] = [];
    const response = () => ({
      subscription_id: id, session: sub.session, status: sub.status,
      events, next_cursor: events.at(-1)?.sequence ?? Math.max(cursor, first - 1),
      first_available_cursor: first - 1, gap: cursor < first - 1,
      has_more: (events.at(-1)?.sequence ?? Math.max(cursor, first - 1)) < sub.sequence,
      ...(sub.error ? { error: sub.error } : {}),
    });
    let bytes = resultBytes(response()) + 256; // Cursor digit growth and separators.
    for (const event of sub.events) {
      if (event.value.sequence <= cursor) continue;
      if (events.length >= limit) break;
      const weight = resultBytes(event.value);
      if (bytes + weight > MAX_RESULT_BYTES) break;
      events.push(event.value);
      bytes += weight;
    };
    return response();
  }

  unsubscribe(id: string): { subscription_id: string; status: 'stopped' } {
    const sub = this.subscriptions.get(id);
    if (sub) {
      sub.status = 'stopped';
      this.stopChild(sub);
      sub.events = []; sub.bytes = 0;
      for (const wake of [...sub.wake]) wake();
      this.subscriptions.delete(id);
    }
    return { subscription_id: id, status: 'stopped' };
  }

  private stopChild(sub: Subscription): void {
    if (sub.child.exitCode !== null || sub.child.signalCode !== null) return;
    sub.child.kill('SIGTERM');
    sub.killTimer ??= setTimeout(() => sub.child.kill('SIGKILL'), 250);
    sub.killTimer.unref();
  }

  renamedSession(previous: string, next: string): void {
    for (const sub of this.subscriptions.values()) if (sub.session === previous) sub.session = next;
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id);
  }
}
