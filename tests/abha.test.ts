import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic } from './helpers';
import { pool } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import { registerPatient, searchPatients } from '../src/domain/patients';
import * as abha from '../src/domain/abha';
import { abdmAccessToken, abdmConfigured, abdmTestConnection, verifyAbhaWithAbdm, _resetAbdmCache } from '../src/lib/abdm';

after(async () => { await pool().end(); });
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return toAppError(e) as AppError; } };

test('ABHA number and address formats', () => {
  assert.equal(abha.normaliseAbhaNumber('12-3456-7890-1234'), '12345678901234');
  assert.equal(abha.normaliseAbhaNumber('1234 5678 9012 34'), '12345678901234');
  assert.equal(abha.normaliseAbhaNumber('1234567890123'), null);
  assert.equal(abha.formatAbhaNumber('12345678901234'), '12-3456-7890-1234');
  assert.equal(abha.maskAbhaNumber('12345678901234'), 'XX-XXXX-XXXX-1234');
  assert.equal(abha.normaliseAbhaAddress(' Asha.Rao@ABDM '), 'asha.rao@abdm');
  assert.equal(abha.normaliseAbhaAddress('asha rao@abdm'), null);
});

test('recording ABHA needs consent, blocks the same ABHA on two charts, and is searchable', async () => {
  const c = await makeClinic();
  const a = await registerPatient(c.reception, c.tenant, { fullName: 'Abha One', birthDate: '1980-01-01' });
  const b = await registerPatient(c.reception, c.tenant, { fullName: 'Abha Two', birthDate: '1981-01-01' });
  assert.equal((await err(abha.recordAbha(c.reception, c.tenant, a.id, { abhaNumber: '12-3456-7890-1234', verification: 'card_seen', consent: false })))?.code, 'VALIDATION');
  assert.equal((await err(abha.recordAbha(c.reception, c.tenant, a.id, { abhaNumber: '123', verification: 'card_seen', consent: true })))?.code, 'VALIDATION');
  await abha.recordAbha(c.reception, c.tenant, a.id, { abhaNumber: '12-3456-7890-1234', abhaAddress: 'abha.one@sbx', verification: 'card_seen', consent: true });
  assert.match((await err(abha.recordAbha(c.reception, c.tenant, b.id, { abhaNumber: '12345678901234', verification: 'self_declared', consent: true })))!.message, /already recorded on chart/);
  const found = await searchPatients(c.reception, '12-3456-7890-1234');
  assert.equal(found[0]?.id, a.id);
  assert.equal((await searchPatients(c.reception, 'abha.one@sbx'))[0]?.id, a.id);
  await abha.recordAbha(c.reception, c.tenant, a.id, { abhaAddress: 'abha.new@sbx', verification: 'self_declared', consent: true });
  const cur = await abha.patientAbha(c.reception, c.tenant, a.id);
  assert.equal(cur?.abha_address, 'abha.new@sbx'); assert.equal(cur?.abha_number, null, 'replaced, not merged');
  await abha.removeAbha(c.reception, c.tenant, a.id, 'Consent withdrawn');
  assert.equal(await abha.patientAbha(c.reception, c.tenant, a.id), null);
});

test('ABDM adapter stays off without credentials and sends the V3 session shape when configured', async () => {
  delete process.env.ABDM_CLIENT_ID; delete process.env.ABDM_CLIENT_SECRET; _resetAbdmCache();
  assert.equal(abdmConfigured(), false);
  assert.match((await err(abdmAccessToken()))!.message, /not connected/);
  assert.match((await err(verifyAbhaWithAbdm()))!.message, /not connected/);
  process.env.ABDM_CLIENT_ID = 'SBX_TEST'; process.env.ABDM_CLIENT_SECRET = 'secret';
  try {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, string> } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ accessToken: 'tok', expiresIn: 1200 }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await abdmAccessToken(fake), 'tok');
    assert.equal(seen!.url, 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions');
    assert.equal(seen!.headers['X-CM-ID'], 'sbx'); assert.ok(seen!.headers['REQUEST-ID']); assert.ok(seen!.headers.TIMESTAMP);
    assert.deepEqual(seen!.body, { clientId: 'SBX_TEST', clientSecret: 'secret', grantType: 'client_credentials' });
    _resetAbdmCache();
    const refused = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const t = await abdmTestConnection(refused);
    assert.equal(t.ok, false); assert.match((t as { error: string }).error, /HTTP 401/);
  } finally { delete process.env.ABDM_CLIENT_ID; delete process.env.ABDM_CLIENT_SECRET; _resetAbdmCache(); }
});
