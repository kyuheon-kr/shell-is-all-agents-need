import test from 'node:test';
import assert from 'node:assert/strict';
import { ZellijError } from '../src/errors.ts';
import { setup } from './helpers.ts';

for (const operation of ['tab', 'pane'] as const) {
  test(`missing ${operation} ID reports observed candidates without replaying or guessing ownership`, async () => {
    let created = false;
    const metadata = operation === 'tab' ? 'list-tabs' : 'list-panes';
    const mutation = operation === 'tab' ? 'new-tab' : 'new-pane';
    const { client, calls } = setup(args => {
      if (args[3] === mutation) { created = true; return ''; }
      if (args[3] === metadata) return JSON.stringify(operation === 'tab'
        ? (created ? [{ tab_id: 8 }, { tab_id: 9 }, { tab_id: 10 }] : [{ tab_id: 8 }])
        : (created ? [{ pane_id: 'terminal_1', tab_id: 8 }, { pane_id: 'terminal_3', tab_id: 8 }, { pane_id: 'terminal_4', tab_id: 8 }]
          : [{ pane_id: 'terminal_1', tab_id: 8 }]));
      return undefined;
    });
    await assert.rejects(operation === 'tab' ? client.createTab({}) : client.createPane(8, {}), error => {
      assert.ok(error instanceof ZellijError);
      assert.equal(error.code, 'OPERATION_UNCERTAIN');
      assert.equal(error.details?.retry_safe, false);
      assert.deepEqual(error.details?.observed_new_ids, operation === 'tab' ? [9, 10] : ['terminal_3', 'terminal_4']);
      assert.deepEqual(error.details?.recovery, { tool: operation === 'tab' ? 'list_tabs' : 'list_panes', arguments: { session: 'dev' } });
      return true;
    });
    assert.equal(calls.filter(args => args[3] === mutation).length, 1);
  });
}

test('creation timeout/cancellation preserves diagnostics and does not start recovery queries', async () => {
  for (const code of ['TIMEOUT', 'CANCELLED'] as const) {
    const { client, calls } = setup(args => {
      if (args[3] === 'new-pane') throw new ZellijError(code, 'Interrupted', { partial_stdout: 'partial ID' });
      return undefined;
    });
    await assert.rejects(client.createPane(8, {}), error => error instanceof ZellijError
      && error.code === 'OPERATION_UNCERTAIN' && error.details?.cause_code === code && error.details?.partial_stdout === 'partial ID');
    assert.equal(calls.at(-1)?.[3], 'new-pane');
  }
});

test('failed pre-creation inspection never dispatches a mutation', async () => {
  const { client, calls } = setup(args => args[3] === 'list-panes' ? '{invalid' : undefined);
  await assert.rejects(client.createPane(8, {}), error => error instanceof ZellijError && error.code === 'INVALID_OUTPUT');
  assert.equal(calls.some(args => args[3] === 'new-pane'), false);
});
