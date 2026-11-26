# Deployment and operations

## Production topology
- **Web**: Next.js 16 on Vercel, or any Node ≥ 20 host (`npm run build && npm start`).
- **Database**: PostgreSQL 14+. Neon in `aws-ap-south-1` (Mumbai) keeps data in India. Before a clinic goes live, confirm the contracted region, point-in-time-restore window and sub-processors (SRS ch. 6).
- **Worker**: `npm run worker` as a long-running process (Railway, Fly, Render or a small VM), **or** `npm run worker -- --once` on a 1-minute cron. It delivers webhooks and cleans up expired holds. Booking correctness does not depend on it running.

## First deployment
1. Create the database. On Neon the default owner role is fine (it is not a superuser and has no `BYPASSRLS`). On self-managed Postgres, create the `pgcrypto` and `btree_gist` extensions as a superuser first.
2. Set `DATABASE_URL` (with `sslmode=require`) and `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`) in the host's environment. Never set `ALLOW_DEV_SMS` or `ALLOW_SANDBOX_PAYMENTS` in production.
3. `npm run db:migrate`. Migrations are checksummed: an edited migration is refused, so add a new file instead.
4. `npm run admin:create -- you@monkmantra.com "Name"` → sign in at `/admin` and onboard clinics.

## Security checklist before the first real patient
- [ ] Database role is not superuser or `BYPASSRLS` (`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;`)
- [ ] HTTPS only. Cookies are `Secure` when `NODE_ENV=production`
- [ ] Each publishable key is restricted to the clinic's domains
- [ ] Backups and point-in-time restore confirmed and a restore rehearsed (SRS NF-007/009)
- [ ] Rate limiting: the built-in limiter is per instance. With more than one instance, back it with a shared store (e.g. Upstash Redis)
- [ ] Data-processing agreement signed with the clinic (see SRS addendum A5)
- [ ] `APP_ENCRYPTION_KEY` set and backed up separately from the database
- [ ] Per module switched on: activation tests passed with the clinic (pharmacist for pharmacy, nursing lead for inpatient)
- [ ] Payments: Razorpay keys + webhook secret entered; webhook URL `https://<host>/api/webhooks/razorpay/<slug>` subscribed to `payment.captured`; one live ₹1 test refunded
- [ ] Portal: MSG91 auth key + DLT OTP template entered; OTP received on a real phone
- [ ] Video: Jitsi base URL points to a server the clinic controls or has contracted
- [ ] File uploads: add antivirus scanning before accepting patient-uploaded files (not built)

## Two-way GitHub sync for the local folder
- `npm run sync` — pull (rebase, autostash) from `origin/main`, then push local commits. Never force-pushes. On a conflict it aborts cleanly and exits non-zero.
- `bash scripts/install-autosync-macos.sh` — installs a LaunchAgent that runs the sync every 5 minutes (`SYNC_MINUTES=…` to change). Add `AUTO_COMMIT=1` to also commit local edits automatically. Remove it with `--uninstall`. Log: `~/Library/Logs/clinic-core-gitsync.log`.
- GitHub → local is covered by the pull; local → GitHub by the push. Edits made directly on GitHub arrive at the next run.
