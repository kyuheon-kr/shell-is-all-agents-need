import test from 'node:test';
import assert from 'node:assert/strict';
import { readCliConfig } from '../src/cli.ts';

test('explicit sessions set the exact scope and first default despite inherited environment', () => {
  const options = readCliConfig(['--allowed-sessions', ' a,b,a,c '], {
    ZELLIJ_SESSION_NAME: 'outside',
    SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'outside',
    SHELL_IS_ALL_AGENTS_NEED_SESSION: 'outside',
    SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN: '/custom/zellij',
  });
  assert.ok('config' in options);
  assert.deepEqual([...options.config.allowedSessions], ['a', 'b', 'c']);
  assert.equal(options.config.defaultSession, 'a');
  assert.equal(options.config.binary, '/custom/zellij');
});

test('explicit default supports equals syntax and must be allowed', () => {
  const options = readCliConfig(['--allowed-sessions=a,b,c', '--session=b'], {});
  assert.ok('config' in options);
  assert.equal(options.config.defaultSession, 'b');
  assert.throws(() => readCliConfig(['--allowed-sessions=a', '--session=b'], {}), /must appear/u);
});

test('invalid flags and malformed session lists fail instead of falling back to discovery', () => {
  for (const args of [
    ['--allowed-sessions'], ['--allowed-sessions='], ['--allowed-sessions=a,,b'],
    ['--allowed-sessions=../bad'], ['--allowed-sessions=-bad'],
    ['--allowd-sessions=a'], ['unexpected'], ['--session=a'],
  ]) assert.throws(() => readCliConfig(args, {}));
});

test('no flags preserve environment configuration; help needs no session', () => {
  const options = readCliConfig([], { ZELLIJ_SESSION_NAME: 'dev' });
  assert.ok('config' in options);
  assert.equal(options.config.defaultSession, 'dev');
  assert.deepEqual(readCliConfig(['--help'], {}), { help: true });
});
