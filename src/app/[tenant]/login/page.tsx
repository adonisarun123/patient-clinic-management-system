import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTenantBySlug } from '@/domain/tenants';
import { login, completeTwoFactorLogin } from '@/domain/staff';
import { sessionCookie, rateLimit } from '@/lib/http';
import { AppError } from '@/lib/errors';

export const metadata = { robots: { index: false } };

const mfaCookie = (slug: string) => `cc_mfa_${slug.replace(/-/g, '_')}`;

export default async function LoginPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ err?: string; step?: string }> }) {
  const { tenant: slug } = await params;
  const { err, step } = await searchParams;
  const pendingMfa = step === 'code' && !!(await cookies()).get(mfaCookie(slug))?.value;
  let tenant;
  try { tenant = await getTenantBySlug(slug, { allowSuspended: true }); } catch { redirect('/'); }

  async function signIn(f: FormData) {
    'use server';
    const t = await getTenantBySlug(slug);
    const ip = (await headers()).get('x-forwarded-for')?.split(',')[0] ?? 'local';
    let r: Awaited<ReturnType<typeof login>>;
    try {
      rateLimit(`login:${slug}:${ip}`, 10);
      r = await login(t.id, String(f.get('email') ?? ''), String(f.get('password') ?? ''), ip);
    } catch (e) {
      if (!(e instanceof AppError)) console.error('[login]', e instanceof Error ? e.message : e);
      redirect(`/${slug}/login?err=${encodeURIComponent(e instanceof AppError ? e.message : 'Sign-in failed')}`);
    }
    const jar = await cookies();
    const secure = process.env.NODE_ENV === 'production';
    if (r.kind === 'challenge') {
      jar.set(mfaCookie(slug), r.challenge, { httpOnly: true, secure, sameSite: 'strict', path: `/${slug}/login`, maxAge: r.maxAge });
      redirect(`/${slug}/login?step=code`);
    }
    jar.set(sessionCookie(slug), r.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: r.maxAge });
    redirect(`/${slug}`);
  }

  async function verifyCode(f: FormData) {
    'use server';
    const t = await getTenantBySlug(slug);
    const ip = (await headers()).get('x-forwarded-for')?.split(',')[0] ?? 'local';
    const jar = await cookies();
    let r: Awaited<ReturnType<typeof completeTwoFactorLogin>>;
    try {
      rateLimit(`login2:${slug}:${ip}`, 20);
      r = await completeTwoFactorLogin(t.id, jar.get(mfaCookie(slug))?.value ?? '', String(f.get('code') ?? ''), ip);
    } catch (e) {
      if (!(e instanceof AppError)) console.error('[login 2fa]', e instanceof Error ? e.message : e);
      const msg = e instanceof AppError ? e.message : 'Sign-in failed';
      redirect(`/${slug}/login?${/Start again/.test(msg) ? '' : 'step=code&'}err=${encodeURIComponent(msg)}`);
    }
    const secure = process.env.NODE_ENV === 'production';
    jar.delete({ name: mfaCookie(slug), path: `/${slug}/login` });
    jar.set(sessionCookie(slug), r.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: r.maxAge });
    redirect(`/${slug}`);
  }

  return (
    <main className="auth" style={{ ['--brand' as string]: tenant.branding.primaryColor ?? '#0f766e' }}>
      <form action={pendingMfa ? verifyCode : signIn} className="card auth-card">
        {tenant.branding.logoUrl ? <img src={tenant.branding.logoUrl} alt="" className="auth-logo" /> : null}
        <h1>{tenant.name}</h1>
        <p className="muted">Staff sign-in</p>
        {tenant.status !== 'active' ? <p className="flash err">This clinic account is {tenant.status}. Contact your administrator.</p> : null}
        {err ? <p className="flash err" role="alert">{err}</p> : null}
        {pendingMfa ? <>
          <label>Code from your authenticator app
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}|[a-zA-Z0-9-]{10,11}" maxLength={11} required autoFocus />
          </label>
          <p className="small muted">Lost your phone? Enter one of your recovery codes instead, or ask an administrator to reset two-factor sign-in.</p>
          <button className="btn primary wide" type="submit">Verify</button>
          <a className="small" href={`/${slug}/login`}>Start again</a>
        </> : <>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="btn primary wide" type="submit">Sign in</button>
        </>}
      </form>
    </main>
  );
}
