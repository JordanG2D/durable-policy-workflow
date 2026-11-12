import { isDeepStrictEqual } from 'node:util';

// JSON objects are unordered. PostgreSQL JSONB may reorder response keys,
// while array order, value types, fields, status and replay marker must match.
export function assertIdempotentReplay(created, replay) {
  if (replay.replayed !== 'true' || replay.status !== created.status || !isDeepStrictEqual(replay.body, created.body)) {
    throw new Error('Idempotent replay did not return the original response.');
  }
}
