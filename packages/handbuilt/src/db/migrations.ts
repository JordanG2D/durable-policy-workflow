/**
 * Schema migrations, embedded as strings so the compiled service needs no
 * extra files at runtime. Append only; never edit an applied migration.
 */
export const MIGRATIONS: readonly { readonly id: number; readonly name: string; readonly sql: string }[] = [
  {
    id: 1,
    name: "workflow core",
    sql: /* sql */ `
      CREATE TABLE workflows (
        id                   uuid PRIMARY KEY,
        state                text NOT NULL,
        version              integer NOT NULL DEFAULT 0,
        application          jsonb NOT NULL,
        premium_cents        bigint,
        payment_charge_id    text,
        policy_number        text UNIQUE,
        document_delivery_id text,
        dead_letter_reason   text,
        correlation_id       text NOT NULL,
        trace_parent         text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT workflows_state_check CHECK (state IN (
          'QUOTE_REQUESTED','QUOTE_PRICED','POLICY_BOUND','PAYMENT_CONFIRMED',
          'POLICY_ISSUED','DOCUMENTS_DELIVERED','DEAD_LETTERED'))
      );
      CREATE INDEX workflows_state_idx ON workflows (state);

      -- Audit trail. The unique constraint is a last line of defence: a workflow
      -- can enter each state at most once, so a policy can never be issued twice.
      CREATE TABLE workflow_transitions (
        id          bigserial PRIMARY KEY,
        workflow_id uuid NOT NULL REFERENCES workflows (id),
        from_state  text,
        to_state    text NOT NULL,
        cause       text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workflow_id, to_state)
      );

      CREATE TABLE outbox (
        id               bigserial PRIMARY KEY,
        event_id         uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        workflow_id      uuid NOT NULL REFERENCES workflows (id),
        type             text NOT NULL,
        payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
        correlation_id   text,
        trace_parent     text,
        status           text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','done','dead')),
        attempts         integer NOT NULL DEFAULT 0,
        available_at     timestamptz NOT NULL DEFAULT now(),
        lease_owner      text,
        lease_token      uuid,
        lease_expires_at timestamptz,
        last_error       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        processed_at     timestamptz
      );
      -- The relay only ever scans pending rows.
      CREATE INDEX outbox_pending_idx ON outbox (available_at, id) WHERE status = 'pending';

      CREATE TABLE idempotency_keys (
        key             text PRIMARY KEY,
        request_hash    text NOT NULL,
        workflow_id     uuid REFERENCES workflows (id),
        response_status integer,
        response_body   jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      -- Inbound callbacks already processed, keyed by the sender's event id.
      CREATE TABLE inbound_events (
        source      text NOT NULL,
        event_id    text NOT NULL,
        workflow_id uuid,
        outcome     text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source, event_id)
      );

      CREATE SEQUENCE policy_number_seq START 100000;
    `,
  },
];
