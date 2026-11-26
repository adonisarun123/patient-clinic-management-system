-- Clinic Core — 003: registration, capacity claims, appointments and queue (OP-001..031)

CREATE TABLE patient (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  uhid                text NOT NULL,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','provisional','temporary','merged','inactive')),
  temp_label          text,                       -- OP-006 distinct temporary label
  full_name           text NOT NULL,              -- as supplied, Unicode preserved (OP-002)
  preferred_name      text,
  name_norm           text NOT NULL,              -- comparison key (OP-004)
  birth_date          date,
  birth_precision     text NOT NULL DEFAULT 'unknown'
                        CHECK (birth_precision IN ('day','month','year','estimated','unknown','declined')),
  estimated_age_years int CHECK (estimated_age_years BETWEEN 0 AND 130),
  age_as_of           date,
  sex                 text NOT NULL DEFAULT 'unknown'
                        CHECK (sex IN ('female','male','other','unknown','declined')),
  phone_e164          text,
  phone_status        text NOT NULL DEFAULT 'unverified'
                        CHECK (phone_status IN ('verified','unverified','none','declined','unavailable')),
  email               text,
  address             jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferred_language  text,
  emergency_contact   jsonb,
  registration_source text NOT NULL DEFAULT 'staff'
                        CHECK (registration_source IN ('staff','walk_in','widget','api','import')),
  identity_review     boolean NOT NULL DEFAULT false,   -- provisional web/API bookings
  -- DM-003: blank allergy list must never print "no known allergies"
  allergy_status      text NOT NULL DEFAULT 'not_reviewed'
                        CHECK (allergy_status IN ('not_reviewed','no_known_allergies','has_allergies')),
  allergy_reviewed_at timestamptz,
  allergy_reviewed_by uuid REFERENCES staff(id),
  merged_into_id      uuid REFERENCES patient(id),
  version             bigint NOT NULL DEFAULT 1,
  created_by          uuid REFERENCES staff(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, uhid),
  CHECK (birth_date IS NOT NULL OR birth_precision IN ('estimated','unknown','declined')),
  CHECK (birth_precision <> 'estimated' OR (estimated_age_years IS NOT NULL AND age_as_of IS NOT NULL)),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL)
);
CREATE INDEX patient_phone_idx ON patient (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX patient_name_idx  ON patient (tenant_id, name_norm);
SELECT app_enable_tenant_rls('patient');

-- OP-008: effective-dated demographic history (correction vs new observation).
CREATE TABLE patient_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  kind        text NOT NULL CHECK (kind IN ('correction','update','merge','link')),
  reason      text,
  actor_id    uuid REFERENCES staff(id),
  at          timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('patient_change');
CREATE TRIGGER patient_change_append_only BEFORE UPDATE OR DELETE ON patient_change
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

CREATE TABLE allergy (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  patient_id   uuid NOT NULL REFERENCES patient(id),
  substance    text NOT NULL,
  reaction     text,
  severity     text CHECK (severity IN ('mild','moderate','severe','unknown')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','entered_in_error')),
  recorded_by  uuid REFERENCES staff(id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX allergy_patient_idx ON allergy (tenant_id, patient_id);
SELECT app_enable_tenant_rls('allergy');

-- OP-019: a short server-timed reservation for an identified booking journey.
CREATE TABLE booking_hold (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  service_id    uuid NOT NULL REFERENCES service(id),
  clinician_id  uuid NOT NULL REFERENCES clinician(id),
  location_id   uuid NOT NULL REFERENCES location(id),
  visit_period  tstzrange NOT NULL,
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','confirmed','expired','released')),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('staff','public','api_key')),
  actor_ref     text NOT NULL,                 -- staff id, or digest of the public journey secret
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('booking_hold');

CREATE TABLE appointment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  booking_ref        text NOT NULL,              -- patient-facing confirmation number
  patient_id         uuid NOT NULL REFERENCES patient(id),
  clinician_id       uuid NOT NULL REFERENCES clinician(id),
  service_id         uuid NOT NULL REFERENCES service(id),
  service_version    bigint NOT NULL,
  department_id      uuid NOT NULL REFERENCES department(id),
  location_id        uuid NOT NULL REFERENCES location(id),
  period             tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  state              text NOT NULL DEFAULT 'booked'
                       CHECK (state IN ('booked','arrived','in_service','completed','cancelled','no_show','left_before_seen')),
  source             text NOT NULL CHECK (source IN ('staff','widget','api','phone')),
  quoted_price_paise bigint NOT NULL DEFAULT 0,
  notes              text,
  cancel_reason      text,
  requested_clinician_id uuid REFERENCES clinician(id),
  version            bigint NOT NULL DEFAULT 1,
  created_by         uuid REFERENCES staff(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, booking_ref)
);
CREATE INDEX appointment_day_idx ON appointment USING gist (tenant_id, period);
CREATE INDEX appointment_patient_idx ON appointment (tenant_id, patient_id);
SELECT app_enable_tenant_rls('appointment');

-- OP-018/019: every occupied interval (including buffers) for each exclusive resource.
-- The exclusion constraint is the database-level guarantee against double booking.
CREATE TABLE resource_claim (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  resource_kind  text NOT NULL CHECK (resource_kind IN ('clinician','location')),
  resource_id    uuid NOT NULL,
  period         tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  status         text NOT NULL CHECK (status IN ('hold','booked','released')),
  hold_id        uuid REFERENCES booking_hold(id),
  appointment_id uuid REFERENCES appointment(id),
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  CHECK (status <> 'hold' OR (hold_id IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (status <> 'booked' OR appointment_id IS NOT NULL),
  CONSTRAINT resource_claim_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, resource_kind WITH =, resource_id WITH =, period WITH &&
  ) WHERE (status IN ('hold','booked'))
);
CREATE INDEX resource_claim_appt_idx ON resource_claim (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX resource_claim_hold_idx ON resource_claim (hold_id) WHERE hold_id IS NOT NULL;
SELECT app_enable_tenant_rls('resource_claim');

-- OP-029: every state transition, with reason and actor.
CREATE TABLE appointment_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  appointment_id uuid NOT NULL REFERENCES appointment(id),
  action         text NOT NULL,
  from_state     text,
  to_state       text,
  reason         text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_kind     text NOT NULL,
  actor_id       text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_event_appt_idx ON appointment_event (appointment_id, at);
SELECT app_enable_tenant_rls('appointment_event');
CREATE TRIGGER appointment_event_append_only BEFORE UPDATE OR DELETE ON appointment_event
  FOR EACH ROW EXECUTE FUNCTION app_append_only();

-- OP-030: visible queue with per-department, per-day tokens.
CREATE TABLE queue_ticket (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  department_id   uuid NOT NULL REFERENCES department(id),
  service_date    date NOT NULL,
  token_no        int  NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patient(id),
  appointment_id  uuid REFERENCES appointment(id),
  clinician_id    uuid REFERENCES clinician(id),
  service_id      uuid REFERENCES service(id),
  kind            text NOT NULL CHECK (kind IN ('booked','walk_in')),
  priority        int  NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),  -- 3 = emergency
  priority_reason text,
  due_at          timestamptz NOT NULL,            -- scheduled time or check-in time
  checked_in_at   timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting','called','in_room','done','left','cancelled')),
  location_id     uuid REFERENCES location(id),
  called_at       timestamptz,
  call_count      int NOT NULL DEFAULT 0,
  called_by       uuid REFERENCES staff(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, department_id, service_date, token_no)
);
CREATE UNIQUE INDEX queue_ticket_appt_uq ON queue_ticket (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX queue_ticket_day_idx ON queue_ticket (tenant_id, service_date, department_id, status);
SELECT app_enable_tenant_rls('queue_ticket');
