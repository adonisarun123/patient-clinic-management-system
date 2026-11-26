import { breakGlassAction } from '@/app/[tenant]/(app)/module-actions';

/** SE-006: shown instead of a restricted chart. Using it is logged and reviewed. */
export function BreakGlass({ slug, patientId, back, minutes }: { slug: string; patientId: string; back: string; minutes: number }) {
  return (
    <div className="card warnbox narrow" style={{ maxWidth: 620 }}>
      <h2>Restricted record</h2>
      <p>This chart is restricted. You can see it if you are treating the patient, or use emergency access when you need it for immediate care.</p>
      <form action={breakGlassAction.bind(null, slug, patientId, back)}>
        <label>Why do you need access now?<textarea name="reason" rows={3} required minLength={10} placeholder="e.g. Patient collapsed in OPD; need allergy and medication history" /></label>
        <p className="small muted">Access lasts {minutes} minutes. Your name, reason and everything you open are recorded and reviewed by medical records.</p>
        <button className="btn danger">Use emergency access</button>
      </form>
    </div>
  );
}
