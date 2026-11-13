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

The same workflow is implemented **twice**. One is built by hand: the state machine,
outbox and leased relay described below, in [`packages/handbuilt`](packages/handbuilt).
The other runs on [Temporal](https://temporal.io)'s TypeScript SDK, in
[`packages/temporal`](packages/temporal). Both run one shared scenario suite and must reach
the same final states with no double side effects. The
[Hand-built vs Temporal](#hand-built-vs-temporal) section compares them honestly.

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

Those 10 edges are the whole state machine ([`packages/domain/src/stateMachine.ts`](packages/domain/src/stateMachine.ts), shared by both implementations).
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

The Temporal implementation has the same API and fakes, but no Postgres:

```
 client ──POST (Idempotency-Key)──▶ API ── start workflow (id derived from the key,
                                     │       REJECT_DUPLICATE) ──▶ Temporal server
     payment callback ──▶ API ── signal ──────────────────────────▶ (event history)
                                                                         │
                     workers (N): run the workflow code (replayed from history)
                     and its activities: priceQuote, chargePayment, issuePolicy,
                     deliverDocuments, each with its own retry policy and the same
                     idempotency keys, against the same fake services
```

| Package | What |
| --- | --- |
| [`packages/domain`](packages/domain) | Shared by both implementations: the application type and pricing rule, states and legal transitions, step names, idempotency keys, API schemas, the retryable/non-retryable error taxonomy, the fault-injectable fake payment provider, document service and policy registry, idempotency-keyed HTTP clients, tracing helpers and the crash hook. |
| [`packages/handbuilt`](packages/handbuilt) | The hand-built implementation. `src/outbox`: outbox writes, `SKIP LOCKED` claims with leases, the relay loop, the jittered retry policy and dead-letter handling. `src/workflow`: the repository (the only code that changes state) and the step handlers. `src/http`: the Fastify API, including `/metrics`. `src/db`: migrations. |
| [`packages/temporal`](packages/temporal) | The Temporal implementation. `src/workflows.ts`: the whole lifecycle as one workflow. `src/activities.ts`: every side effect. `src/api.ts`: the same HTTP API on a Temporal client. `src/tracing.ts`: OpenTelemetry interceptors. |
| [`packages/parity`](packages/parity) | The scenario suite both implementations must pass, and the small driver interface each one implements. |

## Run it

```bash
docker compose up --build
```

This starts Postgres, the fake services, the hand-built API on `localhost:3000` and **two**
workers that compete for the same outbox. If port 5432 is taken, set `POSTGRES_PORT=55432`
first. In another terminal:

```bash
node scripts/smoke.mjs
```

To run the Temporal implementation alongside it, use the `temporal` profile. It adds the
Temporal dev server (with its Web UI on `localhost:8233`), the Temporal API on
`localhost:3100` and two Temporal workers:

```bash
docker compose --profile temporal up --build
```

```bash
node scripts/smoke.mjs http://localhost:3100
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

The tests need Node 22. The hand-built suites also need a Postgres: the integration tests
use `TEST_DATABASE_URL`, which defaults to
`postgres://postgres:postgres@localhost:5432/policy_test`. The Temporal suites need no
database.

```bash
npm ci
```

```bash
docker compose up -d --wait postgres && docker compose exec postgres createdb -U postgres policy_test
```

```bash
npm run typecheck && npm run lint && npm test
```

`npm run test:unit` needs no database. `npm run test:integration` runs the hand-built
outbox, idempotency, API, fault-injection and parity suites against real Postgres. The
crash tests spawn real worker processes.

`npm run test:temporal` runs the Temporal parity, workflow and replay suites in Temporal's
standard time-skipping test environment, which the SDK downloads on first use. The same
suites also run against a real Temporal server, the dev server from compose (the one test
that needs time skipping is skipped there):

```bash
docker compose --profile temporal up -d --wait temporal
```

```bash
TEMPORAL_ADDRESS=localhost:7233 npm run test:temporal
```

Nothing in the tests can hang silently. Every test, hook and teardown has a hard timeout,
and so do test-server startup, worker shutdown and waiting for a workflow to settle. A
failure reports the workflow's status.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs four groups of jobs:
typecheck, lint, unit tests and build; the hand-built suites on a Postgres service
container; the Temporal suites on the time-skipping server **and** on the compose dev
server; and both compose stacks with the smoke script.

## Failure modes (hand-built)

This table is about the hand-built implementation. The Temporal implementation runs the
shared scenarios in the parity suite, compared in the next section.

Every test below ends by asserting the final state **and** that nothing happened twice
([`packages/handbuilt/test/helpers/assertions.ts`](packages/handbuilt/test/helpers/assertions.ts)): at most one capture per workflow
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

## Hand-built vs Temporal

Both implementations run the same lifecycle with the same states, step names, idempotency
keys, HTTP API, fake providers and dead-letter wording. That makes them directly
comparable. Everything below is measured from this repository or was observed while
building it.

### What each one handles for you, and what you still build

| Concern | Hand-built (`packages/handbuilt`) | Temporal (`packages/temporal`) |
| --- | --- | --- |
| Durable workflow state | You build it: `workflows` table, transition audit table, migrations. | Provided: the event history *is* the state. The workflow keeps it in local variables. |
| Moving to the next step reliably | You build it: transactional outbox, relay, `SKIP LOCKED` claims. | Provided: task queues and workflow tasks. |
| Detecting a dead worker | You build it: leases with expiry, lease-token fencing on commit, attempt counting at claim time (poison-event guard). | Provided: activity start-to-close and heartbeat timeouts, then a retry on another worker. |
| Retries and backoff | You build it: retry policy with full jitter, `next_attempt_at`, dead-letter decision. | Provided: a retry policy per activity (backoff, max attempts, non-retryable error types). No jitter. |
| Idempotent creation (`Idempotency-Key`) | You build it: `idempotency_keys` table, request hash, replayed response. | Mostly provided: the workflow id is derived from the key and `REJECT_DUPLICATE` refuses a second start. You still store the request hash (in the memo) to detect "same key, different body". |
| Payment callback | You build it: `inbound_events` dedupe table, row lock shared with the charge response. | A signal. You still decide what a duplicate, a late or a mismatched confirmation means (workflow code). |
| Reading current state | A `SELECT`. | A query, which needs a worker to answer. Ad-hoc SQL across workflows is gone; you would add search attributes or a read model. |
| Idempotency of each side effect | Yours: keys derived from the workflow id. | **Still yours, unchanged.** Activities run at least once, so the same keys are passed to the same providers. Temporal does not make an HTTP call exactly-once. |
| Retryable vs permanent errors | Yours: the shared error taxonomy. | Still yours: the same taxonomy, mapped to `nonRetryableErrorTypes`. |
| Business failure state and reason | Yours: `DEAD_LETTERED` plus `dead_letter_reason`. | Still yours: Temporal reports "Failed", but the reason, the late-capture window and the refund flag are workflow code. |
| Numbering policies | A Postgres sequence in the same transaction as the transition. | No database to share a transaction with, so it became an external, idempotent call (the fake policy registry). |
| Determinism | Not a concern. | **New work.** Workflow code must replay identically. That means a lint rule, recorded-history replay tests, and versioning (`patched()`) for any change that affects running workflows. |
| Tracing | You build it: stored `traceparent` on workflow and outbox rows. | Interceptors provided. You still need some glue: activity spans to match your own naming, plus an adapter because the interceptors package is built on OTel SDK 1.x and this repo uses 2.x. |
| Metrics | You build them: prom-client counters and histograms. | SDK and server metrics are provided, but they are not wired into this repo. Business metrics would still be yours. |
| Operator view | `GET` the workflow, look at outbox rows. | Temporal Web UI: the full history of every attempt, signal and timer, per workflow. |

### Lines of code

Non-blank, non-comment TypeScript lines (`npm run loc`):

| | Hand-built | Temporal |
| --- | --- | --- |
| Implementation (`src`) | **1,318** in 15 files | **730** in 10 files |
| of which durability machinery | ~880: outbox, relay, retry policy, repository, step handlers, migrations, pool | ~430: workflow, activities, worker setup, definitions, tracing glue |
| of which API | 161 | 170 |
| Implementation-specific tests | 1,182 | 482 |
| Shared by both | 698 domain, 331 parity suite | (same) |

The Temporal code is about 45% smaller, and almost all of the difference is durability
machinery that Temporal provides. The API is the same size in both. The hand-built version
also carries Prometheus metrics (96 lines) that the Temporal version does not reimplement.

### Failure modes each covers

Both implementations pass every scenario in the parity suite. They get there by different
mechanisms:

| Scenario (parity suite) | Hand-built | Temporal |
| --- | --- | --- |
| Happy path, one trace per workflow | Outbox steps; stored `traceparent`. | One workflow; client, workflow and activity interceptors. |
| Same `Idempotency-Key` twice / with a different body | `idempotency_keys` row. | Workflow-id uniqueness plus the request hash in the memo. |
| Duplicate payment callbacks (3 copies) | `inbound_events` primary key, then a state check. | Signal handler: event-id set, then a state check. |
| Charge times out, callback confirms it | The callback commits `PAYMENT_CONFIRMED`; the later retry sees it and does nothing. | The signal wins the race. The charge activity is cancelled and its in-flight attempt is aborted through heartbeats. The provider is called once. |
| Charge times out, no callback | The retry replays the original charge (same key). | The activity retry replays the original charge (same key). |
| Success arrives after the workflow failed | The reason is annotated "manual refund required"; the workflow is not resurrected. | The workflow stays open for a 24h late-capture window and annotates the reason the same way. After the window, the webhook reports `workflow-closed`. |
| Transient 500s, persistent 500s, declined card | Relay retry policy; non-retryable errors skip retries. | Activity retry policy; `NonRetryableError` is in `nonRetryableErrorTypes`. |
| Document service down / recovering | Retries, then dead-letter with the 503 in the reason. | Same, same wording. |
| Worker SIGKILLed after charging / after delivering | The lease expires, another worker reclaims the event and replays the call with the same key. | The attempt's heartbeat or start-to-close timeout fires, the activity is retried on another worker, the call is replayed with the same key, and the workflow is rebuilt from history. |

Covered only by the hand-built suite: racing workers on one outbox row, lease takeover and
fencing, random repeated SIGKILLs across 12 workflows, the poison-event crash loop.
Temporal handles these inside the server, so there is nothing of ours to test.

Covered only by the Temporal suite: replaying recorded histories (and rejecting a reordered
workflow), the state query, direct duplicate and mismatched signals, and the real
production retry policies (8 attempts, then the 24h window) run in seconds under time
skipping.

### What the port taught us

Running the parity suite against Temporal found problems that a happy-path port would
have shipped:

- **Cancelling a running activity is not free.** With the default `TRY_CANCEL`, the
  workflow finished while a cancelled charge attempt was still in flight. On the
  time-skipping test server, that attempt's late report never released the server's time
  lock. Every later test then waited in real time on a 24h timer, and the first full test
  run hung. The fix is also correct in production: `WAIT_CANCELLATION_COMPLETED`, plus a
  heartbeating charge activity that aborts its HTTP call when cancelled. Tests now also
  have hard deadlines everywhere and fail with the workflow's status.
- **The test server is not the server.** It did not resolve a cancelled activity that then
  failed (the dev server records it as `ACTIVITY_TASK_FAILED` with `CANCEL_REQUESTED`). It
  also did not move a dead worker's sticky tasks back to the shared queue. This is why CI
  runs the Temporal suites on both servers.
- **Workflow ids are a global namespace.** On a long-lived server, a fixed idempotency key
  in a test matched a workflow from the previous run. Correct behaviour, wrong test.
- **Timing assumptions differ.** The real server retries slower than the in-process relay,
  so "a callback that arrives after the retries are exhausted" needed a callback that is
  late on any server, not only on a fast one.

### Operational cost of running Temporal

- **A stateful cluster, or a vendor.** Self-hosted Temporal is four services (frontend,
  history, matching, worker) on a persistence store (Postgres, MySQL or Cassandra), plus
  optionally Elasticsearch or OpenSearch for advanced visibility. You size it, monitor it,
  upgrade it (including schema migrations) and back it up. The history shard count is
  fixed when the cluster is created. Temporal Cloud removes that work in exchange for
  usage-based pricing; check current pricing for your volume. The single-binary dev server
  used here (`temporalio/temporal`, in-memory) is for development only.
- **Heavier workers.** The worker embeds a Rust core and bundles workflow code with
  webpack. The Temporal image here is 769 MB against 387 MB for the hand-built one. The
  workflow bundle is prebuilt at image build time.
- **Discipline on every change.** Any edit to `workflows.ts` must be checked against the
  histories of workflows that may still be running. Incompatible changes need
  `patched()` or worker versioning. That review step does not exist in the hand-built
  version, where a step handler is ordinary code.
- **Data in history.** Workflow inputs and activity results, including the applicant's
  email address, are stored in Temporal's history for its retention period. In production
  you would add a payload codec to encrypt them, and set retention deliberately.
- **Limits to know about.** A history caps at 50k events / 50 MB. This workflow uses
  29–38 events, so it is nowhere near.

The hand-built version needs only the Postgres it already had.

### When to choose which

**Choose the hand-built approach** when you have a few short, mostly linear workflows; you
already run Postgres and want no new infrastructure; and you benefit from the workflow
state living next to your business data. Same-transaction effects (like the policy-number
sequence) and SQL reporting over workflow state are real advantages. Budget for the parts
that are easy to get subtly wrong: leases, fencing, crash-loop guards. In this repo they
took the most tests.

**Choose Temporal** when there are many workflow types, or workflows that wait for days or
months (renewals, endorsements, claims with human review), sagas with compensation,
fan-out, or several teams writing workflows. That is where "a timer is one line" and the
Web UI pay for the cluster. It also fits when you would otherwise rebuild what this repo's
hand-built package already is, a third time.

### Verdict

For this single workflow, both are correct, and the parity suite shows it. The hand-built
version is the simpler system to *operate*: it adds nothing beyond Postgres. The Temporal
version is the simpler system to *write and change*: 45% less code, and no outbox, leases
or retry scheduler to maintain. In exchange you take on a cluster, determinism rules and
workflow versioning.

With one workflow and an existing Postgres, I would ship the hand-built version. With a
roadmap of more workflows, especially long-running ones, I would move to Temporal (or
Temporal Cloud). The second workflow is where it starts paying back. Either way, Temporal
does not remove the need for idempotency keys on every side effect. Activities are
at-least-once, exactly like the outbox relay.

### How the migration was done

The port was a staged migration on a branch, merged by pull request, with each stage a
small commit that kept every existing suite green:

1. **Workspaces.** The hand-built service moved into `packages/handbuilt` unchanged.
   Tests and the compose smoke test were green before anything else changed.
2. **Shared domain.** Everything both implementations must agree on moved to
   `packages/domain`: types, pricing, states, error taxonomy, fakes, HTTP clients, tracing.
3. **Shared contract.** Step names, idempotency keys, API schemas and request hashing were
   centralised, and a fake policy registry was added for Temporal.
4. **Parity suite first.** The scenarios in `packages/parity` were written and run against
   the *hand-built* implementation before any Temporal code existed. This recorded how
   the existing system behaves, so the port had a fixed target.
5. **Temporal implementation.** One workflow, four activities, the signal and the query,
   per-activity retry policies, the API, and OpenTelemetry interceptors.
6. **Parity on Temporal.** The same suite with a Temporal driver, on the time-skipping
   server and on the dev server. This stage found the problems listed above.
7. **Determinism guards.** Committed histories recorded on the real dev server, a replay
   test that must accept them and must reject a reordered workflow, and lint rules that
   forbid `Date.now`, `Math.random`, timers and I/O in workflow code.
8. **Build and CI.** A Temporal image with a prebuilt workflow bundle, a compose profile,
   and CI jobs for both implementations, Temporal on both servers, and both stacks
   smoke-tested.

**Parity** means the same scenario code, fault settings and expectations
(`packages/parity/src/suite.ts`) run against both implementations. Each implementation only
supplies a driver (start a worker, start a worker that SIGKILLs itself, wait until
settled, count issued policies). The suite talks to the public HTTP API and the fake
providers' ledgers, never to implementation internals. Each scenario asserts the final
state and the invariant: at most one capture, one policy number and one delivery per
workflow, and each state entered once.

**Who did the work.** AI coding agents (Claude Code) did the implementation under human
direction. The human set the requirements and constraints, and reviewed the stages. When
the first Temporal test run hung, the human stopped it and required a root cause and hard
timeouts before work continued. The tests were the gate: a stage was done when the
existing suites and the parity suite passed, not when the code looked right.

## Design decisions (hand-built)

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
- *A local message broker.* Local development still dispatches in-process. The AWS
  adapter described above uses SQS while preserving the handler and lease-fencing
  contract. A LocalStack deployment was not built.
- *Redrive / operator tooling* for dead-lettered workflows, and *automatic refunds* for
  captures that arrive after dead-lettering. These are flagged, not handled.
- *Webhook signature verification* (HMAC) on `/webhooks/payments`, plus authentication and
  rate limiting on the API.
- *Outbox and idempotency-key retention.* Done rows and old keys would need a TTL job in
  production.
- *Customer-facing quote acceptance.* Binding happens automatically after pricing.
- *A UI.*

## How this was built

This project, including the Temporal port, was built with AI coding agents (Claude Code)
working under human direction. The human set the requirements, the design constraints and the bar for
evidence. All code was verified by the test suite in this repository, including the
fault-injection tests that kill real processes. Nothing here was accepted because it
looked right. It was accepted because a test that tried to break it passed.

## Running on AWS

This is a **disposable portfolio demo**, not a production insurance or payment
system. Only `packages/handbuilt` is deployed. Temporal stays local. Payment and
document providers are synthetic, with idempotent effects recorded in Postgres;
no real payment is charged or email sent. Use synthetic applicant data only.

**Verification status (13 November 2026, UTC):** the
[deployment run](https://github.com/JordanG2D/durable-policy-workflow/actions/runs/43336057606)
on main commit `8859505` passed deployment and both migration checks at 00:29:50.
The full cloud smoke test passed at 00:47:11: synthetic policy delivery, semantic
idempotent replay, native poison-message DLQ redrive and the DLQ alarm.
Automated cleanup failed at 01:31:34 after guarded mapping recovery; the workflow
run was not entirely successful. AWS subsequently released the shared Lambda
network interface as an ordinary detached, available interface. Its exact
demo-owned orphan was manually deleted around 01:40, and a standard CloudFormation
retry reached `PolicyDemo` `DELETE_COMPLETE` at 01:42:08. Runtime teardown was
verified after manual recovery: fresh console checks through approximately 01:44 found no
demo VPC or regional network interfaces, no RDS databases, snapshots or retained
backups, an empty application asset bucket, and only the bootstrap stack active.
Function and event-source mapping inventories were empty at 01:39–01:40; the
remaining categories were empty in the workflow inventory at 01:31:34, with none
recreated afterward. This combines workflow inventory with later targeted checks;
it is not a claim that automated teardown passed. Intentional bootstrap resources
and the RDS service-linked role are retained; console-template staging is
preserved separately from runtime cleanup.

```mermaid
flowchart LR
  Client[Signed IAM demo client] --> HTTP[HTTP API]
  HTTP --> API[Node 22 API Lambda]
  API --> DB[(Single-AZ private Postgres)]
  Schedule[EventBridge Scheduler every minute] --> Relay[Outbox publisher Lambda]
  Relay --> DB
  Relay --> Queue[SQS workflow events]
  Queue --> Worker[Worker Lambda]
  Worker --> DB
  Queue -->|poison redrive| DLQ[SQS DLQ]
  Worker -->|durable terminal-failure notice| DLQ
  Migration[Deploy-time migration Lambda] --> DB
  Secret[Secrets Manager] --> API
  Secret --> Relay
  Secret --> Worker
  Secret --> Migration
  Logs[JSON CloudWatch logs + EMF lag metric + X-Ray]
  API -.-> Logs
  Relay -.-> Logs
  Worker -.-> Logs
```

The VPC has two isolated subnets because an RDS subnet group requires two AZs.
The database, Lambdas and the two interface endpoints use **one** AZ. There is no
NAT gateway, Internet gateway, public database, or public IPv4 address. Outbound
traffic is limited to Postgres and the SQS/Secrets Manager endpoints. Lambda's
managed log and X-Ray delivery does not need extra VPC endpoints. The publisher
emits the outbox lag metric as CloudWatch Embedded Metric Format (EMF), rather
than calling the monitoring API through a third endpoint.

### Costs and limits

The demo spending allowance is **$5**. Stop before spending more; the budget alert
is only a delayed warning, not enforcement.

The earlier **~$15–30/month** estimate can apply with allowances or credits; it is
**not a reliable ceiling**. At current us-east-1 list prices, 730 running hours
are roughly **$30.28/month before request/compute/log charges, tax and credits**:

| Item | Approximate monthly baseline |
| --- | ---: |
| RDS PostgreSQL db.t4g.micro, single AZ | $11.68 |
| 20 GiB gp3 database storage | $2.30 |
| SQS and Secrets Manager interface endpoints, one AZ each | $14.60 |
| One Secrets Manager secret | $0.40 |
| DLQ, outbox and error-rate alarms (10 evaluated metrics total) | $1.00 |
| One custom outbox-lag metric | $0.30 |

The error-rate alarm combines Errors and Invocations for four functions, so it
has eight evaluated metrics. A 31-day month adds about $0.50 to endpoint/instance
charges. Free-plan credits, remaining balance and expiry are account-specific;
never assume free RDS. API requests, Lambda/SQS use, secret reads, logs, traces,
asset storage, data transfer and surplus RDS CPU credits can add charges.
Sources: [RDS](https://aws.amazon.com/rds/postgresql/pricing/),
[PrivateLink](https://aws.amazon.com/privatelink/pricing/),
[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/),
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/).

**Deploy for a demonstration, run the smoke test, destroy immediately.** Endpoint
billing rounds partial endpoint-hours up; RDS has a minimum charge when an
instance is started. A short session is much cheaper than leaving it running,
but there is no automatic hard dollar cap.

Required cost controls:

- An account-wide **$5 USD monthly AWS Budget** with an actual-spend email alert
  must exist before bootstrap or deployment. `portfolio-demo-budget` is the
  default name. `infra/lib/budget-stack.ts` defines the budget as code; reuse an
  existing verified budget instead of creating a duplicate. `POLICY_CREATE_BUDGET`
  is off by default. An alert recipient must be explicitly supplied.
- Budget data normally refreshes every **8–12 hours** and notifications may lag.
  The alert does not stop resources, and teardown charges can appear later.
- No NAT; one AZ per interface endpoint; single-AZ micro RDS; low Lambda reserved
  concurrency; IAM-authenticated API with 2 requests/second and burst 5 throttles.
- Seven-day log retention, no database backups/final snapshots, deletion policies
  on runtime resources, and a separate residual-resource verification.
- GitHub's manual demo workflow always attempts cleanup, including after a failed
  smoke test. Cancellation, runner loss or hard timeout can defeat `always()`;
  dispatch `destroy` or run the command below and verify its result.

### Review and first bootstrap

Requirements: Node.js 22, npm, `zip`, and temporary AWS credentials for the first
bootstrap only. Keep credentials in the operator's environment or approved
credential provider, never an env file in this repository. Do not paste keys
into chat, shell history, workflow YAML, commits, or Actions secrets.

Before applying anything, review and approve the supporting resource inventory:
`PolicyDemo` creates the VPC/subnets/routes/security groups, RDS subnet group,
scoped Lambda/Scheduler roles and policies, API integration/routes/stage,
Lambda event mapping and invocation permission, alongside the requested services.
The ZIP-only `PolicyDemoBootstrap` creates a private S3 asset bucket and policy,
a GitHub OIDC provider only if absent, a repository/main-bound deployment role,
a CloudFormation service role and a runtime permissions boundary. It creates
**no ECR repository, SSM parameter, customer-managed KMS key, helper Lambda, SNS
topic or extra VPC endpoint**. AWS may create the RDS service-linked role and
service-managed ENIs. Stop if anything outside this inventory is needed.

**Lambda quota preflight:** this stack reserves six concurrent executions
(API 2, worker 2, publisher 1, migration 1). Lambda requires 100 executions to
remain unreserved, so the account's applied regional concurrency quota must be
at least **106** before deployment. Fresh accounts can start with a quota of 10,
which blocks this configuration. The AWS quota-request console currently requires
a minimum request of 1,000, although this stack itself needs only 106. Obtain owner
approval for the amount accepted by that form and confirm the increase is applied
in us-east-1 before deploying. Keep the function caps in place rather than removing
them to bypass the quota check.

**Approved stage-tagging recovery permission:** the bootstrap adds only
`apigateway:TagResource` on `arn:${AWS::Partition}:apigateway:us-east-1::/apis/*/stages`
(with no trailing `/*`), requiring requested `Project=PolicyDemo` and tag keys
limited to Project or CloudFormation system keys. This wildcard covers stage
collections under other HTTP APIs in us-east-1. Request-tag propagation for this
literal action is not fully documented. The conditions were validated during live
stage creation in run `43323262418` on commit
`1ca27ac45d2f474aa8c6765e4b3c1b2ecf0e966a`: deployment succeeded and both migration
invocations passed at 22:59 UTC on 12 November 2026. This validates stage creation,
not the complete smoke test or teardown. This is not a grant for route/integration
tags or untagging. The owner approved this exact persistent permission; review its
scope before applying and obtain fresh approval for material changes. No resources
are added.

**Approved Lambda configuration reads:** CloudFormation can inspect code-signing,
recursion, runtime-management and scaling configuration using exactly
`lambda:GetFunctionCodeSigningConfig`, `lambda:GetFunctionRecursionConfig`,
`lambda:GetRuntimeManagementConfig` and `lambda:GetFunctionScalingConfig`, limited
to functions named `policy-demo-*` in the stack account/region. These permissions
are read-only and do not add function changes, resources or untag permissions.

**Approved RDS prerequisite:** AWS may automatically create the account-wide
`AWSServiceRoleForRDS` service-linked role so RDS can manage supporting resources.
The owner explicitly approved that prerequisite. It has no separate recurring
charge and persists in the account after demo teardown. The role's presence has
been confirmed and it is retained. The existing bootstrap permission already
covers that exact role; this does not expand the service-linked-role grant.

**Reviewed recovery permissions:** the bootstrap includes two separate recovery
exceptions approved by the owner for this demo. Review their exact scope and risks
before applying; any material change requires fresh persistent-access approval.

- **IAM absent-role cleanup:** GetRole/DeleteRole are added for exactly the five
  root-path names `policy-demo-api`, `policy-demo-migration`, `policy-demo-publisher`,
  `policy-demo-worker`, and `policy-demo-scheduler`. The observed errors may reflect
  IAM's authorization behavior for nonexistent roles; the full failing ARN has
  not been proven. This exception could read/delete a real same-name root-path
  role if one exists later. Runtime role creation, boundary requirements, policy
  writes and PassRole stay restricted to `/policy-demo/runtime/`.
- **HTTP API tagging:** POST is added only for the observed URL-encoded HTTP API
  tag ARN prefix in us-east-1, requiring requested `Project=PolicyDemo` and tag
  keys limited to Project or CloudFormation system keys. There is no untag grant.
  This wildcard can retag another HTTP API in the region, which could enable the
  existing Project-tag-based management/delete permissions on that API. It is
  not fully project-isolated. Request-tag conditions fail closed; their actual
  propagation must still be validated in an approved live run. No resource-tag
  or API-name condition is assumed for this tagging operation.

These recovery permissions add no resource classes. The API operation is described by the
[API Gateway authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigateway.html)
and [HTTP API tagging reference](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/tags-resource-arn.html).

The GitHub role cannot create/update the bootstrap stack or assume its execution
role directly. It can pass that role only to CloudFormation. Runtime roles are
restricted to `/policy-demo/runtime/` and must carry the approved permissions
boundary. Network creation requires the project tag; network modifications are
restricted to that tag. Some AWS create/list APIs have no pre-existing resource
identifier, and their permissions use service/region constraints rather than
claiming every permission can have a resource-specific ARN. Review the complete
policy in `infra/bootstrap/template.mjs` before granting access.

Event-source mapping create/get/update/delete permissions bind the exact
`policy-demo-worker` function; update/delete additionally require its Project tag.
The tag APIs do not support a function-ARN condition, so initial tagging is an
explicit exception: the execution role can set `Project=PolicyDemo` on an untagged
mapping in this account and region, even one belonging to another function. It
cannot overwrite another Project value. Tag writes are restricted to Project and
CloudFormation's reserved system-tag namespace. No event-source mapping untag
permission is granted: demo tags are immutable, and cleanup deletes the mapping
itself rather than removing its tags.
Tagging alone does not grant mapping lifecycle access to other functions. Read-only
mapping listing and tag lookup cover the account's us-east-1 mappings to support
CloudFormation discovery and initial stabilization. No mapping tag-update flow is authorized; review the policy before changing tags.
These conditions follow the [Lambda authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html)
and [event-source mapping tagging guide](https://docs.aws.amazon.com/lambda/latest/dg/tags-esm.html);
local policy assertions do not substitute for a live CloudFormation lifecycle test.

HTTP API route/integration/stage paths cannot be restricted to an ID before it exists;
this documented child-resource exception is limited to the CloudFormation
service role and us-east-1.

The apply example below requires the GitHub CLI (`gh`) to be installed and already
authenticated for this repository. It captures the required IDs without printing
them and keeps the environment variables inside a temporary subshell.

```sh
npm ci
npm run aws:bootstrap              # creates a local review template; no AWS calls
# Only after reviewing and explicitly approving persistent access:
(
  set -eu
  set +x                          # do not trace captured values
  POLICY_GITHUB_OWNER_ID="$(gh api repos/JordanG2D/durable-policy-workflow --jq '.owner.id')"
  POLICY_GITHUB_REPOSITORY_ID="$(gh api repos/JordanG2D/durable-policy-workflow --jq '.id')"
  export POLICY_GITHUB_OWNER_ID POLICY_GITHUB_REPOSITORY_ID
  AWS_REGION=us-east-1 AWS_BUDGET_NAME=portfolio-demo-budget \
    AWS_BOOTSTRAP_APPROVED=true npm run aws:bootstrap -- --apply
)
```

Bootstrap refuses an existing stack rather than silently expanding its IAM
permissions. It checks the budget before writes and reuses an existing matching
GitHub OIDC provider without changing it. Account-specific outputs are saved
only to ignored `infra/.state/bootstrap-outputs.json`, with owner-only access.
Set the repository Actions variable **POLICY_DEMO_ROLE_ARN** to its
`GithubRoleArn`. This value is not a secret, but it is kept out of the public
repository. No long-lived AWS key belongs in GitHub.

The trust policy uses GitHub's [immutable repository subject](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims), not the legacy
name-only subject. `Repository` still supplies the owner/repository names;
`RepositoryOwnerId` and `RepositoryId` are required parameters with no defaults.
Supply the verified public numeric IDs privately through the deployment parameters
or the required `POLICY_GITHUB_OWNER_ID` and `POLICY_GITHUB_REPOSITORY_ID`
environment inputs shown above; do not commit account or repository IDs. The
subject is exactly `repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID:ref:refs/heads/main`,
with audience `sts.amazonaws.com`. There is no wildcard or legacy fallback.
Before creating or correcting trust, inspect the authenticated GitHub endpoint
`GET /repos/JordanG2D/durable-policy-workflow/actions/oidc/customization/sub` and
confirm `use_immutable_subject` and `sub_claim_prefix` match these parameters.
Then compare the IAM role's subject, audience and provider to the reviewed
template. A successful read of this GitHub endpoint is not an AWS authentication
test: verify the manual workflow actually assumes the role. Existing trust-policy
corrections require separate approval; generating this template changes nothing
in AWS. If the repository moves or its OIDC subject configuration changes, review
all names/IDs and the exact subject again rather than broadening trust.

Once the role exists, notify the owner. **Verify a manual OIDC workflow before
removing the temporary `portfolio-bootstrap` IAM user**, so there is a working
replacement. The owner deletes that user and its keys only at the explicitly
approved time. The app runtime never needs administrator access.

### Deploy, migrate and smoke test

After the code is reviewed and the workflow is on `main`, open GitHub Actions →
**Disposable AWS demo** → **Run workflow**, select `demo`, and approve the
reviewed resource inventory. Deployment is manual only; PRs never deploy and
never receive AWS credentials. The workflow uses short-lived GitHub OIDC
credentials, refreshes them before cleanup, and serializes demo runs.

PR checks run `cdk synth` and `cdk diff` against a separately synthesized trusted
base template. This is deliberately **offline**, not a live-account drift check,
so forked PR code cannot obtain AWS privileges. Runtime resources are created
from the synthesized template with an explicitly scoped CloudFormation role.

For the approved first deployment or private troubleshooting with the same
short-lived credentials, the equivalent commands are:

```sh
export AWS_REGION=us-east-1 AWS_BUDGET_NAME=portfolio-demo-budget
export AWS_DEMO_APPROVED=true      # only after inventory/cost approval
npm run aws:deploy
npm run aws:smoke
npm run aws:destroy
```

Before any asset upload or resource write, deploy validates the $5 budget and
bootstrap, then runs the same read-only inventory used to verify cleanup. A denied
inventory read stops deployment with a sanitized service/action/error code.
Existing resources are allowed for a healthy stack update; resources found without
their runtime stack must be inspected or cleaned up first.

For `portfolio-demo-budget`, the console-confirmed ACTUAL/GREATER_THAN alerts at
50%, 80%, and 100% ($2.50/$4/$5) have returned an omitted `ThresholdType` through
the API. The guard recognizes only that verified budget/alert combination as a
percentage compatibility case. Other omitted or unknown types fail closed;
explicit percentage and absolute-value alerts retain their stated meaning.
[AWS's API documentation](https://docs.aws.amazon.com/cli/latest/reference/budgets/describe-notifications-for-budget.html)
marks the type optional and retains legacy percentage wording, but does not
explicitly guarantee a general omitted-type default. The guard does not assume one.

Deploy invokes the migration Lambda twice. Migrations take a transaction-scoped
advisory lock, hash the exact identity/SQL bytes, reject changed or unknown
history, and skip already applied migrations. Only the exact original legacy
migration can be upgraded from an unhashed row. The second deploy-time invocation
must report no new migrations.

The smoke test signs requests with AWS SigV4, creates a synthetic policy,
checks completion and idempotent replay, and sends a uniquely identified poison
message to the work queue. It waits for **native SQS redrive** into the DLQ and
for the DLQ alarm to become ALARM; it also checks that the other two alarms exist.
All waits have deadlines. The default one-minute scheduler means completion is
measured in minutes, not the local relay's milliseconds.

An offline regression through the Fastify Lambda adapter and PostgreSQL 16
confirmed that JSONB can reorder the stored response's object keys without
changing its values. Replay verification uses deep strict equality, preserves the
replay-header check, and checks the original HTTP status. Tests reject changed,
missing or extra fields, changed value types and reordered arrays; durable-effect
and transition checks remain in place. The subsequent cloud smoke test also
passed, as recorded in the verification status above.

SQS is a transport adapter, not a second workflow database. The scheduler sends
due outbox event IDs without marking them complete. The worker claims the exact
DB event and reuses the unchanged step handlers and fenced transaction logic.
Duplicates, expired leases and publish-after-crash repeats are safe; Postgres
still owns retry/backoff and workflow state. Terminal failures have a durable
outbox notice mirrored to the DLQ. Malformed poison messages use SQS native
redrive and partial batch failure responses.

### Destroy and verify

```sh
npm run aws:destroy               # delete runtime, empty demo assets, verify residuals
npm run aws:verify-clean          # read-only verification afterward
```

Destruction skips final RDS snapshots and deletes automated backups. Verification
checks for demo-owned resources and retained snapshots/automated backups instead
of interpreting `DELETE_COMPLETE` alone as proof. The stack never configures
cross-region backup replication; if that changes, its backups must also be
included in cleanup. Residuals or inaccessible inventory fail the command and
need inspection. Never delete unrelated account resources to make a check pass.

If deletion fails on `WorkerMessages`, cleanup permits one guarded retry only
after the complete regional Lambda mapping inventory proves that exact record's
UUID is absent. It skips only the stale CloudFormation record, never a live
mapping or another resource. IAM permissions are not broadened, and full residual
verification must still pass before cleanup is reported complete.

For a remaining Lambda network-interface orphan, follow
[AWS's VPC networking guidance](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html).
Never force-detach or delete an in-use or Lambda-type interface. Verify exact demo
ownership and confirm the relevant functions and event-source mappings are absent.
Only after AWS releases it as an ordinary, detached, available interface may an
operator perform ordinary deletion of that exact orphan. Then retry standard
CloudFormation deletion and repeat the full residual inventory. This manual
recovery does not turn a failed automated-cleanup run into a successful one.

Alarm verification reads exactly the three metric-alarm names in
`scripts/aws/alarm-names.json`, rather than enumerating an arbitrary name prefix.
An infrastructure test requires that list to equal the synthesized alarm names.
This covers this stack's fixed alarm inventory, not additional manually created
alarms. [CloudWatch's authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html)
supports alarm-resource scoping; the preflight verifies that the actual role can
perform the exact-name read without widening IAM permissions.

The empty bootstrap bucket, IAM/OIDC setup and budget deliberately remain for
future manual demos; none has a recurring base charge once the bucket is empty.
Asset uploads are under `policy-demo/`, with a one-day lifecycle fallback.
To remove the free bootstrap as well, the owner can delete `PolicyDemoBootstrap`
after confirming its bucket is empty and no future OIDC run needs the role.
An existing account-wide OIDC provider reused by bootstrap is not owned/deleted
by this project. Do not delete a shared provider or an unrelated budget.

### What production would change

This demo intentionally sacrifices durability and availability for reversibility.
Production needs multi-AZ database capacity, backups/PITR and restore drills,
credential rotation and least-privilege database users, production provider
integrations and signed callbacks, WAF through a supported front door,
strong customer authorization, alarms routed to responders, audited redrive and
retention policies, and a reviewed update/rollback strategy. Provisioned
concurrency, RDS Proxy and additional endpoints may be appropriate after real
load measurement; none is included in this demo's budget. Add them only with
explicit resource and spending approval.

## License

[MIT](LICENSE)
