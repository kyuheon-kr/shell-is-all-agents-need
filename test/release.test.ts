import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion, prepareRelease } from '../scripts/release-prepare.mjs';
import { validateVersion } from '../scripts/release-state.mjs';

test('release preparation changes exactly the requested semver component', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.throws(() => nextVersion('1.2.3', 'prerelease'));
  assert.throws(() => nextVersion('1.2.3-rc.1', 'patch'));
});

test('release confirmation rejects a different version, prereleases, and shell input', () => {
  validateVersion('1.2.3', '1.2.3');
  for (const value of ['1.2.4', '1.2.3-rc.1', '01.2.3', '$(echo example)', undefined]) {
    assert.throws(() => validateVersion('1.2.3', value));
  }
});

function preparation(overrides: Record<string, string> = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const replies: Record<string, string> = {
    'status --porcelain': '', 'branch --show-current': 'main',
    'rev-parse HEAD': 'abc123', 'rev-parse origin/main': 'abc123',
    'view example dist-tags.latest --prefer-online': '1.2.3', ...overrides,
  };
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    return replies[(command === process.execPath ? args.slice(1) : args).join(' ')] ?? '';
  };
  return { calls, execute: () => prepareRelease({ args: ['patch'], manifest: { name: 'example', version: '1.2.3' }, npmCli: '/npm-cli.js', run }) };
}

test('release preparation never pushes main or creates a release tag', () => {
  const { execute, calls } = preparation();
  execute();
  assert.deepEqual(calls.filter(call => call.command === 'git' && call.args[0] === 'push').map(call => call.args),
    [['push', '--set-upstream', 'origin', 'release/v1.2.4']]);
  assert.ok(calls.some(call => call.command === 'gh' && call.args.join(' ').includes('pr create --base main --head release/v1.2.4')));
  assert.ok(calls.some(call => call.args.includes('--no-git-tag-version')));
  assert.ok(!calls.some(call => call.args[0] === 'tag' || call.args[0] === 'publish'));
});

test('unsafe release starting states fail before creating a branch, committing, or pushing', () => {
  for (const overrides of [
    { 'status --porcelain': ' M README.md' }, { 'branch --show-current': 'feature/example' },
    { 'rev-parse origin/main': 'newer' }, { 'view example dist-tags.latest --prefer-online': '1.2.2' },
  ]) {
    const { execute, calls } = preparation(overrides);
    assert.throws(execute);
    assert.ok(!calls.some(call => call.command === 'git' && ['switch', 'commit', 'push'].includes(call.args[0]!)));
  }
});
