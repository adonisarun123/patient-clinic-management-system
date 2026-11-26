import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireStaff } from '@/lib/session';
import { can, ROLE_LABEL, type Permission } from '@/lib/rbac';

export const metadata = { robots: { index: false, follow: false } };

import type { ModuleName } from '@/domain/tenants';

const NAV: { href: string; label: string; perm: Permission; module?: ModuleName }[] = [
  { href: '', label: 'Today', perm: 'schedule.read' },
  { href: '/appointments', label: 'Appointments', perm: 'schedule.read' },
  { href: '/queue', label: 'Queue', perm: 'schedule.read' },
  { href: '/patients', label: 'Patients', perm: 'patient.read' },
  { href: '/follow-ups', label: 'Follow-ups', perm: 'schedule.read' },
  { href: '/waitlist', label: 'Waitlist', perm: 'schedule.read' },
  { href: '/referrals', label: 'Referrals', perm: 'patient.read' },
  { href: '/labs', label: 'Lab & imaging', perm: 'schedule.read', module: 'labs' },
  { href: '/inpatient', label: 'Inpatient', perm: 'schedule.read', module: 'inpatient' },
  { href: '/pharmacy', label: 'Pharmacy', perm: 'pharmacy.dispense', module: 'pharmacy' },
  { href: '/formulary', label: 'Formulary', perm: 'clinical.read' },
  { href: '/billing', label: 'Billing', perm: 'billing.read' },
  { href: '/insurance', label: 'Insurance', perm: 'claims.manage' },
  { href: '/reports', label: 'Reports', perm: 'reports.read' },
  { href: '/accounts', label: 'Accounts', perm: 'finance.close' },
  { href: '/records-requests', label: 'Records requests', perm: 'records.requests', module: 'portal' },
  { href: '/emergency-access', label: 'Emergency access', perm: 'emergency.review', module: 'emergencyAccess' },
  { href: '/import', label: 'Data import', perm: 'import.run', module: 'import' },
  { href: '/settings', label: 'Settings', perm: 'settings.manage' },
];

export default async function AppLayout({ children, params }: { children: ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const { tenant, session } = await requireStaff(slug);
  const b = tenant.branding;
  return (
    <div className="shell" style={{ ['--brand' as string]: b.primaryColor ?? '#0f766e', ['--accent' as string]: b.accentColor ?? '#f59e0b' }}>
      <aside className="side">
        <Link href={`/${slug}`} className="brand">
          {b.logoUrl ? <img src={b.logoUrl} alt="" /> : <span className="brand-mark">{tenant.name.slice(0, 1)}</span>}
          <span>{tenant.name}</span>
        </Link>
        <nav>
          {NAV.filter((n) => can(session.role, n.perm) && (!n.module || tenant.settings.modules[n.module])).map((n) => <Link key={n.href} href={`/${slug}${n.href}`}>{n.label}</Link>)}
        </nav>
        <div className="side-foot">
          <Link href={`/${slug}/account`} className="who">{session.name}<small>{ROLE_LABEL[session.role]}</small></Link>
          <form action={`/${slug}/logout`} method="post"><button className="link" type="submit">Sign out</button></form>
        </div>
      </aside>
      <main className="main">
        {session.mustChangePassword ? <p className="flash warn">You are using a temporary password. <Link href={`/${slug}/account`}>Set your own password</Link>.</p> : null}
        {children}
      </main>
    </div>
  );
}
