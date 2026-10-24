import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.ts';
import { ZellijError } from '../src/errors.ts';
import { lstatSync } from 'node:fs';
import { pasteChunks } from '../src/zellij.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWindowsExecutable } from '../src/windows-console.ts';
import { win32 } from 'node:path';

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

test('Windows argv preserves large Unicode pastes with quotes and backslashes', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const text = '한글😀"\\\n'.repeat(4000);
  const parts: string[] = [];
  for (const chunk of pasteChunks(text)) {
    const output = await createRunner(process.execPath).run(['-e', 'require("node:fs").writeSync(1,JSON.stringify(process.argv[1]))', '--', chunk]);
    parts.push(JSON.parse(output));
  }
  assert.equal(parts.join(''), text);
});

test('Windows environment scrubbing is case insensitive', { skip: process.platform !== 'win32' }, async () => {
  const output = await createRunner(process.execPath, {
    ...process.env, zellij_pane_id: '99', zellij_session_name: 'stale',
  }).run(['-e', 'require("node:fs").writeSync(1,JSON.stringify([process.env.ZELLIJ_PANE_ID,process.env.ZELLIJ_SESSION_NAME]))']);
  assert.deepEqual(JSON.parse(output), [null, null]);
});

test('Windows console resolves bare names, relative paths and the last PATH entry', { skip: process.platform !== 'win32' }, () => {
  const directory = win32.dirname(process.execPath);
  const file = win32.basename(process.execPath);
  const name = file.replace(/\.exe$/iu, '');
  assert.equal(resolveWindowsExecutable(name, { pAtH: `C:\\missing;"${directory}"` }), process.execPath);
  assert.equal(resolveWindowsExecutable(`.\\${file}`, {}, directory), process.execPath);
  assert.equal(resolveWindowsExecutable(process.execPath.replace(/\.exe$/iu, ''), {}), process.execPath);
  assert.equal(resolveWindowsExecutable('missing-zellij-executable', {}), 'missing-zellij-executable');
});

test('Windows console bootstrap preserves argv, bounds output, cancels and releases workers', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const module = new URL('../src/windows-console.ts', import.meta.url).href;
  // A separate host also verifies that console workers do not keep Node alive.
  // It avoids forwarding node:test's CLI flags to node-pty's own helper process.
  const source = `
    import assert from 'node:assert/strict';
    import { writeSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { runWindowsConsole } from ${JSON.stringify(module)};
    const run = (args, options = {}) => runWindowsConsole(process.execPath, args, process.env, options);
    const literal = '한글 " & echo unsafe \\\\';
    const directory = mkdtempSync(join(tmpdir(), 'shell-agents-console-'));
    try {
    const file = join(directory, 'argv.json');
    await run(['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv[2]))', '--', file, literal]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')), literal);
    const code = expected => error => error.code === expected;
    await assert.rejects(run(['-e', 'process.exit(7)']), code('CLI_ERROR'));
    await assert.rejects(run(['-e', 'setInterval(()=>{},1000)'], {timeoutMs: 300}), code('TIMEOUT'));
    await assert.rejects(run(['-e', 'require("node:fs").writeSync(1,"x".repeat(10000))'], {maxBytes: 20}), code('RESOURCE_LIMIT'));
    const controller = new AbortController();
    const pending = run(['-e', 'setInterval(()=>{},1000)'], {signal: controller.signal});
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, code('CANCELLED'));
    await assert.rejects(run([], {signal: controller.signal}), code('CANCELLED'));
    writeSync(1, 'WINDOWS_CONSOLE_OK');
    } finally { rmSync(directory, {recursive:true, force:true}); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 25_000 });
  assert.equal(stdout, 'WINDOWS_CONSOLE_OK');
});
