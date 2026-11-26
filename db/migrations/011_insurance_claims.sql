-- FN-015–016: insurers, TPAs and corporate payers; patient policies; pre-authorisation; claims with split
-- patient/payer responsibility, settlement (with TDS), disallowances and write-offs.

CREATE TABLE payer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('insurer','tpa','corporate','government')),
  code          text,
  email         text,
  phone         text,
  credit_days   int NOT NULL DEFAULT 30 CHECK (credit_days BETWEEN 0 AND 365),
  tds_rate_bp   int NOT NULL DEFAULT 0 CHECK (tds_rate_bp BETWEEN 0 AND 3000),   -- default deduction the payer applies; confirm with your CA
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payer_name_uq ON payer (tenant_id, lower(name));
SELECT app_enable_tenant_rls('payer');

CREATE TABLE patient_policy (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  patient_id        uuid NOT NULL REFERENCES patient(id),
  payer_id          uuid NOT NULL REFERENCES payer(id),     -- who pays (insurer / corporate / scheme)
  tpa_id            uuid REFERENCES payer(id),              -- administrator the claim goes through, if any
  policy_number     text NOT NULL,
  member_id         text,
  holder_name       text,
  relation          text,
  valid_from        date,
  valid_to          date,
  sum_insured_paise bigint CHECK (sum_insured_paise IS NULL OR sum_insured_paise >= 0),
  copay_bp          int NOT NULL DEFAULT 0 CHECK (copay_bp BETWEEN 0 AND 10000),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes             text,
  created_by        uuid REFERENCES staff(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX patient_policy_patient_idx ON patient_policy (tenant_id, patient_id);
SELECT app_enable_tenant_rls('patient_policy');

CREATE TABLE preauth (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  ref_number       text NOT NULL,
  patient_id       uuid NOT NULL REFERENCES patient(id),
  policy_id        uuid NOT NULL REFERENCES patient_policy(id),
  admission_id     uuid REFERENCES admission(id),
  treatment        text NOT NULL,
  estimated_paise  bigint NOT NULL CHECK (estimated_paise > 0),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','query','approved','partially_approved','denied','cancelled')),
  payer_ref        text,
  approved_paise   bigint CHECK (approved_paise IS NULL OR approved_paise >= 0),
  valid_until      date,
  submitted_at     timestamptz,
  decided_at       timestamptz,
  created_by       uuid REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ref_number)
);
SELECT app_enable_tenant_rls('preauth');

CREATE TABLE claim (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  claim_number        text NOT NULL,
  invoice_id          uuid NOT NULL REFERENCES invoice(id),
  patient_id          uuid NOT NULL REFERENCES patient(id),
  policy_id           uuid NOT NULL REFERENCES patient_policy(id),
  payer_id            uuid NOT NULL REFERENCES payer(id),
  preauth_id          uuid REFERENCES preauth(id),
  claimed_paise       bigint NOT NULL CHECK (claimed_paise > 0),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','query','settled','closed')),
  payer_claim_ref     text,
  submitted_at        timestamptz,
  settled_paise       bigint NOT NULL DEFAULT 0 CHECK (settled_paise >= 0),   -- cash received
  tds_paise           bigint NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),       -- tax deducted at source by the payer
  returned_paise      bigint NOT NULL DEFAULT 0 CHECK (returned_paise >= 0),  -- disallowed and moved back to the patient
  written_off_paise   bigint NOT NULL DEFAULT 0 CHECK (written_off_paise >= 0),
  created_by          uuid REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, claim_number),
  CHECK (settled_paise + tds_paise + returned_paise + written_off_paise <= claimed_paise)
);
CREATE INDEX claim_invoice_idx ON claim (tenant_id, invoice_id);
CREATE INDEX claim_payer_idx ON claim (tenant_id, payer_id, status);
SELECT app_enable_tenant_rls('claim');

-- Append-only history of everything that happened to a pre-auth or claim (submissions, queries, replies, settlements).
CREATE TABLE claim_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  claim_id    uuid REFERENCES claim(id),
  preauth_id  uuid REFERENCES preauth(id),
  action      text NOT NULL,
  amount_paise bigint,
  reference   text,
  note        text,
  actor_id    uuid REFERENCES staff(id),
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_id IS NULL) <> (preauth_id IS NULL))
);
CREATE INDEX claim_event_claim_idx ON claim_event (claim_id);
CREATE INDEX claim_event_preauth_idx ON claim_event (preauth_id);
SELECT app_enable_tenant_rls('claim_event');
CREATE TRIGGER claim_event_append_only BEFORE UPDATE OR DELETE ON claim_event FOR EACH ROW EXECUTE FUNCTION app_append_only();

-- The patient's balance on an invoice excludes what an insurer is responsible for. payer_paise is appended so the
-- existing columns keep their positions.
CREATE OR REPLACE VIEW invoice_balance WITH (security_invoker = true) AS
SELECT i.id AS invoice_id, i.tenant_id, i.patient_id, i.number, i.status, i.total_paise,
       COALESCE(sum(CASE a.direction WHEN 'apply' THEN a.amount_paise ELSE -a.amount_paise END), 0)::bigint AS paid_paise,
       (i.total_paise - COALESCE(sum(CASE a.direction WHEN 'apply' THEN a.amount_paise ELSE -a.amount_paise END), 0)
         - COALESCE((SELECT sum(c.claimed_paise - c.returned_paise) FROM claim c WHERE c.invoice_id = i.id), 0))::bigint AS due_paise,
       COALESCE((SELECT sum(c.claimed_paise - c.returned_paise) FROM claim c WHERE c.invoice_id = i.id), 0)::bigint AS payer_paise
FROM invoice i LEFT JOIN allocation a ON a.invoice_id = i.id
GROUP BY i.id;
