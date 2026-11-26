-- Records tools: virus-scan results, re-filing misfiled documents, two-person chart merges with undo,
-- and versioned print layouts. Additive only.

-- ---------------------------------------------------------------- virus scanning
ALTER TABLE attachment ADD COLUMN scan_status text NOT NULL DEFAULT 'not_scanned'
  CHECK (scan_status IN ('not_scanned','clean','error_accepted'));
ALTER TABLE attachment ADD COLUMN scan_detail text;
ALTER TABLE attachment ADD COLUMN scanned_at timestamptz;

-- ---------------------------------------------------------------- re-filing a document filed to the wrong chart
CREATE TABLE attachment_refile (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  attachment_id  uuid NOT NULL REFERENCES attachment(id),
  from_patient_id uuid NOT NULL REFERENCES patient(id),
  to_patient_id  uuid NOT NULL REFERENCES patient(id),
  reason         text NOT NULL CHECK (length(trim(reason)) >= 5),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','rejected','cancelled')),
  requested_by   uuid NOT NULL REFERENCES staff(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES staff(id),
  decided_at     timestamptz,
  decision_note  text,
  CHECK (from_patient_id <> to_patient_id)
);
CREATE UNIQUE INDEX attachment_refile_one_open ON attachment_refile (attachment_id) WHERE status = 'pending';
CREATE INDEX attachment_refile_patient_idx ON attachment_refile (tenant_id, from_patient_id);
CREATE INDEX attachment_refile_to_idx ON attachment_refile (tenant_id, to_patient_id);
SELECT app_enable_tenant_rls('attachment_refile');

-- ---------------------------------------------------------------- chart merge (request → second person approves → undo)
CREATE TABLE chart_merge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  source_id       uuid NOT NULL REFERENCES patient(id),
  survivor_id     uuid NOT NULL REFERENCES patient(id),
  reason          text NOT NULL CHECK (length(trim(reason)) >= 5),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','rejected','cancelled','undone')),
  requested_by    uuid REFERENCES staff(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid REFERENCES staff(id),
  done_at         timestamptz,
  source_prior_status text,
  survivor_prior_allergy_status text,
  moved           jsonb,
  undone_by       uuid REFERENCES staff(id),
  undone_at       timestamptz,
  undo_reason     text,
  undo_left       jsonb,
  decision_note   text,
  CHECK (source_id <> survivor_id)
);
CREATE UNIQUE INDEX chart_merge_one_open ON chart_merge (source_id) WHERE status IN ('pending','done');
CREATE INDEX chart_merge_survivor_idx ON chart_merge (tenant_id, survivor_id);
SELECT app_enable_tenant_rls('chart_merge');

-- ---------------------------------------------------------------- versioned print layouts
CREATE TABLE print_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  doc_kind    text NOT NULL CHECK (doc_kind IN ('prescription','receipt','referral')),
  version     int  NOT NULL CHECK (version > 0),
  layout      jsonb NOT NULL,
  note        text,
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_kind, version)
);
SELECT app_enable_tenant_rls('print_template');

CREATE FUNCTION print_template_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Print template versions are immutable; save a new version';
END $$;
CREATE TRIGGER print_template_no_update BEFORE UPDATE OR DELETE ON print_template
  FOR EACH ROW EXECUTE FUNCTION print_template_immutable();

-- Undoing a merge is recorded in the identity history.
ALTER TABLE patient_change DROP CONSTRAINT IF EXISTS patient_change_kind_check;
ALTER TABLE patient_change ADD CONSTRAINT patient_change_kind_check CHECK (kind IN ('correction','update','merge','link','unmerge'));
