import { requireStaff } from '@/lib/session';
import { registerPatientAction } from '../../actions';
import { Flash, PageHead, RequestKey } from '@/components/ui';

export default async function NewPatient({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  await requireStaff(slug, 'patient.write');
  const sp = await searchParams;
  const dupe = sp.err?.startsWith('Possible existing patient');
  return (
    <>
      <PageHead title="Register patient" sub="Collect only what is needed. Never invent a date of birth or phone number to get past a field." />
      <Flash {...sp} />
      <form action={registerPatientAction.bind(null, slug)} className="card form-grid">
        <RequestKey />
        <label className="span2">Full name (as the patient gives it)<input name="fullName" required maxLength={200} /></label>
        <label>Preferred name<input name="preferredName" maxLength={200} /></label>
        <label>Sex<select name="sex" defaultValue="unknown"><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Unknown</option><option value="declined">Declined to say</option></select></label>
        <fieldset className="span2">
          <legend>Date of birth</legend>
          <div className="radios">
            <label><input type="radio" name="dobMode" value="date" defaultChecked /> Exact date</label>
            <label><input type="radio" name="dobMode" value="year" /> Year only</label>
            <label><input type="radio" name="dobMode" value="age" /> Estimated age</label>
            <label><input type="radio" name="dobMode" value="unknown" /> Unknown</label>
            <label><input type="radio" name="dobMode" value="declined" /> Declined</label>
          </div>
          <div className="inline">
            <label>Date<input type="date" name="birthDate" /></label>
            <label>Year<input name="birthYear" inputMode="numeric" pattern="\d{4}" placeholder="YYYY" /></label>
            <label>Age (years)<input name="age" type="number" min={0} max={130} /></label>
          </div>
        </fieldset>
        <label>Mobile number<input name="phone" type="tel" inputMode="tel" placeholder="10-digit mobile" /></label>
        <label>If no phone<select name="noPhone" defaultValue="none"><option value="none">No phone</option><option value="declined">Declined</option><option value="unavailable">Unavailable / unsafe to contact</option></select></label>
        <label>Email<input name="email" type="email" /></label>
        <label>Preferred language<input name="language" placeholder="e.g. Kannada" /></label>
        <label className="span2">Address<input name="line1" /></label>
        <label>City<input name="city" /></label>
        <label>State<input name="state" /></label>
        <label>PIN code<input name="pincode" inputMode="numeric" /></label>
        <fieldset className="span2"><legend>Emergency contact (a contact only — not authority to see the record)</legend>
          <div className="inline"><label>Name<input name="ecName" /></label><label>Phone<input name="ecPhone" /></label><label>Relation<input name="ecRelation" /></label></div>
        </fieldset>
        <fieldset className="span2"><legend>Unidentified arrival</legend>
          <label className="check"><input type="checkbox" name="temporary" /> Patient cannot be identified now — issue a temporary UHID and open an identity task</label>
          <label>Temporary label<input name="tempLabel" placeholder="e.g. Unknown male, approx 40, brought by ambulance" /></label>
        </fieldset>
        {dupe && <label className="span2 warnbox">Reason to create a new record despite a likely match (required)<input name="overrideReason" required placeholder="e.g. Different person — verified date of birth and father’s name" /></label>}
        <div className="span2"><button className="btn primary">Register</button></div>
      </form>
    </>
  );
}
