import { requireStaff } from '@/lib/session';
import { changePasswordAction } from '../actions';
import { Flash, PageHead } from '@/components/ui';
import { ROLE_LABEL } from '@/lib/rbac';

export default async function Account({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const { session } = await requireStaff(slug);
  return (
    <>
      <PageHead title="My account" sub={`${session.name} · ${session.email} · ${ROLE_LABEL[session.role]}`} />
      <Flash {...await searchParams} />
      <form action={changePasswordAction.bind(null, slug)} className="card narrow">
        <h2>Change password</h2>
        <label>Current password<input type="password" name="current" required autoComplete="current-password" /></label>
        <label>New password (min 10 characters)<input type="password" name="next" required minLength={10} autoComplete="new-password" /></label>
        <label>Confirm new password<input type="password" name="confirm" required minLength={10} autoComplete="new-password" /></label>
        <button className="btn primary">Change password</button>
      </form>
      <div className="card narrow">
        <h2>Two-factor sign-in</h2>
        <p>{session.twoFactorEnabled ? 'On — a code from your phone is needed when you sign in.' : 'Off. Turning it on protects patient records if your password is ever exposed.'}</p>
        <a className="btn" href={`/${slug}/account/two-factor`}>{session.twoFactorEnabled ? 'Manage' : 'Set up'}</a>
      </div>
    </>
  );
}
