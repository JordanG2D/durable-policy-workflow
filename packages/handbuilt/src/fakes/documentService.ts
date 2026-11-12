import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * A fake document generation + delivery service (think "render the policy PDF
 * and email it"). Idempotent on `idempotencyKey`. Faults: fail the next N
 * requests, be completely down (503), or respond slowly.
 */
export interface DocumentFaults {
  failNext: number;
  down: boolean;
  responseDelayMs: number;
}

export const DEFAULT_DOCUMENT_FAULTS: DocumentFaults = { failNext: 0, down: false, responseDelayMs: 0 };

export interface Delivery {
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly policyNumber: string;
  readonly recipient: string;
  readonly deliveredAt: string;
}

export interface FakeDocumentService {
  readonly app: FastifyInstance;
  readonly faults: DocumentFaults;
  setFaults(f: Partial<DocumentFaults>): void;
  deliveries(): Delivery[];
  deliveriesFor(policyNumber: string): number;
  requestCount(): number;
  reset(): void;
}

export function createFakeDocumentService(initial: Partial<DocumentFaults> = {}): FakeDocumentService {
  const app = Fastify({ logger: false });
  const faults: DocumentFaults = { ...DEFAULT_DOCUMENT_FAULTS, ...initial };
  const byKey = new Map<string, Delivery>();
  let requests = 0;

  app.post<{ Body: { idempotencyKey: string; policyNumber: string; recipient: string } }>(
    "/deliveries",
    async (req, reply) => {
      requests++;
      if (faults.down) return reply.code(503).send({ error: "service_unavailable" });
      if (faults.failNext > 0) {
        faults.failNext--;
        return reply.code(500).send({ error: "internal_error" });
      }
      if (faults.responseDelayMs > 0) await sleep(faults.responseDelayMs);
      const { idempotencyKey, policyNumber, recipient } = req.body;
      if (!idempotencyKey || !policyNumber || !recipient) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const existing = byKey.get(idempotencyKey);
      if (existing) return reply.send({ deliveryId: existing.deliveryId, replayed: true });
      const delivery: Delivery = {
        deliveryId: `doc_${randomUUID()}`,
        idempotencyKey,
        policyNumber,
        recipient,
        deliveredAt: new Date().toISOString(),
      };
      byKey.set(idempotencyKey, delivery);
      return reply.send({ deliveryId: delivery.deliveryId });
    },
  );

  app.put<{ Body: Partial<DocumentFaults> }>("/__faults", async (req) => {
    Object.assign(faults, req.body);
    return faults;
  });
  app.get("/__ledger", async () => ({ requests, deliveries: [...byKey.values()] }));
  app.post("/__reset", async () => {
    reset();
    return { ok: true };
  });
  app.get("/healthz", async () => ({ ok: true }));

  function reset() {
    Object.assign(faults, DEFAULT_DOCUMENT_FAULTS, initial);
    byKey.clear();
    requests = 0;
  }

  return {
    app,
    faults,
    setFaults: (f) => Object.assign(faults, f),
    deliveries: () => [...byKey.values()],
    deliveriesFor: (policyNumber) => [...byKey.values()].filter((d) => d.policyNumber === policyNumber).length,
    requestCount: () => requests,
    reset,
  };
}
