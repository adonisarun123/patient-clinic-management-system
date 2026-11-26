# SRS coverage — what this build does and does not do

Legend: ✅ built and exercised by tests or the UI walkthrough · 🟡 partly built (the gap is stated) · ⏸ deferred (conditional module or later release)

| SRS group | Status | Notes |
|---|---|---|
| CFG-001 Operator and facility setup | ✅ | Per-tenant name, zone, currency, branding, document identity |
| CFG-002 Departments, rooms, staff, credentials | 🟡 | Credential **validity dates** and privilege expiry are not modelled yet; deactivation revokes sessions immediately |
| CFG-003 Services and tariffs | ✅ | Versioned. A booking keeps its service version and quoted price |
| CFG-004 Versioned templates | 🟡 | Print layouts are fixed in code and take per-tenant branding; there is no template editor or template versioning yet |
| CFG-005 Approvers and thresholds | 🟡 | Dual control on refunds and identity links (solo-mode exception). No configurable money thresholds or delegates yet |
| CFG-006 Terminology and interactions | ⏸ | Free-text diagnoses. Allergy check is a name match only, **not a drug-interaction database** |
| CFG-007 Printers, exports, quotas | 🟡 | Browser print with A4 CSS. No accounting export file yet |
| CFG-008 Change history | 🟡 | Audit trail for every settings change. No overlapping-effective-date versioning for tariffs |
| OP-001–008 Registration | ✅ | Idempotent UHID, precision-preserving DOB, unknown vs declined, temporary identities, change history with reason |
| OP-009–010 Representatives and portal | ⏸ | Needs the OTP portal (SMS provider and DLT registration) |
| OP-011 Duplicate merge | 🟡 | "Link provisional/temporary into existing chart" with dual control. A general merge of two **active** charts, and **undo** (OP-012), are not built |
| OP-013–021 Availability and capacity | ✅ | Group sessions (OP-015 seat limits) not built |
| OP-022–026 Booking changes, leave | ✅ | Leave produces an impacted-bookings worklist rather than one task row per booking |
| OP-027 Repeating series | ⏸ | |
| OP-028 Waitlist | ⏸ | |
| OP-029–031 States, queue, worklists | ✅ | |
| OP-032 Messaging | 🟡 | Signed webhooks hand events to the clinic's SMS/WhatsApp provider. No built-in SMS sender |
| CL-001–010 Encounter and chart | ✅ | Specialty templates (CL-005) and offline drafts (CL-006) not built |
| CL-011–012 Historical documents, wrong-patient fix | ⏸ | No file uploads yet |
| CL-013–020 Medicines and prescriptions | 🟡 | Signing, credential check, allergy gate, immutable snapshot and amendment are built. No formulary (CL-014). No weight-based dosing support (CL-017) |
| CL-021–023 Licensed pharmacy | ⏸ | Conditional module |
| CL-024–028 Orders and results | ⏸ | Not in this build. Next priority if clinics order labs |
| CL-029–030 Follow-up and recall | ✅ | |
| CL-031 Referrals | ⏸ | |
| CL-032–034 Portal and records requests | ⏸ | |
| CL-035 Telemedicine | ⏸ | |
| CL-036–039 Inpatient | ⏸ | Conditional module |
| FN-002–009 Tariff, charge, invoice | ✅ | GST line tax supported (rate per service). Package and estimate documents not built |
| FN-010–014 Tender, deposits, refunds | ✅ | Concessions and bad-debt write-off (FN-013) not built |
| FN-015–016 Split payer and claims | ⏸ | |
| FN-017 Subledger integrity | ✅ | Deferred balance trigger, append-only journal, unique source key |
| FN-018 Gateway reconciliation | ⏸ | No online gateway yet. UPI and card are recorded with an external reference |
| FN-019 Desk close | 🟡 | Daily close report by tender. No drawer-count entry or variance workflow |
| FN-020–022 Period close, tax evidence | ⏸ | |
| BI / AN Reporting | 🟡 | Core finance and activity metrics with written definitions. No as-of snapshots or exports |
| HS-001–016 Inpatient and pharmacy ops | ⏸ | Conditional modules |
| API-001–007 | ✅ | Idempotency keys, version preconditions, stable error codes, outbox. Cursor pagination is not built (lists are bounded instead) |
| DM-001–009 | ✅ | UTC instants, local wall-clock schedules, integer paise, precision states, exclusion constraints |
| SE-001–005, 008, 013–014 | ✅ | Server-side permission checks, RBAC, session expiry and revocation, audit of chart views and searches |
| SE-006–007 Emergency (break-glass) access | ⏸ | |
| SE-010 Uploads | ⏸ | |
| SE-015 Alerting | ⏸ | Hosting-level monitoring is still needed |
| NF-001–010 Performance, accessibility, DR | 🟡 | Semantic HTML and keyboard-usable forms, but **no WCAG audit has been done**. Backups and point-in-time recovery depend on the hosting provider (Neon supports point-in-time restore — confirm the plan tier) |
| PR-001–021 Privacy | 🟡 | Booking consent is recorded, collection is minimal and nothing clinical goes outbound. Purpose inventory, retention engine and rights-request workflow are not built. See addendum A5 |
| MG-001–014 Migration | ⏸ | No import tooling yet |
