import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('published tarball installs and serves MCP from node_modules', { timeout: 180_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shell-agents-package-'));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run through npm run test:package');
  const npm = (args: string[], cwd: string) => execFileSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
  });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  try {
    npm(['pack', '--pack-destination', directory], process.cwd());
    const archives = readdirSync(directory).filter(name => name.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    const consumer = join(directory, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'package-smoke', private: true, type: 'module', allowScripts: { 'node-pty@1.1.0': true },
    }));
    npm(['install', '--omit=dev', '--no-audit', '--no-fund', join(directory, archives[0]!)], consumer);
    const root = join(consumer, 'node_modules', 'shell-is-all-agents-need');
    for (const entry of readdirSync(root)) {
      assert.ok(['bin', 'dist', 'native', 'README.md', 'LICENSE', 'package.json', 'node_modules'].includes(entry), entry);
    }
    for (const file of ['dist/server.js', 'native/WindowsProcesses.cs', 'native/WindowsPipes.cs',
      'native/discover-windows.ps1', 'native/windows-pipes.ps1']) assert.ok(existsSync(join(root, file)), file);
    const bin = join(root, 'bin', 'shell-is-all-agents-need.js');
    assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8', timeout: 15_000 }), /Usage:/i);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    Object.assign(env, { ZELLIJ_SESSION_NAME: 'package-smoke', SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'package-smoke',
      SHELL_IS_ALL_AGENTS_NEED_SESSION: 'package-smoke' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin], cwd: consumer, env, stderr: 'inherit' });
    await client.connect(transport, { timeout: 15_000 });
    assert.equal(client.getServerVersion()?.version, JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version);
    assert.equal((await client.listTools()).tools.length, 21);
    assert.deepEqual((await client.callTool({ name: 'list_sessions', arguments: {} })).structuredContent, { sessions: ['package-smoke'] });
    if (process.platform === 'win32') {
      const { readWindowsProcesses } = await import(pathToFileURL(join(root, 'dist/windows-discovery.js')).href);
      assert.ok(readWindowsProcesses().length > 0, 'Installed Windows discovery helpers must execute');
    }
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
