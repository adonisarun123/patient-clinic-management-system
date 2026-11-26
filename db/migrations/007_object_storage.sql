-- Files can live in private object storage (Vercel Blob) instead of the database.
-- Exactly one of data / storage_key is set. The key is always prefixed with the owning tenant's id.
ALTER TABLE attachment ALTER COLUMN data DROP NOT NULL;
ALTER TABLE attachment ADD COLUMN storage_key text;
ALTER TABLE attachment ADD CONSTRAINT attachment_one_location CHECK ((data IS NULL) <> (storage_key IS NULL));
ALTER TABLE attachment ADD CONSTRAINT attachment_key_tenant CHECK (storage_key IS NULL OR storage_key LIKE tenant_id::text || '/%');
CREATE UNIQUE INDEX attachment_storage_key_uq ON attachment (storage_key) WHERE storage_key IS NOT NULL;
