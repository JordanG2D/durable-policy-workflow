import { createHash, randomUUID } from "node:crypto";
import type { DocumentGateway, PaymentGateway } from "@policy/domain/clients/gateways";
import { NonRetryableError } from "@policy/domain/errors";
import { withTransaction, type Pool } from "../db/pool.js";

/** Synthetic effects only. No money moves and no email/document is sent.
 * The committed ledger survives a crash between provider response and step commit. */
export function createDemoProviders(pool: Pool): { payments: PaymentGateway; documents: DocumentGateway } {
  async function effect(kind: string, key: string, request: object, field: string): Promise<Record<string, string>> {
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))));
    const hash = createHash("sha256").update(canonical).digest("hex");
    return withTransaction(pool, async (tx) => {
      await tx.query(`INSERT INTO aws_demo_effects(kind, idempotency_key, request_hash, result)
        VALUES ($1,$2,$3,$4) ON CONFLICT (kind,idempotency_key) DO NOTHING`,
        [kind, key, hash, JSON.stringify({ [field]: `demo-${kind}-${randomUUID()}` })]);
      const { rows } = await tx.query<{ request_hash: string; result: Record<string, string> }>(
        `SELECT request_hash, result FROM aws_demo_effects WHERE kind=$1 AND idempotency_key=$2`, [kind, key]);
      if (!rows[0] || rows[0].request_hash !== hash) throw new NonRetryableError("demo idempotency key parameter mismatch");
      return rows[0].result;
    });
  }
  return {
    payments: { async charge(req) { return { chargeId: (await effect("payment", req.idempotencyKey, req, "chargeId")).chargeId! }; } },
    documents: { async deliver(req) { return { deliveryId: (await effect("document", req.idempotencyKey, req, "deliveryId")).deliveryId! }; } },
  };
}
