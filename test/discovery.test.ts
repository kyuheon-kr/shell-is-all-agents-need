import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAncestorSession } from '../src/discovery.ts';
import { readRuntimeConfig } from '../src/config.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function tree(entries: Record<number, { parent: number; env?: string; uid?: number }>) {
  const paths: string[] = [];
  const read = (path: string) => {
    paths.push(path);
    const match = /^\/proc\/(\d+)\/(status|environ)$/u.exec(path)!;
    const entry = entries[Number(match[1])];
    if (!entry) throw new Error('process gone');
    if (match[2] === 'status') return `Name:\thost\nPPid:\t${entry.parent}\nUid:\t${entry.uid ?? 1000}\t${entry.uid ?? 1000}\t1000\t1000\n`;
    if (entry.env === undefined) throw new Error('permission denied');
    return entry.env;
  };
  return { paths, read, platform: 'linux', parentPid: 50, uid: 1000 };
}

test('finds the parent Codex session despite an MCP environment allowlist', () => {
  const fixture = tree({ 50: { parent: 40, env: 'PATH=/bin\0ZELLIJ_SESSION_NAME=dev\0OTHER=unused\0' } });
  assert.equal(discoverAncestorSession(fixture), 'dev');
  const config = readRuntimeConfig({}, () => discoverAncestorSession(fixture));
  assert.equal(config.defaultSession, 'dev');
  assert.deepEqual([...config.allowedSessions], ['dev']);
});

test('walks through wrappers and protected environments; prefers the nearest session', () => {
  const fixture = tree({
    50: { parent: 40 },
    40: { parent: 30, env: 'PATH=/bin\0' },
    30: { parent: 20, env: 'ZELLIJ_SESSION_NAME=inner\0' },
    20: { parent: 1, env: 'ZELLIJ_SESSION_NAME=outer\0' },
  });
  assert.equal(discoverAncestorSession(fixture), 'inner');
  assert.equal(fixture.paths.includes('/proc/20/environ'), false);
});

test('inherited session bypasses discovery', () => {
  const unexpected = () => { throw new Error('discovery should not run'); };
  assert.equal(readRuntimeConfig({ ZELLIJ_SESSION_NAME: 'direct' }, unexpected).defaultSession, 'direct');
});

test('detected current session is allowed alongside configured sessions and defaults', () => {
  const config = readRuntimeConfig({ SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'work', SHELL_IS_ALL_AGENTS_NEED_SESSION: 'work' }, () => 'dev');
  assert.deepEqual([...config.allowedSessions], ['work', 'dev']);
  assert.equal(config.defaultSession, 'work');
  const additional = readRuntimeConfig({ SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'work' }, () => 'dev');
  assert.equal(additional.defaultSession, 'dev');
  assert.deepEqual([...additional.allowedSessions], ['work', 'dev']);
});

test('inspects a same-user host at PID 1 inside a PID namespace', () => {
  const fixture = tree({
    50: { parent: 1, env: 'PATH=/bin\0' },
    1: { parent: 0, env: 'ZELLIJ_SESSION_NAME=namespaced\0' },
  });
  assert.equal(discoverAncestorSession(fixture), 'namespaced');
  assert.equal(discoverAncestorSession({ ...fixture, parentPid: 1 }), 'namespaced');
});

test('discovery does not mutate environment and no session grants no access', () => {
  const env = { PATH: '/bin' };
  assert.equal(readRuntimeConfig(env, () => 'dev').defaultSession, 'dev');
  assert.deepEqual(env, { PATH: '/bin' });
  assert.equal(readRuntimeConfig({}, () => undefined).allowedSessions.size, 0);
});

