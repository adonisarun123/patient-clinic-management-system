import Link from 'next/link';
import type { ReactNode } from 'react';
import { ageLabel, birthLabel, maskPhone } from '@/lib/identity';
import { randomUUID } from 'node:crypto';

export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (!ok && !err) return null;
  return <p className={`flash ${err ? 'err' : 'ok'}`} role={err ? 'alert' : 'status'}>{err ?? ok}</p>;
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub ? <p className="muted">{sub}</p> : null}</div>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}

export function Badge({ v }: { v: string }) {
  return <span className={`badge b-${v}`}>{v.replace(/_/g, ' ')}</span>;
}

/** A fresh request key per rendered form makes double-submits replay-safe (API-002). */
export function RequestKey() {
  return <input type="hidden" name="requestKey" value={randomUUID()} />;
}

type BannerPatient = { id: string; uhid: string; full_name: string; sex: string; birth_date: string | null; birth_precision: string;
  estimated_age_years: number | null; age_as_of: string | null; phone_e164: string | null; status: string; allergy_status: string };

/** Persistent patient banner: two identifiers, allergy state, and record status are always visible. */
export function PatientBanner({ p, slug, allergies }: { p: BannerPatient; slug: string; allergies?: { substance: string }[] }) {
  const allergy = p.allergy_status === 'no_known_allergies' ? <span className="pill ok">No known allergies</span>
    : p.allergy_status === 'has_allergies' ? <span className="pill danger">Allergies: {allergies?.map((a) => a.substance).join(', ') || 'recorded'}</span>
    : <span className="pill warn">Allergies not reviewed</span>;
  return (
    <div className="banner">
      <div>
        <Link href={`/${slug}/patients/${p.id}`} className="banner-name">{p.full_name}</Link>
        <span className="banner-meta">{p.uhid} · {p.sex === 'unknown' ? 'Sex unknown' : p.sex} · {ageLabel(p)} · DOB {birthLabel(p.birth_date, p.birth_precision)} · {maskPhone(p.phone_e164)}</span>
      </div>
      <div className="banner-flags">
        {p.status !== 'active' ? <span className="pill warn">{p.status === 'provisional' ? 'Identity to confirm' : p.status}</span> : null}
        {allergy}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
