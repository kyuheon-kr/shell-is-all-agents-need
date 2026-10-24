import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, SessionScope } from '../src/config.ts';
import { ZellijClient } from '../src/zellij.ts';
import { ZellijError } from '../src/errors.ts';
import { setup } from './helpers.ts';

const code = (expected: string) => (error: unknown) => error instanceof ZellijError && error.code === expected;

test('scope snapshots startup session, preserves explicit default and rejects an unlisted default', () => {
  const env = { ZELLIJ_SESSION_NAME: 'dev', SHELL_IS_ALL_AGENTS_NEED_SESSIONS: ' other, next,other ', SHELL_IS_ALL_AGENTS_NEED_SESSION: 'other' };
  const config = readConfig(env); const scope = new SessionScope(config);
  env.ZELLIJ_SESSION_NAME = 'changed';
  assert.equal(scope.resolve(), 'other');
  assert.equal(scope.resolve('dev'), 'dev');
  assert.throws(() => scope.resolve('changed'), code('ACCESS_DENIED'));
  assert.throws(() => readConfig({ SHELL_IS_ALL_AGENTS_NEED_SESSION: 'other' }), code('ACCESS_DENIED'));
  assert.throws(() => new SessionScope(readConfig({})).resolve(), code('NO_DEFAULT_SESSION'));
});

test('invalid names and IDs are rejected before executing CLI', async () => {
  for (const value of ['../dev', '-dev', 'dev\nother', '.', 'x\\y']) {
    assert.throws(() => readConfig({ ZELLIJ_SESSION_NAME: value }), code('INVALID_ARGUMENT'));
  }
  const { client, calls } = setup();
  await assert.rejects(client.sendText('1', 'hi'), code('INVALID_ARGUMENT'));
  await assert.rejects(client.createPane(-1, {}), code('INVALID_ARGUMENT'));
  await assert.rejects(client.sendText('terminal_1', 'a\0b'), code('INVALID_ARGUMENT'));
  await assert.rejects(client.sendText('terminal_1', '한'.repeat(30_000)), code('INVALID_ARGUMENT'));
  await assert.rejects(client.sendKeys('terminal_1', []), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('version check rejects unsupported versions and prereleases', async () => {
  for (const version of ['0.44.0', '0.45.0', '0.45.1-dev', 'invalid']) {
    const { client } = setup(args => args[0] === '--version' ? `zellij ${version}` : undefined);
    await assert.rejects(client.checkVersion(), code(version === 'invalid' ? 'INVALID_OUTPUT' : 'UNSUPPORTED_VERSION'));
  }
  await setup().client.checkVersion();
});

test('list returns all configured allowed sessions regardless of running status', async () => {
  const { client } = setup(args => args[0] === 'list-sessions' ? 'dev [Created 1s ago] (current)\nsecret [Created 2s ago] \nother [Created 3s ago] \n' : undefined);
  assert.deepEqual(await client.listSessions(), { sessions: ['other', 'next', 'new', 'dev'] });
  await assert.rejects(client.listTabs('secret'), code('ACCESS_DENIED'));
  await assert.rejects(client.listTabs('new'), code('NOT_FOUND'));
});

test('exited sessions are excluded and rejected before sending actions', async () => {
  const { client, calls } = setup(args => args[0] === 'list-sessions'
    ? 'dev [Created 12m 28s ago] (EXITED - attach to resurrect)\nother [Created 1s ago] \n'
    : undefined);
  assert.deepEqual(await client.listSessions(), { sessions: ['other', 'next', 'new', 'dev'] });
  await assert.rejects(client.listTabs(), code('NOT_FOUND'));
  assert.ok(calls.every(args => args[0] === 'list-sessions'));
  assert.ok(calls.every(args => !args.includes('--short')));
});

test('session status parsing preserves spaces and status-like text in names', async () => {
  const name = 'my (EXITED - attach to resurrect) work';
  const { runner } = setup(args => args[0] === 'list-sessions' ? `${name} [Created 1s ago] \n` : undefined);
  const client = new ZellijClient(readConfig({ ZELLIJ_SESSION_NAME: name }), runner);
  assert.deepEqual(await client.listSessions(), { sessions: [name] });
});

test('session listing needs no CLI access; action validation still reports CLI errors', async () => {
  const empty = setup(() => { throw new ZellijError('CLI_ERROR', 'No active sessions found.'); });
  assert.deepEqual(await empty.client.listSessions(), { sessions: ['other', 'next', 'new', 'dev'] });
  await assert.rejects(empty.client.listTabs(), code('NOT_FOUND'));
  const native = setup(() => { throw new ZellijError('CLI_ERROR', 'No active zellij sessions found.'); });
  await assert.rejects(native.client.listTabs(), code('NOT_FOUND'));
  const broken = setup(() => { throw new ZellijError('CLI_ERROR', 'permission denied'); });
  assert.deepEqual(await broken.client.listSessions(), { sessions: ['other', 'next', 'new', 'dev'] });
  assert.equal(broken.calls.length, 0);
  await assert.rejects(broken.client.listTabs(), /permission denied/);
});

test('creation is scoped and never attaches in foreground or waits for command exit', async () => {
  const { client, calls } = setup();
  assert.deepEqual(await client.createSession('new'), { session: 'new' });
  assert.deepEqual(calls.at(-1), ['attach', '--create-background', 'new']);
  await assert.rejects(client.createSession('dev'), code('ALREADY_EXISTS'));
  await assert.rejects(client.createSession('secret'), code('ACCESS_DENIED'));
  assert.deepEqual(await client.createTab({ name: 'tab', cwd: '/tmp/a b', command: ['echo', '$(touch nope)', ''] }), { session: 'dev', tab_id: 9 });
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'new-tab', '--name', 'tab', '--cwd', '/tmp/a b', '--no-focus', '--', 'echo', '$(touch nope)', '']);
  await client.createPane(8, { direction: 'right', command: ['cat'] });
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'new-pane', '--tab-id', '8', '--direction', 'right', '--no-focus', '--', 'cat']);
  await client.createTab({ focus: true });
  assert.equal(calls.at(-1)!.includes('--no-focus'), false);
});

