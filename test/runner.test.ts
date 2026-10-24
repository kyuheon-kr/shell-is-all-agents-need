import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.ts';
import { ZellijError } from '../src/errors.ts';
import { lstatSync } from 'node:fs';

const code = (expected: string) => (error: unknown) => error instanceof ZellijError && error.code === expected;

test('runner preserves an explicitly configured runtime directory', async () => {
  const env = { ...process.env, XDG_RUNTIME_DIR: '/custom/runtime' };
  const output = await createRunner(process.execPath, env).run(['-p', 'process.env.XDG_RUNTIME_DIR']);
  assert.equal(output.trim(), '/custom/runtime');
});

test('runner recovers the Linux runtime directory for a filtered MCP environment', {
  skip: process.platform !== 'linux',
}, async () => {
  const env = { ...process.env };
  delete env.XDG_RUNTIME_DIR;
  const path = `/run/user/${process.getuid!()}`;
  let expected: string | undefined;
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o700) expected = path;
  } catch {}
  const output = await createRunner(process.execPath, env).run(['-p', 'JSON.stringify(process.env.XDG_RUNTIME_DIR ?? null)']);
  assert.equal(JSON.parse(output), expected ?? null);
  assert.equal(env.XDG_RUNTIME_DIR, undefined);
});

test('runner uses literal argv and scrubs caller pane identity', async () => {
  const runner = createRunner(process.execPath, { ...process.env, ZELLIJ_PANE_ID: '99', ZELLIJ_SESSION_NAME: 'stale' });
  const output = await runner.run(['-e', 'require("node:fs").writeSync(1,JSON.stringify([process.env.ZELLIJ_PANE_ID, process.env.ZELLIJ_SESSION_NAME, process.argv[1]]))', '--', '$(touch nope)\n한글']);
  assert.deepEqual(JSON.parse(output), [null, null, '$(touch nope)\n한글']);
});

test('runner identifies missing executable and CLI failures', async () => {
  await assert.rejects(createRunner('/does/not/exist/zellij').run([]), code('BINARY_NOT_FOUND'));
  await assert.rejects(createRunner(process.execPath).run(['-e', 'require("node:fs").writeSync(2,"failure"); process.exit(2)']),
    (error: unknown) => error instanceof ZellijError && error.code === 'CLI_ERROR' && error.message === 'failure');
});

test('runner timeout kills even a child ignoring SIGTERM', async () => {
  const runner = createRunner(process.execPath);
  await assert.rejects(runner.run(['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 100 }), code('TIMEOUT'));
});

test('runner abort handles both already aborted and running subprocesses', async () => {
  const runner = createRunner(process.execPath);
  const before = new AbortController(); before.abort();
  await assert.rejects(runner.run([], { signal: before.signal }), code('CANCELLED'));
  const controller = new AbortController();
  const result = runner.run(['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(result, code('CANCELLED'));
});

test('runner bounds subprocess output', async () => {
  await assert.rejects(createRunner(process.execPath).run(['-e', 'require("node:fs").writeSync(1,"x".repeat(1000))'], { maxBytes: 20 }), code('RESOURCE_LIMIT'));
});
