'use client';
import { useActionState, useState } from 'react';
import { adminConfirmTwoFactor, adminStartTwoFactor, type PlatformEnrol } from './actions';

export function AdminTwoFactor() {
  const [start, setStart] = useState<PlatformEnrol | null>(null);
  const [state, confirm, pending] = useActionState(adminConfirmTwoFactor, {} as PlatformEnrol);
  if (state.codes) return (<div><p><b>Two-factor sign-in is on.</b> Save these recovery codes now — they are not shown again.</p><pre className="recovery-codes">{state.codes.join('\n')}</pre></div>);
  const v = { ...(start ?? {}), ...(state.error ? { error: state.error } : {}) };
  if (!v.secret) return (<div>{v.error && <p className="flash err">{v.error}</p>}<button className="btn primary small" onClick={async () => setStart(await adminStartTwoFactor())}>Set up two-factor sign-in</button></div>);
  return (
    <form action={confirm}>
      {v.qr && <img src={v.qr} alt="QR code for your authenticator app" width={220} height={220} />}
      <p className="small">Key: <code className="secret-key">{v.secret.match(/.{1,4}/g)?.join(' ')}</code></p>
      {v.error && <p className="flash err">{v.error}</p>}
      <label>6-digit code<input name="code" inputMode="numeric" required /></label>
      <button className="btn primary small" disabled={pending}>Turn on</button>
    </form>
  );
}
