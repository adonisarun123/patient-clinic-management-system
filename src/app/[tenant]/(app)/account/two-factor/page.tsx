import { requireStaff } from '@/lib/session';
import { recoveryCodesLeft } from '@/domain/staff';
import { Flash, PageHead } from '@/components/ui';
import { Enrol } from './Enrol';
import { turnOff } from './actions';

export default async function TwoFactor({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ ok?: string; err?: string; required?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { session, tenant, actor } = await requireStaff(slug, undefined, { twoFactorSetup: true });
  const required = tenant.settings.twoFactorRoles.includes(session.role);
  return (
    <>
      <PageHead title="Two-factor sign-in" sub="A code from your phone in addition to your password" />
      <Flash ok={sp.ok} err={sp.err} />
      {required && !session.twoFactorEnabled && <p className="flash warn">Your clinic requires two-factor sign-in for your role. Set it up to continue.</p>}
      {session.twoFactorEnabled ? (
        <div className="card narrow">
          <p><b>On.</b> You have {await recoveryCodesLeft(actor)} unused recovery code(s).</p>
          {required ? <p className="small muted">Required by your clinic for your role. If you change phones, ask an administrator to reset it, then set it up again.</p> : (
            <form action={turnOff.bind(null, slug)}>
              <h3>Turn off</h3>
              <label>Password<input type="password" name="password" required autoComplete="current-password" /></label>
              <label>Current code<input name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" required /></label>
              <button className="btn danger">Turn off two-factor sign-in</button>
            </form>
          )}
        </div>
      ) : <Enrol slug={slug} />}
    </>
  );
}
