import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listTenants, platformSession, setTenantStatus, tenantUsage } from '@/domain/platform';
import { provisionTenant } from '@/domain/tenants';
import { AppError } from '@/lib/errors';
import { Flash } from '@/components/ui';

export const metadata = { robots: { index: false } };

async function requirePlatform() {
  const s = await platformSession((await cookies()).get('cc_platform')?.value);
  if (!s) redirect('/admin/login');
  return s;
}

export default async function Admin({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; created?: string }> }) {
  const admin = await requirePlatform();
  const sp = await searchParams;
  const tenants = await listTenants();
  const usage = await tenantUsage(tenants.map((t) => t.id));
  const h = await headers();
  const host = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;

  async function create(f: FormData) {
    'use server';
    await requirePlatform();
    let msg: string;
    try {
      const r = await provisionTenant({
        slug: String(f.get('slug')).trim().toLowerCase(), name: String(f.get('name')).trim(), ownerEmail: String(f.get('ownerEmail')).trim(),
        ownerName: String(f.get('ownerName')).trim(), soloPractice: f.get('solo') === 'on', uhidPrefix: String(f.get('prefix') || 'MRN').toUpperCase(),
        allowedOrigins: String(f.get('origins') ?? '').split(/[\s,]+/).filter(Boolean),
      });
      msg = `Created /${r.slug}. Owner ${r.ownerEmail} temporary password: ${r.tempPassword} · Website key: ${r.publishableKey} — copy both now; they are not shown again.`;
    } catch (e) {
      redirect(`/admin?err=${encodeURIComponent(e instanceof AppError ? e.message : (e as Error).message ?? 'Failed')}`);
    }
    redirect(`/admin?created=${encodeURIComponent(msg)}`);
  }
  async function toggle(f: FormData) {
    'use server';
    await requirePlatform();
    await setTenantStatus(String(f.get('id')), f.get('status') === 'suspended' ? 'suspended' : 'active');
    redirect('/admin?ok=Updated');
  }

  return (
    <main className="main admin">
      <div className="page-head"><div><h1>Clinic Core — platform</h1><p className="muted">Signed in as {admin.full_name}</p></div></div>
      <Flash ok={sp.ok ?? sp.created} err={sp.err} />
      <div className="card">
        <h2>Clinics</h2>
        <table className="table"><thead><tr><th>Clinic</th><th>Slug</th><th>Patients</th><th>Bookings (30d)</th><th>Staff</th><th>Status</th><th /></tr></thead>
          <tbody>{tenants.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td><Link href={`/${t.slug}/login`}>/{t.slug}</Link></td><td>{usage[t.id]?.patients}</td><td>{usage[t.id]?.appts30}</td><td>{usage[t.id]?.staff}</td><td>{t.status}</td>
              <td><form action={toggle}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={t.status === 'active' ? 'suspended' : 'active'} />
                <button className="btn small">{t.status === 'active' ? 'Suspend' : 'Reactivate'}</button></form></td></tr>))}</tbody></table>
      </div>
      <form action={create} className="card form-grid">
        <h2 className="span2">Onboard a new clinic</h2>
        <label>Clinic name<input name="name" required /></label>
        <label>URL slug<input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,40}" placeholder="sports-ortho" /></label>
        <label>Owner name<input name="ownerName" required /></label>
        <label>Owner email<input name="ownerEmail" type="email" required /></label>
        <label>UHID prefix<input name="prefix" defaultValue="MRN" pattern="[A-Za-z0-9]{1,6}" /></label>
        <label className="check"><input type="checkbox" name="solo" /> Solo practice (single doctor)</label>
        <label className="span2">Clinic website origins (for the booking widget)<input name="origins" placeholder="https://www.clinic.com https://clinic.com" /></label>
        <div className="span2"><button className="btn primary">Create clinic</button> <small className="muted">Staff then sign in at {host}/&lt;slug&gt;/login</small></div>
      </form>
    </main>
  );
}
