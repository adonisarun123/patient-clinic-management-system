import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { platformLogin, platformCompleteLogin } from '@/domain/platform';
import { rateLimit } from '@/lib/http';

export const metadata = { robots: { index: false } };

export default async function AdminLogin({ searchParams }: { searchParams: Promise<{ err?: string; step?: string }> }) {
  const { err, step } = await searchParams;
  const pending = step === 'code' && !!(await cookies()).get('cc_platform_mfa')?.value;
  const secure = process.env.NODE_ENV === 'production';
  async function signIn(f: FormData) {
    'use server';
    let r: Awaited<ReturnType<typeof platformLogin>>;
    try {
      rateLimit('platform-login', 20);
      r = await platformLogin(String(f.get('email')), String(f.get('password')));
    } catch { redirect('/admin/login?err=1'); }
    const jar = await cookies();
    if (r.kind === 'challenge') {
      jar.set('cc_platform_mfa', r.challenge, { httpOnly: true, secure, sameSite: 'strict', path: '/admin/login', maxAge: 300 });
      redirect('/admin/login?step=code');
    }
    jar.set('cc_platform', r.token, { httpOnly: true, secure, sameSite: 'strict', path: '/admin', maxAge: 8 * 3600 });
    redirect('/admin');
  }
  async function verify(f: FormData) {
    'use server';
    const jar = await cookies();
    let token: string;
    try {
      rateLimit('platform-login-2', 30);
      token = await platformCompleteLogin(jar.get('cc_platform_mfa')?.value ?? '', String(f.get('code') ?? ''));
    } catch { redirect('/admin/login?step=code&err=1'); }
    jar.delete({ name: 'cc_platform_mfa', path: '/admin/login' });
    jar.set('cc_platform', token, { httpOnly: true, secure, sameSite: 'strict', path: '/admin', maxAge: 8 * 3600 });
    redirect('/admin');
  }
  return (
    <main className="auth"><form action={pending ? verify : signIn} className="card auth-card">
      <h1>Clinic Core</h1><p className="muted">Platform console</p>
      {err && <p className="flash err">Sign-in failed.</p>}
      {pending ? <>
        <label>Authenticator code (or a recovery code)<input name="code" autoComplete="one-time-code" required autoFocus /></label>
        <button className="btn primary wide">Verify</button>
        <a className="small" href="/admin/login">Start again</a>
      </> : <>
        <label>Email<input name="email" type="email" required /></label>
        <label>Password<input name="password" type="password" required /></label>
        <button className="btn primary wide">Sign in</button>
      </>}
    </form></main>
  );
}
