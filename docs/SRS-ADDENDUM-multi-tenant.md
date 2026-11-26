# SRS Addendum A — Multi-tenant add-on delivery

**Applies to:** Clinic and Hospital Patient Management System SRS v1.0 (26 Nov 2026)
**Status:** Proposed. These are design decisions implemented in this repository. They need sign-off from the product, privacy and engineering owners.

The base SRS specifies a system for **one hospital operator**: the `hospital` table is a singleton, and there is one UHID
registry and one document-numbering namespace. Monk Mantra wants a single add-on that serves every clinic and hospital
website it builds. This addendum lists what the base SRS does not cover, and the rule adopted for each gap.

## A1. Tenancy model
| ID | Requirement | Implementation |
|---|---|---|
| MT-001 | Each client organisation is a **tenant**. Every clinical, financial, scheduling and audit row carries `tenant_id`. | `tenant` table; `tenant_id NOT NULL` on 40 tables, RLS forced on 39 (the exception, `tenant_api_key`, is a routing table looked up only by key hash) |
| MT-002 | Isolation is enforced **by the database**, not only by application code. | `ENABLE` + `FORCE ROW LEVEL SECURITY` with `tenant_id = app_tenant_id()`. Every request runs in a transaction with `SET LOCAL app.tenant_id` |
| MT-003 | With no tenant bound, a query returns nothing (fail closed). Writes tagged for another tenant are rejected. | `USING` + `WITH CHECK` policies; covered by tests |
| MT-004 | UHID, booking, invoice, receipt, prescription and queue numbers are gapless **per tenant**. Each tenant sets its own UHID prefix. | `doc_sequence(tenant_id, scope)` and `next_doc_number()` |
| MT-005 | The database role used by the app must not be superuser or `BYPASSRLS`. | Documented in `.env.example`; CI creates a non-superuser role |
| MT-006 | A tenant can be suspended (staff and website access stop at once; data is retained) or offboarded. | `tenant.status`; platform console |
| MT-007 | Each tenant's configuration (time zone, currency, branding, booking rules) is independent. | `tenant.settings`, `tenant.branding` |

## A2. Website integration contract
| ID | Requirement | Implementation |
|---|---|---|
| WI-001 | A clinic website embeds booking with one snippet and no build step. Any CMS works. | `public/embed.js` → iframe → `/embed/<slug>` |
| WI-002 | WordPress sites get a plugin with a shortcode and a settings page. | `wordpress-plugin/clinic-core-booking` |
| WI-003 | Website calls use a **publishable** key that can only read the catalogue and availability and make bookings. The key never grants chart access. | `tenant_api_key.kind = 'publishable'` |
| WI-004 | Publishable keys are restricted to listed origins (CORS and CSP `frame-ancestors`). | `allowed_origins` |
| WI-005 | Server-to-server integrations use **secret** keys with reception-level permissions. Secret keys never appear in a browser. | `Authorization: Bearer sk_…` |
| WI-006 | A web booking creates a **provisional** registration. It never reveals, searches or attaches to an existing chart (OP-005 public-search rule). Reception confirms identity at arrival. | `patient.status = 'provisional'`, identity-review worklist, "link into existing chart" |
| WI-007 | A hold belongs to the visitor's journey secret. Another visitor can neither confirm nor release it. | `booking_hold.actor_ref = sha256(journey)` |
| WI-008 | Outbound events go to tenant-configured HTTPS webhooks, signed with HMAC-SHA256. By default they carry only ids and times; contact details require an explicit opt-in per endpoint. No clinical content is ever sent. | `webhook_endpoint.include_contact`; worker re-checks contact permission at send time |
| WI-009 | The host page can react to a confirmed booking (analytics or a thank-you page) without receiving patient data. | `window` event `clinic-core:booked` with booking ref and time only |

## A3. Practice size
| ID | Requirement | Implementation |
|---|---|---|
| PS-001 | **Solo-practice mode.** A single doctor can approve their own refunds and identity links where the SRS requires a second person. Each such action is flagged (`self_approved`) and audited. | `settings.soloPractice` |
| PS-002 | One doctor can act as owner, clinician and cashier through role permissions without separate logins. | Owner role holds all permissions |

## A4. Platform operations (Monk Mantra)
| ID | Requirement | Implementation |
|---|---|---|
| PO-001 | A platform console that is separate from clinic logins: onboard, suspend and view usage. | `/admin`, `platform_admin`, separate cookie scope |
| PO-002 | Platform staff cannot read clinical content through the console. Usage counts are aggregates only. | Console queries only counts |
| PO-003 | Onboarding creates the ledger, the owner login (must change password) and a website key in one step. | `provisionTenant()` |

## A5. Legal roles under DPDP — needs counsel review
In the shared model, each clinic is most likely the **Data Fiduciary** and Monk Mantra the **Data Processor**. This
reading is not certain and should be confirmed with counsel before the first client goes live. Before go-live, put in place:
1. A data-processing agreement with each clinic: purpose limitation, sub-processors (hosting, database, messaging), breach-notice timelines and deletion on termination.
2. Per-tenant export on request, and deletion or return of data at offboarding. Deletion must respect the record-retention holds in SRS chapter 9.
3. A hosting region and sub-processor list that each clinic can be shown. SRS chapter 6 already notes this for Neon.

## A6. Release scope of this build
This build implements the SRS **first production release for OPD**. The conditional modules (inpatient/ADT, licensed
pharmacy stock, laboratory and imaging interfaces, online payment gateway, OTP patient portal, telemedicine, data
migration tooling) stay inactive until each has its own activation tests, as SRS chapter 1 requires.
See `SRS-COVERAGE.md`.
