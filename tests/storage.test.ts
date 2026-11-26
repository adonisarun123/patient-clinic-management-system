import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTenantKey, objectStorageEnabled } from '../src/lib/blob';
import { withPlatform } from '../src/lib/db';

test('object storage keys must belong to the clinic; DB enforces one location and tenant prefix', async () => {
  const t = '11111111-1111-4111-8111-111111111111';
  assert.doesNotThrow(() => assertTenantKey(t, `${t}/uploads/report-abc.pdf`));
  for (const bad of [`22222222-2222-4222-8222-222222222222/uploads/x.pdf`, `${t}/other/x.pdf`, `${t}/uploads/../x.pdf`, `uploads/x.pdf`])
    assert.throws(() => assertTenantKey(t, bad), /not recognised/);
  assert.equal(objectStorageEnabled(), !!process.env.BLOB_READ_WRITE_TOKEN);
  const c = await withPlatform((tx) => tx.many<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = 'attachment'::regclass AND conname IN ('attachment_one_location','attachment_key_tenant') ORDER BY 1`));
  assert.deepEqual(c.map((r) => r.conname), ['attachment_key_tenant', 'attachment_one_location']);
});
