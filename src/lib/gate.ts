import { AppError } from './errors';

/** Returns true when an error means "restricted chart — emergency access required". */
export function needsBreakGlass(e: unknown): boolean {
  return e instanceof AppError && e.code === 'FORBIDDEN' && (e.details as { needs?: string } | undefined)?.needs === 'emergency_access';
}
