import Link from 'next/link';

export default function Home() {
  return (
    <main className="auth">
      <div className="card auth-card" style={{ maxWidth: 560 }}>
        <h1>Clinic Core</h1>
        <p className="muted">Patient management add-on for clinic and hospital websites built by Monk Mantra.</p>
        <p>Clinic staff sign in at <code>/&lt;clinic-slug&gt;/login</code>. Platform administrators use the <Link href="/admin">console</Link>.</p>
      </div>
    </main>
  );
}
