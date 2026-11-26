import Link from 'next/link';
import { cookies } from 'next/headers';
import { portalTenant, portalCookie } from '@/lib/portal-session';
import { portalSession } from '@/domain/portal';
import { Flash } from '@/components/ui';
import { requestCode, signOut, verifyCode } from './actions';

export default async function PortalHome({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ step?: string; err?: string; ok?: string; dev?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const tenant = await portalTenant(slug);
  const s = await portalSession(tenant, (await cookies()).get(portalCookie(slug))?.value);
  if (!s) {
    return (
      <div className="card narrow">
        <h1>Sign in</h1>
        <Flash ok={sp.ok} err={sp.err} />
        {sp.step === 'code' ? (
          <form action={verifyCode.bind(null, slug)}>
            <p>Enter the 6-digit code sent to your mobile.</p>
            {sp.dev && <p className="pill warn">Test mode — no SMS provider configured. Code: {sp.dev}</p>}
            <label>Code<input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></label>
            <button className="btn primary wide">Verify</button>
            <p className="small"><Link href={`/p/${slug}`}>Use a different number</Link></p>
          </form>
        ) : (
          <form action={requestCode.bind(null, slug)}>
            <label>Mobile number<input name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="10-digit mobile" /></label>
            <button className="btn primary wide">Send code</button>
            <p className="small muted">You will only see records the clinic has linked to this number after checking your identity at the desk.</p>
          </form>)}
      </div>
    );
  }
  return (
    <div className="card narrow">
      <div className="row-between"><h1>Welcome</h1><form action={signOut.bind(null, slug)}><button className="link">Sign out</button></form></div>
      {s.links.length === 0 ? (
        <p>No records are linked to this mobile number yet. Ask at reception to link your record — please bring photo ID{tenant.branding.phone ? ` or call ${tenant.branding.phone}` : ''}.</p>
      ) : (
        <>
          <p className="muted">Choose whose record to open:</p>
          <div className="list-cards">{s.links.map((l) => (
            <Link key={l.link_id} className="slot" href={`/p/${slug}/patient/${l.patient_id}`} style={{ textAlign: 'left' }}>{l.full_name}<small>{l.uhid} · {l.relation === 'self' ? 'You' : l.relation}</small></Link>))}</div>
        </>)}
    </div>
  );
}
