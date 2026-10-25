import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/doctor.ts';
import { setup } from './helpers.ts';
import { ZellijError } from '../src/errors.ts';
import { inspectWindowsSession } from '../src/windows-discovery.ts';
import { readCliConfig } from '../src/cli.ts';

test('doctor reports its session source and configuration without mutating or exposing secrets', async () => {
  const { runner, calls } = setup();
  const report = await diagnose(['--allowed-sessions=dev,other', '--session=other'], {
    env: { PRIVATE_TOKEN: 'must-not-appear', SHELL_IS_ALL_AGENTS_NEED_TIMEOUT_MS: '0' }, platform: 'linux', runner,
    discover: () => ({ source: 'shared-client', session: 'dev' }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.discovery.source, 'shared-client');
  assert.deepEqual(report.sessions, { default: 'other', allowed: ['dev', 'other'] });
  assert.equal(report.control_timeout_ms, 0);
  assert.ok(!JSON.stringify(report).includes('must-not-appear'));
  assert.ok(calls.every(args => args[0] === '--version' || args[0] === 'list-sessions'));
  assert.deepEqual(readCliConfig(['--doctor', '--allowed-sessions=dev'], {}), { doctor: true, args: ['--allowed-sessions=dev'] });
});

test('doctor explains ambiguity, missing binaries, invalid configuration and deadlines', async () => {
  const { runner } = setup(args => { if (args[0] === '--version') throw new ZellijError('BINARY_NOT_FOUND', 'missing zellij'); });
  const report = await diagnose([], { env: {}, platform: 'linux', runner,
    discover: () => ({ source: 'ambiguous', candidates: ['dev', 'work'] }) });
  assert.equal(report.ok, false);
  assert.equal(report.sessions.default, null);
  assert.ok(report.checks.some(check => check.name === 'zellij' && check.status === 'error'));
  assert.ok(report.next_steps.some(step => step.includes('--allowed-sessions')));
  const invalid = await diagnose(['--allowed-sessions=../bad'], { env: { SHELL_IS_ALL_AGENTS_NEED_TIMEOUT_MS: '-1' }, platform: 'linux',
    discover: () => ({ source: 'unresolved' }) });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.checks.some(check => check.name === 'configuration' && check.status === 'error'));
  assert.ok(invalid.checks.some(check => check.name === 'control_timeout' && check.status === 'error'));
});

test('doctor rejects unsupported Zellij and diagnoses native Windows prerequisites', async () => {
  const { runner } = setup(args => args[0] === '--version' ? 'zellij 0.44.0' : undefined);
  const report = await diagnose([], { env: { ZELLIJ_SESSION_NAME: 'dev' }, platform: 'win32', runner,
    discover: () => ({ source: 'environment', session: 'dev' }),
    windows: async () => ({ powershell: true, helpers: false, node_pty: false }) });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some(check => check.name === 'zellij' && check.message.includes('0.45.1')));
  assert.ok(report.next_steps.some(step => step.includes('--allow-scripts=node-pty')));
  const ambiguous = inspectWindowsSession(10, () => [
    { pid: 20, parentPid: 0, isClient: true, session: 'dev' },
    { pid: 30, parentPid: 0, isClient: true, session: 'work' },
  ]);
  assert.deepEqual(ambiguous, { source: 'ambiguous', candidates: ['dev', 'work'] });
});
