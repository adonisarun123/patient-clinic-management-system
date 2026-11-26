import type { Tx } from './db';
import { getSecret } from '@/domain/tenants';

/**
 * SMS delivery adapter. Drivers:
 *  - "msg91": POST https://control.msg91.com/api/v5/flow/ with an Authkey header and a DLT-approved template
 *    (per MSG91's published Flow API; verify field names against MSG91's current docs before go-live).
 *  - "dev": no SMS is sent; the code is written to the server log. Refused when NODE_ENV=production.
 * Indian bulk SMS needs a registered principal entity, header and template on DLT (SRS ch. 6, TRAI).
 */
export type SmsResult = { delivered: boolean; driver: string; detail?: string };

export async function sendOtpSms(tx: Tx, phoneE164: string, code: string, clinicName: string): Promise<SmsResult> {
  const authKey = await getSecret(tx, 'msg91_authkey');
  const templateId = await getSecret(tx, 'msg91_otp_template_id');
  if (authKey && templateId) {
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authkey: authKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [{ mobiles: phoneE164.replace(/^\+/, ''), otp: code, clinic: clinicName.slice(0, 30) }] }),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as Response);
    return { delivered: res.ok, driver: 'msg91', detail: res.ok ? undefined : `HTTP ${res.status}` };
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_SMS !== '1') {
    return { delivered: false, driver: 'none', detail: 'No SMS provider configured for this clinic' };
  }
  console.log(`[sms:dev] OTP for ${phoneE164.slice(0, 3)}••••${phoneE164.slice(-4)}: ${code}`);
  return { delivered: true, driver: 'dev' };
}
