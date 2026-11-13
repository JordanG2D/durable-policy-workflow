import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIdempotentReplay } from './smoke-assertions.mjs';

const created = { status: 202, body: { workflowId: 'workflow-1', state: 'QUOTE_REQUESTED', correlationId: 'correlation-1' } };
const replay = { status: 202, replayed: 'true', body: { state: 'QUOTE_REQUESTED', workflowId: 'workflow-1', correlationId: 'correlation-1' } };

test('accepts equivalent JSONB-reordered object keys, unlike string comparison', () => {
  assert.notEqual(JSON.stringify(replay.body), JSON.stringify(created.body));
  assert.doesNotThrow(() => assertIdempotentReplay(created, replay));
});
test('requires replay marker and original HTTP status', () => {
  for (const change of [{ replayed: null }, { replayed: 'false' }, { status: 200 }]) {
    assert.throws(() => assertIdempotentReplay(created, { ...replay, ...change }));
  }
});
test('rejects changed, missing and extra response fields', () => {
  for (const body of [
    { ...replay.body, workflowId: 'workflow-2' },
    { ...replay.body, state: 'DOCUMENTS_DELIVERED' },
    { ...replay.body, correlationId: 'correlation-2' },
    { workflowId: 'workflow-1', state: 'QUOTE_REQUESTED' },
    { ...replay.body, extra: true },
    { ...replay.body, workflowId: 1 },
  ]) assert.throws(() => assertIdempotentReplay(created, { ...replay, body }));
});
test('preserves strict nested values and array order', () => {
  const nested = { status: 202, body: { items: [{ a: 1, b: 2 }, { c: 3 }] } };
  assert.doesNotThrow(() => assertIdempotentReplay(nested, { status: 202, replayed: 'true', body: { items: [{ b: 2, a: 1 }, { c: 3 }] } }));
  assert.throws(() => assertIdempotentReplay(nested, { status: 202, replayed: 'true', body: { items: [{ c: 3 }, { a: 1, b: 2 }] } }));
});
