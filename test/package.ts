import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('global install, documented command, Codex registration and MCP handshake', { timeout: 240_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shell agents package '));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run through npm run test:package');
  const npm = (args: string[], cwd: string, env = process.env) => execFileSync(process.execPath, [npmCli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
  });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  const session = `package-smoke-${randomUUID()}`;
  const renamed = `${session}-renamed`;
  let connected = false;
  try {
    npm(['pack', '--pack-destination', directory], process.cwd());
    const archives = readdirSync(directory).filter(name => name.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    const consumer = join(directory, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'package-smoke', private: true, type: 'module', allowScripts: { 'node-pty@1.1.0': true },
    }));
    const prefix = join(directory, 'global install');
    const npmMajor = Number(npm(['--version'], consumer).split('.')[0]);
    npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund',
      ...(npmMajor >= 12 ? ['--allow-scripts=node-pty'] : []), join(directory, archives[0]!)], consumer);
    const root = join(npm(['root', '--global', '--prefix', prefix], consumer).trim(), 'shell-is-all-agents-need');
    for (const entry of readdirSync(root)) {
      assert.ok(['bin', 'dist', 'native', 'README.md', 'LICENSE', 'package.json', 'node_modules'].includes(entry), entry);
    }
    for (const file of ['dist/server.js', 'native/WindowsProcesses.cs', 'native/WindowsPipes.cs',
      'native/discover-windows.ps1', 'native/windows-pipes.ps1']) assert.ok(existsSync(join(root, file)), file);
    const bin = join(root, 'bin', 'shell-is-all-agents-need.js');
    assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8', timeout: 15_000 }), /Usage:/i);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = (process.platform === 'win32' ? prefix : join(prefix, 'bin')) + delimiter + path;
    const codexHome = join(directory, 'codex home');
    mkdirSync(codexHome);
    env.CODEX_HOME = codexHome;
    Object.assign(env, { ZELLIJ_SESSION_NAME: session, SHELL_IS_ALL_AGENTS_NEED_SESSIONS: `${session},${renamed}`,
      SHELL_IS_ALL_AGENTS_NEED_SESSION: session });
    const help = execFileSync(process.platform === 'win32' ? (env.ComSpec || env.COMSPEC || 'cmd.exe') : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'shell-is-all-agents-need --help'] : ['-c', 'shell-is-all-agents-need --help'],
      { cwd: consumer, env, encoding: 'utf8', timeout: 15_000 });
    assert.match(help, /Usage: shell-is-all-agents-need/);
    const diagnostic = JSON.parse(execFileSync(process.platform === 'win32' ? (env.ComSpec || env.COMSPEC || 'cmd.exe') : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'shell-is-all-agents-need --doctor'] : ['-c', 'shell-is-all-agents-need --doctor'],
      { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 }));
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.discovery.source, 'environment');
    assert.equal(diagnostic.sessions.default, session);
    const codex = ['exec', '--yes', '--package=@openai/codex@0.164.0', '--', 'codex', 'mcp'];
    npm([...codex, 'add', 'shell-is-all-agents-need', '--', 'shell-is-all-agents-need'], consumer, env);
    const registered = JSON.parse(npm([...codex, 'get', 'shell-is-all-agents-need', '--json'], consumer, env));
    assert.equal(registered.transport.command, 'shell-is-all-agents-need');
    assert.deepEqual(registered.transport.args, []);
    // The real stored registration launches through PATH, including the npm
    // .cmd shim on Windows, rather than bypassing it with node /path/bin.js.
    const transport = new StdioClientTransport({ command: registered.transport.command,
      args: registered.transport.args, cwd: consumer, env, stderr: 'inherit' });
    await client.connect(transport, { timeout: 15_000 });
    connected = true;
    assert.equal(client.getServerVersion()?.version, JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version);
    assert.equal((await client.listTools()).tools.length, 21);
    assert.deepEqual((await client.callTool({ name: 'list_sessions', arguments: {} })).structuredContent, { sessions: [session, renamed] });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      return result.structuredContent as Record<string, unknown>;
    };
    await call('create_session', { name: session });
    let pane: string | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await call('list_panes', { session });
      pane = (result.panes as { pane_id: string }[]).find(row => row.pane_id.startsWith('terminal_'))?.pane_id;
      if (pane) break;
      await delay(100);
    }
    assert.ok(pane, 'Installed package must discover its background session pane');
    await call('capture', { session, pane_id: pane });
    await call('rename_session', { session, name: renamed });
    const after = await call('list_panes', { session: renamed });
    assert.ok((after.panes as { pane_id: string }[]).some(row => row.pane_id === pane));
    if (process.platform === 'win32') {
      const { readWindowsProcesses } = await import(pathToFileURL(join(root, 'dist/windows-discovery.js')).href);
      assert.ok(readWindowsProcesses().length > 0, 'Installed Windows discovery helpers must execute');
    }
  } finally {
    if (connected) {
      // These UUID names belong only to this test, even after a partial rename.
      for (const name of [renamed, session]) {
        await client.callTool({ name: 'close_session', arguments: { session: name } }).catch(() => {});
      }
    }
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
