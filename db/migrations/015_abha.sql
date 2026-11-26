-- ABDM / ABHA: capture of the patient's ABHA number and address with how it was verified and the patient's
-- consent. Verification against ABDM happens only once the clinic's ABDM integration is approved. Additive only.
CREATE TABLE patient_abha (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  patient_id      uuid NOT NULL REFERENCES patient(id),
  abha_number     text CHECK (abha_number ~ '^[0-9]{14}$'),
  abha_address    text CHECK (abha_address ~ '^[a-z0-9._]{3,40}@[a-z]{2,10}$'),
  verification    text NOT NULL DEFAULT 'self_declared' CHECK (verification IN ('self_declared','card_seen','abdm_verified')),
  consent_given   boolean NOT NULL CHECK (consent_given),
  consent_note    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  recorded_by     uuid REFERENCES staff(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  removed_by      uuid REFERENCES staff(id),
  removed_at      timestamptz,
  removed_reason  text,
  CHECK (abha_number IS NOT NULL OR abha_address IS NOT NULL)
);
CREATE UNIQUE INDEX patient_abha_one_active ON patient_abha (tenant_id, patient_id) WHERE status = 'active';
CREATE UNIQUE INDEX patient_abha_number_uq ON patient_abha (tenant_id, abha_number) WHERE status = 'active' AND abha_number IS NOT NULL;
CREATE UNIQUE INDEX patient_abha_address_uq ON patient_abha (tenant_id, abha_address) WHERE status = 'active' AND abha_address IS NOT NULL;
SELECT app_enable_tenant_rls('patient_abha');
