# Clinic Core — patient management add-on for clinic and hospital websites

One multi-tenant service that every Monk Mantra clinic or hospital site plugs into, so it never has to be rebuilt per client.
It is built from the *Clinic and Hospital Patient Management System SRS v1.0 (26 Nov 2026)*. This repository covers the
**outpatient (OPD) first production release**, plus the extra pieces a shared add-on needs. Those extra pieces are
specified in [`docs/SRS-ADDENDUM-multi-tenant.md`](docs/SRS-ADDENDUM-multi-tenant.md).

```
 clinic-a.com ─┐  <script src=".../embed.js" data-clinic="clinic-a" data-key="pk_…">     (booking widget, iframe)
 clinic-b.in  ─┼─ [clinic_booking] WordPress shortcode                                     (same widget)
 CRM / WhatsApp┘  webhooks (HMAC-signed)  ·  REST API with secret keys
                         │
                ┌────────▼─────────┐    staff app per clinic:  https://<host>/<clinic-slug>
                │  Clinic Core     │    platform console:      https://<host>/admin
                │  Next.js 16      │
                │  + worker        │
                └────────┬─────────┘
                         │  every query runs with app.tenant_id set; FORCE ROW LEVEL SECURITY
                ┌────────▼─────────┐
                │  PostgreSQL      │  (Neon or any Postgres 14+)
                └──────────────────┘
```

## What is in the box

| Area | Built | Key safeguards |
|---|---|---|
| **Multi-tenancy** | Clinic provisioning, per-clinic branding, settings, numbering, staff and keys | `tenant_id` on every row; PostgreSQL RLS with `FORCE`; a missing tenant returns zero rows |
| **Registration** (OP-001–008, 011) | UHID per clinic, temporary IDs for unidentified arrivals, date-of-birth precision, duplicate ranking, change history, linking provisional records | Idempotent registration; never fabricates a date of birth or phone number; signed and posted records keep their original identity |
| **Scheduling** (OP-013–029) | Weekly sessions, leave, closures, extra sessions, buffers, holds, booking, reschedule, cancel, no-show, check-in, impacted-booking worklist | A **PostgreSQL exclusion constraint** makes double-booking impossible, even under concurrent requests |
| **Queue** (OP-030–031) | Per-department daily tokens, triage priority, call, left-before-seen, waiting-room screen | Reception cannot change clinical priority; the screen shows tokens only |
| **Clinical** (CL-001–010, 013–020, 029–030) | Encounters, vitals, allergies, SOAP notes, prescriptions, amendments, follow-ups, chart timeline, prescription print | Signed notes and prescriptions are frozen by database triggers. A blank allergy list never prints "no known allergies". Signing requires a medical council registration number |
| **Billing** (FN-002–014, 017, 019) | Charges captured from completed visits, invoices, receipts, allocation, advances, refunds, voids, daily cash close | Integer paise only. Balanced double-entry ledger enforced at commit. Append-only ledger. Dual control on refunds |
| **Reporting** (AN, BI) | Earned, collected, outstanding, advances, by doctor and department, no-show rate, trial balance, audit trail | Metric definitions are written on the page. Reports are cut by local business date |
| **Website integration** | `embed.js` widget, WordPress plugin, public API, secret-key REST API, signed webhooks | Publishable keys are locked to the clinic's domains (CORS and `frame-ancestors`). Holds are tied to the visitor's journey secret. Rate limits apply |
| **Platform** | `/admin` console: onboard, suspend and monitor clinics | Separate admin identity and cookie scope |

**Conditional modules** — each off by default, switched on per clinic by its owner (Settings › Modules):

