-- Clinic Core — 001: platform, tenancy and shared infrastructure
-- Every clinical/financial table carries tenant_id and is protected by
-- FORCE ROW LEVEL SECURITY keyed on the transaction-local setting
-- app.tenant_id. A missing setting yields zero rows (fail closed).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Returns the tenant bound to the current transaction, or NULL.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Enables tenant isolation on a table. Called once per tenant table.
CREATE OR REPLACE FUNCTION app_enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
    tbl);
END $$;

-- Blocks UPDATE/DELETE on append-only tables.
CREATE OR REPLACE FUNCTION app_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;

-- ---------------------------------------------------------------- platform
CREATE TABLE platform_admin (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admin_email_uq ON platform_admin (lower(email));

CREATE TABLE platform_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid NOT NULL REFERENCES platform_admin(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per client clinic/hospital. Not RLS-protected: it is the
-- routing table used to resolve a slug or API key to a tenant.
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text NOT NULL,
  legal_name  text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','offboarded')),
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  currency    text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  locale      text NOT NULL DEFAULT 'en-IN',
  -- branding: { primaryColor, accentColor, logoUrl, address, phone, email, website, registrationText }
  branding    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- settings: { soloPractice, uhidPrefix, holdMinutes, noShowGraceMinutes, bookingHorizonDays,
  --             minLeadMinutes, publicBookingEnabled, requireAllergyReviewToSign }
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Validate the timezone at write time so session expansion never fails later.
CREATE OR REPLACE FUNCTION tenant_check_tz() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM now() AT TIME ZONE NEW.timezone;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_check_tz BEFORE INSERT OR UPDATE OF timezone ON tenant
  FOR EACH ROW EXECUTE FUNCTION tenant_check_tz();

-- API keys used by client websites (publishable) and server integrations (secret).
CREATE TABLE tenant_api_key (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  kind            text NOT NULL CHECK (kind IN ('publishable','secret')),
  label           text NOT NULL,
  key_prefix      text NOT NULL,
  key_hash        text NOT NULL UNIQUE,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX tenant_api_key_tenant_idx ON tenant_api_key (tenant_id);

-- Gapless, transaction-safe counters: UHID, invoice, receipt, queue tokens.
CREATE TABLE doc_sequence (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  scope       text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, scope)
);
SELECT app_enable_tenant_rls('doc_sequence');

-- Allocates the next number in a scope inside the caller's transaction.
CREATE OR REPLACE FUNCTION next_doc_number(p_scope text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO doc_sequence (tenant_id, scope, next_value)
  VALUES (app_tenant_id(), p_scope, 2)
  ON CONFLICT (tenant_id, scope) DO UPDATE SET next_value = doc_sequence.next_value + 1
  RETURNING next_value - 1 INTO v;
  RETURN v;
END $$;

-- ---------------------------------------------------------------- reliability
-- API-002 / DM-006: replay-safe commands.
CREATE TABLE idempotency_key (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  principal      text NOT NULL,
  operation      text NOT NULL,
  key            text NOT NULL,
  request_digest text NOT NULL,
  status_code    int  NOT NULL,
  response       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal, operation, key)
);
SELECT app_enable_tenant_rls('idempotency_key');

-- API-004 / DM-006: transactional outbox. One event per accepted mutation.
CREATE TABLE outbox_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  type           text NOT NULL,
  aggregate_kind text NOT NULL,
  aggregate_id   uuid NOT NULL,
  aggregate_version bigint,
  correlation_id text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX outbox_pending_idx ON outbox_event (occurred_at) WHERE processed_at IS NULL;
SELECT app_enable_tenant_rls('outbox_event');

CREATE TABLE webhook_endpoint (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  url             text NOT NULL CHECK (url ~ '^https://'),
  secret          text NOT NULL,
  events          text[] NOT NULL DEFAULT '{}',
  include_contact boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('webhook_endpoint');

CREATE TABLE webhook_delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoint(id),
  event_id        uuid NOT NULL REFERENCES outbox_event(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts        int NOT NULL DEFAULT 0,
  response_code   int,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (next_attempt_at) WHERE status = 'pending';
SELECT app_enable_tenant_rls('webhook_delivery');

-- DM-008: append-only audit trail without clinical narrative.
CREATE TABLE audit_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  actor_kind  text NOT NULL CHECK (actor_kind IN ('staff','api_key','public','system','platform')),
  actor_id    text,
  actor_role  text,
  action      text NOT NULL,
  entity_kind text NOT NULL,
  entity_id   uuid,
  patient_id  uuid,
  reason      text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_time_idx ON audit_event (tenant_id, at DESC);
CREATE INDEX audit_event_patient_idx ON audit_event (tenant_id, patient_id, at DESC) WHERE patient_id IS NOT NULL;
SELECT app_enable_tenant_rls('audit_event');
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION app_append_only();
