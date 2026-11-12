/**
 * A deliberately incompatible change to the workflow, used only by
 * replay.test.ts: it issues the policy before taking payment. Any history
 * recorded by the real workflow must fail to replay against this code.
 */
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../../src/activities.js";
import type { PolicyWorkflowInput } from "../../src/definitions.js";

const acts = proxyActivities<Activities>({ startToCloseTimeout: "10s" });

export async function policyIssuance(input: PolicyWorkflowInput): Promise<void> {
  const workflowId = "replay";
  const premiumCents = await acts.priceQuote({ workflowId, application: input.application });
  const { policyNumber } = await acts.issuePolicy({ workflowId, premiumCents });
  await acts.chargePayment({ workflowId, amountCents: premiumCents });
  await acts.deliverDocuments({ workflowId, policyNumber, recipient: input.application.contactEmail });
}
