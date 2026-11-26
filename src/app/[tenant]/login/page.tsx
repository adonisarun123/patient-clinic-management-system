import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTenantBySlug } from '@/domain/tenants';
import { login } from '@/domain/staff';
import { sessionCookie, rateLimit } from '@/lib/http';
import { AppError } from '@/lib/errors';

export const metadata = { robots: { index: false } };

export default async function LoginPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ err?: string }> }) {
  const { tenant: slug } = await params;
  const { err } = await searchParams;
  let tenant;
  try { tenant = await getTenantBySlug(slug, { allowSuspended: true }); } catch { redirect('/'); }

  async function signIn(f: FormData) {
    'use server';
    const t = await getTenantBySlug(slug);
    const ip = (await headers()).get('x-forwarded-for')?.split(',')[0] ?? 'local';
    let token: { token: string; maxAge: number };
    try {
      rateLimit(`login:${slug}:${ip}`, 10);
      token = await login(t.id, String(f.get('email') ?? ''), String(f.get('password') ?? ''), ip);
    } catch (e) {
      if (!(e instanceof AppError)) console.error('[login]', e instanceof Error ? e.message : e);
      redirect(`/${slug}/login?err=${encodeURIComponent(e instanceof AppError ? e.message : 'Sign-in failed')}`);
    }
    (await cookies()).set(sessionCookie(slug), token.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: token.maxAge });
    redirect(`/${slug}`);
  }

  return (
    <main className="auth" style={{ ['--brand' as string]: tenant.branding.primaryColor ?? '#0f766e' }}>
      <form action={signIn} className="card auth-card">
        {tenant.branding.logoUrl ? <img src={tenant.branding.logoUrl} alt="" className="auth-logo" /> : null}
        <h1>{tenant.name}</h1>
        <p className="muted">Staff sign-in</p>
        {tenant.status !== 'active' ? <p className="flash err">This clinic account is {tenant.status}. Contact your administrator.</p> : null}
        {err ? <p className="flash err" role="alert">{err}</p> : null}
        <label>Email<input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="btn primary wide" type="submit">Sign in</button>
      </form>
    </main>
  );
}
