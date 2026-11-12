import { RetryableError } from "./errors.js";

/**
 * A deliberately fake pricing rule for a small-business general liability
 * policy. The numbers are invented; the point is a deterministic, testable
 * function with an injectable failure mode.
 */

export const Industries = ["retail", "restaurant", "consulting", "construction", "software"] as const;
export type Industry = (typeof Industries)[number];

export interface PolicyApplication {
  readonly businessName: string;
  readonly industry: Industry;
  readonly annualRevenueCents: number;
  readonly employeeCount: number;
  readonly contactEmail: string;
}

/** Rate per $1,000 of revenue, in cents. */
const RATE_PER_THOUSAND_CENTS: Record<Industry, number> = {
  consulting: 120,
  software: 140,
  retail: 210,
  restaurant: 330,
  construction: 610,
};

const PER_EMPLOYEE_CENTS = 4_500;
const MINIMUM_PREMIUM_CENTS = 50_000;

export function priceQuote(app: PolicyApplication): number {
  const revenueComponent = Math.round((app.annualRevenueCents / 100_000) * RATE_PER_THOUSAND_CENTS[app.industry]);
  const employeeComponent = app.employeeCount * PER_EMPLOYEE_CENTS;
  return Math.max(MINIMUM_PREMIUM_CENTS, revenueComponent + employeeComponent);
}

export interface PricingEngine {
  price(app: PolicyApplication): Promise<number>;
}

export const rulePricing: PricingEngine = {
  price: (app) => Promise.resolve(priceQuote(app)),
};

/** Fails the next `n` calls with a retryable error, then prices normally. */
export function flakyPricing(failNext: number, inner: PricingEngine = rulePricing): PricingEngine & {
  remaining(): number;
} {
  let remaining = failNext;
  return {
    remaining: () => remaining,
    price(app) {
      if (remaining > 0) {
        remaining--;
        return Promise.reject(new RetryableError("pricing engine unavailable (injected)"));
      }
      return inner.price(app);
    },
  };
}
