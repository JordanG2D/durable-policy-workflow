import { MIGRATIONS } from "./migrations.js";
import { withTransaction, type Pool } from "./pool.js";

// Arbitrary constant: serialises concurrent migrators (e.g. several replicas starting at once).
const MIGRATION_LOCK_KEY = 4_242_001;

export async function migrate(pool: Pool): Promise<number[]> {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await tx.query<{ id: number }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    const ran: number[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await tx.query(m.sql);
      await tx.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
      ran.push(m.id);
    }
    return ran;
  });
}

export async function isMigrated(pool: Pool): Promise<boolean> {
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'
     ) AND COALESCE((SELECT max(id) FROM schema_migrations), 0) >= $1 AS ok`,
    [latest],
  );
  return rows[0]?.ok === true;
}
