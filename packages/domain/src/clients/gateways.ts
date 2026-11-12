import { inSpan } from "../tracing.js";
import { postJson } from "./http.js";

export interface ChargeRequest {
  readonly idempotencyKey: string;
  readonly reference: string;
  readonly amountCents: number;
  readonly callbackUrl: string;
}

export interface CallOptions {
  /** Abort the call early (the caller no longer needs the answer). */
  readonly signal?: AbortSignal;
}

export interface PaymentGateway {
  charge(req: ChargeRequest, opts?: CallOptions): Promise<{ chargeId: string }>;
}

export interface DeliveryRequest {
  readonly idempotencyKey: string;
  readonly policyNumber: string;
  readonly recipient: string;
}

export interface DocumentGateway {
  deliver(req: DeliveryRequest): Promise<{ deliveryId: string }>;
}

export interface IssueRequest {
  readonly idempotencyKey: string;
  readonly reference: string;
  readonly premiumCents: number;
}

export interface PolicyGateway {
  issue(req: IssueRequest): Promise<{ policyNumber: string }>;
}

export function httpPaymentGateway(baseUrl: string, timeoutMs: number): PaymentGateway {
  return {
    charge: (req, opts) =>
      inSpan("payment.charge", { "payment.reference": req.reference, "payment.amount_cents": req.amountCents }, () =>
        postJson<{ chargeId: string }>(`${baseUrl}/charges`, req, timeoutMs, opts?.signal),
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

export function httpPolicyGateway(baseUrl: string, timeoutMs: number): PolicyGateway {
  return {
    issue: (req) =>
      inSpan("policy.issue", { "policy.reference": req.reference }, () =>
        postJson<{ policyNumber: string }>(`${baseUrl}/policies`, req, timeoutMs),
      ),
  };
}
