-- Clinic Core — 004: encounters, notes, prescriptions and follow-up (Chapter 03)

CREATE TABLE encounter (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  patient_id        uuid NOT NULL REFERENCES patient(id),
  appointment_id    uuid UNIQUE REFERENCES appointment(id),   -- at most one primary encounter per booking
  queue_ticket_id   uuid UNIQUE REFERENCES queue_ticket(id),
  department_id     uuid NOT NULL REFERENCES department(id),
  lead_clinician_id uuid NOT NULL REFERENCES clinician(id),
  service_id        uuid REFERENCES service(id),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  chief_complaint   text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  version           bigint NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES staff(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX encounter_patient_idx ON encounter (tenant_id, patient_id, started_at DESC);
SELECT app_enable_tenant_rls('encounter');

CREATE TABLE vitals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  encounter_id uuid NOT NULL REFERENCES encounter(id),
  patient_id   uuid NOT NULL REFERENCES patient(id),
  measured_at  timestamptz NOT NULL DEFAULT now(),
  systolic     int CHECK (systolic BETWEEN 40 AND 300),
  diastolic    int CHECK (diastolic BETWEEN 20 AND 200),
  pulse        int CHECK (pulse BETWEEN 20 AND 250),
  resp_rate    int CHECK (resp_rate BETWEEN 4 AND 80),
  temp_c       numeric(4,1) CHECK (temp_c BETWEEN 25 AND 45),
  spo2         int CHECK (spo2 BETWEEN 40 AND 100),
  weight_kg    numeric(6,2) CHECK (weight_kg > 0 AND weight_kg < 500),
  height_cm    numeric(5,1) CHECK (height_cm > 20 AND height_cm < 280),
  recorded_by  uuid REFERENCES staff(id),
  entered_in_error boolean NOT NULL DEFAULT false
);
SELECT app_enable_tenant_rls('vitals');

-- Note versions. A signed row is frozen; amendment = new row with supersedes_id.
CREATE TABLE clinical_note (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  encounter_id  uuid NOT NULL REFERENCES encounter(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  author_id     uuid NOT NULL REFERENCES staff(id),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','superseded','entered_in_error')),
  version_no    int  NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES clinical_note(id),
  -- { subjective, objective, assessment, plan, diagnoses: [{code?, text}] }
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  amend_reason  text,
  content_digest text,
  signed_by     uuid REFERENCES staff(id),
  signed_at     timestamptz,
  row_version   bigint NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL AND content_digest IS NOT NULL))
);
CREATE INDEX clinical_note_encounter_idx ON clinical_note (encounter_id);
SELECT app_enable_tenant_rls('clinical_note');

CREATE TABLE prescription (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  encounter_id   uuid NOT NULL REFERENCES encounter(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  clinician_id   uuid NOT NULL REFERENCES clinician(id),
  rx_number      text,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','superseded','cancelled')),
  version_no     int  NOT NULL DEFAULT 1,
  supersedes_id  uuid REFERENCES prescription(id),
  advice         text,
  follow_up_in_days int CHECK (follow_up_in_days BETWEEN 0 AND 3650),
  amend_reason   text,
  safety_override_reason text,
  snapshot       jsonb,           -- exactly what the patient received (DM-005)
  content_digest text,
  signed_by      uuid REFERENCES staff(id),
  signed_at      timestamptz,
  row_version    bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('draft','cancelled') OR (snapshot IS NOT NULL AND content_digest IS NOT NULL AND signed_at IS NOT NULL))
);
CREATE INDEX prescription_patient_idx ON prescription (tenant_id, patient_id, created_at DESC);
CREATE UNIQUE INDEX prescription_number_uq ON prescription (tenant_id, rx_number) WHERE rx_number IS NOT NULL;
SELECT app_enable_tenant_rls('prescription');

CREATE TABLE rx_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  prescription_id uuid NOT NULL REFERENCES prescription(id) ON DELETE CASCADE,
  sort_order      int  NOT NULL DEFAULT 0,
  drug_name       text NOT NULL,
  strength        text,
  form            text,
  dose            text NOT NULL,
  route           text NOT NULL DEFAULT 'oral',
  frequency       text NOT NULL,
  duration        text NOT NULL,
  quantity        text,
  prn             boolean NOT NULL DEFAULT false,
  prn_indication  text,
  instructions    text,
  CHECK (NOT prn OR prn_indication IS NOT NULL)
);
CREATE INDEX rx_line_rx_idx ON rx_line (prescription_id);
SELECT app_enable_tenant_rls('rx_line');

-- Freezes issued clinical content: only the status may move signed -> superseded/entered_in_error.
CREATE OR REPLACE FUNCTION clinical_freeze_signed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'signed % % cannot be deleted', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('signed','superseded','entered_in_error','cancelled') AND OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - 'status' - 'row_version') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'row_version') THEN
      RAISE EXCEPTION 'signed % % is immutable; create an amendment', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NOT (OLD.status = 'signed' AND NEW.status IN ('superseded','entered_in_error')) THEN
      RAISE EXCEPTION 'invalid status change % -> % on %', OLD.status, NEW.status, TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clinical_note_freeze BEFORE UPDATE OR DELETE ON clinical_note
  FOR EACH ROW EXECUTE FUNCTION clinical_freeze_signed();
CREATE TRIGGER prescription_freeze BEFORE UPDATE OR DELETE ON prescription
  FOR EACH ROW EXECUTE FUNCTION clinical_freeze_signed();

-- Lines of a non-draft prescription cannot change.
CREATE OR REPLACE FUNCTION rx_line_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM prescription WHERE id = COALESCE(NEW.prescription_id, OLD.prescription_id);
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'prescription lines are frozen once signed' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER rx_line_freeze BEFORE INSERT OR UPDATE OR DELETE ON rx_line
  FOR EACH ROW EXECUTE FUNCTION rx_line_freeze();

-- Follow-ups and recalls with a named owner and due window.
CREATE TABLE follow_up (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  encounter_id   uuid REFERENCES encounter(id),
  clinician_id   uuid REFERENCES clinician(id),
  owner_id       uuid REFERENCES staff(id),
  due_date       date NOT NULL,
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','completed','cancelled')),
  appointment_id uuid REFERENCES appointment(id),
  outcome        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
CREATE INDEX follow_up_due_idx ON follow_up (tenant_id, status, due_date);
SELECT app_enable_tenant_rls('follow_up');
