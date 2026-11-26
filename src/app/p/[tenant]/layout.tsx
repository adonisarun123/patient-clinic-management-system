import type { ReactNode } from 'react';
import { portalTenant } from '@/lib/portal-session';

export const metadata = { robots: { index: false, follow: false } };

export default async function PortalLayout({ children, params }: { children: ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const t = await portalTenant(slug);
  return (
    <div className="portal" style={{ ['--brand' as string]: t.branding.primaryColor ?? '#0f766e' }}>
      <header className="portal-head">{t.branding.logoUrl ? <img src={t.branding.logoUrl} alt="" /> : null}<b>{t.name}</b><span className="muted">Patient portal</span></header>
      <main className="portal-main">{children}</main>
      <footer className="portal-foot">{t.branding.phone ? `Questions? Call ${t.branding.phone}` : ''}</footer>
    </div>
  );
}
