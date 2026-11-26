// Role → permission map. The server checks a permission on every command (API-001).
export const ROLES = ['owner', 'admin', 'doctor', 'nurse', 'reception', 'cashier', 'records', 'pharmacist', 'lab'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'patient.read', 'patient.write', 'patient.merge',
  'schedule.read', 'schedule.book', 'schedule.override', 'schedule.configure',
  'queue.manage', 'queue.triage',
  'clinical.read', 'clinical.write', 'clinical.sign', 'vitals.write',
  'billing.read', 'billing.charge', 'billing.post', 'billing.collect', 'billing.void',
  'refund.request', 'refund.approve', 'discount.apply',
  'reports.read', 'settings.manage', 'staff.manage', 'audit.read',
  // conditional modules
  'orders.write', 'results.enter', 'results.ack', 'portal.manage', 'records.requests',
  'pharmacy.dispense', 'pharmacy.stock', 'pharmacy.approve', 'inpatient.admit', 'inpatient.nursing', 'inpatient.discharge',
  'emergency.review', 'import.run', 'telemedicine.conduct',
  'finance.close', 'claims.manage', 'formulary.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const GRANTS: Record<Role, Set<Permission>> = {
  owner: ALL,
  admin: new Set(PERMISSIONS.filter((p) => !['clinical.sign', 'clinical.write', 'orders.write', 'results.ack', 'telemedicine.conduct',
    'inpatient.discharge', 'pharmacy.dispense'].includes(p))),
  doctor: new Set<Permission>([
    'patient.read', 'patient.write', 'schedule.read', 'schedule.book', 'queue.manage', 'queue.triage',
    'clinical.read', 'clinical.write', 'clinical.sign', 'vitals.write', 'billing.read', 'billing.charge',
    'discount.apply', 'reports.read', 'orders.write', 'results.enter', 'results.ack', 'inpatient.admit', 'inpatient.nursing',
    'inpatient.discharge', 'telemedicine.conduct', 'portal.manage',
  ]),
  nurse: new Set<Permission>([
    'patient.read', 'patient.write', 'schedule.read', 'queue.manage', 'queue.triage',
    'clinical.read', 'vitals.write', 'results.enter', 'inpatient.nursing',
  ]),
  reception: new Set<Permission>([
    'patient.read', 'patient.write', 'schedule.read', 'schedule.book', 'queue.manage',
    'billing.read', 'billing.charge', 'billing.post', 'billing.collect', 'refund.request', 'portal.manage', 'inpatient.admit', 'claims.manage',
  ]),
  cashier: new Set<Permission>([
    'patient.read', 'schedule.read', 'billing.read', 'billing.charge', 'billing.post', 'billing.collect',
    'refund.request', 'reports.read', 'claims.manage',
  ]),
  records: new Set<Permission>(['patient.read', 'patient.write', 'patient.merge', 'clinical.read', 'audit.read', 'schedule.read',
    'portal.manage', 'records.requests', 'emergency.review', 'import.run']),
  pharmacist: new Set<Permission>(['patient.read', 'schedule.read', 'clinical.read', 'pharmacy.dispense', 'pharmacy.stock', 'billing.read', 'billing.charge', 'formulary.manage']),
  lab: new Set<Permission>(['patient.read', 'schedule.read', 'results.enter']),
};

export function can(role: Role | undefined, perm: Permission): boolean {
  return !!role && GRANTS[role].has(perm);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', admin: 'Administrator', doctor: 'Doctor', nurse: 'Nurse',
  reception: 'Reception', cashier: 'Cashier', records: 'Medical records', pharmacist: 'Pharmacist', lab: 'Lab technician',
};