test('stops at other users, vanished processes, invalid names and process cycles', () => {
  for (const fixture of [
    tree({ 50: { parent: 40, uid: 0, env: 'ZELLIJ_SESSION_NAME=other\0' } }),
    tree({}),
    tree({ 50: { parent: 40, env: 'ZELLIJ_SESSION_NAME=../bad\0' } }),
    tree({ 50: { parent: 50, env: '' } }),
    tree({ 50: { parent: 1, env: 'ZELLIJ_SESSION_NAME=\0' } }),
  ]) assert.equal(discoverAncestorSession(fixture), undefined);
});

test('non-Linux platforms do not read procfs and ancestor walks are bounded', () => {
  assert.equal(discoverAncestorSession({ platform: 'darwin', read: () => { throw new Error('must not read'); } }), undefined);
  const entries = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [50 - i, { parent: 49 - i, env: '' }]));
  const fixture = tree(entries);
  assert.equal(discoverAncestorSession(fixture), undefined);
  assert.equal(fixture.paths.filter(path => path.endsWith('/status')).length, 32);
});

test('real parent process supplies session to a child with a filtered environment', { skip: !['linux', 'win32'].includes(process.platform), timeout: 30_000 }, async () => {
  const configUrl = new URL('../src/config.ts', import.meta.url).href;
  const childCode = `import { readRuntimeConfig } from ${JSON.stringify(configUrl)}; import { writeSync } from 'node:fs'; const config = readRuntimeConfig(); writeSync(1, JSON.stringify({ session: config.defaultSession, allowed: [...config.allowedSessions] }));`;
  const parentCode = `const { spawn } = require('node:child_process'); const env = { ...process.env }; delete env.ZELLIJ_SESSION_NAME; const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childCode)}], { env, stdio: ['ignore', 'inherit', 'inherit'] }); child.on('error', () => process.exitCode = 1); child.on('close', code => process.exitCode = code ?? 1);`;
  const { stdout: result } = await promisify(execFile)(process.execPath, ['-e', parentCode], { env: { ...process.env, ZELLIJ_SESSION_NAME: 'discovery-test-session' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { session: 'discovery-test-session', allowed: ['discovery-test-session'] });
});

test('shared daemon discovery accepts only a unique same-user Codex client session', async () => {
  const { discoverClientSession } = await import('../src/discovery.ts');
  function fixture(entries: Record<string, { session?: string; uid?: number; command?: string }>) {
    return {
      platform: 'linux', uid: 1000, pids: () => Object.keys(entries),
      read(path: string) {
        const [, pid, file] = /^\/proc\/(\d+)\/(.*)$/u.exec(path)!;
        const entry = entries[pid!]!;
        if (file === 'status') return `Uid:\t${entry.uid ?? 1000}\t${entry.uid ?? 1000}\n`;
        if (file === 'cmdline') return entry.command ?? '/opt/bin/codex\0resume\0';
        if (entry.session === undefined) throw new Error('inaccessible environment');
        return `ZELLIJ_SESSION_NAME=${entry.session}\0`;
      },
    };
  }
  assert.equal(discoverClientSession(fixture({ '1': { session: 'dev' }, '2': { session: 'dev' } })), 'dev');
  assert.equal(discoverClientSession(fixture({ '1': { session: 'dev' }, '2': { session: 'work' } })), undefined);
  assert.equal(discoverClientSession(fixture({ '1': { session: 'other', uid: 0 } })), undefined);
  assert.equal(discoverClientSession(fixture({ '1': { session: 'other', command: '/bin/sh\0' } })), undefined);
  assert.equal(discoverClientSession(fixture({ '1': { session: 'old', command: '/opt/codex\0app-server\0' } })), undefined);
  assert.equal(discoverClientSession(fixture({ '1': {}, '2': { session: '../bad' }, '3': { session: 'dev' } })), 'dev');
  assert.equal(discoverClientSession({ platform: 'darwin', pids: () => { throw new Error('must not scan'); } }), undefined);
  assert.equal(discoverClientSession({ platform: 'linux', uid: 1000, pids: () => { throw new Error('no proc'); } }), undefined);
});
