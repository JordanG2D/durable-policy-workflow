import { randomUUID } from "node:crypto";
import { createPool, withTransaction, type Pool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import type { PolicyApplication } from "@policy/domain/pricing";
import { insertWorkflow } from "../../src/workflow/repository.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/policy_test";

export async function setupDb(max = 10): Promise<Pool> {
  const pool = createPool(TEST_DATABASE_URL, max);
  await migrate(pool);
  await resetDb(pool);
  return pool;
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE outbox, workflow_transitions, idempotency_keys, inbound_events, workflows
     RESTART IDENTITY CASCADE`,
  );
}

export const sampleApplication: PolicyApplication = {
  businessName: "Acme Bicycle Repair LLC",
  industry: "retail",
  annualRevenueCents: 85_000_000,
  employeeCount: 6,
  contactEmail: "owner@example.com",
};

export async function createTestWorkflow(pool: Pool, id: string = randomUUID()): Promise<string> {
  await withTransaction(pool, (tx) =>
    insertWorkflow(tx, {
      id,
      application: sampleApplication,
      correlationId: `test-${id}`,
      traceParent: undefined,
    }),
  );
  return id;
}

export async function outboxRows(pool: Pool, workflowId?: string) {
  const { rows } = await pool.query<{
    id: string;
    type: string;
    status: string;
    attempts: number;
    last_error: string | null;
    lease_owner: string | null;
  }>(
    `SELECT id, type, status, attempts, last_error, lease_owner FROM outbox
      ${workflowId ? "WHERE workflow_id = $1" : ""} ORDER BY id`,
    workflowId ? [workflowId] : [],
  );
  return rows;
}
