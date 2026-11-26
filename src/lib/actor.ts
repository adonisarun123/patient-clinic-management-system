import type { Role, Permission } from './rbac';
import { can } from './rbac';
import { AppError } from './errors';

export type Actor =
  | { kind: 'staff'; tenantId: string; staffId: string; role: Role; clinicianId: string | null; name: string; ip?: string }
  | { kind: 'public'; tenantId: string; journey: string; ip?: string }
  | { kind: 'api_key'; tenantId: string; keyId: string; ip?: string }
  | { kind: 'system'; tenantId: string };

export function actorId(a: Actor): string {
  switch (a.kind) {
    case 'staff': return a.staffId;
    case 'public': return `journey:${a.journey.slice(0, 12)}`;
    case 'api_key': return a.keyId;
    case 'system': return 'system';
  }
}

export function staffId(a: Actor): string | null {
  return a.kind === 'staff' ? a.staffId : null;
}

/** Secret API keys act with an integration role; publishable keys never reach privileged commands. */
export function authorize(a: Actor, perm: Permission): void {
  if (a.kind === 'system') return;
  if (a.kind === 'staff' && can(a.role, perm)) return;
  if (a.kind === 'api_key' && can('reception', perm)) return;
  throw new AppError('FORBIDDEN', 'You do not have permission for this action');
}
