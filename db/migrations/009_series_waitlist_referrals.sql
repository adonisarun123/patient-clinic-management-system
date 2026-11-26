-- OP-027 repeating series, OP-028 waitlist, CL-031 referrals.

CREATE TABLE appointment_series (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  service_id    uuid NOT NULL REFERENCES service(id),
  clinician_id  uuid NOT NULL REFERENCES clinician(id),
  freq          text NOT NULL CHECK (freq IN ('daily','weekly')),
  every_n       int  NOT NULL CHECK (every_n BETWEEN 1 AND 8),
  requested     int  NOT NULL CHECK (requested BETWEEN 2 AND 52),
  first_start   timestamptz NOT NULL,
  notes         text,
  created_by    uuid REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  cancel_reason text
);
SELECT app_enable_tenant_rls('appointment_series');
ALTER TABLE appointment ADD COLUMN series_id uuid REFERENCES appointment_series(id);
ALTER TABLE appointment ADD COLUMN series_seq int;
CREATE INDEX appointment_series_idx ON appointment (tenant_id, series_id) WHERE series_id IS NOT NULL;

CREATE TABLE waitlist_entry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  patient_id      uuid NOT NULL REFERENCES patient(id),
  service_id      uuid NOT NULL REFERENCES service(id),
  clinician_id    uuid REFERENCES clinician(id),          -- null: any eligible doctor
  earliest_date   date NOT NULL,
  latest_date     date NOT NULL,
  time_pref       text NOT NULL DEFAULT 'any' CHECK (time_pref IN ('any','morning','afternoon','evening')),
  priority        int  NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2),   -- 0 routine, 1 soon, 2 urgent
  notes           text,
  status          text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','booked','removed')),
  match_start     timestamptz,                             -- a freed slot that fits (set when a booking is cancelled)
  match_clinician uuid REFERENCES clinician(id),
  matched_at      timestamptz,
  appointment_id  uuid REFERENCES appointment(id),
  removed_reason  text,
  created_by      uuid REFERENCES staff(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (latest_date >= earliest_date)
);
CREATE INDEX waitlist_open_idx ON waitlist_entry (tenant_id, service_id, status, earliest_date);
SELECT app_enable_tenant_rls('waitlist_entry');

CREATE TABLE referrer (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  name             text NOT NULL,
  specialty        text,
  organisation     text,
  phone            text,
  email            text,
  registration_no  text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX referrer_name_org_uq ON referrer (tenant_id, lower(name), lower(coalesce(organisation, '')));
SELECT app_enable_tenant_rls('referrer');

CREATE TABLE referral (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  ref_number       text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('outbound','inbound')),
  patient_id       uuid NOT NULL REFERENCES patient(id),
  encounter_id     uuid REFERENCES encounter(id),
  referrer_id      uuid REFERENCES referrer(id),         -- the external party (sender for inbound, recipient for outbound)
  to_specialty     text,
  urgency          text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','soon','urgent')),
  reason           text NOT NULL,
  clinical_summary text,
  status           text NOT NULL CHECK (status IN ('draft','signed','sent','received','booked','completed','declined','cancelled')),
  clinician_id     uuid REFERENCES clinician(id),        -- author (outbound) or receiving doctor (inbound)
  signed_by        uuid REFERENCES staff(id),
  signed_at        timestamptz,
  appointment_id   uuid REFERENCES appointment(id),
  outcome_notes    text,
  created_by       uuid REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ref_number)
);
CREATE INDEX referral_patient_idx ON referral (tenant_id, patient_id);
CREATE INDEX referral_referrer_idx ON referral (tenant_id, referrer_id, created_at);
SELECT app_enable_tenant_rls('referral');

-- A signed outbound letter's clinical content cannot change.
CREATE OR REPLACE FUNCTION referral_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL AND (NEW.reason IS DISTINCT FROM OLD.reason OR NEW.clinical_summary IS DISTINCT FROM OLD.clinical_summary
      OR NEW.referrer_id IS DISTINCT FROM OLD.referrer_id OR NEW.to_specialty IS DISTINCT FROM OLD.to_specialty
      OR NEW.urgency IS DISTINCT FROM OLD.urgency OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.signed_at IS DISTINCT FROM OLD.signed_at) THEN
    RAISE EXCEPTION 'signed referral is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_freeze BEFORE UPDATE ON referral FOR EACH ROW EXECUTE FUNCTION referral_freeze();
