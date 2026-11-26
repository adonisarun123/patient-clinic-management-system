-- FN-019 desk (drawer) close with variance, FN-020–022 period close and tax evidence, accounting export mapping,
-- CFG-008 effective-dated prices.

ALTER TABLE refund ADD COLUMN paid_by uuid REFERENCES staff(id);

-- New journal sources (drawer variance now; insurance settlement kinds used by the claims module).
ALTER TABLE journal DROP CONSTRAINT IF EXISTS journal_source_kind_check;
ALTER TABLE journal ADD CONSTRAINT journal_source_kind_check CHECK (source_kind IN
  ('invoice','invoice_void','payment','allocation','refund','adjustment',
   'drawer_variance','payer_transfer','claim_settlement','claim_writeoff','payer_payment'));

-- How each ledger account appears in the clinic's accounting package (e.g. Tally ledger and group names).
ALTER TABLE ledger_account ADD COLUMN external_name text;
ALTER TABLE ledger_account ADD COLUMN external_group text;

-- Cash drawer sessions: open with a float, close with a denomination count; expected cash is computed from receipts.
CREATE TABLE desk_session (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  staff_id             uuid NOT NULL REFERENCES staff(id),
  business_date        date NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  opening_float_paise  bigint NOT NULL DEFAULT 0 CHECK (opening_float_paise >= 0),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','pending_approval','approved')),
  closed_at            timestamptz,
  counted              jsonb,                    -- {"500": 4, "100": 7, …} denomination → count
  counted_paise        bigint,
  expected_paise       bigint,
  variance_paise       bigint,
  variance_reason      text,
  approved_by          uuid REFERENCES staff(id),
  approved_at          timestamptz,
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND counted_paise IS NOT NULL AND expected_paise IS NOT NULL))
);
CREATE UNIQUE INDEX desk_session_one_open ON desk_session (tenant_id, staff_id) WHERE status = 'open';
SELECT app_enable_tenant_rls('desk_session');

-- Month close. A closed month accepts no journals dated inside it; reopening is explicit, reasoned and audited.
CREATE TABLE accounting_period (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  period_start   date NOT NULL CHECK (extract(day FROM period_start) = 1),
  status         text NOT NULL CHECK (status IN ('closed','reopened')),
  closed_by      uuid REFERENCES staff(id),
  closed_at      timestamptz,
  snapshot       jsonb,                          -- trial balance, revenue, tax by rate, receipts by tender at close
  reopened_by    uuid REFERENCES staff(id),
  reopened_at    timestamptz,
  reopen_reason  text,
  UNIQUE (tenant_id, period_start)
);
SELECT app_enable_tenant_rls('accounting_period');

CREATE OR REPLACE FUNCTION journal_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_period WHERE tenant_id = NEW.tenant_id
              AND period_start = date_trunc('month', NEW.business_date)::date AND status = 'closed') THEN
    RAISE EXCEPTION 'accounting period % is closed', to_char(NEW.business_date, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_period_open BEFORE INSERT ON journal FOR EACH ROW EXECUTE FUNCTION journal_period_open();

-- Effective-dated prices. Without a row covering a date, the service's base price applies.
CREATE TABLE service_price (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  service_id      uuid NOT NULL REFERENCES service(id),
  price_paise     bigint NOT NULL CHECK (price_paise >= 0),
  valid           daterange NOT NULL CHECK (NOT isempty(valid) AND lower_inc(valid) AND lower(valid) IS NOT NULL),
  reason          text,
  created_by      uuid REFERENCES staff(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (tenant_id WITH =, service_id WITH =, valid WITH &&)
);
SELECT app_enable_tenant_rls('service_price');

CREATE OR REPLACE FUNCTION service_price_on(p_service uuid, p_day date) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT price_paise FROM service_price WHERE service_id = p_service AND valid @> p_day LIMIT 1),
    (SELECT price_paise FROM service WHERE id = p_service));
$$;
