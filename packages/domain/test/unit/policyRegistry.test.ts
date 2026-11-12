import { describe, expect, it } from "vitest";
import { createFakePolicyRegistry } from "../../src/fakes/policyRegistry.js";

describe("fake policy registry", () => {
  const issue = (r: ReturnType<typeof createFakePolicyRegistry>, key: string, reference = "wf-1") =>
    r.app.inject({ method: "POST", url: "/policies", payload: { idempotencyKey: key, reference, premiumCents: 50_000 } });

  it("assigns one policy number per idempotency key", async () => {
    const r = createFakePolicyRegistry();
    const first = (await issue(r, "issue:wf-1")).json<{ policyNumber: string }>();
    const again = (await issue(r, "issue:wf-1")).json<{ policyNumber: string; replayed: boolean }>();
    const other = (await issue(r, "issue:wf-2", "wf-2")).json<{ policyNumber: string }>();
    expect(first.policyNumber).toMatch(/^GL-\d{4}-100000$/);
    expect(again).toEqual({ policyNumber: first.policyNumber, replayed: true });
    expect(other.policyNumber).not.toBe(first.policyNumber);
    expect(r.issuedFor("wf-1")).toBe(1);
    expect(r.requestCount()).toBe(3);
  });

  it("can be failed or taken down", async () => {
    const r = createFakePolicyRegistry({ failNext: 1 });
    expect((await issue(r, "k")).statusCode).toBe(500);
    r.setFaults({ down: true });
    expect((await issue(r, "k")).statusCode).toBe(503);
    expect(r.issuedFor("wf-1")).toBe(0);
  });
});
