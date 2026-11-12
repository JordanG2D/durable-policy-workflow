/**
 * Runs the fake external services. Used by docker compose and `npm run fakes`.
 * Initial faults can be set with FAKE_PAYMENT_FAULTS / FAKE_DOCUMENT_FAULTS / FAKE_POLICY_FAULTS
 * (JSON) and changed at runtime with `PUT /__faults`.
 */
import { createFakeDocumentService } from "./documentService.js";
import { createFakePaymentProvider } from "./paymentProvider.js";
import { createFakePolicyRegistry } from "./policyRegistry.js";

const parse = <T>(raw: string | undefined): Partial<T> => (raw ? (JSON.parse(raw) as Partial<T>) : {});

const payment = createFakePaymentProvider(parse(process.env.FAKE_PAYMENT_FAULTS));
const documents = createFakeDocumentService(parse(process.env.FAKE_DOCUMENT_FAULTS));
const policies = createFakePolicyRegistry(parse(process.env.FAKE_POLICY_FAULTS));
const host = process.env.FAKES_HOST ?? "0.0.0.0";
const paymentPort = Number(process.env.FAKE_PAYMENT_PORT ?? 4001);
const documentPort = Number(process.env.FAKE_DOCUMENT_PORT ?? 4002);
const policyPort = Number(process.env.FAKE_POLICY_PORT ?? 4003);

await payment.app.listen({ host, port: paymentPort });
await documents.app.listen({ host, port: documentPort });
await policies.app.listen({ host, port: policyPort });
console.log(JSON.stringify({ msg: "fakes listening", paymentPort, documentPort, policyPort }));

const shutdown = () => {
  void Promise.all([payment.app.close(), documents.app.close(), policies.app.close()]).then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