test('tab identity uses stable IDs instead of position; panes retain plugin/terminal distinction', async () => {
  const { client, calls } = setup();
  const panes = await client.listPanes(undefined, 8);
  assert.deepEqual(panes.panes.map(p => p.pane_id), ['terminal_1', 'terminal_2', 'plugin_1']);
  await assert.rejects(client.tabAction('focus', 0), code('NOT_FOUND'));
  await client.tabAction('focus', 8);
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'go-to-tab-by-id', '8']);
  await client.tabAction('rename', 8, undefined, '-new');
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'rename-tab-by-id', '8', '--', '-new']);
  await client.tabAction('close', 8);
  assert.equal(calls.at(-1)![3], 'close-tab-by-id');
});

test('missing panes do not fall back to a focused pane', async () => {
  const { client, calls } = setup();
  await assert.rejects(client.sendText('terminal_99', 'wrong target'), code('NOT_FOUND'));
  assert.equal(calls.some(args => args[3] === 'paste'), false);
});

test('rename updates default only after success and keeps the configured allowlist', async () => {
  const { client, calls } = setup();
  assert.deepEqual(await client.renameSession('next'), { session: 'next' });
  assert.equal(client.scope.resolve(), 'next');
  assert.equal(client.scope.resolve('dev'), 'dev');
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'rename-session', '--', 'next']);
  await assert.rejects(client.renameSession('secret'), code('ACCESS_DENIED'));
  const failing = setup(args => { if (args[3] === 'rename-session') throw new ZellijError('CLI_ERROR', 'failed'); });
  await assert.rejects(failing.client.renameSession('next'), /failed/);
  assert.equal(failing.client.scope.resolve(), 'dev');
});

test('close session terminates without deleting resurrection state', async () => {
  const { client, calls } = setup();
  await client.closeSession();
  assert.deepEqual(calls.at(-1), ['kill-session', 'dev']);
});

