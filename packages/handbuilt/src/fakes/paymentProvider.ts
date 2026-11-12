import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * A fake card processor, modelled loosely on how real ones behave:
 * - `POST /charges` captures money and is idempotent on `idempotencyKey`
 *   (a repeat returns the original charge instead of charging again);
 * - it later POSTs a `charge.succeeded` callback, possibly more than once.
 *
 * Every failure the workflow has to survive can be switched on through
 * `PUT /__faults` or the constructor. `GET /__ledger` exposes what was really
 * captured, so tests can prove nobody was charged twice.
 */
export interface PaymentFaults {
  /** Respond 500 without capturing, for the next N requests. */
  failNext: number;
  /** Capture (or find the existing capture), then respond 500 anyway: the client cannot tell it succeeded. */
  failAfterCaptureNext: number;
  /** Capture immediately but delay the first response (client times out, success is "late"). Replays answer at once. */
  responseDelayMs: number;
  /** Respond 402 card_declined for the next N requests. */
  declineNext: number;
  /** Send asynchronous charge.succeeded callbacks. */
  callbacks: boolean;
  /** How many copies of each callback to send (>1 simulates duplicate delivery). */
  callbackCopies: number;
  callbackDelayMs: number;
}

export const DEFAULT_PAYMENT_FAULTS: PaymentFaults = {
  failNext: 0,
  failAfterCaptureNext: 0,
  responseDelayMs: 0,
  declineNext: 0,
  callbacks: true,
  callbackCopies: 1,
  callbackDelayMs: 50,
};

export interface Charge {
  readonly chargeId: string;
  readonly idempotencyKey: string;
  readonly reference: string;
  readonly amountCents: number;
  readonly capturedAt: string;
}

interface ChargeRequest {
  idempotencyKey: string;
  reference: string;
  amountCents: number;
  callbackUrl?: string;
}

export interface FakePaymentProvider {
  readonly app: FastifyInstance;
  readonly faults: PaymentFaults;
  setFaults(f: Partial<PaymentFaults>): void;
  /** Captured charges. One entry per real capture. */
  charges(): Charge[];
  capturesFor(reference: string): number;
  requestCount(): number;
  callbacksSent(): number;
  /** Resolves once all scheduled callbacks have been attempted. */
  drainCallbacks(): Promise<void>;
  reset(): void;
}

export function createFakePaymentProvider(initial: Partial<PaymentFaults> = {}): FakePaymentProvider {
  const app = Fastify({ logger: false });
  const faults: PaymentFaults = { ...DEFAULT_PAYMENT_FAULTS, ...initial };
  const byKey = new Map<string, Charge>();
  let requests = 0;
  let callbacksSent = 0;
  const pending = new Set<Promise<void>>();

  const sendCallbacks = (charge: Charge, url: string) => {
    const body = JSON.stringify({
      eventId: `evt_${charge.chargeId}`,
      type: "charge.succeeded",
      chargeId: charge.chargeId,
      reference: charge.reference,
      amountCents: charge.amountCents,
    });
    for (let i = 0; i < faults.callbackCopies; i++) {
      const p = (async () => {
        await sleep(faults.callbackDelayMs * (i + 1));
        // Like real providers, retry a callback a few times until it gets a 2xx.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              signal: AbortSignal.timeout(2_000),
            });
            if (res.ok) break;
          } catch {
            // receiver down; try again
          }
          await sleep(100 * 2 ** attempt);
        }
        callbacksSent++;
      })();
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
  };

  app.post<{ Body: ChargeRequest }>("/charges", async (req, reply) => {
    requests++;
    const { idempotencyKey, reference, amountCents, callbackUrl } = req.body;
    if (!idempotencyKey || !reference || !Number.isInteger(amountCents) || amountCents <= 0) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (faults.declineNext > 0) {
      faults.declineNext--;
      return reply.code(402).send({ error: "card_declined" });
    }
    if (faults.failNext > 0) {
      faults.failNext--;
      return reply.code(500).send({ error: "internal_error" });
    }

    let charge = byKey.get(idempotencyKey);
    const replayed = charge !== undefined;
    if (charge) {
      if (charge.amountCents !== amountCents || charge.reference !== reference) {
        return reply.code(409).send({ error: "idempotency_key_reused_with_different_request" });
      }
    } else {
      charge = {
        chargeId: `ch_${randomUUID()}`,
        idempotencyKey,
        reference,
        amountCents,
        capturedAt: new Date().toISOString(),
      };
      byKey.set(idempotencyKey, charge);
      if (faults.callbacks && callbackUrl) sendCallbacks(charge, callbackUrl);
    }

    // Money has moved at this point, whatever the response says.
    if (faults.failAfterCaptureNext > 0) {
      faults.failAfterCaptureNext--;
      return reply.code(500).send({ error: "internal_error" });
    }
    if (faults.responseDelayMs > 0 && !replayed) await sleep(faults.responseDelayMs);
    return reply.send({ chargeId: charge.chargeId, status: "captured", ...(replayed ? { replayed } : {}) });
  });

  app.put<{ Body: Partial<PaymentFaults> }>("/__faults", async (req) => {
    Object.assign(faults, req.body);
    return faults;
  });
  app.get("/__ledger", async () => ({ requests, callbacksSent, charges: [...byKey.values()] }));
  app.post("/__reset", async () => {
    reset();
    return { ok: true };
  });
  app.get("/healthz", async () => ({ ok: true }));

  function reset() {
    Object.assign(faults, DEFAULT_PAYMENT_FAULTS, initial);
    byKey.clear();
    requests = 0;
    callbacksSent = 0;
  }

  return {
    app,
    faults,
    setFaults: (f) => Object.assign(faults, f),
    charges: () => [...byKey.values()],
    capturesFor: (reference) => [...byKey.values()].filter((c) => c.reference === reference).length,
    requestCount: () => requests,
    callbacksSent: () => callbacksSent,
    drainCallbacks: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    reset,
  };
}
