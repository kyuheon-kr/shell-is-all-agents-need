import test from 'node:test';
import assert from 'node:assert/strict';
import { readCliConfig as parseCliConfig } from '../src/cli.ts';

const readCliConfig = (args: string[], env: NodeJS.ProcessEnv) => parseCliConfig(args, env, () => undefined);

test('explicit sessions include the current session and preserve the first default', () => {
  const options = readCliConfig(['--allowed-sessions', ' a,b,a,c '], {
    ZELLIJ_SESSION_NAME: 'outside',
    SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'unrelated',
    SHELL_IS_ALL_AGENTS_NEED_SESSION: 'outside',
    SHELL_IS_ALL_AGENTS_NEED_ZELLIJ_BIN: '/custom/zellij',
  });
  assert.ok('config' in options);
  assert.deepEqual([...options.config.allowedSessions], ['a', 'b', 'c', 'outside']);
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

test('explicit sessions recover the current session through ancestor discovery', () => {
  const options = parseCliConfig(['--allowed-sessions=a,b', '--session=b'], {}, () => 'current');
  assert.ok('config' in options);
  assert.deepEqual([...options.config.allowedSessions], ['a', 'b', 'current']);
  assert.equal(options.config.defaultSession, 'b');
});

test('an inherited current session bypasses discovery and is deduplicated', () => {
  const options = parseCliConfig(['--allowed-sessions=a,b'], { ZELLIJ_SESSION_NAME: 'a' }, () => {
    throw new Error('discovery must not run');
  });
  assert.ok('config' in options);
  assert.deepEqual([...options.config.allowedSessions], ['a', 'b']);
});