test('text is literal, multiline and Unicode; Enter is a separate explicit action', async () => {
  const { client, calls } = setup();
  const text = '-한글\n\t`echo nope` $(echo nope)';
  await client.sendText('terminal_1', text);
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'paste', '--pane-id', 'terminal_1', '--', text]);
  await client.sendText('terminal_1', 'echo hi', true);
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'send-keys', '--pane-id', 'terminal_1', '--', 'Enter']);
  await client.sendKeys('terminal_2', ['Ctrl c', 'Left']);
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'send-keys', '--pane-id', 'terminal_2', '--', 'Ctrl c', 'Left']);
});

test('same-pane inputs remain ordered while other panes progress', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { client, calls } = setup(async args => {
    if (args[3] === 'paste' && args.at(-1) === 'first') { started(); await blocked; }
    return undefined;
  });
  const first = client.sendText('terminal_1', 'first', true);
  await ready;
  const second = client.sendText('terminal_1', 'second');
  await client.sendText('terminal_2', 'independent');
  assert.equal(calls.some(args => args.at(-1) === 'second'), false);
  release(); await Promise.all([first, second]);
  const input = calls.filter(args => ['paste', 'send-keys'].includes(args[3]!));
  assert.deepEqual(input.map(args => args.at(-1)), ['first', 'independent', 'Enter', 'second']);
});

test('failed input does not poison the queue and queued cancellation sends nothing', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const { client, calls } = setup(async args => {
    if (args[3] === 'paste' && args.at(-1) === 'fail') { started(); await gate; throw new ZellijError('CLI_ERROR', 'failed'); }
    return undefined;
  });
  const first = client.sendText('terminal_1', 'fail');
  const checked = assert.rejects(first, /failed/);
  await ready;
  const controller = new AbortController();
  const second = client.sendText('terminal_1', 'cancelled', false, undefined, controller.signal);
  const cancelled = assert.rejects(second, code('CANCELLED'));
  const third = client.sendText('terminal_1', 'recover');
  controller.abort(); release();
  await Promise.all([checked, cancelled, third]);
  assert.equal(calls.some(args => args.at(-1) === 'cancelled'), false);
  assert.equal(calls.at(-1)!.at(-1), 'recover');
});

test('capture clips the tail, strips ANSI by default and never scrolls the visible pane', async () => {
  const { client, calls } = setup(args => args[3] === 'dump-screen' ? '\x1b[31mone\x1b[0m\ntwo\nthree\n' : undefined);
  assert.deepEqual(await client.capture('terminal_1', { lines: 2, scrollback: true }), {
    session: 'dev', pane_id: 'terminal_1', text: 'two\nthree', truncated: true,
  });
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'dump-screen', '--pane-id', 'terminal_1', '--full']);
  assert.equal((await client.capture('terminal_1', { lines: 3 })).text, 'one\ntwo\nthree');
  assert.match((await client.capture('terminal_1', { ansi: true })).text, /\x1b\[31m/);
});

test('resize uses the actual CLI increase/decrease syntax and explicit pane IDs', async () => {
  const { client, calls } = setup();
  await client.paneAction('resize', 'terminal_2', undefined, { resize: 'decrease', direction: 'right' });
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'resize', '--pane-id', 'terminal_2', 'decrease', 'right']);
  await client.paneAction('close', 'terminal_2');
  assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'close-pane', '--pane-id', 'terminal_2']);
});

test('invalid JSON and missing identity never silently return wrong targets', async () => {
  for (const output of ['oops', '{}', '[{}]']) {
    const { client } = setup(args => args[3] === 'list-panes' ? output : undefined);
    await assert.rejects(client.listPanes(), code('INVALID_OUTPUT'));
  }
  const { runner } = setup();
  const client = new ZellijClient(readConfig({ SHELL_IS_ALL_AGENTS_NEED_SESSIONS: 'dev' }), runner);
  await assert.rejects(client.listPanes(), code('NO_DEFAULT_SESSION'));
  assert.equal((await client.listPanes('dev')).session, 'dev');
});
