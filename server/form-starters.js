'use strict';
// Starter form templates every SUD programme needs on day one. A county can upload its own PDFs, but
// shipping with an empty form library meant a new installation had no consent form at all — and consent is
// the one thing 42 CFR Part 2 will not let you work without.
//
// These are field definitions rather than uploaded files, so they print from the built-in PDF writer and
// can be filled in on a phone. They are a starting point: a county is expected to edit the wording to
// match what its own counsel has approved.
const db = require('./db');
const audit = require('./audit');
const { uuid } = require('./crypto');

const text = (key, label, opts = {}) => ({ key, label, type: 'text', ...opts });
const area = (key, label, opts = {}) => ({ key, label, type: 'textarea', ...opts });
const date = (key, label, opts = {}) => ({ key, label, type: 'date', ...opts });
const check = (key, label, opts = {}) => ({ key, label, type: 'checkbox', ...opts });
const section = (key, label) => ({ key, label, type: 'section' });

const TEMPLATES = [
  {
    key: 'part2_consent',
    name: 'Consent to release information (42 CFR Part 2)',
    category: 'consent',
    description: 'Written consent before any substance use disorder record is shared. Required elements per 42 CFR §2.31.',
    instructions: 'Complete with the client, read the redisclosure notice aloud, and record the signed copy against the client. Have your county counsel review the wording before first use.',
    fields: [
      section('sec_client', 'Client'),
      text('client_name', 'Client name', { required: true }), date('client_dob', 'Date of birth'),
      section('sec_release', 'What may be released, to whom, and why'),
      text('discloser', 'Who may make the disclosure (this program, or the named program or person)', { required: true }),
      text('recipient', 'Information may be released to (name and agency, or a class — for a treatment, payment and operations consent: "my treating providers, health plans, third-party payers, and people helping to operate this program")', { required: true }),
      area('purpose', 'Purpose of the disclosure', { required: true, help: 'Be specific — "for treatment coordination", "at the request of the patient", or for a single TPO consent "for treatment, payment, and health care operations"; "for any purpose" is not. SUD counseling notes, and use in a legal proceeding, each need a separate consent of their own.' }),
      { key: 'info', label: 'Information to be released', type: 'select', required: true,
        options: ['Referral summary only', 'Diagnosis and medication-assisted treatment status', 'Attendance and progress', 'Assessment and treatment plan', 'Full record'] },
      area('info_other', 'If other, describe exactly what will be released'),
      section('sec_limits', 'Limits'),
      date('expires', 'This consent expires on', { required: true, help: 'Part 2 requires an expiry date, event or condition.' }),
      area('expires_event', 'Or, the event or condition that ends it'),
      check('redisclosure', 'The redisclosure notice below was explained to the client', { required: true }),
      section('sec_rights', 'Client rights'),
      check('may_revoke', 'This consent states that the client may revoke it at any time in writing, and how, except to the extent the program or another lawful holder has already acted in reliance on it', { required: true }),
      check('no_condition', 'This consent states the consequences of refusing to sign (including that treatment, payment and eligibility do not depend on signing, where that is so)', { required: true }),
      check('redisclosure_hipaa', 'This consent states that records disclosed to a HIPAA covered entity or business associate may be redisclosed as HIPAA permits, except for use in proceedings against the client'),
      section('sec_sign', 'Signatures'),
      text('client_sig', 'Client signature', { required: true }), date('client_sig_date', 'Date', { required: true }),
      text('rep_sig', 'Personal representative (if applicable)'), text('rep_relationship', 'Relationship and authority'),
      text('witness_sig', 'Witness / staff signature'), date('witness_date', 'Date'),
    ],
    footer: `NOTICE TO RECIPIENT (42 CFR §2.32): ${require('./constants').PART2_REDISCLOSURE_NOTICE}`,
  },
  {
    key: 'consent_revocation',
    name: 'Revocation of consent',
    category: 'consent',
    description: 'Records that a client has withdrawn a release of information, and when.',
    instructions: 'Complete as soon as the client tells you, then revoke the consent in SUDS so any open referrals relying on it are flagged.',
    fields: [
      text('client_name', 'Client name', { required: true }),
      text('consent_description', 'Consent being revoked (recipient and date signed)', { required: true }),
      date('effective', 'Revoked with effect from', { required: true }),
      area('reason', 'Reason (optional — the client does not have to give one)'),
      check('told_already_shared', 'The client was told that information already shared in reliance on the consent cannot be recalled'),
      text('client_sig', 'Client signature'), date('client_sig_date', 'Date'),
      text('staff_sig', 'Staff signature', { required: true }), date('staff_date', 'Date', { required: true }),
    ],
  },
  {
    key: 'intake_face_sheet',
    name: 'Intake face sheet',
    category: 'intake',
    description: 'The first page of a client file: who they are, how to reach them, and what brought them in.',
    instructions: 'Most of this is pre-filled from the client record. Print it for a paper file, or fill it in on a phone during an outreach contact and enter it afterwards.',
    fields: [
      section('sec_who', 'Client'),
      text('client_name', 'Name', { required: true }), text('preferred_name', 'Preferred name'), date('client_dob', 'Date of birth'),
      text('pronouns', 'Pronouns'), text('phone', 'Phone'), check('ok_to_text', 'OK to text'), check('ok_to_voicemail', 'OK to leave a voicemail'),
      text('address', 'Address'), text('emergency_contact', 'Emergency contact'),
      section('sec_need', 'Presenting need'),
      area('presenting', 'What brought them in today', { required: true }),
      text('primary_substance', 'Primary substance'), text('housing_status', 'Housing situation'), text('insurance', 'Insurance'),
      check('overdose_history', 'History of overdose'), check('naloxone_given', 'Naloxone provided today'),
      section('sec_next', 'Next steps'),
      area('plan', 'Immediate plan'), date('follow_up', 'Follow-up date'), text('worker', 'Navigator'),
    ],
  },
  {
    key: 'assistance_request',
    name: 'Client assistance request',
    category: 'assistance',
    description: 'Request for flexible funds — bus passes, identification documents, work clothes, a deposit.',
    instructions: 'Complete with the client, attach receipts to the completed form, and record the spending against the funding source in Funding & spending.',
    fields: [
      text('client_name', 'Client name', { required: true }), text('client_code', 'Client code'),
      { key: 'category', label: 'What is needed', type: 'select', required: true, options: ['Transport (bus pass, fuel, fare)', 'Identification documents', 'Housing deposit or rent', 'Clothing', 'Phone or phone credit', 'Medication or medical', 'Food', 'Other'] },
      area('justification', 'How this supports their recovery plan', { required: true }),
      text('amount', 'Amount requested', { required: true }), text('vendor', 'Vendor or provider'),
      check('alternatives', 'Other sources were checked first (Medicaid, CalFresh, housing programmes)'),
      text('requested_by', 'Requested by', { required: true }), date('requested_on', 'Date', { required: true }),
      section('sec_approval', 'Approval'),
      text('approved_by', 'Approved by'), date('approved_on', 'Date'), area('approval_notes', 'Notes'),
    ],
  },
  {
    key: 'naloxone_log',
    name: 'Naloxone distribution log',
    category: 'harm_reduction',
    description: 'A single distribution event, including community distribution with no identified client.',
    instructions: 'Use this for outreach and community events. Enter the totals in SUDS as a visit or service afterwards so they reach the funder report.',
    fields: [
      date('event_date', 'Date', { required: true }), text('location', 'Location'), text('event_name', 'Event or outreach activity'),
      text('kits', 'Naloxone kits distributed', { required: true }), text('strips', 'Fentanyl test strips distributed'),
      text('people', 'People who received training'),
      check('training_given', 'Overdose recognition and response training was given'),
      check('anonymous', 'Recipients were anonymous (community distribution)'),
      area('notes', 'Notes'),
      text('staff', 'Staff', { required: true }),
    ],
  },
];

