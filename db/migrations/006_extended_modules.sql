-- Clinic Core — 006: conditional modules (each switched on per clinic in tenant.settings.modules)
--   labs (CL-024–028) · portal (OP-009/010, CL-032–034) · payments (FN-018) · telemedicine (CL-035)
--   emergency access (SE-006/007) · pharmacy (CL-021–023, HS-009–013) · inpatient (CL-036–039, HS-001–008)
--   import (MG-001–014) · attachments (CL-011, SE-010)

-- ------------------------------------------------------------------ shared adjustments
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('owner','admin','doctor','nurse','reception','cashier','records','pharmacist','lab'));

ALTER TABLE location DROP CONSTRAINT IF EXISTS location_kind_check;
ALTER TABLE location ADD CONSTRAINT location_kind_check CHECK (kind IN ('room','counter','equipment','store','ward','lab'));

ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check CHECK (method IN ('cash','upi','card','bank_transfer','cheque','other','gateway'));

ALTER TABLE patient ADD COLUMN restricted boolean NOT NULL DEFAULT false;
ALTER TABLE patient ADD COLUMN restricted_reason text;
ALTER TABLE patient DROP CONSTRAINT IF EXISTS patient_registration_source_check;
ALTER TABLE patient ADD CONSTRAINT patient_registration_source_check
  CHECK (registration_source IN ('staff','walk_in','widget','api','import','portal'));

ALTER TABLE service ADD COLUMN modality text NOT NULL DEFAULT 'in_person' CHECK (modality IN ('in_person','video'));
ALTER TABLE appointment ADD COLUMN modality text NOT NULL DEFAULT 'in_person' CHECK (modality IN ('in_person','video'));
ALTER TABLE appointment DROP CONSTRAINT IF EXISTS appointment_source_check;
ALTER TABLE appointment ADD CONSTRAINT appointment_source_check CHECK (source IN ('staff','widget','api','phone','portal','import'));

ALTER TABLE encounter ADD COLUMN kind text NOT NULL DEFAULT 'outpatient' CHECK (kind IN ('outpatient','inpatient','video'));
ALTER TABLE clinical_note ADD COLUMN note_type text NOT NULL DEFAULT 'consultation' CHECK (note_type IN ('consultation','progress','discharge','procedure'));

-- Provider secrets per clinic (Razorpay, SMS). Values are AES-256-GCM encrypted by the app (APP_ENCRYPTION_KEY).
CREATE TABLE tenant_secret (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  ciphertext  text NOT NULL,
  hint        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES staff(id),
  PRIMARY KEY (tenant_id, name)
);
SELECT app_enable_tenant_rls('tenant_secret');

-- Legacy and external identifiers (MG-001), searchable but never an access key.
CREATE TABLE patient_identifier (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  issuer     text NOT NULL,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, issuer, value)
);
SELECT app_enable_tenant_rls('patient_identifier');

-- Uploaded files (reports, outside documents). Bytes held in Postgres for portability; checksum recorded.
CREATE TABLE attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  entity_kind   text NOT NULL CHECK (entity_kind IN ('result','patient_document','discharge','import')),
  entity_id     uuid,
  category      text NOT NULL DEFAULT 'other',
  title         text NOT NULL,
  filename      text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes    int  NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  document_date date,
  source        text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','entered_in_error')),
  uploaded_by   uuid REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_patient_idx ON attachment (tenant_id, patient_id, created_at DESC);
SELECT app_enable_tenant_rls('attachment');

