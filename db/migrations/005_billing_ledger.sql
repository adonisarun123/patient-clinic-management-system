-- Clinic Core — 005: charges, invoices, receipts, refunds and a balanced ledger (Chapter 04)
-- All money is integer minor units (paise for INR). No floating point.

CREATE TABLE ledger_account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('asset','liability','income','expense','equity')),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('ledger_account');

-- Service delivered = revenue trigger. source_key makes charge capture idempotent.
CREATE TABLE charge_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  patient_id       uuid NOT NULL REFERENCES patient(id),
  encounter_id     uuid REFERENCES encounter(id),
  appointment_id   uuid REFERENCES appointment(id),
  service_id       uuid REFERENCES service(id),
  clinician_id     uuid REFERENCES clinician(id),
  department_id    uuid REFERENCES department(id),
  description      text NOT NULL,
  quantity         int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  discount_paise   bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  tax_rate_bp      int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'unbilled' CHECK (status IN ('unbilled','billed','voided')),
  invoice_id       uuid,
  source_key       text NOT NULL,
  discount_reason  text,
  created_by       uuid REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_key),
  CHECK (discount_paise <= unit_price_paise * quantity)
);
CREATE INDEX charge_item_patient_idx ON charge_item (tenant_id, patient_id, status);
SELECT app_enable_tenant_rls('charge_item');

CREATE TABLE invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  patient_id      uuid NOT NULL REFERENCES patient(id),
  encounter_id    uuid REFERENCES encounter(id),
  number          text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
  subtotal_paise  bigint NOT NULL DEFAULT 0,
  discount_paise  bigint NOT NULL DEFAULT 0,
  tax_paise       bigint NOT NULL DEFAULT 0,
  total_paise     bigint NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  business_date   date,
  posted_at       timestamptz,
  posted_by       uuid REFERENCES staff(id),
  void_reason     text,
  voided_at       timestamptz,
  voided_by       uuid REFERENCES staff(id),
  version         bigint NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES staff(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR (number IS NOT NULL AND posted_at IS NOT NULL AND business_date IS NOT NULL)),
  CHECK (total_paise = subtotal_paise - discount_paise + tax_paise)
);
CREATE UNIQUE INDEX invoice_number_uq ON invoice (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX invoice_patient_idx ON invoice (tenant_id, patient_id);
SELECT app_enable_tenant_rls('invoice');
ALTER TABLE charge_item ADD CONSTRAINT charge_item_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoice(id);

CREATE TABLE invoice_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  invoice_id       uuid NOT NULL REFERENCES invoice(id),
  charge_item_id   uuid NOT NULL REFERENCES charge_item(id),
  description      text NOT NULL,
  quantity         int NOT NULL,
  unit_price_paise bigint NOT NULL,
  discount_paise   bigint NOT NULL,
  tax_rate_bp      int NOT NULL,
  tax_paise        bigint NOT NULL,
  line_total_paise bigint NOT NULL,
  clinician_id     uuid REFERENCES clinician(id),
  department_id    uuid REFERENCES department(id),
  service_id       uuid REFERENCES service(id),
  CHECK (line_total_paise = unit_price_paise * quantity - discount_paise + tax_paise)
);
CREATE INDEX invoice_line_invoice_idx ON invoice_line (invoice_id);
SELECT app_enable_tenant_rls('invoice_line');

-- Issued financial documents are frozen except for voiding.
CREATE OR REPLACE FUNCTION invoice_freeze_posted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'posted invoice cannot be deleted' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    IF (to_jsonb(NEW) - 'status' - 'void_reason' - 'voided_at' - 'voided_by' - 'version')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'void_reason' - 'voided_at' - 'voided_by' - 'version')
       OR NEW.status NOT IN ('posted','void') THEN
      RAISE EXCEPTION 'posted invoice % is immutable; void and reissue', OLD.number USING ERRCODE='P0001';
    END IF;
  ELSIF OLD.status = 'void' THEN
    RAISE EXCEPTION 'void invoice % is immutable', OLD.number USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_freeze BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_freeze_posted();

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  receipt_no    text NOT NULL,
  method        text NOT NULL CHECK (method IN ('cash','upi','card','bank_transfer','cheque','other')),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  reference     text,                      -- external confirmation (UPI ref, card slip)
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','void')),
  business_date date NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_by   uuid REFERENCES staff(id),
  note          text,
  UNIQUE (tenant_id, receipt_no)
);
CREATE UNIQUE INDEX payment_reference_uq ON payment (tenant_id, method, reference) WHERE reference IS NOT NULL;
CREATE INDEX payment_patient_idx ON payment (tenant_id, patient_id);
SELECT app_enable_tenant_rls('payment');

