import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Pool } from "../db/pool.js";

export type Metrics = ReturnType<typeof createMetrics>;

/** All Prometheus metrics, on a private registry so tests can create isolated instances. */
export function createMetrics(opts: { defaultMetrics?: boolean } = {}) {
  const registry = new Registry();
  if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });

  return {
    registry,
    workflowsStarted: new Counter({
      name: "workflows_started_total",
      help: "Workflows created via the API",
      registers: [registry],
    }),
    workflowsCompleted: new Counter({
      name: "workflows_completed_total",
      help: "Workflows that reached DOCUMENTS_DELIVERED",
      registers: [registry],
    }),
    workflowsFailed: new Counter({
      name: "workflows_failed_total",
      help: "Workflows moved to DEAD_LETTERED",
      labelNames: ["step"] as const,
      registers: [registry],
    }),
    stepRetries: new Counter({
      name: "workflow_step_retries_total",
      help: "Step attempts that failed and were scheduled for retry",
      labelNames: ["step"] as const,
      registers: [registry],
    }),
    stepDuration: new Histogram({
      name: "workflow_step_duration_seconds",
      help: "Wall-clock duration of a step attempt",
      labelNames: ["step", "outcome"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    illegalTransitions: new Counter({
      name: "workflow_illegal_transitions_total",
      help: "Rejected attempts to make a transition not in the state machine",
      labelNames: ["from", "to"] as const,
      registers: [registry],
    }),
    duplicatesSuppressed: new Counter({
      name: "duplicates_suppressed_total",
      help: "Duplicate requests, callbacks or events detected and not re-applied",
      labelNames: ["kind"] as const,
      registers: [registry],
    }),
    leaseLost: new Counter({
      name: "outbox_lease_lost_total",
      help: "Step results discarded because the worker no longer held the outbox lease",
      registers: [registry],
    }),
    capturedAfterDeadLetter: new Counter({
      name: "payment_captured_after_dead_letter_total",
      help: "Payment confirmations that arrived after the workflow was dead-lettered (needs manual refund/review)",
      registers: [registry],
    }),
  };
}

/** Outbox gauges are computed from the database at scrape time. */
export function registerOutboxGauges(metrics: Metrics, pool: Pool): void {
  const query = async () => {
    const { rows } = await pool.query<{ pending: string; dead: string; lag: number | null }>(
      `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE status = 'dead')    AS dead,
              EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::float8 AS lag
         FROM outbox`,
    );
    return rows[0];
  };
  new Gauge({
    name: "outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event (0 when empty)",
    registers: [metrics.registry],
    async collect() {
      this.set((await query())?.lag ?? 0);
    },
  });
  new Gauge({
    name: "outbox_pending_events",
    help: "Outbox events not yet published",
    registers: [metrics.registry],
    async collect() {
      this.set(Number((await query())?.pending ?? 0));
    },
  });
  new Gauge({
    name: "outbox_dead_events",
    help: "Outbox events that exhausted retries",
    registers: [metrics.registry],
    async collect() {
      this.set(Number((await query())?.dead ?? 0));
    },
  });
}