-- ------------------------------------------------------------------ labs, imaging, orders (CL-024–028)
CREATE TABLE lab_test (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  code          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'lab' CHECK (kind IN ('lab','imaging','procedure')),
  specimen      text,
  unit          text,
  ref_low       numeric(12,4),
  ref_high      numeric(12,4),
  ref_text      text,
  critical_low  numeric(12,4),
  critical_high numeric(12,4),
  price_paise   bigint NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  department_id uuid REFERENCES department(id),
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('lab_test');

CREATE TABLE service_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  accession_no    text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patient(id),
  encounter_id    uuid REFERENCES encounter(id),
  admission_id    uuid,
  test_id         uuid NOT NULL REFERENCES lab_test(id),
  ordering_clinician_id uuid NOT NULL REFERENCES clinician(id),
  ordered_by      uuid REFERENCES staff(id),
  priority        text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
  clinical_info   text,
  destination     text NOT NULL DEFAULT 'internal' CHECK (destination IN ('internal','external')),
  external_lab    text,
  status          text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','collected','in_progress','resulted','cancelled')),
  collected_at    timestamptz,
  collected_by    uuid REFERENCES staff(id),
  cancel_reason   text,
  version         bigint NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, accession_no)
);
CREATE INDEX service_order_status_idx ON service_order (tenant_id, status, created_at);
CREATE INDEX service_order_patient_idx ON service_order (tenant_id, patient_id, created_at DESC);
SELECT app_enable_tenant_rls('service_order');

-- Every result version is kept. An amendment appends a version; the earlier one stays readable (CL-028).
CREATE TABLE result_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  order_id       uuid NOT NULL REFERENCES service_order(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  version_no     int  NOT NULL,
  supersedes_id  uuid REFERENCES result_version(id),
  status         text NOT NULL CHECK (status IN ('preliminary','final','amended','entered_in_error')),
  value_num      numeric(14,4),
  value_text     text,
  unit           text,
  ref_range      text,
  flag           text NOT NULL DEFAULT 'none' CHECK (flag IN ('none','normal','low','high','critical_low','critical_high','abnormal','critical')),
  is_critical    boolean NOT NULL DEFAULT false,
  report_text    text,
  performing_lab text,
  attachment_id  uuid REFERENCES attachment(id),
  amend_reason   text,
  verified_by    uuid NOT NULL REFERENCES staff(id),
  verified_at    timestamptz NOT NULL DEFAULT now(),
  recipient_clinician_id uuid NOT NULL REFERENCES clinician(id),
  UNIQUE (order_id, version_no)
);
CREATE INDEX result_version_order_idx ON result_version (order_id, version_no DESC);
SELECT app_enable_tenant_rls('result_version');
CREATE TRIGGER result_version_append_only BEFORE UPDATE OR DELETE ON result_version
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

-- Acknowledgement is per version: acknowledging v1 never closes v2 (critical result correction rule).
CREATE TABLE result_ack (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  result_version_id uuid NOT NULL UNIQUE REFERENCES result_version(id),
  staff_id          uuid NOT NULL REFERENCES staff(id),
  action            text NOT NULL CHECK (action IN ('acknowledged','patient_informed','follow_up_created','no_action_needed')),
  note              text,
  follow_up_id      uuid REFERENCES follow_up(id),
  at                timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('result_ack');

-- ------------------------------------------------------------------ patient portal (OP-009/010, CL-032–034)
CREATE TABLE portal_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  phone_e164    text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (tenant_id, phone_e164)
);
SELECT app_enable_tenant_rls('portal_account');

-- A verified phone alone never exposes a chart. Staff create each link after checking identity and authority.
CREATE TABLE portal_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  account_id   uuid NOT NULL REFERENCES portal_account(id),
  patient_id   uuid NOT NULL REFERENCES patient(id),
  relation     text NOT NULL CHECK (relation IN ('self','parent','guardian','spouse','child','representative')),
  can_schedule boolean NOT NULL DEFAULT true,
  can_view_documents boolean NOT NULL DEFAULT true,
  can_pay      boolean NOT NULL DEFAULT true,
  evidence     text NOT NULL,
  verified_by  uuid NOT NULL REFERENCES staff(id),
  verified_at  timestamptz NOT NULL DEFAULT now(),
  valid_until  date,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES staff(id),
  revoke_reason text
);
CREATE UNIQUE INDEX portal_link_active_uq ON portal_link (account_id, patient_id) WHERE revoked_at IS NULL;
SELECT app_enable_tenant_rls('portal_link');

