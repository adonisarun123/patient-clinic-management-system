# SRS coverage — what this build does and does not do

_Updated for the third release (roadmap items 3–10: two-factor sign-in, front-desk extensions, finance close, insurance, prescribing safety, records tools, day care and theatre, ABHA)._

Legend: ✅ built and exercised by tests or the UI walkthrough · 🟡 partly built (the gap is stated) · ⏸ deferred (conditional module or later release)

| SRS group | Status | Notes |
|---|---|---|
| CFG-001 Operator and facility setup | ✅ | Per-tenant name, zone, currency, branding, document identity |
| CFG-002 Departments, rooms, staff, credentials | 🟡 | Credential **validity dates** and privilege expiry are not modelled yet; deactivation revokes sessions immediately |
| CFG-003 Services and tariffs | ✅ | Versioned. A booking keeps its service version and quoted price |
| CFG-004 Versioned templates | 🟡 | Versioned print layouts for prescriptions, receipts and referral letters (paper, pre-printed stationery space, header, accent, footer, signature line); immutable versions with restore; a signed prescription keeps the layout it was signed with. Structured fields only — no free HTML editor (by design). Clinical note templates are not versioned |
| CFG-005 Approvers and thresholds | 🟡 | Dual control on refunds and identity links (solo-mode exception). No configurable money thresholds or delegates yet |
| CFG-006 Terminology and interactions | 🟡 | Per-clinic formulary and drug-interaction rules (generic or class level) with CSV import. **Ships empty — no interaction data is bundled**; the clinic loads it from a licensed source or its pharmacy committee, and every entry records its source. Diagnoses remain free text (no ICD/SNOMED coding) |
| CFG-007 Printers, exports, quotas | ✅ | Browser print with A4/A5 layouts. Journal export as CSV and Tally XML with ledger mapping (import into a Tally test company first) |
| CFG-008 Change history | ✅ | Audit trail for every settings change. Effective-dated price lists, with overlapping dates refused by a database constraint |
| OP-001–008 Registration | ✅ | Idempotent UHID, precision-preserving DOB, unknown vs declined, temporary identities, change history with reason |
| OP-009–010 Representatives and portal | ✅ | OTP proves the phone only; staff create each link (relation, permissions, evidence, expiry). Family members on one phone see only their own linked charts. Revocation ends sessions at once. Live SMS needs MSG91 and DLT registration |
| OP-011–012 Duplicate merge and undo | ✅ | Two established charts: one person requests, a second approves (solo-mode exception, audited). Open work moves; signed records stay on the original and are read through the link. Every merge — including provisional links — can be undone; items that progressed since stay put and are listed for review |
| OP-013–021 Availability and capacity | ✅ | Group sessions (OP-015 seat limits) not built |
| OP-022–026 Booking changes, leave | ✅ | Leave produces an impacted-bookings worklist rather than one task row per booking |
| OP-027 Repeating series | ✅ | Courses of visits booked together, numbered, cancellable as a whole |
| OP-028 Waitlist | ✅ | Freed slots are matched to waiting patients; staff book or decline the offer |
| OP-029–031 States, queue, worklists | ✅ | |
| OP-032 Messaging | 🟡 | Signed webhooks hand events to the clinic's SMS/WhatsApp provider. No built-in SMS sender |
| CL-001–010 Encounter and chart | ✅ | Specialty templates (CL-005) and offline drafts (CL-006) not built |
| CL-011–012 Historical documents, wrong-patient fix | ✅ | Uploads with category, date, source, checksum and file-signature checks; “entered in error”. Misfiled documents move to the right chart only after a second person approves, with a trail on both charts. Results and discharge papers are corrected at source |
| CL-013–020 Medicines and prescriptions | ✅ | Signing, credential check, allergy gate (name and drug class), formulary dose limits, weight-based dosing for children, interaction checks within the prescription and against recent prescriptions and ward orders. Serious findings block signing unless the doctor records a reason; findings are frozen into the signed record. Checks are only as good as the clinic’s formulary data |
| CL-021–023 Licensed pharmacy | ✅ | Dispense only against the current signed prescription, FEFO from released unexpired lots, prescribed-quantity ceiling, restricted products pharmacist-only, schedule-H not sold without prescription. Needs pharmacist sign-off before use |
| CL-024–028 Orders and results | ✅ | Orders, collection, results (value, report text, PDF), auto flags from reference/critical limits, immutable versions, amendments with reason, version-specific acknowledgement, critical worklist + webhook. No live LIS/PACS interface (needs a partner spec) |
| CL-029–030 Follow-up and recall | ✅ | |
| CL-031 Referrals | ✅ | Outbound letters signed by the doctor; inbound referrals tracked to an appointment and closed |
| CL-032–034 Portal and records requests | ✅ | Staff release (or auto-release) documents; portal shows only released items. Records requests from desk or portal get a case number and due date. The response clock is clinic-configured — confirm the legal timeline |
| CL-035 Telemedicine | ✅ | Video services, consent (portal or recorded), identity check, initiator, actual mode, video encounter. Uses Jitsi; use a self-hosted or contracted server in production |
| CL-036–039 Inpatient | 🟡 | Admission, bed board, transfers, signed discharge summary, discharge gates (summary, active medicines, financial clearance), bed-day charges, day-care conversion. Remote authentication of reports (CL-039) not built |
| FN-002–009 Tariff, charge, invoice | ✅ | GST line tax supported (rate per service). Package and estimate documents not built |
| FN-010–014 Tender, deposits, refunds | ✅ | Concessions and bad-debt write-off (FN-013) not built |
| FN-015–016 Split payer and claims | ✅ | Payers (insurer, TPA, corporate), patient policies, pre-authorisation, claims with queries, settlement with TDS and disallowance, payer aging. The patient owes only the part not claimed |
| FN-017 Subledger integrity | ✅ | Deferred balance trigger, append-only journal, unique source key |
| FN-018 Gateway reconciliation | 🟡 | Razorpay hosted checkout; Checkout signature and webhook HMAC both verified; settles exactly once; every webhook logged. Settlement-file and bank-statement matching are not built |
| FN-019 Desk close | ✅ | Drawer open/close with denomination count; variance above the clinic’s threshold needs a second person and posts to cash over/short |
| FN-020–022 Period close, tax evidence | 🟡 | Month close locks journals (database trigger) with a trial balance; owner-only reopen. Statutory GST returns are not generated — export to the accountant |
| BI / AN Reporting | 🟡 | Core finance and activity metrics with written definitions. No as-of snapshots or exports |
| HS-001–008 Ward operations | ✅ | Bed exclusivity by database constraint, same-instant transfers, MAR with one record per scheduled dose, early-dose reason, missed-dose marking, dose changes that supersede only future doses, PRN doses, handover with acceptance |
| HS-009–013 Pharmacy stock | ✅ | Purchase orders with second-person approval, goods receipt (expired refused), returns with restock/quarantine, recalls listing affected patients, blind counts posted by a second person. Stock can never go negative (database check) |
| HS-014–016 Day-care, theatre | ✅ | Day care: same-day admissions, overdue board, conversion to inpatient. Theatre: clash prevention for room (with turnover), surgeon, anaesthetist and patient by database constraint; WHO Surgical Safety Checklist with stop rules; operation note signed by the surgeon; consumables and implants from stock with serials; theatre time and procedure fee charged. **Needs surgical and anaesthesia sign-off before use** |
| API-001–007 | ✅ | Idempotency keys, version preconditions, stable error codes, outbox. Cursor pagination is not built (lists are bounded instead) |
| DM-001–009 | ✅ | UTC instants, local wall-clock schedules, integer paise, precision states, exclusion constraints |
| SE-001–005, 008, 013–014 | ✅ | Server-side permission checks, RBAC, session expiry and revocation, audit of chart views and searches. Two-factor sign-in (authenticator app, recovery codes) per role policy; platform admin password change and two-factor |
| SE-006–007 Emergency (break-glass) access | ✅ | Restricted charts need a care relationship or a time-limited grant; grant and audit commit together; review queue shows what was opened; review ends the grant |
| SE-010 Uploads | 🟡 | Bound to patient and order; PDF/JPEG/PNG verified by signature; 10 MB cap; served as downloads with sandbox CSP. ClamAV scanning is built but **off until a scanner is hosted** (`CLAMAV_HOST`) |
| SE-015 Alerting | ⏸ | Hosting-level monitoring is still needed |
| NF-001–010 Performance, accessibility, DR | 🟡 | Semantic HTML and keyboard-usable forms, but **no WCAG audit has been done**. Backups and point-in-time recovery depend on the hosting provider (Neon supports point-in-time restore — confirm the plan tier) |
| PR-001–021 Privacy | 🟡 | Booking consent is recorded, collection is minimal and nothing clinical goes outbound. Purpose inventory, retention engine and rights-request workflow are not built. See addendum A5 |
| MG-001–014 Migration | 🟡 | CSV import of patients and future appointments: dry run, duplicate review, commit, repeatable via source-id map, legacy IDs searchable, booking overlaps rejected by constraint. Historical clinical notes, opening balances and the cutover runbook are not built |

## Integrations that are built but switched off

| Integration | What it needs | Until then |
|---|---|---|
| ABDM / ABHA | HFR registration for each clinic, NHA integrator credentials (`ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET`), sandbox testing and certification | ABHA number/address is recorded on the chart with consent and how it was checked. Verification, care-context linking and record sharing are not implemented; the gateway adapter only opens a session and its endpoint should be re-checked against NHA’s current documentation |
| Virus scanning | A ClamAV (`clamd`) service you host; TLS in front of it if it is not on a private network | Uploads are accepted without scanning, as before |
| Drug-interaction data | A licensed interaction dataset or your pharmacy committee’s list, as CSV | Interaction checks find nothing; dose, weight and allergy checks still run on formulary entries |
