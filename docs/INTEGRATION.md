# Integration guide

## 1. Booking widget (any website)
```html
<div id="clinic-booking"></div>
<script src="https://CLINIC-CORE-HOST/embed.js" data-clinic="SLUG" data-key="pk_…" async></script>
```
- Optional attributes: `data-target="#selector"` and `data-min-height="600"`.
- The widget runs in an iframe served by Clinic Core. The host page gets no patient data.
- Listen for confirmed bookings (booking ref, start time and service name only):
```js
window.addEventListener('clinic-core:booked', (e) => gtag?.('event', 'appointment_booked', { ref: e.detail.bookingRef }));
```
- Add the site's exact origin (e.g. `https://www.clinic.com`) to the key's **allowed websites**. Otherwise any site could frame the widget.

## 2. WordPress
Zip `wordpress-plugin/clinic-core-booking`, upload and activate it, fill in **Settings → Clinic Core Booking**, then place `[clinic_booking]` on a page.
Attributes override the saved settings: `[clinic_booking clinic="slug" key="pk_…" host="https://…" min_height="600"]`.

## 3. Public API (publishable key) — for custom booking UIs
Send `X-Clinic-Key: pk_…` and, for holds and bookings, `X-Journey: <random ≥20 chars per visitor session>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/v1/{slug}/config` | Clinic, departments, bookable services, doctors |
| GET | `/api/public/v1/{slug}/availability?serviceId=&clinicianId=&from=YYYY-MM-DD&days=1..14` | Free start times (ISO, with offset) |
| POST | `/api/public/v1/{slug}/holds` `{serviceId, clinicianId, start}` | Reserve for `holdMinutes` (default 5) |
| DELETE | `/api/public/v1/{slug}/holds?holdId=` | Release a hold |
| POST | `/api/public/v1/{slug}/bookings` `{holdId, consent:true, patient:{fullName, phone, email?, birthDate?, sex?}, notes?}` | Confirm. Send `Idempotency-Key` |
| GET | `/api/public/v1/{slug}/board` | Waiting-room tokens |

## 4. Staff / integration API (secret key or staff session)
`Authorization: Bearer sk_…` (reception-level permissions). Send `Idempotency-Key` on every write.

| Method | Path |
|---|---|
| GET/POST | `/api/v1/{slug}/patients` (`?q=` search; POST register) |
| GET | `/api/v1/{slug}/patients/{id}` · `/patients/{id}/timeline` (clinical scope: staff sessions only) |
| GET | `/api/v1/{slug}/availability` |
| GET/POST | `/api/v1/{slug}/appointments` (`?date=`; POST `{serviceId, clinicianId, start, patientId}`) |
| POST | `/api/v1/{slug}/appointments/{id}/cancel\|reschedule\|check-in\|no-show` |
| GET | `/api/v1/{slug}/queue` |
| POST | `/api/v1/{slug}/invoices` `{patientId, chargeIds[]}` · `/payments` `{patientId, method, amountPaise, reference}` |
| GET | `/api/v1/{slug}/reports/summary?from=&to=` |

Errors always have the shape `{ "error": { "code", "message", "retry"?, "details"?, "correlationId" } }`.
Codes: `VALIDATION 422`, `UNAUTHENTICATED 401`, `FORBIDDEN 403`, `NOT_FOUND 404`, `CONFLICT/SLOT_TAKEN/HOLD_EXPIRED/IDEMPOTENCY_MISMATCH 409`, `VERSION_CONFLICT 412`, `RATE_LIMITED 429`.

## 5. Webhooks
Events: `patient.registered, appointment.booked, appointment.rescheduled, appointment.cancelled, appointment.checked_in,
appointment.no_show, appointment.completed, prescription.signed, invoice.posted, invoice.voided, payment.received,
refund.paid, follow_up.created, result.critical, result.final, document.released, records_request.received,
patient.admitted, patient.discharged, dispense.completed, lot.recalled, emergency_access.granted`.

`result.critical` is meant for paging: route it to the on-duty doctor's WhatsApp/SMS through your provider.

```json
{ "id": "evt uuid", "type": "appointment.booked", "clinic": "slug", "occurredAt": "…",
  "object": { "kind": "appointment", "id": "…", "version": 1 },
  "data": { "bookingRef": "BK000123", "start": "…", "end": "…", "clinicianId": "…", "serviceId": "…", "source": "widget" },
  "contact": { "name": "…", "phone": "+91…", "language": "…" } }
```
`contact` appears only when the endpoint has "include patient name and phone" turned on. Verify the signature like this:
```js
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const ok = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex') === v1 && Date.now()/1000 - t < 300;
```
Failed deliveries retry with exponential backoff (up to 8 attempts). Deliveries are at-least-once, so deduplicate on `id`.

## 6. Patient portal and online payments
- Portal URL per clinic: `https://<host>/p/<slug>` (link it from the clinic website's menu as "Patient login").
- Razorpay webhook: `POST https://<host>/api/webhooks/razorpay/<slug>`, event `payment.captured`, signed with the webhook secret saved in Settings › Modules.