CREATE TABLE portal_otp (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  phone_e164   text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  delivery     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_otp_phone_idx ON portal_otp (tenant_id, phone_e164, created_at DESC);
SELECT app_enable_tenant_rls('portal_otp');

CREATE TABLE portal_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  account_id  uuid NOT NULL REFERENCES portal_account(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('portal_session');

-- Provider action that makes a document visible in the portal (CL-033).
CREATE TABLE document_release (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  doc_kind    text NOT NULL CHECK (doc_kind IN ('prescription','invoice','result','attachment','discharge')),
  doc_id      uuid NOT NULL,
  released_by uuid REFERENCES staff(id),
  released_at timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  note        text
);
CREATE UNIQUE INDEX document_release_active_uq ON document_release (tenant_id, doc_kind, doc_id) WHERE revoked_at IS NULL;
SELECT app_enable_tenant_rls('document_release');

CREATE TABLE records_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  case_no          text NOT NULL,
  patient_id       uuid REFERENCES patient(id),
  requester_kind   text NOT NULL CHECK (requester_kind IN ('patient','representative','third_party')),
  requester_name   text NOT NULL,
  requester_contact text,
  authority_note   text,
  request_type     text NOT NULL DEFAULT 'copy' CHECK (request_type IN ('copy','correction','access_log','erasure','consent_withdrawal','other')),
  scope            text NOT NULL,
  date_from        date,
  date_to          date,
  delivery         text NOT NULL DEFAULT 'portal' CHECK (delivery IN ('portal','print','email','in_person')),
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_review','fulfilled','rejected','withdrawn')),
  received_at      timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz NOT NULL,
  assigned_to      uuid REFERENCES staff(id),
  outcome          text,
  closed_at        timestamptz,
  source           text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','portal')),
  UNIQUE (tenant_id, case_no)
);
SELECT app_enable_tenant_rls('records_request');

-- ------------------------------------------------------------------ online payments (FN-018)
CREATE TABLE gateway_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  provider            text NOT NULL CHECK (provider IN ('razorpay','sandbox')),
  provider_order_id   text NOT NULL,
  patient_id          uuid NOT NULL REFERENCES patient(id),
  invoice_id          uuid REFERENCES invoice(id),
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','expired')),
  created_via         text NOT NULL CHECK (created_via IN ('portal','staff')),
  provider_payment_id text,
  payment_id          uuid REFERENCES payment(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  UNIQUE (tenant_id, provider, provider_order_id)
);
CREATE UNIQUE INDEX gateway_order_payment_uq ON gateway_order (tenant_id, provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
SELECT app_enable_tenant_rls('gateway_order');

-- Every inbound provider event, verified or not, for reconciliation (API-005).
CREATE TABLE gateway_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  provider    text NOT NULL,
  event_type  text,
  signature_ok boolean NOT NULL,
  provider_payment_id text,
  outcome     text,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('gateway_event');

-- ------------------------------------------------------------------ telemedicine (CL-035)
CREATE TABLE tele_session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  appointment_id  uuid NOT NULL UNIQUE REFERENCES appointment(id),
  provider        text NOT NULL DEFAULT 'jitsi',
  room_name       text NOT NULL UNIQUE,
  consent_at      timestamptz,
  consent_method  text CHECK (consent_method IN ('portal','verbal_recorded','written')),
  identity_verified_by uuid REFERENCES staff(id),
  identity_method text,
  initiated_by    text CHECK (initiated_by IN ('patient','clinician')),
  started_at      timestamptz,
  ended_at        timestamptz,
  actual_mode     text CHECK (actual_mode IN ('video','audio','text','converted_in_person','not_held')),
  technical_notes text,
  encounter_id    uuid REFERENCES encounter(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('tele_session');

-- ------------------------------------------------------------------ emergency (break-glass) access (SE-006/007)
CREATE TABLE emergency_access (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  reason        text NOT NULL CHECK (length(reason) >= 10),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  reviewed_by   uuid REFERENCES staff(id),
  reviewed_at   timestamptz,
  review_outcome text CHECK (review_outcome IN ('appropriate','inappropriate','needs_follow_up')),
  review_note   text,
  CHECK (expires_at > granted_at)
);
CREATE INDEX emergency_access_live_idx ON emergency_access (tenant_id, staff_id, patient_id, expires_at);
SELECT app_enable_tenant_rls('emergency_access');

-- ------------------------------------------------------------------ pharmacy (CL-021–023, HS-009–013)
CREATE TABLE product (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  code            text NOT NULL,
  generic_name    text NOT NULL,
  brand_name      text,
  form            text NOT NULL,
  strength        text,
  base_unit       text NOT NULL DEFAULT 'unit',
  schedule        text NOT NULL DEFAULT 'OTC',
  restricted      boolean NOT NULL DEFAULT false,      -- needs pharmacist dispensing and leadership activation (CL-023)
  sale_price_paise bigint NOT NULL DEFAULT 0 CHECK (sale_price_paise >= 0),
  tax_rate_bp     int NOT NULL DEFAULT 0,
  reorder_level   int NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('product');

CREATE TABLE lot (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  product_id     uuid NOT NULL REFERENCES product(id),
  batch_no       text NOT NULL,
  expiry_date    date NOT NULL,
  manufacturer   text,
  supplier       text,
  unit_cost_paise bigint NOT NULL DEFAULT 0 CHECK (unit_cost_paise >= 0),
  status         text NOT NULL DEFAULT 'released' CHECK (status IN ('released','quarantine','recalled')),
  recall_ref     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, batch_no)
);
SELECT app_enable_tenant_rls('lot');

-- Balance per lot and store. The CHECK is the database guarantee that stock never goes negative.
CREATE TABLE stock_balance (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  lot_id      uuid NOT NULL REFERENCES lot(id),
  location_id uuid NOT NULL REFERENCES location(id),
  qty         int  NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (lot_id, location_id)
);
SELECT app_enable_tenant_rls('stock_balance');

CREATE TABLE stock_move (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  kind        text NOT NULL CHECK (kind IN ('receipt','dispense','return','adjustment','count','transfer_out','transfer_in','ward_supply','expiry_writeoff')),
  lot_id      uuid NOT NULL REFERENCES lot(id),
  location_id uuid NOT NULL REFERENCES location(id),
  qty_delta   int NOT NULL CHECK (qty_delta <> 0),
  ref_kind    text,
  ref_id      uuid,
  reason      text,
  by_staff    uuid REFERENCES staff(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_move_lot_idx ON stock_move (lot_id, at);
SELECT app_enable_tenant_rls('stock_move');
CREATE TRIGGER stock_move_append_only BEFORE UPDATE OR DELETE ON stock_move
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

CREATE TABLE purchase_order (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  po_number    text NOT NULL,
  supplier     text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','partly_received','received','cancelled')),
  location_id  uuid NOT NULL REFERENCES location(id),
  created_by   uuid NOT NULL REFERENCES staff(id),
  approved_by  uuid REFERENCES staff(id),
  approved_at  timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, po_number)
);
SELECT app_enable_tenant_rls('purchase_order');

CREATE TABLE po_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  po_id         uuid NOT NULL REFERENCES purchase_order(id),
  product_id    uuid NOT NULL REFERENCES product(id),
  qty_ordered   int NOT NULL CHECK (qty_ordered > 0),
  qty_received  int NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost_paise bigint NOT NULL DEFAULT 0,
  CHECK (qty_received <= qty_ordered)
);
SELECT app_enable_tenant_rls('po_line');

CREATE TABLE dispense (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  dispense_no     text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patient(id),
  prescription_id uuid REFERENCES prescription(id),
  location_id     uuid NOT NULL REFERENCES location(id),
  dispensed_by    uuid NOT NULL REFERENCES staff(id),
  counselled      boolean NOT NULL DEFAULT false,
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dispense_no)
);
SELECT app_enable_tenant_rls('dispense');

CREATE TABLE dispense_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  dispense_id        uuid NOT NULL REFERENCES dispense(id),
  rx_line_id         uuid REFERENCES rx_line(id),
  product_id         uuid NOT NULL REFERENCES product(id),
  lot_id             uuid NOT NULL REFERENCES lot(id),
  qty                int NOT NULL CHECK (qty > 0),
  qty_returned       int NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  substitution_reason text,
  charge_item_id     uuid REFERENCES charge_item(id),
  CHECK (qty_returned <= qty)
);
CREATE INDEX dispense_line_rx_idx ON dispense_line (rx_line_id);
CREATE INDEX dispense_line_lot_idx ON dispense_line (lot_id);
SELECT app_enable_tenant_rls('dispense_line');

CREATE TABLE stock_count (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  location_id  uuid NOT NULL REFERENCES location(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','posted','cancelled')),
  cutoff_at    timestamptz NOT NULL DEFAULT now(),
  counted_by   uuid REFERENCES staff(id),
  posted_by    uuid REFERENCES staff(id),
  posted_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('stock_count');

CREATE TABLE stock_count_line (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  count_id    uuid NOT NULL REFERENCES stock_count(id),
  lot_id      uuid NOT NULL REFERENCES lot(id),
  system_qty  int NOT NULL,                 -- snapshot at cutoff; hidden from the counter (blind count)
  counted_qty int,
  PRIMARY KEY (count_id, lot_id)
);
SELECT app_enable_tenant_rls('stock_count_line');

-- ------------------------------------------------------------------ inpatient (CL-036–039, HS-001–008)
CREATE TABLE bed (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  ward_id     uuid NOT NULL REFERENCES location(id),
  code        text NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  daily_rate_paise bigint NOT NULL DEFAULT 0 CHECK (daily_rate_paise >= 0),
  status      text NOT NULL DEFAULT 'available' CHECK (status IN ('available','cleaning','blocked')),
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('bed');

CREATE TABLE admission (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  admission_no       text NOT NULL,
  patient_id         uuid NOT NULL REFERENCES patient(id),
  encounter_id       uuid NOT NULL UNIQUE REFERENCES encounter(id),
  source_encounter_id uuid REFERENCES encounter(id),
  department_id      uuid NOT NULL REFERENCES department(id),
  admitting_clinician_id uuid NOT NULL REFERENCES clinician(id),
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','discharged','cancelled')),
  admitted_at        timestamptz NOT NULL DEFAULT now(),
  expected_discharge date,
  discharged_at      timestamptz,
  disposition        text CHECK (disposition IN ('home','referred','lama','absconded','death','transferred_out')),
  discharge_summary_id uuid REFERENCES clinical_note(id),
  financial_clearance text,
  version            bigint NOT NULL DEFAULT 1,
  created_by         uuid REFERENCES staff(id),
  UNIQUE (tenant_id, admission_no)
);
CREATE UNIQUE INDEX admission_one_active_uq ON admission (tenant_id, patient_id) WHERE status = 'admitted';
SELECT app_enable_tenant_rls('admission');
ALTER TABLE service_order ADD CONSTRAINT service_order_admission_fk FOREIGN KEY (admission_id) REFERENCES admission(id);

-- Bed occupancy. Two exclusion constraints: one patient per bed at a time, one bed per admission at a time.
CREATE TABLE bed_stay (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  admission_id uuid NOT NULL REFERENCES admission(id),
  bed_id       uuid NOT NULL REFERENCES bed(id),
  period       tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  reason       text,
  moved_by     uuid REFERENCES staff(id),
  CONSTRAINT bed_stay_bed_excl EXCLUDE USING gist (bed_id WITH =, period WITH &&),
  CONSTRAINT bed_stay_admission_excl EXCLUDE USING gist (admission_id WITH =, period WITH &&)
);
SELECT app_enable_tenant_rls('bed_stay');

CREATE TABLE med_order (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  admission_id   uuid NOT NULL REFERENCES admission(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  product_id     uuid REFERENCES product(id),
  drug_name      text NOT NULL,
  dose           text NOT NULL,
  route          text NOT NULL,
  schedule_times text[] NOT NULL DEFAULT '{}',     -- local HH:MM; empty with prn = as needed only
  prn            boolean NOT NULL DEFAULT false,
  prn_indication text,
  start_at       timestamptz NOT NULL,
  stop_at        timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','superseded')),
  supersedes_id  uuid REFERENCES med_order(id),
  instructions   text,
  ordered_by     uuid NOT NULL REFERENCES staff(id),
  clinician_id   uuid NOT NULL REFERENCES clinician(id),
  signed_at      timestamptz NOT NULL DEFAULT now(),
  stop_reason    text,
  CHECK (prn OR array_length(schedule_times, 1) > 0),
  CHECK (NOT prn OR prn_indication IS NOT NULL)
);
CREATE INDEX med_order_adm_idx ON med_order (admission_id, status);
SELECT app_enable_tenant_rls('med_order');

-- Medication administration record. One row per scheduled occurrence; a retry or witness cannot create a second dose.
CREATE TABLE mar_dose (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  med_order_id  uuid NOT NULL REFERENCES med_order(id),
  admission_id  uuid NOT NULL REFERENCES admission(id),
  due_at        timestamptz,                         -- NULL for a PRN administration
  status        text NOT NULL DEFAULT 'due' CHECK (status IN ('due','given','held','refused','missed','superseded')),
  given_at      timestamptz,
  given_by      uuid REFERENCES staff(id),
  dose_given    text,
  note          text,
  witness_by    uuid REFERENCES staff(id),
  recorded_at   timestamptz,
  CHECK (status NOT IN ('given','held','refused') OR (given_by IS NOT NULL AND recorded_at IS NOT NULL))
);
CREATE UNIQUE INDEX mar_dose_occurrence_uq ON mar_dose (med_order_id, due_at) WHERE due_at IS NOT NULL;
CREATE INDEX mar_dose_due_idx ON mar_dose (tenant_id, admission_id, due_at);
SELECT app_enable_tenant_rls('mar_dose');

CREATE TABLE handover (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  admission_id uuid NOT NULL REFERENCES admission(id),
  from_staff   uuid NOT NULL REFERENCES staff(id),
  to_staff     uuid NOT NULL REFERENCES staff(id),
  summary      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  CHECK (from_staff <> to_staff)
);
SELECT app_enable_tenant_rls('handover');

-- ------------------------------------------------------------------ data import (MG-001–014)
CREATE TABLE import_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  kind         text NOT NULL CHECK (kind IN ('patients','appointments')),
  source_system text NOT NULL,
  filename     text NOT NULL,
  checksum     text NOT NULL,
  status       text NOT NULL DEFAULT 'validated' CHECK (status IN ('validated','committed','discarded')),
  row_count    int NOT NULL,
  ok_count     int NOT NULL,
  error_count  int NOT NULL,
  review_count int NOT NULL,
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  committed_by uuid REFERENCES staff(id),
  committed_at timestamptz
);
SELECT app_enable_tenant_rls('import_batch');

CREATE TABLE import_row (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  batch_id    uuid NOT NULL REFERENCES import_batch(id),
  row_no      int NOT NULL,
  source_id   text,
  data        jsonb NOT NULL,
  status      text NOT NULL CHECK (status IN ('ok','error','review','imported','skipped')),
  messages    text[] NOT NULL DEFAULT '{}',
  target_id   uuid,
  PRIMARY KEY (batch_id, row_no)
);
SELECT app_enable_tenant_rls('import_row');

-- Repeatability: the same source record never imports twice (MG-007).
CREATE TABLE import_map (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  source_system text NOT NULL,
  entity_kind   text NOT NULL,
  source_id     text NOT NULL,
  target_id     uuid NOT NULL,
  batch_id      uuid NOT NULL REFERENCES import_batch(id),
  PRIMARY KEY (tenant_id, source_system, entity_kind, source_id)
);
SELECT app_enable_tenant_rls('import_map');

-- Journal source kinds used by the new modules.
ALTER TABLE journal DROP CONSTRAINT IF EXISTS journal_source_kind_check;
ALTER TABLE journal ADD CONSTRAINT journal_source_kind_check
  CHECK (source_kind IN ('invoice','invoice_void','payment','allocation','refund','adjustment'));
