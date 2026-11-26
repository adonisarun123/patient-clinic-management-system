import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { platformLogin } from '@/domain/platform';
import { rateLimit } from '@/lib/http';

export const metadata = { robots: { index: false } };

export default async function AdminLogin({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  async function signIn(f: FormData) {
    'use server';
    let token: string;
    try {
      rateLimit('platform-login', 20);
      token = await platformLogin(String(f.get('email')), String(f.get('password')));
    } catch { redirect('/admin/login?err=1'); }
    (await cookies()).set('cc_platform', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/admin', maxAge: 8 * 3600 });
    redirect('/admin');
  }
  return (
    <main className="auth"><form action={signIn} className="card auth-card">
      <h1>Clinic Core</h1><p className="muted">Platform console</p>
      {err && <p className="flash err">Sign-in failed.</p>}
      <label>Email<input name="email" type="email" required /></label>
      <label>Password<input name="password" type="password" required /></label>
      <button className="btn primary wide">Sign in</button>
    </form></main>
  );
}
