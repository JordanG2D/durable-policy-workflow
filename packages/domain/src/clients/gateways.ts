import { inSpan } from "../tracing.js";
import { postJson } from "./http.js";

export interface ChargeRequest {
  readonly idempotencyKey: string;
  readonly reference: string;
  readonly amountCents: number;
  readonly callbackUrl: string;
}

export interface PaymentGateway {
  charge(req: ChargeRequest): Promise<{ chargeId: string }>;
}

export interface DeliveryRequest {
  readonly idempotencyKey: string;
  readonly policyNumber: string;
  readonly recipient: string;
}

export interface DocumentGateway {
  deliver(req: DeliveryRequest): Promise<{ deliveryId: string }>;
}

export function httpPaymentGateway(baseUrl: string, timeoutMs: number): PaymentGateway {
  return {
    charge: (req) =>
      inSpan("payment.charge", { "payment.reference": req.reference, "payment.amount_cents": req.amountCents }, () =>
        postJson<{ chargeId: string }>(`${baseUrl}/charges`, req, timeoutMs),
      ),
  };
}

export function httpDocumentGateway(baseUrl: string, timeoutMs: number): DocumentGateway {
  return {
    deliver: (req) =>
      inSpan("documents.deliver", { "policy.number": req.policyNumber }, () =>
        postJson<{ deliveryId: string }>(`${baseUrl}/deliveries`, req, timeoutMs),
      ),
  };
}
