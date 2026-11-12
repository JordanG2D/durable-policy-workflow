import { createHash } from "node:crypto";
import { MIGRATIONS } from "./migrations.js";
import { withTransaction, type Pool } from "./pool.js";

// Arbitrary constant: serialises concurrent migrators (e.g. several replicas starting at once).
const MIGRATION_LOCK_KEY = 4_242_001;
const LEGACY_CORE_DIGEST = "363eeb7defe967dfc9764d2e95635ffa88100174c9b513408a6c27c760f3bac2";

export async function migrate(pool: Pool): Promise<number[]> {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id integer PRIMARY KEY,
        name text NOT NULL,
        digest text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Legacy installations can contain the original unhashed migration. Only that
    // exact known migration can be adopted; unknown/modified history fails closed.
    await tx.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS digest text");
    const { rows } = await tx.query<{ id: number; name: string; digest: string | null }>(
      "SELECT id, name, digest FROM schema_migrations ORDER BY id",
    );
    const applied = new Map(rows.map((r) => [r.id, r]));
    for (const row of rows) {
      if (!MIGRATIONS.some((m) => m.id === row.id)) throw new Error(`Unknown applied migration ${row.id}`);
    }
    const ran: number[] = [];
    for (const m of MIGRATIONS) {
      const digest = migrationDigest(m);
      const previous = applied.get(m.id);
      if (previous) {
        if (previous.name !== m.name) throw new Error(`Migration ${m.id} name changed`);
        if (previous.digest === null) {
          if (m.id !== 1 || digest !== LEGACY_CORE_DIGEST) throw new Error(`Migration ${m.id} has no trusted recorded digest`);
          await tx.query("UPDATE schema_migrations SET digest=$2 WHERE id=$1", [m.id, digest]);
        } else if (previous.digest !== digest) {
          throw new Error(`Migration ${m.id} digest mismatch; applied migrations are immutable`);
        }
        continue;
      }
      await tx.query(m.sql);
      await tx.query("INSERT INTO schema_migrations (id, name, digest) VALUES ($1, $2, $3)", [m.id, m.name, digest]);
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

/** Hash exact migration identity and bytes, not only its sequence number. */
export function migrationDigest(m: { readonly id: number; readonly name: string; readonly sql: string }): string {
  return createHash("sha256").update(JSON.stringify([m.id, m.name, m.sql])).digest("hex");
}