| Module | What it does | Key safeguards |
|---|---|---|
| **Lab & imaging** | Orders from the consultation, collection, results with PDF reports, critical-result worklist | Results are append-only versions; acknowledging an old version cannot close an amended one |
| **Patient portal** | Mobile-OTP sign-in, linked family records, released documents, booking, cancellation, records requests | A phone number alone shows nothing — staff link each chart with evidence; revocation ends sessions |
| **Online payments** | Razorpay hosted checkout for invoices | Checkout signature and webhook HMAC verified; money recorded once; card data never touches Clinic Core |
| **Video consultations** | Video services, consent, identity check, Jitsi room, actual mode | Consent and identity recorded before the consult |
| **Restricted records** | Sensitive charts visible only with a care relationship or break-glass access | Time-limited grant + audit committed together; reviewed by medical records |
| **Pharmacy** | Dispensing against prescriptions, batch/expiry stock, POs, returns, recalls, blind counts | FEFO; prescribed quantity is a ceiling; stock cannot go negative (DB check); second-person approvals |
| **Inpatient** | Bed board, admission, transfer, MAR, handover, discharge summary, discharge | Exclusion constraints on beds; one record per scheduled dose; discharge gates |
| **Data import** | CSV patients and future bookings from an old system | Dry run, duplicate review, repeatable by source id |

`docs/SRS-COVERAGE.md` maps each SRS requirement group to *built / partial / deferred*, so nothing is over-claimed.

## Quick start (local)

```bash
cp .env.example .env            # set DATABASE_URL (role must NOT be superuser/BYPASSRLS)
npm install
npm run db:migrate
npm run db:seed                 # demo clinic with every module switched on + printed logins and website key
npm run dev                     # http://localhost:3000/demo-clinic
npm run worker                  # in a second terminal: webhooks + hold cleanup
npm run admin:create -- you@monkmantra.com "Your Name"   # platform console at /admin
```

Tests run against a real Postgres (18 integration tests). They cover tenant isolation, an 8-way race for the last slot, idempotency,
the visit → bill → pay → refund flow, the ledger balance, login, and every conditional module (critical-result versions,
portal family isolation, Razorpay HMAC, break-glass, FEFO and oversell races, MAR, bed exclusivity, import repeatability):

```bash
DATABASE_URL=postgres://clinic_app:…@localhost:5432/clinic_test npm test
```

## Onboarding a new client site (≈10 minutes)

1. `/admin` → **Onboard a new clinic**: name, slug, owner email, website domains. Copy the owner's temporary password and the `pk_` key. They are shown once.
2. The owner signs in at `/<slug>/login`, then goes to **Settings** to set branding, departments, rooms, doctors (with council registration), services and prices, and weekly sessions.
3. Website: paste the snippet from **Settings › Website & integrations**, or install `wordpress-plugin/clinic-core-booking` and add `[clinic_booking]`.
4. Optional: add a webhook (CRM or WhatsApp provider) and a secret API key for server-side integrations.

## Deploy

Production runs on Vercel (project `clinic-core`, functions in `sin1`) with Neon Postgres and a private Vercel Blob
store; see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Every push to `main` is built by Vercel and goes live only after
CI, the dependency audit and a post-deploy smoke test pass — see [`docs/CI-CD.md`](docs/CI-CD.md). On other Node 22
hosts, run `npm run worker` alongside the app instead of the Vercel cron.

## Repository layout

```
db/migrations/        SQL schema: tenancy + RLS, scheduling exclusion constraints, clinical freeze triggers, ledger
src/domain/           business rules (patients, scheduling, queue, clinical, billing, reports, tenants, staff)
src/lib/              db (tenant-bound transactions), RBAC, idempotency, audit/outbox, HTTP helpers
src/app/[tenant]/     staff workspace (server components + server actions)
src/app/api/public/   website-facing API (publishable key)
src/app/api/v1/       staff / integration API (session cookie or secret key)
src/app/embed/        widget page served into the iframe
public/embed.js       one-line loader for any website
wordpress-plugin/     shortcode plugin for WordPress sites
scripts/              migrate, seed, worker, platform admin, git sync
tests/                integration tests against PostgreSQL
docs/                 SRS addendum, coverage matrix, integration and deployment guides
```

## Syncing this folder with GitHub

`npm run sync` pulls from and pushes to `origin/main`. It never force-pushes, and it stops on a conflict.
`bash scripts/install-autosync-macos.sh` runs the same sync every 5 minutes on a Mac. Add `AUTO_COMMIT=1` to also
commit local edits automatically. Details are in `docs/DEPLOYMENT.md`.
