import { requireStaff } from '@/lib/session';
import * as fin from '@/domain/finance';
import { fail } from '@/lib/http';

/** File downloads for the Accounts page (Tally XML vouchers or ledger masters, or CSV). Owner/admin only (finance.close). */
export async function GET(req: Request, ctx: { params: Promise<{ tenant: string }> }) {
  try {
    const { tenant: slug } = await ctx.params;
    const { tenant, actor } = await requireStaff(slug, 'finance.close');
    const u = new URL(req.url);
    const format = u.searchParams.get('format') ?? 'csv';
    const name = `${slug}`;
    if (format === 'ledgers') return download(await fin.tallyLedgerMasters(actor, tenant), `${name}-ledgers.xml`, 'application/xml');
    const from = u.searchParams.get('from') ?? ''; const to = u.searchParams.get('to') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return new Response('Choose a valid date range', { status: 400 });
    const rows = await fin.journalRows(actor, tenant, from, to);
    if (format === 'tally') return download(fin.journalsToTallyXml(rows, u.searchParams.get('company') || undefined), `${name}-vouchers-${from}-${to}.xml`, 'application/xml');
    return download('﻿' + fin.journalsToCsv(rows), `${name}-journals-${from}-${to}.csv`, 'text/csv; charset=utf-8');
  } catch (e) { return fail(e); }
}

const download = (body: string, filename: string, type: string) => new Response(body, {
  headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store' } });
