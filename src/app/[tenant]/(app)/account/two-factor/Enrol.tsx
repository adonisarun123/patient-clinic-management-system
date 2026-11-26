'use client';
import { useActionState, useState } from 'react';
import { confirmEnrolment, startEnrolment, type EnrolState } from './actions';

export function Enrol({ slug }: { slug: string }) {
  const [start, setStart] = useState<EnrolState | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, confirm, pending] = useActionState(confirmEnrolment.bind(null, slug), {} as EnrolState);
  const view = state.codes ? state : { ...(start ?? {}), ...(state.error ? { error: state.error } : {}) };

  if (view.codes) return (
    <div className="card narrow">
      <h2>Two-factor sign-in is on</h2>
      <p>Save these recovery codes somewhere safe (a password manager, or printed and locked away). Each works once if you lose your phone. <b>They will not be shown again.</b></p>
      <pre className="recovery-codes">{view.codes.join('\n')}</pre>
      <a className="btn primary" href={`/${slug}`}>I have saved them — continue</a>
    </div>
  );

  if (!view.secret) return (
    <div className="card narrow">
      <h2>Set up two-factor sign-in</h2>
      <p>You will need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password.</p>
      {view.error && <p className="flash err">{view.error}</p>}
      <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); setStart(await startEnrolment(slug)); setBusy(false); }}>
        {busy ? 'Preparing…' : 'Start set-up'}
      </button>
    </div>
  );

  return (
    <form action={confirm} className="card narrow">
      <h2>Scan this code</h2>
      <p>Open your authenticator app, add an account, and scan the QR code.</p>
      {view.qr && <img src={view.qr} alt="QR code for your authenticator app" width={220} height={220} />}
      <details><summary className="small">Can’t scan? Enter this key instead</summary><code className="secret-key">{view.secret.match(/.{1,4}/g)?.join(' ')}</code></details>
      {view.error && <p className="flash err" role="alert">{view.error}</p>}
      <label>Enter the 6-digit code the app shows<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus /></label>
      <button className="btn primary" disabled={pending}>{pending ? 'Checking…' : 'Turn on two-factor sign-in'}</button>
    </form>
  );
}
