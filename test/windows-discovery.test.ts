import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { discoverWindowsSession, readWindowsProcesses } from '../src/windows-discovery.ts';
import type { WindowsProcess } from '../src/windows-discovery.ts';

const row = (pid: number, parentPid: number, session: string | null = null, isClient = false): WindowsProcess => ({ pid, parentPid, session, isClient });

test('Windows discovery prefers the nearest same-user ancestor over other clients', () => {
  const rows = [row(10, 20), row(20, 30, 'inner'), row(30, 0, 'outer'), row(40, 0, 'unrelated', true)];
  assert.equal(discoverWindowsSession(10, () => rows), 'inner');
  assert.equal(discoverWindowsSession(30, () => rows), 'outer');
});

test('Windows shared daemon requires a unique Codex client session', () => {
  assert.equal(discoverWindowsSession(10, () => [row(20, 0, 'dev', true), row(30, 0, 'dev', true)]), 'dev');
  assert.equal(discoverWindowsSession(10, () => [row(20, 0, 'dev', true), row(30, 0, 'other', true)]), undefined);
  assert.equal(discoverWindowsSession(10, () => [row(20, 0, 'dev', false)]), undefined);
  assert.equal(discoverWindowsSession(10, () => [row(20, 0, null, true), row(30, 0, '../bad', true)]), undefined);
  assert.equal(discoverWindowsSession(10, () => [row(20, 0, '한글 session', true)]), '한글 session');
});

test('Windows discovery handles denied access, vanished parents, cycles and bounded ancestry', () => {
  assert.equal(discoverWindowsSession(10, () => { throw new Error('denied'); }), undefined);
  assert.equal(discoverWindowsSession(10, () => []), undefined);
  assert.equal(discoverWindowsSession(10, () => [row(10, 10)]), undefined);
  assert.equal(discoverWindowsSession(10, () => [row(10, 20, '../bad'), row(20, 0, 'outer')]), undefined);
  const rows = Array.from({ length: 34 }, (_, i) => row(i + 1, i + 2, i === 32 ? 'too-far' : null));
  assert.equal(discoverWindowsSession(1, () => rows), undefined);
});

test('native Windows helper reads real Codex clients, excludes daemons and detects ambiguity', {
  skip: process.platform !== 'win32', timeout: 60_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shell-agents-'));
  const executable = join(directory, 'codex.exe');
  await copyFile(process.execPath, executable);
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill(); await closed;
    }));
    await rm(directory, { recursive: true, force: true });
  });
  async function start(session: string, daemon = false) {
    const child = spawn(executable, ['-e', 'require("node:fs").writeSync(1,"ready");setInterval(()=>{},1000)', '--', ...(daemon ? ['app-server'] : [])], {
      env: { ...process.env, ZELLIJ_SESSION_NAME: session }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(child);
    await once(child.stdout!, 'data');
    return child.pid!;
  }
  const first = await start('한글 session');
  const second = await start('한글 session');
  const daemon = await start('ignored', true);
  let rows = readWindowsProcesses().filter(row => [first, second, daemon].includes(row.pid));
  assert.equal(rows.length, 3, 'the native helper must return the test processes');
  assert.equal(rows.find(row => row.pid === first)?.session, '한글 session');
  assert.equal(rows.find(row => row.pid === daemon)?.isClient, false);
  assert.equal(discoverWindowsSession(0, () => rows), '한글 session');
  const third = await start('other');
  rows = readWindowsProcesses().filter(row => [first, second, third].includes(row.pid));
  assert.equal(rows.length, 3);
  assert.equal(discoverWindowsSession(0, () => rows), undefined);
});