function installedKeys() {
  try { return JSON.parse(db.getSetting('form_starters_installed', '[]')); } catch { return []; }
}

/** What is available and what has already been installed. */
function list() {
  const installed = new Set(installedKeys());
  return TEMPLATES.map(t => ({ key: t.key, name: t.name, category: t.category, description: t.description, fields: t.fields.length, installed: installed.has(t.key) }));
}

/** Install the starter templates that are not already there. Existing templates are never modified. */
function install({ keys = null, actor = null } = {}) {
  const wanted = TEMPLATES.filter(t => !keys || keys.includes(t.key));
  const already = new Set(installedKeys());
  const added = [];
  db.transaction(() => {
    for (const t of wanted) {
      if (already.has(t.key)) continue;
      // A county may have uploaded its own version under the same name; never overwrite that.
      if (db.one(`SELECT 1 FROM form_templates WHERE name=?`, t.name)) { already.add(t.key); continue; }
      const id = uuid();
      db.run(`INSERT INTO form_templates(id,name,description,category,version,fields_json,instructions,is_active,uploaded_by) VALUES(?,?,?,?,?,?,?,1,?)`,
        id, t.name, t.description, t.category, 'starter', JSON.stringify(t.fields), [t.instructions, t.footer].filter(Boolean).join('\n\n'), actor);
      added.push({ key: t.key, id, name: t.name });
      already.add(t.key);
    }
    db.setSetting('form_starters_installed', JSON.stringify([...already]));
  });
  if (added.length) audit.log({ user: actor ? { id: actor, username: 'form-starters' } : { username: 'form-starters' }, action: 'forms.starters.install', details: { added: added.map(a => a.key) } });
  return { added, total: TEMPLATES.length };
}

module.exports = { TEMPLATES, list, install };
