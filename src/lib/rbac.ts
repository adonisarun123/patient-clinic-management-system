// Role → permission map. The server checks a permission on every command (API-001).
export const ROLES = ['owner', 'admin', 'doctor', 'nurse', 'reception', 'cashier', 'records'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'patient.read', 'patient.write', 'patient.merge',
  'schedule.read', 'schedule.book', 'schedule.override', 'schedule.configure',
  'queue.manage', 'queue.triage',
  'clinical.read', 'clinical.write', 'clinical.sign', 'vitals.write',
  'billing.read', 'billing.charge', 'billing.post', 'billing.collect', 'billing.void',
  'refund.request', 'refund.approve', 'discount.apply',
  'reports.read', 'settings.manage', 'staff.manage', 'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const GRANTS: Record<Role, Set<Permission>> = {
  owner: ALL,
  admin: new Set(PERMISSIONS.filter((p) => !['clinical.sign', 'clinical.write'].includes(p))),
  doctor: new Set<Permission>([
    'patient.read', 'patient.write', 'schedule.read', 'schedule.book', 'queue.manage', 'queue.triage',
    'clinical.read', 'clinical.write', 'clinical.sign', 'vitals.write', 'billing.read', 'billing.charge',
    'discount.apply', 'reports.read',
  ]),
  nurse: new Set<Permission>([
    'patient.read', 'patient.write', 'schedule.read', 'queue.manage', 'queue.triage',
    'clinical.read', 'vitals.write',
  ]),
  reception: new Set<Permission>([
    'patient.read', 'patient.write', 'schedule.read', 'schedule.book', 'queue.manage',
    'billing.read', 'billing.charge', 'billing.post', 'billing.collect', 'refund.request',
  ]),
  cashier: new Set<Permission>([
    'patient.read', 'schedule.read', 'billing.read', 'billing.charge', 'billing.post', 'billing.collect',
    'refund.request', 'reports.read',
  ]),
  records: new Set<Permission>(['patient.read', 'patient.write', 'patient.merge', 'clinical.read', 'audit.read', 'schedule.read']),
};

export function can(role: Role | undefined, perm: Permission): boolean {
  return !!role && GRANTS[role].has(perm);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', admin: 'Administrator', doctor: 'Doctor', nurse: 'Nurse',
  reception: 'Reception', cashier: 'Cashier', records: 'Medical records',
};
