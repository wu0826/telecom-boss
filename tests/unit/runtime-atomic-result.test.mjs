import assert from 'node:assert/strict';
import test from 'node:test';

import { runAtomicResult } from '../../src/server/db/runtime-database.mjs';

function fakeDatabase() {
  const state = { value: 0, commits: 0, rollbacks: 0 };
  return {
    state,
    async transaction(operation) {
      const before = state.value;
      try {
        const result = await operation(this);
        state.commits += 1;
        return result;
      } catch (error) {
        state.value = before;
        state.rollbacks += 1;
        throw error;
      }
    },
  };
}

test('atomic result transaction commits successful business results', async () => {
  const database = fakeDatabase();
  const result = await runAtomicResult(database, async () => {
    database.state.value = 10;
    return { kind: 'updated', id: 7 };
  });

  assert.deepEqual(result, { kind: 'updated', id: 7 });
  assert.equal(database.state.value, 10);
  assert.equal(database.state.commits, 1);
  assert.equal(database.state.rollbacks, 0);
});

test('atomic result transaction rolls back a late conflict but returns the business result', async () => {
  const database = fakeDatabase();
  const result = await runAtomicResult(database, async () => {
    database.state.value = 99;
    return { kind: 'conflict' };
  });

  assert.deepEqual(result, { kind: 'conflict' });
  assert.equal(database.state.value, 0);
  assert.equal(database.state.commits, 0);
  assert.equal(database.state.rollbacks, 1);
});

test('atomic result transaction rolls back any failure kind after partial writes', async () => {
  const database = fakeDatabase();
  for (const kind of ['not-found', 'invalid-stock', 'insufficient-stock', 'overpayment']) {
    database.state.value = 0;
    const result = await runAtomicResult(database, async () => {
      database.state.value = 1;
      return { kind };
    });
    assert.equal(result.kind, kind);
    assert.equal(database.state.value, 0, `${kind} must not commit partial state`);
  }
  assert.equal(database.state.rollbacks, 4);
});

test('atomic result transaction preserves thrown failures for the caller', async () => {
  const database = fakeDatabase();
  await assert.rejects(
    runAtomicResult(database, async () => {
      database.state.value = 5;
      throw new Error('audit write failed');
    }),
    /audit write failed/,
  );
  assert.equal(database.state.value, 0);
  assert.equal(database.state.rollbacks, 1);
});
