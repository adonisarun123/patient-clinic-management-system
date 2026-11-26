-- Clinic Core — 002: workforce, catalogue, schedules and capacity (CFG-002/003, OP-013..021)

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  email         text NOT NULL,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','admin','doctor','nurse','reception','cashier','records')),
  active        boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);
CREATE UNIQUE INDEX staff_email_uq ON staff (tenant_id, lower(email));
SELECT app_enable_tenant_rls('staff');

CREATE TABLE staff_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
SELECT app_enable_tenant_rls('staff_session');

CREATE TABLE department (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('department');

-- Rooms, counters and other exclusive physical resources.
CREATE TABLE location (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  department_id uuid REFERENCES department(id),
  code          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'room' CHECK (kind IN ('room','counter','equipment')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('location');

CREATE TABLE clinician (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  staff_id              uuid REFERENCES staff(id),
  display_name          text NOT NULL,
  qualification         text,
  specialty             text,
  registration_council  text,
  registration_number   text,
  bio                   text,
  public_profile        boolean NOT NULL DEFAULT true,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, staff_id)
);
SELECT app_enable_tenant_rls('clinician');

CREATE TABLE clinician_department (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  clinician_id  uuid NOT NULL REFERENCES clinician(id),
  department_id uuid NOT NULL REFERENCES department(id),
  PRIMARY KEY (clinician_id, department_id)
);
SELECT app_enable_tenant_rls('clinician_department');

-- Bookable / chargeable services. Prices in integer minor units (DM-002).
CREATE TABLE service (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  department_id      uuid NOT NULL REFERENCES department(id),
  code               text NOT NULL,
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'consultation'
                       CHECK (kind IN ('consultation','review','procedure','investigation','other')),
  duration_min       int NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_before_min  int NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 120),
  buffer_after_min   int NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 120),
  price_paise        bigint NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  tax_rate_bp        int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  follow_up_free_days int NOT NULL DEFAULT 0 CHECK (follow_up_free_days >= 0),
  public_bookable    boolean NOT NULL DEFAULT true,
  patient_instructions text,
  active             boolean NOT NULL DEFAULT true,
  version            bigint NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('service');

CREATE TABLE service_clinician (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  service_id   uuid NOT NULL REFERENCES service(id),
  clinician_id uuid NOT NULL REFERENCES clinician(id),
  PRIMARY KEY (service_id, clinician_id)
);
SELECT app_enable_tenant_rls('service_clinician');

-- OP-014: weekly sessions stored as local wall-clock times; expanded in the tenant zone.
CREATE TABLE schedule_template (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  clinician_id   uuid NOT NULL REFERENCES clinician(id),
  location_id    uuid NOT NULL REFERENCES location(id),
  weekday        int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  start_time     time NOT NULL,
  end_time       time NOT NULL,
  slot_step_min  int  NOT NULL DEFAULT 10 CHECK (slot_step_min BETWEEN 5 AND 120),
  valid_from     date NOT NULL DEFAULT current_date,
  valid_to       date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX schedule_template_clinician_idx ON schedule_template (tenant_id, clinician_id, weekday);
SELECT app_enable_tenant_rls('schedule_template');

-- Leave, clinic closures and approved extra sessions (OP-014, OP-021, OP-026).
CREATE TABLE schedule_exception (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  clinician_id  uuid REFERENCES clinician(id),          -- NULL = whole-clinic closure
  location_id   uuid REFERENCES location(id),           -- required for 'extra'
  kind          text NOT NULL CHECK (kind IN ('leave','closure','extra')),
  period        tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  slot_step_min int NOT NULL DEFAULT 10,
  reason        text,
  created_by    uuid REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'extra' OR (clinician_id IS NOT NULL AND location_id IS NOT NULL)),
  CHECK (kind <> 'leave' OR clinician_id IS NOT NULL)
);
CREATE INDEX schedule_exception_period_idx ON schedule_exception USING gist (tenant_id, period);
SELECT app_enable_tenant_rls('schedule_exception');
