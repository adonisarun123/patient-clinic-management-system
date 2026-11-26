# CI/CD

```
push / PR ──► GitHub Actions CI ─────────────┐
                 verify: migration rules,    │
                   fresh + upgrade migrations │  required
                   on Postgres 18, typecheck, │  Deployment
                   19 integration tests, build│  Checks
                 audit: npm audit (prod deps) │
                                              ▼
push to main ──► Vercel production build ──► held ──► promoted to production domain
                 (runs db:migrate first)       ▲        only when all 3 checks pass
                                               │
       vercel.deployment.ready ──► Post-deploy smoke (against that exact deployment)
```

## What runs where
| Stage | Where | What it proves |
|---|---|---|
| `CI / verify` | GitHub Actions, every push + PR | Shipped migrations untouched; new ones additive; migrations apply to an empty DB **and** on top of the previous release; re-running is a no-op; typecheck; all integration tests against real Postgres 18 with a non-superuser role (so row-level security is exercised); production build |
| `CI / audit` | GitHub Actions | No high/critical advisories in production dependencies |
| Production build | Vercel (`vercel.json`) | Applies pending migrations as `clinic_app`, then `next build` |
| `Post-deploy smoke` | GitHub Actions on `vercel.deployment.ready` | The new deployment serves pages, reaches the database, refuses unauthenticated cron and upload calls, sends security headers |
| Promotion | Vercel Deployment Checks | The production domain moves to the new deployment only when `verify`, `audit` and `smoke` all pass. Otherwise the previous deployment keeps serving |
| Previews | Vercel, every branch/PR | Built and protected by Vercel Authentication. They have no database configured, so they show the build only |
| Dependencies | Dependabot | Weekly grouped npm PRs (Monday 04:00 IST), monthly Actions PRs — each goes through CI |

## The one rule to respect: migrations must be backward-compatible
Vercel applies migrations during the production build, **before** the checks decide whether the new code goes live.
If a later check fails, the database has the new schema while the old code keeps serving. So every migration must
work with the code that is currently live:

- Add tables, columns (nullable or with a default), indexes, constraints that existing data and code already satisfy.
- To remove or rename something, ship in two releases: first stop using it in code, then drop it in a later
  migration marked `-- allow-destructive: <reason>`.
- Never edit or delete a migration that has shipped; add a new one. CI and the migrator both refuse.

`scripts/check-migrations.ts` enforces this in CI.

## Rolling back
Vercel › clinic-core › Deployments › pick the last good production deployment › **Instant Rollback**. Code rolls
back immediately; the database does not (by design, migrations are additive, so the older code still works).

## Bypassing a failed check (emergencies only)
Deployment page › **Force Promote**. Record why in the commit or the incident note.

## Running locally
```
npx tsx scripts/check-migrations.ts origin/main   # migration rules vs. main
node scripts/smoke.mjs https://<deployment-url>   # smoke-test any deployment
```

## Where it is configured
- GitHub: `.github/workflows/ci.yml` (jobs `verify`, `audit`), `.github/workflows/post-deploy.yml` (job `smoke`,
  status `Vercel - clinic-core: smoke`), `.github/dependabot.yml`.
- Vercel › clinic-core › Settings › Git: `repository_dispatch` events **on** (needed for the smoke test).
- Vercel › clinic-core › Settings › Build and Deployment › Deployment Checks: `verify`, `audit` and
  `Vercel - clinic-core: smoke`, all for Production.
