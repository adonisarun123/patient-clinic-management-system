'use client';
import Link from 'next/link';

/** Shown when a page cannot load: no permission, a module switched off, or an unexpected failure. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card narrow">
      <h2>This page is not available</h2>
      <p className="muted">You may not have permission, the feature may be switched off for this clinic, or something went wrong.</p>
      {error.digest && <p className="small muted">Reference: {error.digest}</p>}
      <p><button className="btn" onClick={() => reset()}>Try again</button> <Link href="..">Go back</Link></p>
    </div>
  );
}
