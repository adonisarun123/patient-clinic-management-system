import { listCatalog } from '@/domain/catalog';
import { ok, preflight, publicContext, route } from '@/lib/http';

/** Everything a website needs to render the booking widget. Contains no patient data. */
export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, cors } = await publicContext(req, slug);
  const c = await listCatalog(tenant.id, { publicOnly: true });
  const deptIds = new Set(c.services.map((s) => s.department_id));
  return ok({
    clinic: { slug: tenant.slug, name: tenant.name, timezone: tenant.timezone, currency: tenant.currency, locale: tenant.locale,
      branding: tenant.branding, bookingEnabled: tenant.settings.publicBookingEnabled, holdMinutes: tenant.settings.holdMinutes },
    departments: c.departments.filter((d) => d.active && deptIds.has(d.id)).map((d) => ({ id: d.id, name: d.name })),
    services: c.services.map((s) => ({ id: s.id, departmentId: s.department_id, name: s.name, kind: s.kind, durationMin: s.duration_min,
      pricePaise: Number(s.price_paise), instructions: s.patient_instructions, clinicianIds: s.clinician_ids })),
    clinicians: c.clinicians.map((d) => ({ id: d.id, name: d.display_name, qualification: d.qualification, specialty: d.specialty, bio: d.bio, departmentIds: d.department_ids })),
  }, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
});
export const OPTIONS = (req: Request, ctx: { params: Promise<{ tenant: string }> }) => ctx.params.then((p) => preflight(req, p.tenant));
