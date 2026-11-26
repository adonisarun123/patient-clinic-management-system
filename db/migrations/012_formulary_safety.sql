-- CFG-006 / CL-014 / CL-017: clinic formulary with dose limits, drug-interaction rules, prescribing safety findings.
-- Clinical reference data is entered or imported by the clinic (pharmacist / licensed source). Nothing is pre-loaded.

CREATE TABLE formulary_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  generic_name      text NOT NULL,
  brand_names       text[] NOT NULL DEFAULT '{}',
  classes           text[] NOT NULL DEFAULT '{}',        -- e.g. {penicillin, beta-lactam}; used for class allergies and class interactions
  strength          text,
  form              text,
  route             text,
  dose_unit         text NOT NULL DEFAULT 'mg' CHECK (dose_unit IN ('mg','mcg','g','ml','units')),
  per_kg_min        numeric(10,3) CHECK (per_kg_min IS NULL OR per_kg_min > 0),   -- per dose, in dose_unit per kg
  per_kg_max        numeric(10,3) CHECK (per_kg_max IS NULL OR per_kg_max > 0),
  max_single_dose   numeric(12,3) CHECK (max_single_dose IS NULL OR max_single_dose > 0),
  max_daily_dose    numeric(12,3) CHECK (max_daily_dose IS NULL OR max_daily_dose > 0),
  weight_required_under_years int CHECK (weight_required_under_years IS NULL OR weight_required_under_years BETWEEN 0 AND 18),
  schedule          text,                                  -- e.g. H, H1, X, OTC
  product_id        uuid REFERENCES product(id),
  source            text NOT NULL,                         -- where the limits came from (e.g. "BNFc 2026", "Pharmacy committee 12-Nov-2026")
  notes             text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  reviewed_by       uuid REFERENCES staff(id),
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (per_kg_max IS NULL OR per_kg_min IS NULL OR per_kg_max >= per_kg_min)
);
CREATE UNIQUE INDEX formulary_generic_strength_uq ON formulary_item (tenant_id, lower(generic_name), lower(coalesce(strength, '')), lower(coalesce(form, '')));
SELECT app_enable_tenant_rls('formulary_item');

CREATE TABLE interaction_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  a_kind      text NOT NULL CHECK (a_kind IN ('generic','class')),
  a_value     text NOT NULL,
  b_kind      text NOT NULL CHECK (b_kind IN ('generic','class')),
  b_value     text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('contraindicated','major','moderate','minor')),
  effect      text NOT NULL,
  management  text,
  source      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX interaction_rule_pair_uq ON interaction_rule (tenant_id, a_kind, lower(a_value), b_kind, lower(b_value));
SELECT app_enable_tenant_rls('interaction_rule');

-- Structured dose (optional) so limits can be checked; and what the checks found at signing.
ALTER TABLE rx_line ADD COLUMN formulary_item_id uuid REFERENCES formulary_item(id);
ALTER TABLE prescription ADD COLUMN safety_findings jsonb;
