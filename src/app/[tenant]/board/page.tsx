import { getTenantBySlug } from '@/domain/tenants';
import { Board } from '@/components/Board';

export const metadata = { robots: { index: false } };

/** Waiting-room display. Needs the clinic's publishable key in ?key=. Shows tokens and rooms only. */
export default async function BoardPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ key?: string; departmentId?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const t = await getTenantBySlug(slug);
  return <Board slug={slug} name={t.name} color={t.branding.primaryColor ?? '#0f766e'} keyParam={sp.key ?? ''} departmentId={sp.departmentId} />;
}
