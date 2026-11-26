import Link from 'next/link';
import { headers } from 'next/headers';
import { requireStaff } from '@/lib/session';
import { listCatalog, listSchedules } from '@/domain/catalog';
import { listIntegrations, MODULES, MODULE_LABEL } from '@/domain/tenants';
import { withTenant } from '@/lib/db';
import { gatewayActivity } from '@/domain/payments';
import { listStaff } from '@/domain/staff';
import { ROLES, ROLE_LABEL } from '@/lib/rbac';
import { EVENT_TYPES } from '@/lib/events';
import { fmtDateTime, label, money } from '@/lib/format';
import { Badge, Flash, PageHead } from '@/components/ui';
import { modulesAction, clinicSettingsAction, clinicianAction, departmentAction, integrationAction, scheduleAction, serviceAction, staffAction } from '../actions';

const TABS = ['clinic', 'modules', 'structure', 'doctors', 'services', 'schedules', 'staff', 'website'] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default async function Settings({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; edit?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'settings.manage');
  const tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? sp.tab! : 'clinic';
  const cat = await listCatalog(tenant.id);
  const b = tenant.branding; const st = tenant.settings;
  const h = await headers();
  const host = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  const dName = (id: string | null) => cat.departments.find((d) => d.id === id)?.name ?? '—';
  const cName = (id: string | null) => cat.clinicians.find((c) => c.id === id)?.display_name ?? 'All doctors';
  const lName = (id: string | null) => cat.locations.find((l) => l.id === id)?.name ?? '—';
  const editSvc = cat.services.find((s) => s.id === sp.edit);
  const editDoc = cat.clinicians.find((c) => c.id === sp.edit);

  return (
    <>
      <PageHead title="Settings" sub={`${tenant.name} · /${tenant.slug}`} />
      <nav className="tabs">{TABS.map((t) => <Link key={t} href={`?tab=${t}`} className={t === tab ? 'on' : ''}>{t === 'website' ? 'Website & integrations' : label(t)}</Link>)}</nav>
      <Flash ok={sp.ok} err={sp.err} />

      {tab === 'clinic' && (
        <form action={clinicSettingsAction.bind(null, slug)} className="card form-grid">
          <label>Clinic name<input name="name" defaultValue={tenant.name} required /></label>
          <label>Time zone (IANA)<input name="timezone" defaultValue={tenant.timezone} required /></label>
          <label>Brand colour<input type="color" name="primaryColor" defaultValue={b.primaryColor ?? '#0f766e'} /></label>
          <label>Accent colour<input type="color" name="accentColor" defaultValue={b.accentColor ?? '#f59e0b'} /></label>
          <label className="span2">Logo URL (https)<input name="logoUrl" defaultValue={b.logoUrl ?? ''} /></label>
          <label className="span2">Address (printed on documents)<input name="address" defaultValue={b.address ?? ''} /></label>
          <label>Phone<input name="phone" defaultValue={b.phone ?? ''} /></label>
          <label>Email<input name="email" defaultValue={b.email ?? ''} /></label>
          <label>Website<input name="website" defaultValue={b.website ?? ''} /></label>
          <label>Registration / licence line<input name="registrationText" defaultValue={b.registrationText ?? ''} /></label>
          <label className="span2">Document footer<input name="footerNote" defaultValue={b.footerNote ?? ''} /></label>
          <h3 className="span2">Operating rules</h3>
          <label className="check span2"><input type="checkbox" name="soloPractice" defaultChecked={st.soloPractice} /> Solo practice — allow one person to approve their own refunds and identity links (every such action is flagged in the audit trail)</label>
          <label className="check"><input type="checkbox" name="publicBookingEnabled" defaultChecked={st.publicBookingEnabled} /> Online booking enabled</label>
          <label className="check"><input type="checkbox" name="requireAllergyReviewToSign" defaultChecked={st.requireAllergyReviewToSign} /> Require allergy review before signing prescriptions</label>
          <label>Hold time for online bookings (min)<input type="number" name="holdMinutes" min={1} max={30} defaultValue={st.holdMinutes} /></label>
          <label>No-show allowed after (min past start)<input type="number" name="noShowGraceMinutes" min={0} max={240} defaultValue={st.noShowGraceMinutes} /></label>
          <label>Online booking horizon (days)<input type="number" name="bookingHorizonDays" min={1} max={365} defaultValue={st.bookingHorizonDays} /></label>
          <label>Minimum notice for online booking (min)<input type="number" name="minLeadMinutes" min={0} defaultValue={st.minLeadMinutes} /></label>
          <div className="span2"><button className="btn primary">Save</button></div>
        </form>)}

      {tab === 'modules' && <ModulesTab slug={slug} tenant={tenant} host={host} canToggle={actor.role === 'owner'} />}

      {tab === 'structure' && (
        <div className="grid2">
          <div className="card"><h2>Departments</h2>
            <table className="table small"><tbody>{cat.departments.map((d) => <tr key={d.id}><td>{d.code}</td><td>{d.name}</td></tr>)}</tbody></table>
            <form action={departmentAction.bind(null, slug)} className="inline-form"><input type="hidden" name="kind" value="department" />
              <input name="code" placeholder="Code e.g. ORTHO" required /><input name="name" placeholder="Name" required /><button className="btn small">Add</button></form></div>
          <div className="card"><h2>Rooms and counters</h2>
            <table className="table small"><tbody>{cat.locations.map((l) => <tr key={l.id}><td>{l.code}</td><td>{l.name}</td><td>{l.kind}</td><td>{dName(l.department_id)}</td></tr>)}</tbody></table>
            <form action={departmentAction.bind(null, slug)} className="inline-form"><input type="hidden" name="kind" value="location" />
              <input name="code" placeholder="Code" required /><input name="name" placeholder="Name" required />
              <select name="locKind"><option value="room">Room</option><option value="counter">Counter</option><option value="equipment">Equipment</option></select>
              <select name="departmentId"><option value="">No department</option>{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
              <button className="btn small">Add</button></form></div>
        </div>)}

      {tab === 'doctors' && (
        <>
          <div className="card"><h2>Doctors</h2>
            <p className="small muted">A doctor who signs in and prescribes needs a staff login with role Doctor (see Staff). Profiles here control what the website shows.</p>
            <table className="table small"><thead><tr><th>Name</th><th>Specialty</th><th>Registration</th><th>Departments</th><th>Website</th><th /></tr></thead>
              <tbody>{cat.clinicians.map((c) => <tr key={c.id} className={c.active ? '' : 'dim'}><td>{c.display_name}<br /><small className="muted">{c.qualification}</small></td><td>{c.specialty}</td>
                <td>{c.registration_number ? `${c.registration_number} (${c.registration_council ?? ''})` : <span className="pill warn">Missing — cannot sign</span>}</td>
                <td>{c.department_ids.map(dName).join(', ')}</td><td>{c.public_profile ? 'Shown' : 'Hidden'}</td><td><Link href={`?tab=doctors&edit=${c.id}`}>Edit</Link></td></tr>)}</tbody></table></div>
          <form action={clinicianAction.bind(null, slug)} className="card form-grid">
            <h2 className="span2">{editDoc ? `Edit ${editDoc.display_name}` : 'Add doctor profile (without login)'}</h2>
            {editDoc && <input type="hidden" name="id" value={editDoc.id} />}
            <label>Display name<input name="displayName" defaultValue={editDoc?.display_name} required /></label>
            <label>Qualification<input name="qualification" defaultValue={editDoc?.qualification ?? ''} /></label>
            <label>Specialty<input name="specialty" defaultValue={editDoc?.specialty ?? ''} /></label>
            <label>Medical council<input name="council" defaultValue={editDoc?.registration_council ?? ''} placeholder="e.g. Karnataka Medical Council" /></label>
            <label>Registration number<input name="regNo" defaultValue={editDoc?.registration_number ?? ''} /></label>
            <label>Departments<select name="departmentIds" multiple defaultValue={editDoc?.department_ids}>{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="span2">Short bio (website)<textarea name="bio" rows={2} defaultValue={editDoc?.bio ?? ''} /></label>
            <label className="check"><input type="checkbox" name="publicProfile" defaultChecked={editDoc?.public_profile ?? true} /> Show on website</label>
            {editDoc && <label>Status<select name="active" defaultValue={editDoc.active ? 'on' : 'off'}><option value="on">Active</option><option value="off">Inactive</option></select></label>}
            <div className="span2"><button className="btn primary">Save</button></div>
          </form>
        </>)}

      {tab === 'services' && (
        <>
          <div className="card"><h2>Services and tariffs</h2>
            <table className="table small"><thead><tr><th>Code</th><th>Service</th><th>Duration</th><th>Price</th><th>Doctors</th><th>Online</th><th>v</th><th /></tr></thead>
              <tbody>{cat.services.map((s) => <tr key={s.id} className={s.active ? '' : 'dim'}><td>{s.code}</td><td>{s.name}<br /><small className="muted">{dName(s.department_id)} · {s.kind}</small></td>
                <td>{s.duration_min} min{s.buffer_after_min ? ` +${s.buffer_after_min}` : ''}</td><td>{money(s.price_paise, tenant)}{s.tax_rate_bp ? ` +${s.tax_rate_bp / 100}% tax` : ''}</td>
                <td>{s.clinician_ids.map((id) => cName(id)).join(', ')}</td><td>{s.public_bookable ? 'Yes' : 'No'}</td><td>{s.version}</td><td><Link href={`?tab=services&edit=${s.id}`}>Edit</Link></td></tr>)}</tbody></table>
            <p className="small muted">Changing a price creates a new version. Existing bookings keep the price quoted when they were made.</p></div>
          <form action={serviceAction.bind(null, slug)} className="card form-grid">
            <h2 className="span2">{editSvc ? `Edit ${editSvc.name}` : 'Add service'}</h2>
            {editSvc && <input type="hidden" name="id" value={editSvc.id} />}
            <label>Department<select name="departmentId" defaultValue={editSvc?.department_id} required>{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label>Code<input name="code" defaultValue={editSvc?.code} required /></label>
            <label className="span2">Name<input name="name" defaultValue={editSvc?.name} required /></label>
            <label>Type<select name="kind" defaultValue={editSvc?.kind ?? 'consultation'}>{['consultation', 'review', 'procedure', 'investigation', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></label>
            <label>Duration (min)<input type="number" name="durationMin" min={5} max={480} defaultValue={editSvc?.duration_min ?? 15} required /></label>
            <label>Buffer before (min)<input type="number" name="bufferBeforeMin" min={0} defaultValue={editSvc?.buffer_before_min ?? 0} /></label>
            <label>Buffer after (min)<input type="number" name="bufferAfterMin" min={0} defaultValue={editSvc?.buffer_after_min ?? 0} /></label>
            <label>Price ({tenant.currency})<input name="price" inputMode="decimal" defaultValue={editSvc ? (editSvc.price_paise / 100).toFixed(2) : ''} required /></label>
            <label>Tax rate %<input name="taxRate" inputMode="decimal" defaultValue={editSvc ? editSvc.tax_rate_bp / 100 : 0} /></label>
            <label>Free follow-up within (days)<input type="number" name="followUpFreeDays" min={0} defaultValue={editSvc?.follow_up_free_days ?? 0} /></label>
            <label>Eligible doctors<select name="clinicianIds" multiple required defaultValue={editSvc?.clinician_ids}>{cat.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
            <label className="span2">Patient instructions (shown after booking)<textarea name="instructions" rows={2} defaultValue={editSvc?.patient_instructions ?? ''} /></label>
            <label className="check"><input type="checkbox" name="publicBookable" defaultChecked={editSvc?.public_bookable ?? true} /> Bookable online</label>
            <label>Mode<select name="modality" defaultValue={editSvc?.modality ?? 'in_person'}><option value="in_person">In person</option><option value="video">Video consultation</option></select></label>
            {editSvc && <label>Status<select name="active" defaultValue={editSvc.active ? 'on' : 'off'}><option value="on">Active</option><option value="off">Retired</option></select></label>}
            <p className="span2 small muted">Most Indian healthcare services are GST-exempt; confirm tax treatment with your accountant before setting a rate.</p>
            <div className="span2"><button className="btn primary">Save service</button></div>
          </form>
        </>)}

      {tab === 'schedules' && <Schedules slug={slug} tenantId={tenant.id} tz={tenant.timezone} cName={cName} lName={lName} cat={cat} locale={tenant.locale} />}

      {tab === 'staff' && <StaffTab slug={slug} actor={actor} cat={cat} required={tenant.settings.twoFactorRoles} />}

      {tab === 'website' && <Website slug={slug} tenantId={tenant.id} host={host} />}
    </>
  );
}

async function Schedules({ slug, tenantId, tz, cName, lName, cat, locale }: { slug: string; tenantId: string; tz: string; locale: string; cName: (id: string | null) => string; lName: (id: string | null) => string; cat: Awaited<ReturnType<typeof listCatalog>> }) {
  const s = await listSchedules(tenantId);
  const t = { timezone: tz, locale };
  return (
    <>
      <div className="card"><h2>Weekly sessions</h2>
        <table className="table small"><thead><tr><th>Doctor</th><th>Day</th><th>Time</th><th>Room</th><th>Slot grid</th><th>From</th><th /></tr></thead>
          <tbody>{s.templates.map((x) => <tr key={x.id}><td>{cName(x.clinician_id)}</td><td>{DAYS[x.weekday]}</td><td>{x.start_time.slice(0, 5)}–{x.end_time.slice(0, 5)}</td><td>{lName(x.location_id)}</td><td>{x.slot_step_min} min</td><td>{x.valid_from}{x.valid_to ? ` → ${x.valid_to}` : ''}</td>
            <td><form action={scheduleAction.bind(null, slug)}><input type="hidden" name="op" value="end" /><input type="hidden" name="id" value={x.id} /><button className="btn small">End</button></form></td></tr>)}</tbody></table>
        <form action={scheduleAction.bind(null, slug)} className="inline-form wrap">
          <select name="clinicianId" required>{cat.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select>
          <select name="locationId" required>{cat.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          {DAYS.map((d, i) => <label key={d} className="check"><input type="checkbox" name="weekdays" value={i} defaultChecked={i > 0 && i < 6} />{d}</label>)}
          <input type="time" name="startTime" defaultValue="09:00" required /><input type="time" name="endTime" defaultValue="13:00" required />
          <select name="slotStepMin" defaultValue="10"><option value="5">5-min grid</option><option value="10">10-min grid</option><option value="15">15-min grid</option><option value="20">20-min grid</option><option value="30">30-min grid</option></select>
          <button className="btn small primary">Add session</button></form></div>
      <div className="card"><h2>Leave, closures and extra sessions</h2>
        <table className="table small"><tbody>{s.exceptions.map((x) => <tr key={x.id}><td><Badge v={x.kind} /></td><td>{cName(x.clinician_id)}</td><td>{fmtDateTime(x.starts_at, t)} → {fmtDateTime(x.ends_at, t)}</td><td>{x.reason}</td>
          <td><form action={scheduleAction.bind(null, slug)}><input type="hidden" name="op" value="lift" /><input type="hidden" name="id" value={x.id} /><button className="btn small">Remove</button></form></td></tr>)}</tbody></table>
        <form action={scheduleAction.bind(null, slug)} className="inline-form wrap"><input type="hidden" name="op" value="exception" />
          <select name="kind"><option value="leave">Doctor leave</option><option value="closure">Clinic closure (all doctors)</option><option value="extra">Extra session</option></select>
          <select name="clinicianId"><option value="">(closure: all doctors)</option>{cat.clinicians.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select>
          <select name="locationId"><option value="">Room (extra sessions)</option>{cat.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <input type="datetime-local" name="startsAt" required /><input type="datetime-local" name="endsAt" required /><input name="reason" placeholder="Reason" />
          <button className="btn small primary">Publish</button></form>
        <p className="small muted">Publishing leave blocks new bookings at once. Existing bookings in that window appear under Appointments › Impacted for rebooking.</p></div>
    </>
  );
}

async function StaffTab({ slug, actor, cat, required }: { slug: string; actor: Parameters<typeof listStaff>[0]; cat: Awaited<ReturnType<typeof listCatalog>>; required: string[] }) {
  const rows = await listStaff(actor);
  return (
    <>
      <form action={staffAction.bind(null, slug)} className="card"><input type="hidden" name="op" value="policy" />
        <h2>Two-factor sign-in policy</h2>
        <p className="small muted">Staff in the ticked roles must set up an authenticator app before they can use anything else. Recommended for everyone who can see patient records.</p>
        <div className="inline-form wrap">{ROLES.map((r) => <label key={r} className="check"><input type="checkbox" name="twoFactorRoles" value={r} defaultChecked={required.includes(r)} /> {ROLE_LABEL[r]}</label>)}</div>
        <button className="btn primary small">Save policy</button>
      </form>
      <div className="card"><h2>Staff accounts</h2>
        <table className="table small"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Two-factor</th><th /></tr></thead>
          <tbody>{rows.map((s) => <tr key={s.id} className={s.active ? '' : 'dim'}><td>{s.full_name}{s.clinician_id ? ' · prescriber' : ''}</td><td>{s.email}</td><td>{ROLE_LABEL[s.role]}</td>
            <td>{s.active ? (s.must_change_password ? 'Temp password' : 'Active') : 'Deactivated'}</td>
            <td>{s.two_factor ? 'On' : required.includes(s.role) ? <span className="pill warn">Required — not set up</span> : 'Off'}</td>
            <td className="row-actions">
              <form action={staffAction.bind(null, slug)}><input type="hidden" name="op" value="toggle" /><input type="hidden" name="staffId" value={s.id} /><input type="hidden" name="active" value={s.active ? '0' : '1'} /><button className="btn small">{s.active ? 'Deactivate' : 'Reactivate'}</button></form>
              {s.active && <form action={staffAction.bind(null, slug)}><input type="hidden" name="op" value="reset" /><input type="hidden" name="staffId" value={s.id} /><button className="btn small">Reset password</button></form>}
              {s.active && s.two_factor && <form action={staffAction.bind(null, slug)}><input type="hidden" name="op" value="reset2fa" /><input type="hidden" name="staffId" value={s.id} /><button className="btn small">Reset two-factor</button></form>}
            </td></tr>)}</tbody></table></div>
      <form action={staffAction.bind(null, slug)} className="card form-grid">
        <h2 className="span2">Add staff member</h2>
        <label>Full name<input name="fullName" required /></label>
        <label>Email (login)<input type="email" name="email" required /></label>
        <label>Role<select name="role">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        <label className="check"><input type="checkbox" name="isClinician" /> Practising clinician (can be booked; can sign if registration given)</label>
        <label>Qualification<input name="qualification" /></label><label>Specialty<input name="specialty" /></label>
        <label>Medical council<input name="council" /></label><label>Registration number<input name="regNo" /></label>
        <label className="span2">Departments<select name="departmentIds" multiple>{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <div className="span2"><button className="btn primary">Create account</button> <small className="muted">A one-time temporary password is shown after creation.</small></div>
      </form>
    </>
  );
}

async function Website({ slug, tenantId, host }: { slug: string; tenantId: string; host: string }) {
  const { keys, webhooks, deliveries } = await listIntegrations(tenantId);
  const pk = keys.find((k) => k.kind === 'publishable' && !k.revoked_at);
  const snippet = `<div id="clinic-booking"></div>\n<script src="${host}/embed.js" data-clinic="${slug}" data-key="YOUR_PUBLISHABLE_KEY" async></script>`;
  const wp = `[clinic_booking clinic="${slug}" key="YOUR_PUBLISHABLE_KEY" host="${host}"]`;
  return (
    <>
      <div className="card">
        <h2>Add booking to the clinic website</h2>
        <p>Paste this where the booking form should appear. Works on any site (static HTML, Next.js, Webflow, Elementor HTML widget).</p>
        <pre className="code">{snippet}</pre>
        <p><b>WordPress:</b> install the <code>clinic-core-booking</code> plugin from the repository’s <code>wordpress-plugin</code> folder, then use the shortcode:</p>
        <pre className="code">{wp}</pre>
        <p className="small muted">Replace YOUR_PUBLISHABLE_KEY with the full key (starts <code>pk_</code>) shown once when it was created{pk ? `; the current key begins ${pk.key_prefix}…` : ''}. Restrict the key to the clinic’s domain below — the widget will then refuse to load on any other site.</p>
        <p className="small">Waiting-room screen: <code>{host}/{slug}/board?key=YOUR_PUBLISHABLE_KEY</code> (shows tokens and rooms only).</p>
      </div>
      <div className="card"><h2>API keys</h2>
        <table className="table small"><thead><tr><th>Label</th><th>Type</th><th>Key</th><th>Allowed websites</th><th>Last used</th><th /></tr></thead>
          <tbody>{keys.map((k) => <tr key={k.id} className={k.revoked_at ? 'dim' : ''}><td>{k.label}</td><td>{k.kind}</td><td><code>{k.key_prefix}…</code></td>
            <td>{k.allowed_origins.length ? k.allowed_origins.join(', ') : k.kind === 'publishable' ? <span className="pill warn">Any website</span> : '—'}</td>
            <td>{k.last_used_at ? new Date(k.last_used_at).toISOString().slice(0, 16).replace('T', ' ') : 'Never'}</td>
            <td>{!k.revoked_at && <form action={integrationAction.bind(null, slug)}><input type="hidden" name="op" value="revoke" /><input type="hidden" name="id" value={k.id} /><button className="btn small danger">Revoke</button></form>}</td></tr>)}</tbody></table>
        <form action={integrationAction.bind(null, slug)} className="inline-form wrap"><input type="hidden" name="op" value="key" />
          <select name="kind"><option value="publishable">Publishable (website widget)</option><option value="secret">Secret (server-to-server API)</option></select>
          <input name="label" placeholder="Label" /><input name="origins" placeholder="https://www.clinic.com https://clinic.com" size={40} />
          <button className="btn small primary">Create key</button></form>
        <p className="small muted">Secret keys act with reception-level permissions through <code>/api/v1/{slug}/…</code> with <code>Authorization: Bearer sk_…</code>. Never put a secret key in website code.</p></div>
      <div className="card"><h2>Webhooks</h2>
        <p className="small muted">Send booking and billing events to the clinic’s CRM or WhatsApp provider. Payloads carry ids and times only (contact details only if enabled), signed with HMAC-SHA256 in the <code>X-Clinic-Signature</code> header. Delivery last 7 days: {deliveries.map((d) => `${d.status} ${d.n}`).join(', ') || 'none'}.</p>
        <table className="table small"><tbody>{webhooks.map((w) => <tr key={w.id} className={w.active ? '' : 'dim'}><td>{w.url}</td><td>{w.events.join(', ') || 'all events'}</td><td>{w.include_contact ? 'with contact' : 'ids only'}</td>
          <td>{w.active && <form action={integrationAction.bind(null, slug)}><input type="hidden" name="op" value="webhook-off" /><input type="hidden" name="id" value={w.id} /><button className="btn small">Disable</button></form>}</td></tr>)}</tbody></table>
        <form action={integrationAction.bind(null, slug)} className="inline-form wrap"><input type="hidden" name="op" value="webhook" />
          <input name="url" type="url" placeholder="https://hooks.example.com/clinic" required size={40} pattern="https://.*" />
          <select name="events" multiple size={4}>{EVENT_TYPES.map((e) => <option key={e} value={e}>{e}</option>)}</select>
          <label className="check"><input type="checkbox" name="includeContact" /> Include patient name and phone (needed for WhatsApp/SMS reminders)</label>
          <button className="btn small primary">Add webhook</button></form></div>
    </>
  );
}

const MODULE_NOTE: Record<string, string> = {
  labs: 'Order tests, record and amend results, critical-result acknowledgement.',
  portal: 'Patients sign in with a mobile OTP; staff link each chart after checking identity.',
  payments: 'Patients pay invoices online through Razorpay hosted checkout.',
  telemedicine: 'Video consultations with recorded consent and identity checks.',
  emergencyAccess: 'Mark sensitive charts restricted; break-glass access is time-limited and reviewed.',
  pharmacy: 'Licensed dispensing, batch and expiry stock, purchase orders, recalls, counts. Needs pharmacist sign-off.',
  inpatient: 'Beds, admissions, transfers, medication administration, discharge. Needs nursing and medical sign-off.',
  import: 'Bring patients and future bookings from an old system with a dry run first.',
};

async function ModulesTab({ slug, tenant, host, canToggle }: { slug: string; tenant: Awaited<ReturnType<typeof requireStaff>>['tenant']; host: string; canToggle: boolean }) {
  const st = tenant.settings;
  const secrets = await withTenant(tenant.id, (tx) => tx.many<{ name: string; hint: string | null; updated_at: Date }>(`SELECT name, hint, updated_at FROM tenant_secret ORDER BY name`));
  const has = (n: string) => secrets.find((x) => x.name === n);
  const gw = st.modules.payments ? await gatewayActivity(tenant.id) : null;
  return (
    <>
      <form action={modulesAction.bind(null, slug)} className="card">
        <h2>Modules</h2>
        <p className="small muted">Each module stays off until you switch it on. Only the clinic owner can change these. Switching a module off hides it; data is kept.</p>
        <table className="table"><tbody>{MODULES.map((m) => (
          <tr key={m}><td><label className="check"><input type="checkbox" name={`m_${m}`} defaultChecked={st.modules[m]} disabled={!canToggle} /> <b>{MODULE_LABEL[m]}</b></label></td><td className="small muted">{MODULE_NOTE[m]}</td></tr>))}
        </tbody></table>
        <div className="form-grid">
          <label className="check"><input type="checkbox" name="autoReleasePrescriptions" defaultChecked={st.autoReleasePrescriptions} disabled={!canToggle} /> Release signed prescriptions to the portal automatically</label>
          <label>Records request response time (days) — confirm the legal timeline<input type="number" name="recordsRequestDays" min={1} max={90} defaultValue={st.recordsRequestDays} disabled={!canToggle} /></label>
          <label>Emergency access lasts (minutes)<input type="number" name="emergencyAccessMinutes" min={5} max={720} defaultValue={st.emergencyAccessMinutes} disabled={!canToggle} /></label>
          <label>Video server (Jitsi base URL)<input name="jitsiBaseUrl" defaultValue={st.jitsiBaseUrl} disabled={!canToggle} /></label>
        </div>
        {canToggle ? <button className="btn primary">Save modules</button> : <p className="muted small">Only the owner can change modules.</p>}
      </form>
      <form action={modulesAction.bind(null, slug)} className="card form-grid">
        <input type="hidden" name="secretsOnly" value="1" />
        <h2 className="span2">Provider credentials (stored encrypted)</h2>
        <p className="span2 small muted">Leave a field blank to keep the saved value. Values are never shown again after saving.</p>
        <label>Razorpay Key ID {has('razorpay_key_id') && <small className="muted">saved {has('razorpay_key_id')!.hint}</small>}<input name="razorpay_key_id" placeholder="rzp_live_…" autoComplete="off" /></label>
        <label>Razorpay Key Secret {has('razorpay_key_secret') && <small className="muted">saved {has('razorpay_key_secret')!.hint}</small>}<input name="razorpay_key_secret" type="password" autoComplete="off" /></label>
        <label>Razorpay webhook secret {has('razorpay_webhook_secret') && <small className="muted">saved</small>}<input name="razorpay_webhook_secret" type="password" autoComplete="off" /></label>
        <label>Razorpay webhook URL (paste in Razorpay dashboard, event payment.captured)<input readOnly value={`${host}/api/webhooks/razorpay/${slug}`} /></label>
        <label>MSG91 auth key {has('msg91_authkey') && <small className="muted">saved {has('msg91_authkey')!.hint}</small>}<input name="msg91_authkey" type="password" autoComplete="off" /></label>
        <label>MSG91 OTP template ID (DLT-approved, variable “otp”) {has('msg91_otp_template_id') && <small className="muted">saved</small>}<input name="msg91_otp_template_id" autoComplete="off" /></label>
        <p className="span2 small muted">Without Razorpay keys, online payment runs in sandbox mode on test servers and is disabled in production. Without MSG91, OTPs are only written to the server log on test servers.</p>
        <div className="span2"><button className="btn primary">Save credentials</button></div>
      </form>
      {gw && (
        <div className="card"><h2>Online payment activity</h2>
          <table className="table small"><thead><tr><th>When</th><th>Patient</th><th>Order</th><th>Amount</th><th>Status</th><th>Payment</th></tr></thead>
            <tbody>{gw.orders.map((o) => <tr key={o.id}><td>{new Date(o.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td><td>{o.full_name}</td><td><code>{o.provider_order_id}</code></td><td>{money(o.amount_paise, tenant)}</td><td><Badge v={o.status} /></td><td>{o.provider_payment_id}</td></tr>)}</tbody></table>
          <h3>Webhook deliveries</h3>
          <table className="table small"><tbody>{gw.events.map((e, i) => <tr key={i}><td>{new Date(e.received_at).toISOString().slice(0, 16).replace('T', ' ')}</td><td>{e.event_type}</td><td>{e.signature_ok ? 'signature ok' : <span className="pill danger">bad signature</span>}</td><td>{e.outcome}</td></tr>)}</tbody></table>
        </div>)}
    </>
  );
}
