-- Day-care admissions and the operating theatre: scheduling with exclusion constraints, the WHO Surgical Safety
-- Checklist, operation notes, consumables and charges. Additive only.

-- ---------------------------------------------------------------- day care
ALTER TABLE admission ADD COLUMN care_type text NOT NULL DEFAULT 'inpatient' CHECK (care_type IN ('inpatient','daycare'));
ALTER TABLE admission ADD COLUMN planned_end_at timestamptz;          -- day care: expected discharge time today
ALTER TABLE admission ADD COLUMN converted_at timestamptz;            -- day care converted to an inpatient stay
ALTER TABLE admission ADD COLUMN converted_reason text;

-- ---------------------------------------------------------------- theatres
CREATE TABLE theatre (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  code              text NOT NULL,
  name              text NOT NULL,
  hourly_rate_paise bigint NOT NULL DEFAULT 0 CHECK (hourly_rate_paise >= 0),
  turnover_minutes  int NOT NULL DEFAULT 30 CHECK (turnover_minutes BETWEEN 0 AND 240),
  active            boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('theatre');

CREATE TABLE surgery_case (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  case_no            text NOT NULL,
  patient_id         uuid NOT NULL REFERENCES patient(id),
  admission_id       uuid REFERENCES admission(id),
  theatre_id         uuid NOT NULL REFERENCES theatre(id),
  surgeon_id         uuid NOT NULL REFERENCES clinician(id),
  anaesthetist_id    uuid REFERENCES clinician(id),
  procedure_name     text NOT NULL CHECK (length(trim(procedure_name)) >= 3),
  laterality         text NOT NULL DEFAULT 'na' CHECK (laterality IN ('left','right','bilateral','na')),
  anaesthesia        text NOT NULL DEFAULT 'general' CHECK (anaesthesia IN ('general','spinal','epidural','regional_block','local','sedation','none')),
  priority           text NOT NULL DEFAULT 'elective' CHECK (priority IN ('elective','urgent','emergency')),
  service_id         uuid REFERENCES service(id),                 -- surgeon / procedure fee
  planned            tstzrange NOT NULL CHECK (NOT isempty(planned) AND lower_inc(planned) AND NOT upper_inc(planned)),
  blocked            tstzrange NOT NULL,                          -- planned plus room turnover
  status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_theatre','completed','cancelled')),
  consent_confirmed  boolean NOT NULL DEFAULT false,
  wheels_in_at       timestamptz,
  incision_at        timestamptz,
  closure_at         timestamptz,
  wheels_out_at      timestamptz,
  cancel_reason      text,
  notes              text,
  created_by         uuid REFERENCES staff(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, case_no),
  CHECK (blocked @> planned),
  CONSTRAINT surgery_theatre_excl EXCLUDE USING gist (theatre_id WITH =, blocked WITH &&) WHERE (status IN ('scheduled','in_theatre')),
  CONSTRAINT surgery_surgeon_excl EXCLUDE USING gist (surgeon_id WITH =, planned WITH &&) WHERE (status IN ('scheduled','in_theatre')),
  CONSTRAINT surgery_anaesthetist_excl EXCLUDE USING gist (anaesthetist_id WITH =, planned WITH &&) WHERE (status IN ('scheduled','in_theatre') AND anaesthetist_id IS NOT NULL),
  CONSTRAINT surgery_patient_excl EXCLUDE USING gist (patient_id WITH =, planned WITH &&) WHERE (status IN ('scheduled','in_theatre'))
);
CREATE INDEX surgery_case_day_idx ON surgery_case USING gist (tenant_id, planned);
CREATE INDEX surgery_case_patient_idx ON surgery_case (tenant_id, patient_id);
SELECT app_enable_tenant_rls('surgery_case');

-- WHO Surgical Safety Checklist: one immutable record per phase.
CREATE TABLE surgery_checklist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  case_id       uuid NOT NULL REFERENCES surgery_case(id),
  phase         text NOT NULL CHECK (phase IN ('sign_in','time_out','sign_out')),
  answers       jsonb NOT NULL,
  concerns      text,
  completed_by  uuid NOT NULL REFERENCES staff(id),
  team          text,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, phase)
);
SELECT app_enable_tenant_rls('surgery_checklist');

CREATE TABLE operation_note (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  case_id          uuid NOT NULL UNIQUE REFERENCES surgery_case(id),
  content          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  author_id        uuid NOT NULL REFERENCES staff(id),
  signed_by_clinician uuid REFERENCES clinician(id),
  signed_at        timestamptz,
  content_digest   text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('operation_note');

CREATE TABLE surgery_consumable (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  case_id       uuid NOT NULL REFERENCES surgery_case(id),
  product_id    uuid NOT NULL REFERENCES product(id),
  lot_id        uuid NOT NULL REFERENCES lot(id),
  location_id   uuid NOT NULL REFERENCES location(id),
  qty           int NOT NULL CHECK (qty > 0),
  implant_serial text,
  status        text NOT NULL DEFAULT 'used' CHECK (status IN ('used','returned')),
  recorded_by   uuid REFERENCES staff(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX surgery_consumable_case_idx ON surgery_consumable (case_id);
SELECT app_enable_tenant_rls('surgery_consumable');

CREATE FUNCTION surgery_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'surgery_checklist' THEN
    RAISE EXCEPTION 'A completed checklist phase cannot be changed';
  END IF;
  IF TG_TABLE_NAME = 'operation_note' AND OLD.status = 'signed' THEN
    RAISE EXCEPTION 'A signed operation note cannot be changed; add an addendum to the chart';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER surgery_checklist_immutable BEFORE UPDATE OR DELETE ON surgery_checklist FOR EACH ROW EXECUTE FUNCTION surgery_record_guard();
CREATE TRIGGER operation_note_freeze BEFORE UPDATE OR DELETE ON operation_note FOR EACH ROW EXECUTE FUNCTION surgery_record_guard();
