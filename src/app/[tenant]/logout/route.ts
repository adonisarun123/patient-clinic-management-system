import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getTenantBySlug } from '@/domain/tenants';
import { logout } from '@/domain/staff';
import { sessionCookie } from '@/lib/http';

export async function POST(req: Request, ctx: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await ctx.params;
  const jar = await cookies();
  const token = jar.get(sessionCookie(slug))?.value;
  if (token) {
    const t = await getTenantBySlug(slug, { allowSuspended: true });
    await logout(t.id, token).catch(() => undefined);
  }
  jar.delete(sessionCookie(slug));
  return NextResponse.redirect(new URL(`/${slug}/login`, req.url), 303);
}
