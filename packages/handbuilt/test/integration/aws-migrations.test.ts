import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, type Pool } from '../../src/db/pool.js';
import { migrate, migrationDigest } from '../../src/db/migrate.js';
import { MIGRATIONS } from '../../src/db/migrations.js';
import { TEST_DATABASE_URL } from '../helpers/db.js';
let pool: Pool;
beforeAll(async () => { pool = createPool(TEST_DATABASE_URL); await migrate(pool); });
afterAll(async () => { await pool.end(); });
it('re-runs without executing applied SQL and rejects modified applied bytes', async () => {
  expect(await migrate(pool)).toEqual([]);
  await pool.query("UPDATE schema_migrations SET digest='tampered' WHERE id=1");
  try { await expect(migrate(pool)).rejects.toThrow('digest mismatch'); }
  finally { await pool.query('UPDATE schema_migrations SET digest=$1 WHERE id=1', [migrationDigest(MIGRATIONS[0]!)]); }
  expect(await migrate(pool)).toEqual([]);
});
it('only adopts the known legacy migration and rejects unknown migration history', async () => {
  await pool.query('UPDATE schema_migrations SET digest=NULL WHERE id=1');
  expect(await migrate(pool)).toEqual([]);
  const {rows} = await pool.query<{digest:string}>('SELECT digest FROM schema_migrations WHERE id=1');
  expect(rows[0]?.digest).toBe(migrationDigest(MIGRATIONS[0]!));
  await pool.query("INSERT INTO schema_migrations(id,name,digest) VALUES(999,'unknown','x')");
  try { await expect(migrate(pool)).rejects.toThrow('Unknown applied migration'); }
  finally { await pool.query('DELETE FROM schema_migrations WHERE id=999'); }
});