-- Many-to-many link between confirmed money and receivables.
CREATE TABLE allocation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  payment_id   uuid NOT NULL REFERENCES payment(id),
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  direction    text NOT NULL CHECK (direction IN ('apply','release')),
  reason       text,
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX allocation_invoice_idx ON allocation (invoice_id);
CREATE INDEX allocation_payment_idx ON allocation (payment_id);
SELECT app_enable_tenant_rls('allocation');
CREATE TRIGGER allocation_append_only BEFORE UPDATE OR DELETE ON allocation
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

CREATE TABLE refund (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  payment_id    uuid NOT NULL REFERENCES payment(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  method        text NOT NULL CHECK (method IN ('cash','upi','card','bank_transfer','cheque','other')),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','rejected')),
  requested_by  uuid NOT NULL REFERENCES staff(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES staff(id),
  decided_at    timestamptz,
  self_approved boolean NOT NULL DEFAULT false,    -- solo-practice exception, always audited
  paid_reference text,
  paid_at       timestamptz,
  business_date date
);
SELECT app_enable_tenant_rls('refund');

-- Balanced double-entry journal. One header per accounting event, unique source key.
CREATE TABLE journal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  source_kind   text NOT NULL CHECK (source_kind IN ('invoice','invoice_void','payment','allocation','refund','adjustment')),
  source_id     uuid NOT NULL,
  source_key    text NOT NULL,
  business_date date NOT NULL,
  memo          text,
  reverses_id   uuid REFERENCES journal(id),
  posted_at     timestamptz NOT NULL DEFAULT now(),
  posted_by     uuid REFERENCES staff(id),
  UNIQUE (tenant_id, source_key)
);
SELECT app_enable_tenant_rls('journal');
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON journal
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

CREATE TABLE journal_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  journal_id   uuid NOT NULL REFERENCES journal(id),
  account_id   uuid NOT NULL REFERENCES ledger_account(id),
  currency     text NOT NULL,
  debit_paise  bigint NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise bigint NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  patient_id   uuid REFERENCES patient(id),
  CHECK ((debit_paise > 0) <> (credit_paise > 0))
);
CREATE INDEX journal_line_journal_idx ON journal_line (journal_id);
SELECT app_enable_tenant_rls('journal_line');
CREATE TRIGGER journal_line_append_only BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

-- Every journal must balance per currency, checked at commit (deferred).
CREATE OR REPLACE FUNCTION journal_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, sum(debit_paise) d, sum(credit_paise) c, count(*) n INTO bad
  FROM journal_line WHERE journal_id = NEW.journal_id
  GROUP BY currency HAVING sum(debit_paise) <> sum(credit_paise) OR count(*) < 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % unbalanced in %: debit % credit %', NEW.journal_id, bad.currency, bad.d, bad.c
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM journal_line WHERE journal_id = NEW.journal_id) < 2 THEN
    RAISE EXCEPTION 'journal % needs at least two lines', NEW.journal_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();

-- Convenience view: invoice balance from underlying allocations (never a stored running total).
CREATE VIEW invoice_balance WITH (security_invoker = true) AS
SELECT i.id AS invoice_id, i.tenant_id, i.patient_id, i.number, i.status, i.total_paise,
       COALESCE(sum(CASE a.direction WHEN 'apply' THEN a.amount_paise ELSE -a.amount_paise END), 0)::bigint AS paid_paise,
       (i.total_paise - COALESCE(sum(CASE a.direction WHEN 'apply' THEN a.amount_paise ELSE -a.amount_paise END), 0))::bigint AS due_paise
FROM invoice i LEFT JOIN allocation a ON a.invoice_id = i.id
GROUP BY i.id;

-- Unallocated money held per payment (advance) after allocations and refunds.
CREATE VIEW payment_balance WITH (security_invoker = true) AS
SELECT p.id AS payment_id, p.tenant_id, p.patient_id, p.receipt_no, p.amount_paise, p.status,
       COALESCE((SELECT sum(CASE a.direction WHEN 'apply' THEN a.amount_paise ELSE -a.amount_paise END)
                 FROM allocation a WHERE a.payment_id = p.id), 0)::bigint AS allocated_paise,
       COALESCE((SELECT sum(r.amount_paise) FROM refund r WHERE r.payment_id = p.id AND r.status IN ('approved','paid')), 0)::bigint AS refunded_paise
FROM payment p;
