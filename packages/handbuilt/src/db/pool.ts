import pg from "pg";

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client erroring (e.g. Postgres restarted) must not crash the process.
  pool.on("error", () => undefined);
  return pool;
}

/**
 * Runs `fn` inside one transaction. Commits if it resolves, rolls back if it
 * throws. Everything that must be atomic (state change + outbox row, idempotency
 * key + workflow, lease fence + effect) goes through here.
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
