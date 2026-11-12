import { describe, expect, it } from "vitest";
import { flakyPricing, priceQuote, type PolicyApplication } from "../../src/domain/pricing.js";

const base: PolicyApplication = {
  businessName: "Test Co",
  industry: "retail",
  annualRevenueCents: 85_000_000,
  employeeCount: 6,
  contactEmail: "a@example.com",
};

describe("fake pricing rule", () => {
  it("is deterministic and combines revenue and headcount", () => {
    // $850k revenue * $2.10 per $1k = $1,785; 6 employees * $45 = $270.
    expect(priceQuote(base)).toBe(178_500 + 27_000);
    expect(priceQuote(base)).toBe(priceQuote({ ...base }));
  });

  it("prices riskier industries higher and applies a minimum premium", () => {
    expect(priceQuote({ ...base, industry: "construction" })).toBeGreaterThan(priceQuote(base));
    expect(priceQuote({ ...base, annualRevenueCents: 0, employeeCount: 0 })).toBe(50_000);
  });

  it("can be made to fail on purpose", async () => {
    const p = flakyPricing(2);
    await expect(p.price(base)).rejects.toThrow("injected");
    await expect(p.price(base)).rejects.toThrow("injected");
    await expect(p.price(base)).resolves.toBe(priceQuote(base));
  });
});
