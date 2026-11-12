import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { FakeDocumentService } from "@policy/domain/fakes/documentService";
import type { FakePaymentProvider } from "@policy/domain/fakes/paymentProvider";
import type { FakePolicyRegistry } from "@policy/domain/fakes/policyRegistry";
import type { WorkflowState } from "@policy/domain/stateMachine";

/**
 * What the parity suite needs from an implementation. Each implementation
 * provides one driver; the suite itself never touches implementation code,
 * only the public HTTP API, the fake providers' ledgers and the spans.
 */
export interface ParityDriver {
  readonly name: string;
  /** Fake external services this implementation's workers talk to. */
  readonly fakes: Fakes;
  /** Base URL of the implementation's HTTP API (same routes and response shape in both). */
  readonly apiUrl: string;
  /** Spans exported in this process. */
  readonly spans: InMemorySpanExporter;

  /** Clear fakes, spans and state; stop all workers. Called before every scenario. */
  reset(): Promise<void>;
  close(): Promise<void>;

  /** Start an in-process worker with the shared parity configuration. */
  startWorker(): Promise<void>;
  /**
   * Start a worker in a separate OS process that SIGKILLs itself when it
   * reaches `crashAt` (see @policy/domain/crash). Resolves once it is running.
   */
  startCrashingWorker(crashAt: string): Promise<{ readonly exited: Promise<unknown> }>;

  /** Resolve once the workflow is terminal and the implementation has no more work queued for it. */
  waitUntilSettled(workflowId: string): Promise<void>;
  /** How many policy numbers were assigned to this workflow (ledger or database). */
  policiesIssued(workflowId: string): Promise<number>;
}

export interface Fakes {
  readonly payment: FakePaymentProvider;
  readonly documents: FakeDocumentService;
  readonly policies: FakePolicyRegistry;
}

/** `GET /v1/policy-applications/:id`, identical in both implementations. */
export interface WorkflowView {
  readonly workflowId: string;
  readonly state: WorkflowState;
  readonly premiumCents: number | null;
  readonly paymentChargeId: string | null;
  readonly policyNumber: string | null;
  readonly documentDeliveryId: string | null;
  readonly deadLetterReason: string | null;
  readonly correlationId: string;
  readonly transitions: readonly { readonly from: WorkflowState | null; readonly to: WorkflowState; readonly cause: string }[];
}

/**
 * Configuration both drivers apply in parity runs, so retries and timeouts
 * mean the same thing on both sides.
 */
export const PARITY_CONFIG = {
  /** Client-side timeout for each call to a fake provider. */
  externalCallTimeoutMs: 300,
  /** Total attempts per step, including the first. */
  maxAttempts: 4,
  initialBackoffMs: 20,
  maxBackoffMs: 100,
} as const;
