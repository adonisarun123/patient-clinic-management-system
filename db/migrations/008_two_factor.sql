-- Two-factor sign-in (TOTP) for clinic staff and the platform console.
-- Secrets are encrypted by the app (AES-256-GCM, APP_ENCRYPTION_KEY); recovery codes are stored only as hashes.

ALTER TABLE staff ADD COLUMN totp_secret_enc text;
ALTER TABLE staff ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE staff ADD COLUMN totp_last_step bigint;
ALTER TABLE staff ADD COLUMN recovery_code_hashes text[] NOT NULL DEFAULT '{}';

-- Password accepted, second factor pending. Short-lived, single-use, attempt-limited.
CREATE TABLE staff_login_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_challenge_staff_idx ON staff_login_challenge (tenant_id, staff_id);
SELECT app_enable_tenant_rls('staff_login_challenge');

ALTER TABLE platform_admin ADD COLUMN totp_secret_enc text;
ALTER TABLE platform_admin ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE platform_admin ADD COLUMN totp_last_step bigint;
ALTER TABLE platform_admin ADD COLUMN recovery_code_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE platform_admin ADD COLUMN password_changed_at timestamptz;

CREATE TABLE platform_login_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid NOT NULL REFERENCES platform_admin(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
