import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * A fake policy administration system that assigns policy numbers.
 *
 * The hand-built implementation numbers policies with a Postgres sequence
 * inside the transaction that issues the policy. The Temporal implementation
 * has no database of its own, so issuing a policy is an external call like any
 * other: it is idempotent on `idempotencyKey`, and the ledger lets tests prove
 * that no workflow was issued two policy numbers.
 */
export interface PolicyRegistryFaults {
  failNext: number;
  down: boolean;
  responseDelayMs: number;
}

export const DEFAULT_POLICY_REGISTRY_FAULTS: PolicyRegistryFaults = { failNext: 0, down: false, responseDelayMs: 0 };

export interface IssuedPolicy {
  readonly policyNumber: string;
  readonly idempotencyKey: string;
  readonly reference: string;
  readonly premiumCents: number;
  readonly issuedAt: string;
}

export interface FakePolicyRegistry {
  readonly app: FastifyInstance;
  readonly faults: PolicyRegistryFaults;
  setFaults(f: Partial<PolicyRegistryFaults>): void;
  policies(): IssuedPolicy[];
  issuedFor(reference: string): number;
  requestCount(): number;
  reset(): void;
}

export function createFakePolicyRegistry(initial: Partial<PolicyRegistryFaults> = {}): FakePolicyRegistry {
  const app = Fastify({ logger: false });
  const faults: PolicyRegistryFaults = { ...DEFAULT_POLICY_REGISTRY_FAULTS, ...initial };
  const byKey = new Map<string, IssuedPolicy>();
  let requests = 0;
  let sequence = 100_000;

  app.post<{ Body: { idempotencyKey: string; reference: string; premiumCents: number } }>(
    "/policies",
    async (req, reply) => {
      requests++;
      if (faults.down) return reply.code(503).send({ error: "service_unavailable" });
      if (faults.failNext > 0) {
        faults.failNext--;
        return reply.code(500).send({ error: "internal_error" });
      }
      if (faults.responseDelayMs > 0) await sleep(faults.responseDelayMs);
      const { idempotencyKey, reference, premiumCents } = req.body;
      if (!idempotencyKey || !reference || !Number.isInteger(premiumCents)) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const existing = byKey.get(idempotencyKey);
      if (existing) return reply.send({ policyNumber: existing.policyNumber, replayed: true });
      const now = new Date();
      const policy: IssuedPolicy = {
        policyNumber: `GL-${now.getUTCFullYear()}-${sequence++}`,
        idempotencyKey,
        reference,
        premiumCents,
        issuedAt: now.toISOString(),
      };
      byKey.set(idempotencyKey, policy);
      return reply.send({ policyNumber: policy.policyNumber });
    },
  );

  app.put<{ Body: Partial<PolicyRegistryFaults> }>("/__faults", async (req) => {
    Object.assign(faults, req.body);
    return faults;
  });
  app.get("/__ledger", async () => ({ requests, policies: [...byKey.values()] }));
  app.get("/healthz", async () => ({ ok: true }));

  function reset() {
    Object.assign(faults, DEFAULT_POLICY_REGISTRY_FAULTS, initial);
    byKey.clear();
    requests = 0;
  }

  return {
    app,
    faults,
    setFaults: (f) => Object.assign(faults, f),
    policies: () => [...byKey.values()],
    issuedFor: (reference) => [...byKey.values()].filter((p) => p.reference === reference).length,
    requestCount: () => requests,
    reset,
  };
}
