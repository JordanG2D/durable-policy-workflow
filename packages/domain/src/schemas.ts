import { createHash } from "node:crypto";
import { Industries, type PolicyApplication } from "./pricing.js";

/** JSON schemas for the public HTTP API, shared so both implementations accept exactly the same requests. */

export const applicationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["businessName", "industry", "annualRevenueCents", "employeeCount", "contactEmail"],
  properties: {
    businessName: { type: "string", minLength: 1, maxLength: 200 },
    industry: { type: "string", enum: [...Industries] },
    annualRevenueCents: { type: "integer", minimum: 0, maximum: 100_000_000_000 },
    employeeCount: { type: "integer", minimum: 0, maximum: 10_000 },
    contactEmail: { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+$" },
  },
} as const;

export const paymentCallbackSchema = {
  type: "object",
  required: ["eventId", "type", "chargeId", "reference"],
  properties: {
    eventId: { type: "string", minLength: 1, maxLength: 200 },
    type: { type: "string" },
    chargeId: { type: "string", minLength: 1, maxLength: 200 },
    reference: { type: "string" },
  },
} as const;

/** Stable hash of the request body, so "same key, different request" can be detected. */
export function requestHash(body: PolicyApplication): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(canonical).digest("hex");
}
