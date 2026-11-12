# durable-policy-workflow

[![CI](https://github.com/JordanG2D/durable-policy-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/JordanG2D/durable-policy-workflow/actions/workflows/ci.yml)

A small Node.js + TypeScript service that runs a small-business insurance workflow,
from quote request to delivered policy documents, and keeps it correct when things go
wrong. The domain is deliberately simple. The engineering is the point: an explicit state
machine, a transactional outbox drained by leased workers using `FOR UPDATE SKIP LOCKED`,
idempotency keys at every boundary, jittered retries with a dead-letter state, crash
recovery that never repeats a side effect, and tracing, metrics and logs that follow one
workflow across processes. The fake pricing rule, payment provider and document service
can all be made to fail on purpose, and the test suite does so: it times out payments,
delivers duplicates, takes services down, races workers and `SIGKILL`s them mid-step, then
checks that nobody was charged twice and no policy was issued twice.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> QUOTE_REQUESTED: POST /v1/policy-applications
    QUOTE_REQUESTED --> QUOTE_PRICED: price (fake rule)
    QUOTE_PRICED --> POLICY_BOUND: bind
    POLICY_BOUND --> PAYMENT_CONFIRMED: charge response or payment callback
    PAYMENT_CONFIRMED --> POLICY_ISSUED: assign policy number
    POLICY_ISSUED --> DOCUMENTS_DELIVERED: deliver documents
    DOCUMENTS_DELIVERED --> [*]

    QUOTE_REQUESTED --> DEAD_LETTERED: retries exhausted / permanent error
    QUOTE_PRICED --> DEAD_LETTERED
    POLICY_BOUND --> DEAD_LETTERED
    PAYMENT_CONFIRMED --> DEAD_LETTERED
    POLICY_ISSUED --> DEAD_LETTERED
    DEAD_LETTERED --> [*]
```

Those 10 edges are the whole state machine ([`src/domain/stateMachine.ts`](src/domain/stateMachine.ts)).
Any other transition throws `IllegalTransitionError`. It is logged at `warn`, counted in
`workflow_illegal_transitions_total`, and nothing is written.

## How it fits together

```
 client ──POST (Idempotency-Key)──▶ API ──┐ one transaction:
                                          │   idempotency key + workflow row
                                          │   + audit row + outbox event
                                          ▼
                                   ┌─────────────┐
     payment callback ──▶ API ───▶ │  Postgres   │ ◀── workers (N): claim due outbox rows
     (dedupe on event id)          │  workflows  │     FOR UPDATE SKIP LOCKED + lease token,
                                   │  outbox     │     run the step, then in one transaction:
                                   │  ...        │     fence on lease → transition → next event
                                   └─────────────┘
                                          │
                        idempotency-keyed calls to the fake payment provider
                        and document service (src/fakes)
```

Each outbox event names the next step. A worker claims it, checks that the workflow is still
in the state the event expects, performs the external call with an idempotency key derived
from the workflow id (`charge:<id>`, `documents:<id>`), and then, in one transaction,
confirms it still holds the lease, re-locks the workflow, transitions it, and enqueues the
next event. Delivery is at least once. Effects are exactly once.

| Path | What |
| --- | --- |
| [`src/domain`](src/domain) | State machine, retry policy, pricing rule, error taxonomy. Pure, unit-tested. |
| [`src/outbox`](src/outbox) | Outbox writes, `SKIP LOCKED` claims with leases, the relay loop, retry/dead-letter handling. |
| [`src/workflow`](src/workflow) | Repository (the only code that changes state) and the step handlers. |
| [`src/http`](src/http) | Fastify API: applications, payment webhook, `/healthz`, `/readyz`, `/metrics`. |
| [`src/fakes`](src/fakes) | Fault-injectable payment provider and document service. |
| [`src/observability`](src/observability) | pino JSON logs, prom-client metrics, OpenTelemetry tracing. |
| [`src/faults/crash.ts`](src/faults/crash.ts) | `CRASH_AT=<point>` makes a worker `SIGKILL` itself at a named point. |

## Run it

```bash
docker compose up --build
```

This starts Postgres, the fake services, the API on `localhost:3000` and **two** workers
that compete for the same outbox. If port 5432 is taken, set `POSTGRES_PORT=55432` first.
In another terminal:

```bash
node scripts/smoke.mjs
```

The smoke script creates an application, replays it with the same key, waits for delivery
and prints the transition history. To try a fault live, make the payment provider slow
(longer than the 2s client timeout) and run the smoke script again. The callback will
confirm the payment instead of the charge response:

```bash
curl -X PUT localhost:4001/__faults -H 'content-type: application/json' -d '{"responseDelayMs":4000}'
```

The API by hand:

```bash
curl -s localhost:3000/v1/policy-applications \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo-key-0001' \
  -d '{"businessName":"Acme Bikes","industry":"retail","annualRevenueCents":85000000,"employeeCount":6,"contactEmail":"owner@example.com"}'
```

```bash
curl -s localhost:3000/v1/policy-applications/<workflowId>
```

```bash
curl -s localhost:3000/metrics | grep -E '^(workflow|outbox|duplicates)'
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example a local Jaeger on `http://host.docker.internal:4318`)
to export traces. All configuration is in [`.env.example`](.env.example). There are no secrets.

## Run the tests

The tests need Node 22 and a Postgres. The integration tests use `TEST_DATABASE_URL`,
which defaults to `postgres://postgres:postgres@localhost:5432/policy_test`.

```bash
npm ci
```

```bash
docker compose up -d --wait postgres && docker compose exec postgres createdb -U postgres policy_test
```

```bash
npm run typecheck && npm run lint && npm test
```

`npm run test:unit` needs no database. `npm run test:integration` runs the outbox,
idempotency, API and fault-injection suites against real Postgres. The crash tests spawn
real worker processes. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs
typecheck, lint, unit tests and build, then the integration suite against a Postgres
service container, then `docker compose up --build` with the smoke script.

## Failure modes

Every test below ends by asserting the final state **and** that nothing happened twice
([`test/helpers/assertions.ts`](test/helpers/assertions.ts)): at most one capture per workflow
in the provider's ledger, at most one delivery per policy, each state entered at most once,
and each outbox event type emitted at most once.

| Failure | What the system does | Proven by |
| --- | --- | --- |
| **Worker killed after charging the card, before recording it** | The lease expires and another worker reclaims the event. It re-runs the charge with the same idempotency key. The provider returns the original charge and the workflow continues. | `faults.crash.test.ts`: crash at `after-side-effect:policy.bound` |
| Worker killed holding a lease / between steps / after delivering documents | Same mechanism. Committed work is never redone, and uncommitted work is redone safely. | `faults.crash.test.ts`: `after-claim:policy.bound`, `after-commit:payment.confirmed`, `after-side-effect:policy.issued` |
| Workers `SIGKILL`ed repeatedly at random while 12 workflows are in flight | All 12 complete, each with one capture and one delivery, and nothing is dead-lettered. | `faults.crash.test.ts`: "survives repeated random SIGKILLs" |
| A step crashes its worker every time (poison event) | Attempts are counted at claim time. Past the limit, the event is dead-lettered without running. | `outbox.test.ts`: "crash loop guard" |
| **Payment times out, then succeeds late** | The client gives up and schedules a retry. The provider's callback confirms the payment. The retry then sees `PAYMENT_CONFIRMED` and acknowledges without calling the provider. | `faults.payment.test.ts`: "callback confirms the late capture" |
| Payment times out and no callback ever arrives | The retry reuses the idempotency key and gets the original charge back. | `faults.payment.test.ts`: "without a callback" |
| Provider returns 500 *after* capturing (ambiguous) | Treated as retryable. The repeat is a replay, not a second charge. | `faults.payment.test.ts`: "a 500 after the money moved" |
| Provider 500s persistently | Retries 4× (test config) with backoff, then `DEAD_LETTERED` with the reason `policy.bound failed: exhausted 4 attempts: … HTTP 500`. No capture. | `faults.payment.test.ts`: "dead-letters after the attempt limit" |
| Card declined (4xx) | Not retried. Dead-lettered on the first attempt as `non-retryable`. | `faults.payment.test.ts`: "a declined card is not retried" |
| Payment confirmed *after* the workflow was dead-lettered | The workflow is **not** resurrected. The reason gets `manual refund required` appended and `payment_captured_after_dead_letter_total` is incremented. | `faults.payment.test.ts`: "flags a capture…" |
| **Document service down** | Retries, then dead-letters with the 503 in the reason. The policy stays issued and paid once. Retry and dead-letter log lines carry the correlation id. | `faults.documents.test.ts`: "retries, then dead-letters" |
| Document service recovers within the retry budget, or the host refuses connections | Delivered once after retries. Connection errors are retried like 5xx. | `faults.documents.test.ts` |
| **Duplicate event delivery** (every step event redelivered after completion) | Each copy is recognised as no longer current and acknowledged. The provider is never called again. | `faults.duplicates.test.ts`: "redelivering every step event" |
| Duplicates of one event claimed concurrently in one batch | The row lock plus the state re-check inside the commit let exactly one copy win. | `faults.duplicates.test.ts`: "same batch race", "concurrent duplicate payment steps" |
| **Duplicate payment callbacks** (provider sends 3 copies) | `inbound_events` has a primary key on the provider's event id, written in the same transaction as the effect. Copies are acknowledged with `duplicate`. | `faults.duplicates.test.ts`: "duplicate payment callbacks" |
| **Two workers racing for the same outbox row** | `SKIP LOCKED` means a row is claimed by one worker at a time. 200 rows across 4 claimers gives 0 double claims. 3 workers on 15 workflows complete each exactly once. | `outbox.test.ts`: "SKIP LOCKED"; `faults.race.test.ts`: "three workers" |
| Worker's lease expires mid-step and another worker takes over | The slow worker's commit fails the lease-token fence (`LeaseLostError`) and rolls back. The new owner's result stands, and `outbox_lease_lost_total` is incremented. | `outbox.test.ts`: "expired lease is reclaimed"; `faults.race.test.ts`: "fenced out" |
| Client retries `POST` (same key), possibly concurrently | The stored response is replayed (`Idempotent-Replayed: true`). 20 concurrent requests create 1 workflow. The same key with a different body gets 422. | `api.test.ts`: "API idempotency" |
| Crash between the state change and publishing its event | Impossible by construction: both are in one transaction. | `outbox.test.ts`: "rolls back both" |
| Illegal transition attempted | Rejected, logged, counted, and nothing is persisted. | `stateMachine.test.ts`, `outbox.test.ts`: "rejects and does not persist" |
| Pricing engine transiently unavailable | Retried and completed. | `faults.payment.test.ts`: "transient pricing failure" |
| Database unreachable | `/readyz` returns 503 (`/healthz` stays 200, so the orchestrator stops routing but does not restart). | `api.test.ts`: "reports not-ready" |

## Design decisions

**Why a transactional outbox.** The failure that matters most is a state change that commits
while the event announcing it is lost, or the reverse. Writing the event row in the same
Postgres transaction as the state change removes that window without a distributed
transaction. Postgres is already the source of truth, so the outbox adds no new
infrastructure. The relay is the only component that needs to be at least once, and the
steps are written to absorb that.

**Why leases and fencing, not just row locks.** Holding a row lock across an HTTP call to a
payment provider would tie up a connection per in-flight step and stall on network
partitions. Instead, the claim commits immediately with a lease (owner, random token,
expiry). When a step finishes, its first statement is
`UPDATE outbox … WHERE lease_token = $mine`. If another worker has reclaimed the row, that
update matches nothing and the whole transaction rolls back. The lease (15s) is
comfortably longer than the external call timeout (2s), so takeover only happens when a
worker is really dead or stuck.

**Why "exactly-once effects" instead of exactly-once delivery.** A process can always die
after the remote side acted and before we recorded it. No local trick removes that window,
so the design makes repeats harmless instead:
- external calls carry idempotency keys derived from the workflow id, which are stable
  across retries, crashes and workers;
- internal effects (policy number, state) live in the same transaction as the lease fence;
- `UNIQUE (workflow_id, to_state)` on the audit table and `UNIQUE` on `policy_number` are
  a last line of defence;
- the synchronous charge response and the asynchronous callback share one confirmation
  function, serialised by a row lock.

**Why these retry limits.** The default is 6 attempts with full-jitter exponential backoff
(500ms base, 30s cap): up to 0.5 + 1 + 2 + 4 + 8 = 15.5s of waiting, about 30s including
2s timeouts. That rides out the blips and deploys a payment or email provider typically
has. An outage longer than that is better surfaced to a human as a dead-lettered workflow
with a reason than retried silently for hours. Full jitter stops many workflows that
failed together from retrying in lockstep. Retries are safe because of the idempotency
keys, so the limits are about latency and visibility, not correctness. They are all
configurable. Non-retryable errors (4xx such as a declined card, illegal transitions) skip
retries entirely.

**Why dead-letter is a workflow state.** `DEAD_LETTERED` with a `dead_letter_reason` is
visible through the API, in metrics (`workflows_failed_total{step}`), and in the outbox
(`status = 'dead'`, `last_error`). An operator can see what failed and why without reading
logs.

**One trace per workflow.** The API starts a root span and stores its `traceparent` on the
workflow and on each outbox row. Every step, in whichever worker and however much later,
starts its span from that context, so retries and crash recovery appear in the same trace.

**Deliberately left out**, to keep the scope tight:
- *A message broker.* The relay dispatches to in-process step handlers. The `Relay`
  handler map is the seam where an SQS/Kafka publisher would go. The optional SQS-via-
  LocalStack adapter was not built.
- *Redrive / operator tooling* for dead-lettered workflows, and *automatic refunds* for
  captures that arrive after dead-lettering. These are flagged, not handled.
- *Webhook signature verification* (HMAC) on `/webhooks/payments`, plus authentication and
  rate limiting on the API.
- *Outbox and idempotency-key retention.* Done rows and old keys would need a TTL job in
  production.
- *Customer-facing quote acceptance.* Binding happens automatically after pricing.
- *A UI.*

## How this was built

This project was built with AI coding agents (Claude Code / Codex) working under human
direction. The human set the requirements, the design constraints and the bar for
evidence. All code was verified by the test suite in this repository, including the
fault-injection tests that kill real processes. Nothing here was accepted because it
looked right. It was accepted because a test that tried to break it passed.

## License

[MIT](LICENSE)
