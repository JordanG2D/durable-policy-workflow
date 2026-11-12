import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PolicyApplication } from "@policy/domain/pricing";
import type { WorkflowView } from "./driver.js";

export const sampleApplication: PolicyApplication = {
  businessName: "Acme Bicycle Repair LLC",
  industry: "retail",
  annualRevenueCents: 85_000_000,
  employeeCount: 6,
  contactEmail: "owner@example.com",
};

export async function submit(
  apiUrl: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${apiUrl}/v1/policy-applications`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": opts.key ?? `parity-${randomUUID()}` },
    body: JSON.stringify(opts.body ?? sampleApplication),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

export async function startWorkflow(apiUrl: string): Promise<string> {
  const res = await submit(apiUrl);
  if (res.status !== 202) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.workflowId as string;
}

export async function view(apiUrl: string, workflowId: string): Promise<WorkflowView> {
  const res = await fetch(`${apiUrl}/v1/policy-applications/${workflowId}`);
  if (!res.ok) throw new Error(`GET workflow ${workflowId}: ${res.status} ${await res.text()}`);
  return (await res.json()) as WorkflowView;
}

export async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 25, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}
