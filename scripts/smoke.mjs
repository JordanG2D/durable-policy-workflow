// End-to-end smoke test against a running stack (docker compose up).
// Usage: node scripts/smoke.mjs [baseUrl]
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3000";
const key = `smoke-${randomUUID()}`;
const body = {
  businessName: "Smoke Test Bakery",
  industry: "restaurant",
  annualRevenueCents: 42_000_000,
  employeeCount: 4,
  contactEmail: "owner@example.com",
};

const post = () =>
  fetch(`${base}/v1/policy-applications`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });

const res = await post();
const created = await res.json();
if (res.status !== 202) throw new Error(`create failed: ${res.status} ${JSON.stringify(created)}`);
const replay = await (await post()).json();
if (replay.workflowId !== created.workflowId) throw new Error("idempotent replay returned a different workflow");
console.log(`created ${created.workflowId} (correlation ${created.correlationId})`);

const deadline = Date.now() + 30_000;
for (;;) {
  const wf = await (await fetch(`${base}/v1/policy-applications/${created.workflowId}`)).json();
  if (wf.state === "DOCUMENTS_DELIVERED") {
    console.log(`delivered policy ${wf.policyNumber}, premium $${(wf.premiumCents / 100).toFixed(2)}`);
    console.log(wf.transitions.map((t) => `${t.to} (${t.cause})`).join(" -> "));
    break;
  }
  if (wf.state === "DEAD_LETTERED") throw new Error(`dead-lettered: ${wf.deadLetterReason}`);
  if (Date.now() > deadline) throw new Error(`timed out in state ${wf.state}`);
  await new Promise((r) => setTimeout(r, 250));
}
const metrics = await (await fetch(`${base}/metrics`)).text();
console.log(
  metrics
    .split("\n")
    .filter((l) => /^workflows_started_total|^outbox_/.test(l))
    .join("\n"),
);
