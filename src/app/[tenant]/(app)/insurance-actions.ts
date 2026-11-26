'use server';
import * as ins from '@/domain/insurance';
import { s, opt, run } from '@/lib/action-helpers';
import { toPaise } from '@/lib/money';

const paise = (v: string) => (v ? toPaise(v) : 0);

export async function insuranceAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/insurance`;
  await run(slug, back, async ({ actor, tenant }) => {
    const id = s(f, 'id');
    switch (s(f, 'op')) {
      case 'payer': await ins.upsertPayer(actor, tenant, { id: opt(f, 'id'), name: s(f, 'name'), kind: s(f, 'kind') as 'insurer', code: opt(f, 'code'), email: opt(f, 'email') ?? '',
        phone: opt(f, 'phone'), creditDays: Number(s(f, 'creditDays') || 30), tdsRateBp: Math.round(Number(s(f, 'tdsRate') || 0) * 100), active: s(f, 'active') !== 'off' }); return 'Payer saved';
      case 'policy': await ins.addPolicy(actor, tenant, { patientId: s(f, 'patientId'), payerId: s(f, 'payerId'), tpaId: opt(f, 'tpaId') ?? null, policyNumber: s(f, 'policyNumber'),
        memberId: opt(f, 'memberId'), holderName: opt(f, 'holderName'), relation: opt(f, 'relation'), validFrom: opt(f, 'validFrom'), validTo: opt(f, 'validTo'),
        sumInsuredPaise: opt(f, 'sumInsured') ? toPaise(s(f, 'sumInsured')) : undefined, copayBp: Math.round(Number(s(f, 'copay') || 0) * 100) }); return 'Policy added';
      case 'policyStatus': await ins.setPolicyStatus(actor, tenant, id, s(f, 'active') === '1'); return 'Policy updated';
      case 'preauth': { const pid = await ins.createPreauth(actor, tenant, { patientId: s(f, 'patientId'), policyId: s(f, 'policyId'), admissionId: opt(f, 'admissionId') ?? null,
        treatment: s(f, 'treatment'), estimatedPaise: toPaise(s(f, 'estimate')) }); return { redirect: `/${slug}/insurance/preauth/${pid}`, msg: 'Pre-authorisation drafted' }; }
      case 'preauthStatus': await ins.updatePreauth(actor, tenant, id, s(f, 'to'), { payerRef: opt(f, 'payerRef'), approvedPaise: opt(f, 'approved') ? toPaise(s(f, 'approved')) : undefined,
        validUntil: opt(f, 'validUntil'), note: opt(f, 'note') }); return 'Pre-authorisation updated';
      case 'claim': { const r = await ins.raiseClaim(actor, tenant, { invoiceId: s(f, 'invoiceId'), policyId: s(f, 'policyId'), amountPaise: toPaise(s(f, 'amount')), preauthId: opt(f, 'preauthId') ?? null });
        return { redirect: `/${slug}/insurance/claims/${r.claimId}`, msg: `Claim ${r.claimNumber} raised — submit it on the payer’s portal, then record the reference here` }; }
      case 'submit': await ins.submitClaim(actor, tenant, id, s(f, 'payerRef')); return 'Claim marked submitted';
      case 'query': await ins.claimQuery(actor, tenant, id, s(f, 'note')); return 'Query recorded';
      case 'settle': { const r = await ins.settleClaim(actor, tenant, id, { receivedPaise: paise(s(f, 'received')), tdsPaise: paise(s(f, 'tds')), disallowedPaise: paise(s(f, 'disallowed')),
        disallowedTo: (s(f, 'disallowedTo') || 'patient') as 'patient', reference: opt(f, 'reference'), note: opt(f, 'note') });
        return r.remaining ? `Settlement recorded; ₹${(r.remaining / 100).toFixed(2)} still open` : 'Claim settled and closed'; }
      case 'reject': await ins.rejectClaim(actor, tenant, id, s(f, 'note'), (s(f, 'to') || 'patient') as 'patient'); return 'Rejection recorded';
      case 'withdraw': await ins.withdrawClaim(actor, tenant, id, s(f, 'note')); return 'Claim withdrawn; the amount is due from the patient again';
    }
  });
}
