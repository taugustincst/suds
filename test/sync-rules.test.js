'use strict';
// Characterisation harness for the per-table rules (server/rules/): for every table a device pushes, the same
// row is sent through /api/sync/push and through the REST route that writes that table, case by case —
// valid, each invalid field, a client off the caseload, another worker's record, a role without the
// permission, a module switched off, a tombstone, a skewed clock and a lost-update conflict — and both
// outcomes are compared with EXPECT below.
//
// EXPECT was first recorded against the code before the rules existed (1.13.0), so the refactor ran under it.
// Where REST and sync disagreed, the entry was changed on purpose and says what it was ("was: ...") and why
// the new outcome is the right one; docs/architecture/README.md lists them. Run with SUDS_CHARACTERISE=1 to
// print the observed outcomes as an EXPECT block instead of asserting them.
//
// Push outcomes: 'applied' | 'flagged: <warning>' (applied, and the device told why the office looked twice)
// | 'rejected: <reason>' | 'conflict' (the office copy was newer and kept) | 'ignored' (neither).
// Tombstones: 'deleted' | 'kept' | 'rejected: <reason>'. REST outcomes are HTTP status codes; null means the
// table has no REST route that takes that action (named in `restNote`).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const OBSERVE = process.env.SUDS_CHARACTERISE === '1';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const U = {}; const C = {}; const X = {};
let enc;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  enc = require('../server/crypto').encrypt;
  for (const [k, role] of [['nav', 'navigator'], ['nav2', 'navigator'], ['sup', 'supervisor'], ['clin', 'clinician'], ['fin', 'finance'], ['ro', 'readonly']]) {
    const u = H.makeUser(`rules_${k}`, role); U[k] = u.id;
    C[k] = H.client(); await C[k].login(u.username, u.password);
  }
  C.admin = H.client(); await C.admin.login('admin', 'AdminPassw0rd!x');
  U.admin = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, (H.makeCaseloadUser('rules_gone', 'navigator')).id);
  U.gone = H.db.one(`SELECT id FROM users WHERE username='rules_gone'`).id;
  // Shared reference data the rows point at.
  X.resource = randomUUID(); H.db.run(`INSERT INTO resources(id,name,category) VALUES(?,?,?)`, X.resource, 'County OTP', 'mat_otp');
  X.fund = randomUUID(); H.db.run(`INSERT INTO funding_sources(id,name,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?)`, X.fund, 'Rules fund', day(-200), day(200), 100000);
  X.line = randomUUID(); H.db.run(`INSERT INTO budget_lines(id,funding_source_id,category,allocated_amount) VALUES(?,?,?,?)`, X.line, X.fund, 'supplies', 50000);
  X.oldFund = randomUUID(); H.db.run(`INSERT INTO funding_sources(id,name,fiscal_year_start,fiscal_year_end,total_amount,is_active) VALUES(?,?,?,?,?,0)`, X.oldFund, 'Closed fund', day(-900), day(-500), 1000);
  // Supplies (docs/SUPPLIES.md): an item and a site in use, and ones the office has retired.
  X.item = randomUUID(); H.db.run(`INSERT INTO supply_items(id,name,category) VALUES(?,?,?)`, X.item, 'Rules kit', 'naloxone');
  X.oldItem = randomUUID(); H.db.run(`INSERT INTO supply_items(id,name,category,is_active) VALUES(?,?,?,0)`, X.oldItem, 'Retired kit', 'naloxone');
  X.site = randomUUID(); H.db.run(`INSERT INTO supply_sites(id,name) VALUES(?,?)`, X.site, 'Rules van');
  // SUPRT-A is a module of its own, off unless the programme switches it on (server/programme.js).
  H.db.setSetting('module_suprt', '1');
  X.template = randomUUID(); H.db.run(`INSERT INTO form_templates(id,name,category,fields_json) VALUES(?,?,?,?)`, X.template, 'Rules form', 'other', JSON.stringify([{ key: 'a', label: 'A', type: 'text', required: true }]));
});
after(async () => { await H.stop(); });

// ---- fixtures ----
/** A client on `owners`' caseloads (created directly: the fixture is not what is under test). */
function client(...owners) {
  const id = randomUUID();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'R-' + id.slice(0, 8), enc('Rule'), enc('Case' + id.slice(0, 4)), 'active', day(-30), U[owners[0] || 'nav']);
  for (const o of owners) H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), id, U[o], 'primary', day(-30), U.sup);
  return id;
}
const ts = (ms = Date.now()) => ({ created_at: iso(ms), updated_at: iso(ms) });
async function push(as, body, skewMs = 0) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(Date.now() + skewMs), ...body });
  assert.equal(r.status, 200, `push as ${as}: ${JSON.stringify(r.data)}`);
  return r.data;
}
function outcome(res, table, id) {
  const rej = (res.rejected || []).find(x => x.table === table && x.id === id);
  if (rej) return `rejected: ${rej.reason}`;
  if ((res.conflicts || []).some(x => x.table === table && x.id === id)) return 'conflict';
  const w = (res.warnings || []).find(x => x.table === table && x.id === id);
  if (w) return `flagged: ${w.reason}`;
  return (res.applied || {})[table] ? 'applied' : 'ignored';
}
/** The row as the REST API names it: plaintext under the name without _enc, no bookkeeping. */
function api(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) { if (['id', 'created_at', 'updated_at'].includes(k)) continue; o[k.endsWith('_enc') ? k.slice(0, -4) : k] = v; }
  return o;
}
const st = (r) => (r ? r.status : null);

// ---- the tables ----
// row(x): a valid new row as a device sends it (x.client: a client on nav's caseload; x.shared: one nav and nav2
// both hold; x.other: nav2's only). as: who pushes (default nav). create/update/del: the REST equivalent.
// invalid: [name, mutation (applied to a copy of the row; null deletes the column)]. edit: a column change
// for the edit cases. owner: the row's owning column (for "another worker's record").
const T = {
  resources: {
    as: 'nav', noPerm: 'clin',
    row: () => ({ id: randomUUID(), name: 'Clinic ' + randomUUID().slice(0, 6), category: 'outpatient', ...ts() }),
    create: (c, r) => c.post('/api/resources', api(r)), update: (c, r, p) => c.put(`/api/resources/${r.id}`, p), del: (c, r) => c.del(`/api/resources/${r.id}`),
    invalid: [['category not a category', { category: 'spaceship' }], ['name too long', { name: 'x'.repeat(201) }], ['name missing', { name: null }]],
    edit: { hours: 'Mon-Fri' },
  },
  policy_documents: {
    as: 'sup', noPerm: 'nav', restNote: 'a document is created with its file (POST /api/documents)',
    row: () => ({ id: randomUUID(), title: 'Policy ' + randomUUID().slice(0, 6), category: 'policy', ...ts() }),
    update: (c, r, p) => c.put(`/api/documents/${r.id}`, p), del: (c, r) => c.del(`/api/documents/${r.id}`),
    invalid: [['category not a category', { category: 'spaceship' }], ['title too long', { title: 'x'.repeat(201) }]],
    edit: { description: 'Updated' },
  },
  funding_sources: {
    as: 'sup', noPerm: 'nav',
    row: () => ({ id: randomUUID(), name: 'Grant ' + randomUUID().slice(0, 6), fiscal_year_start: day(-10), fiscal_year_end: day(300), total_amount: 1000, ...ts() }),
    create: (c, r) => c.post('/api/budget/funds', api(r)), update: (c, r, p) => c.put(`/api/budget/funds/${r.id}`, p),
    invalid: [['period ends before it starts', { fiscal_year_end: day(-20) }], ['source type unknown', { source_type: 'lottery' }], ['negative total', { total_amount: -5 }]],
    edit: { notes: 'Renewed' },
  },
  budget_lines: {
    as: 'sup', noPerm: 'nav',
    row: () => ({ id: randomUUID(), funding_source_id: X.fund, category: 'supplies', allocated_amount: 10, ...ts() }),
    create: (c, r) => c.post(`/api/budget/funds/${r.funding_source_id}/lines`, api(r)), update: (c, r, p) => c.put(`/api/budget/lines/${r.id}`, p), del: (c, r) => c.del(`/api/budget/lines/${r.id}`),
    invalid: [['category unknown', { category: 'yachts' }], ['more than the fund holds', { allocated_amount: 10000000 }], ['its own parent', (r) => ({ parent_id: r.id })]],
    edit: { label: 'Kits' },
  },
  clients: {
    as: 'nav', clientSelf: true,
    row: () => ({ id: randomUUID(), client_code: 'M26-' + randomUUID().slice(0, 4), first_name_enc: 'Ada' + randomUUID().slice(0, 4), last_name_enc: 'Pushed', status: 'active', intake_date: day(0), ...ts() }),
    create: (c, r) => c.post('/api/clients', { ...api(r), first_name: r.first_name_enc, last_name: r.last_name_enc, confirm_duplicate: true }), update: (c, r, p) => c.put(`/api/clients/${r.id}`, p),
    invalid: [['status unknown', { status: 'vanished' }], ['date of birth in the future', { dob_enc: day(400) }], ['email not an address', { email_enc: 'not-an-email' }], ['first name too long', { first_name_enc: 'x'.repeat(101) }],
      ['sets a legal hold without the permission', { legal_hold: 1 }]],
    edit: { city: 'Weaverville' },
  },
  assignments: {
    as: 'sup', noPerm: 'nav',
    row: (x) => ({ id: randomUUID(), client_id: x.client, user_id: U.nav2, role_on_case: 'secondary', start_date: day(0), ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/assignments`, api(r)),
    invalid: [['role unknown', { role_on_case: 'lead' }], ['a deactivated worker', { user_id: '$gone' }]],
    edit: { notes_enc: 'Covering' },
  },
  episodes: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, opened_at: day(0), status: 'open', ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/episodes`, api(r)),
    invalid: [['a second open episode', { _setup: (x) => H.db.run(`INSERT INTO episodes(id,client_id,opened_at,status) VALUES(?,?,?,?)`, randomUUID(), x.client, day(-3), 'open') }], ['closed before it opened', { status: 'closed', closed_at: day(-5), discharge_reason: 'completed' }, async (c, r) => { const e = await c.post(`/api/clients/${r.client_id}/episodes`, { opened_at: r.opened_at }); return c.post(`/api/episodes/${e.data.id}/close`, { discharge_reason: 'completed', closed_at: r.closed_at }); }]],
    edit: { referral_source: 'Court' },
  },
  interventions: {
    as: 'nav', unlinked: true, noPerm: 'fin', unlinkedPatch: { type: 'outreach' },
    row: (x) => ({ id: randomUUID(), client_id: x.client, user_id: U.nav, type: 'case_management', occurred_at: iso(), duration_minutes: 15, ...ts() }),
    create: (c, r) => c.post('/api/interventions', api(r)), update: (c, r, p) => c.put(`/api/interventions/${r.id}`, p), del: (c, r) => c.del(`/api/interventions/${r.id}`),
    invalid: [['type not on the list', { type: 'teleportation' }], ['a client is required for this service', { client_id: null }], ['duration over a day', { duration_minutes: 5000 }],
      ['stage of change unknown', { stage_of_change: 'bargaining' }], ['a cost with no budget line', { cost: 10, funding_source_id: '$fund' }], ['a cost on a line of another fund', { cost: 10, funding_source_id: '$oldFund', budget_line_id: '$line' }], ['attributed to another worker', { user_id: '$nav2' }]],
    edit: { duration_minutes: 30 },
  },
  overdose_events: {
    as: 'nav', unlinked: true, owner: 'reported_by', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, occurred_at: iso(), kind: 'reversal', naloxone_used: 1, naloxone_doses: 1, reported_by: U.nav, ...ts() }),
    create: (c, r) => c.post('/api/overdose-events', api(r)), update: (c, r, p) => c.put(`/api/overdose-events/${r.id}`, p), del: (c, r) => c.del(`/api/overdose-events/${r.id}`),
    invalid: [['kind unknown', { kind: 'bad_trip' }], ['doses negative', { naloxone_doses: -1 }], ['reported by another worker', { reported_by: '$nav2' }]],
    edit: { city: 'Redding' },
  },
  calls: {
    as: 'nav', unlinked: true, noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, user_id: U.nav, direction: 'outbound', method: 'phone', started_at: iso(), outcome: 'reached', ...ts() }),
    create: (c, r) => c.post('/api/calls', api(r)), update: (c, r, p) => c.put(`/api/calls/${r.id}`, p), del: (c, r) => c.del(`/api/calls/${r.id}`),
    invalid: [['direction unknown', { direction: 'sideways' }], ['a text outcome on a phone call', { outcome: 'sent' }], ['contact name too long', { contact_name_enc: 'x'.repeat(121) }]],
    edit: { duration_minutes: 12 },
  },
  time_entries: {
    as: 'nav', unlinked: true, noPerm: 'ro',
    row: (x) => ({ id: randomUUID(), client_id: x.client, user_id: U.nav, work_date: day(0), minutes: 30, category: 'direct_service', ...ts() }),
    create: (c, r) => c.post('/api/time', api(r)), update: (c, r, p) => c.put(`/api/time/${r.id}`, p), del: (c, r) => c.del(`/api/time/${r.id}`),
    invalid: [['no minutes', { minutes: 0 }], ['charged to a fund outside its period', { funding_source_id: '$oldFund' }], ['category not on the list', { category: 'napping' }]],
    edit: { minutes: 45 },
  },
  consents: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, type: 'roi', recipient_enc: 'County OTP', purpose_enc: 'Care coordination', signed_at: day(0), created_by: U.nav, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/consents`, api(r)),
    invalid: [['type unknown', { type: 'pinky_swear' }], ['a Part 2 consent missing its elements', { type: 'part2_disclosure' }], ['recipient too long', { recipient_enc: 'x'.repeat(2001) }]],
    edit: { purpose_enc: 'Something else' },
  },
  court_orders: {
    as: 'sup', noPerm: 'nav',
    row: (x) => ({ id: randomUUID(), client_id: x.client, order_type: 'noncriminal_2_64', court_enc: 'Superior Court', issued_at: day(-1), purpose_enc: 'Custody', scope_enc: 'Attendance dates', recorded_by: U.sup, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/court-orders`, api(r)),
    invalid: [['order type unknown', { order_type: 'parking' }], ['expires before it was issued', { expires_at: day(-30) }], ['no court', { court_enc: null }]],
    edit: { scope_enc: 'Everything' },
  },
  part2_notices: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, given_at: day(0), method: 'in_person_paper', acknowledged: 1, given_by: U.nav, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/part2-notices`, api(r)),
    invalid: [['method unknown', { method: 'carrier_pigeon' }], ['given in the future', { given_at: day(30) }], ['acknowledged and refused', { ack_refused: 1 }]],
    edit: { notes_enc: 'Copy given' },
  },
  referrals: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, resource_id: X.resource, user_id: U.nav, referred_at: iso(), status: 'pending', urgency: 'routine', ...ts() }),
    create: (c, r) => c.post('/api/referrals', api(r)), update: (c, r, p) => c.put(`/api/referrals/${r.id}`, p), del: (c, r) => c.del(`/api/referrals/${r.id}`),
    invalid: [['urgency unknown', { urgency: 'whenever' }], ['cites another client\'s consent', { consent_id: '$otherConsent' }], ['status not on the list', { status: 'lost' }]],
    edit: { notes_enc: 'Called twice' },
  },
  tasks: {
    as: 'nav', unlinked: true, owner: 'assigned_to', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, assigned_to: U.nav, created_by: U.nav, title_enc: 'Call back', priority: 'normal', status: 'open', ...ts() }),
    create: (c, r) => c.post('/api/tasks', api(r)), update: (c, r, p) => c.put(`/api/tasks/${r.id}`, p), del: (c, r) => c.del(`/api/tasks/${r.id}`),
    invalid: [['priority unknown', { priority: 'meh' }], ['title too long', { title_enc: 'x'.repeat(201) }], ['no title', { title_enc: null }]],
    edit: { priority: 'high' },
  },
  expenditures: {
    as: 'nav', unlinked: true, noPerm: 'clin',
    row: (x) => ({ id: randomUUID(), funding_source_id: X.fund, budget_line_id: X.line, client_id: x.client, user_id: U.nav, spent_at: day(0), amount: 12.5, category: 'supplies', ...ts() }),
    create: (c, r) => c.post('/api/budget/expenditures', api(r)), update: (c, r, p) => c.put(`/api/budget/expenditures/${r.id}`, p), del: (c, r) => c.del(`/api/budget/expenditures/${r.id}`),
    invalid: [['category unknown', { category: 'yachts' }], ['an inactive fund', { funding_source_id: '$oldFund', budget_line_id: null }], ['nothing spent', { amount: 0 }]],
    edit: { vendor: 'Pharmacy' },
  },
  notes: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, author_id: U.nav, kind: 'admin', format: 'narrative', content_enc: 'Met at the library.', occurred_at: iso(), status: 'draft', ...ts() }),
    create: (c, r) => c.post('/api/notes', api(r)), update: (c, r, p) => c.put(`/api/notes/${r.id}`, p), del: (c, r) => c.del(`/api/notes/${r.id}`),
    invalid: [['a clinical note from a navigator', { kind: 'clinical' }], ['format not on the list', { format: 'haiku' }], ['a counseling note that is not clinical', { counseling_note: 1 }]],
    edit: { content_enc: 'Met at the library, then the clinic.' },
  },
  patient_requests: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, kind: 'access', received_at: day(0), due_at: day(30), status: 'open', handled_by: U.nav, created_by: U.nav, ...ts() }),
    create: (c, r) => c.post('/api/patient-requests', api(r)), update: (c, r, p) => c.put(`/api/patient-requests/${r.id}`, p), del: (c, r) => c.del(`/api/patient-requests/${r.id}`),
    invalid: [['kind unknown', { kind: 'deletion' }], ['status unknown', { status: 'pending' }]],
    edit: { notes_enc: 'Copy posted' },
  },
  problems: {
    as: 'nav', noPerm: 'fin', module: 'careplan',
    row: (x) => ({ id: randomUUID(), client_id: x.client, problem_enc: 'Housing instability', status: 'active', source: 'self_report', added_by: U.nav, updated_by: U.nav, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/problems`, api(r)), update: (c, r, p) => c.put(`/api/problems/${r.id}`, p),
    invalid: [['status unknown', { status: 'cured' }], ['not an ICD-10 code', { icd10_code_enc: 'banana' }]],
    edit: { problem_enc: 'Housing' },
  },
  care_plan_goals: {
    as: 'nav', noPerm: 'fin', module: 'careplan',
    row: (x) => ({ id: randomUUID(), client_id: x.client, goal_enc: 'Stable housing', status: 'active', start_date: day(0), created_by: U.nav, updated_by: U.nav, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/goals`, api(r)), update: (c, r, p) => c.put(`/api/goals/${r.id}`, p), del: (c, r) => c.del(`/api/goals/${r.id}`),
    invalid: [['status unknown', { status: 'someday' }], ['a problem on another client\'s list', { problem_id: '$otherProblem' }]],
    edit: { target_date: day(60) },
  },
  asam_assessments: {
    as: 'clin', noPerm: 'nav', module: 'assessments', clientOwners: ['clin'],
    row: (x) => ({ id: randomUUID(), client_id: x.client, assessed_at: day(0), assessed_by: U.clin, d1_rating: 1, d2_rating: 1, d3_rating: 2, d4_rating: 1, d5_rating: 2, d6_rating: 1, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/asam`, api(r)), update: (c, r, p) => c.put(`/api/asam/${r.id}`, p), del: (c, r) => c.del(`/api/asam/${r.id}`),
    invalid: [['a rating out of range', { d1_rating: 9 }], ['a level of care unknown', { recommended_loc: '9.9' }]],
    edit: { d2_rating: 2 },
  },
  outcome_measures: {
    as: 'clin', noPerm: 'nav', module: 'assessments', clientOwners: ['clin'],
    row: (x) => ({ id: randomUUID(), client_id: x.client, instrument: 'phq9', administered_at: day(0), administered_by: U.clin, responses_enc: '[0,1,0,1,0,0,0,0,0]', total_score: 2, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/outcomes`, { ...api(r), responses: JSON.parse(r.responses_enc) }), update: (c, r, p) => c.put(`/api/outcomes/${r.id}`, p), del: (c, r) => c.del(`/api/outcomes/${r.id}`),
    invalid: [['answers that do not score', { responses_enc: '[9]' }], ['an instrument that is switched off', { instrument: 'dast10', responses_enc: '[0,0,0,0,0,0,0,0,0,0]' }]],
    edit: { notes_enc: 'Repeated' },
  },
  form_templates: {
    as: 'sup', noPerm: 'nav',
    row: () => ({ id: randomUUID(), name: 'Form ' + randomUUID().slice(0, 6), category: 'other', fields_json: '[]', ...ts() }),
    create: (c, r) => c.post('/api/forms/templates', api(r)), update: (c, r, p) => c.put(`/api/forms/templates/${r.id}`, p), del: (c, r) => c.del(`/api/forms/templates/${r.id}`),
    invalid: [['category unknown', { category: 'napkin' }]],
    edit: { description: 'Revised' },
  },
  client_forms: {
    as: 'nav', noPerm: 'fin',
    row: (x) => ({ id: randomUUID(), client_id: x.client, template_id: X.template, template_name: 'Rules form', fields_json: JSON.stringify([{ key: 'a', label: 'A', type: 'text', required: true }]), values_enc: '{"a":"yes"}', status: 'draft', created_by: U.nav, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/forms`, { template_id: r.template_id, values: JSON.parse(r.values_enc) }), update: (c, r, p) => c.put(`/api/forms/${r.id}`, p), del: (c, r) => c.del(`/api/forms/${r.id}`),
    invalid: [['status unknown', { status: 'shredded' }, async (c, r) => { const f = await c.post(`/api/clients/${r.client_id}/forms`, { template_id: r.template_id }); return c.put(`/api/forms/${f.data.id}`, { status: r.status }); }],
      ['completed with a required field empty', { status: 'completed', values_enc: '{}' }, async (c, r) => { const f = await c.post(`/api/clients/${r.client_id}/forms`, { template_id: r.template_id }); return c.put(`/api/forms/${f.data.id}`, { status: 'completed' }); }]],
    edit: { notes_enc: 'Signed copy to follow' },
  },
  suprt_assessments: {
    as: 'nav', noPerm: 'fin', module: 'suprt',
    row: (x) => ({ id: randomUUID(), client_id: x.client, assessment_type: 'baseline', assessment_date: day(0), status: 'draft', answers_enc: '{}', created_by: U.nav, updated_by: U.nav, ...ts() }),
    create: (c, r) => c.post(`/api/clients/${r.client_id}/suprt`, { assessment_type: r.assessment_type, assessment_date: r.assessment_date, status: r.status, answers: JSON.parse(r.answers_enc || '{}') }),
    update: (c, r, p) => c.put(`/api/suprt/${r.id}`, p), del: (c, r) => c.del(`/api/suprt/${r.id}`),
    invalid: [['type unknown', { assessment_type: 'midterm' }], ['dated in the future', { assessment_date: day(30) }], ['an answer the instrument does not ask', { answers_enc: '{"no_such_item":"1"}' }],
      ['complete with required answers missing', { status: 'complete' }]],
    edit: { assessment_date: day(-1) },
  },
  supply_ledger: {
    // No noPerm case: every role that may sync (clients:write) holds supplies:receive; supplies:manage for the other
    // kinds is ledgerPushProblem's (test/supplies.test.js).
    as: 'sup', restNote: 'stock is received over REST by POST /api/supplies/receipts (another shape: the ledger row is the office\'s)',
    row: () => ({ id: randomUUID(), item_id: X.item, site_id: X.site, kind: 'received', quantity: 10, occurred_on: day(0), source: 'ndp', user_id: U.sup, ...ts() }),
    create: (c, r) => c.post('/api/supplies/receipts', { item_id: r.item_id, site_id: r.site_id, quantity: r.quantity, received_on: r.occurred_on, source: r.source, funding_source_id: r.funding_source_id }),
    invalid: [['a visit\'s draw-down', { kind: 'distributed', quantity: -1 }, () => null], ['a negative delivery', { quantity: -5 }], ['an item the office has retired', { item_id: '$oldItem' }],
      ['a fund on a delivery that was not a purchase', { funding_source_id: '$fund' }]],
    edit: { quantity: 11 },
  },
  imports: {
    as: 'nav', noPerm: 'fin', restNote: 'an import is created by uploading a file (POST /api/imports/upload)',
    row: () => ({ id: randomUUID(), source: 'generic', filename_enc: 'notes.txt', imported_by: U.nav, item_count: 0, status: 'staged', ...ts() }),
    invalid: [['source unknown', { source: 'fax' }]],
    edit: { status: 'done' },
  },
};

// Values that name fixtures by key ('$nav2', '$oldFund', ...) are resolved when a case runs.
function resolve(v, x) {
  if (typeof v !== 'string' || !v.startsWith('$')) return v;
  const k = v.slice(1);
  return U[k] || X[k] || x[k];
}
function mutate(row, m, x) {
  const o = { ...row }; const patch = typeof m === 'function' ? m(row) : m;
  for (const [k, v] of Object.entries(patch)) { if (k.startsWith('_')) continue; if (v === null) o[k] = null; else o[k] = resolve(v, x); }
  return o;
}

async function prepare(name, spec, x) {
  // A case's own clients: nav's (and the pushing user's), a shared one, and nav2's alone.
  const owners = spec.clientOwners || [];
  x.client = client('nav', ...owners.filter(o => o !== 'nav'), ...(spec.as && !['nav', 'sup', 'admin'].includes(spec.as) && !owners.includes(spec.as) ? [spec.as] : []));
  x.shared = client('nav2', 'nav', ...owners.filter(o => o !== 'nav'));
  x.other = client('nav2');
  if (name === 'referrals') {
    X.otherConsent = randomUUID();
    H.db.run(`INSERT INTO consents(id,client_id,type,signed_at,created_by) VALUES(?,?,?,?,?)`, X.otherConsent, x.other, 'roi', day(0), U.nav2);
  }
  if (name === 'care_plan_goals') {
    X.otherProblem = randomUUID();
    H.db.run(`INSERT INTO problems(id,client_id,problem_enc,added_by) VALUES(?,?,?,?)`, X.otherProblem, x.other, enc('x'), U.nav2);
  }
}

/** Every case for one table: [caseName, { push, rest }]. */
async function runTable(name, spec) {
  // Each table's cases are a few dozen requests; the office's per-address API limit is not what is under test.
  require('../server/app').rateLimitReset('api:127.0.0.1');
  const out = {};
  const as = spec.as || 'nav';
  const x = {};
  await prepare(name, spec, x);
  const clientCol = !spec.clientSelf && spec.row(x).client_id !== undefined;
  const rest = async (fn, ...args) => (fn ? st(await fn(...args)) : null);

  const fresh = () => client('nav', ...(spec.clientOwners || []), ...(!['nav', 'sup', 'admin'].includes(as) && !(spec.clientOwners || []).includes(as) ? [as] : []));
  // valid
  { const r = spec.row({ ...x, client: fresh() }); const res = await push(as, { tables: { [name]: [r] } });
    out.valid = { push: outcome(res, name, r.id), rest: await rest(spec.create, C[as], spec.row({ ...x, client: fresh() }), x) }; }
  // each invalid field
  for (const [label, m, restFn] of spec.invalid || []) {
    const px = { ...x, client: fresh() }; if (m._setup) m._setup(px);
    const r = mutate(spec.row(px), m, px); const res = await push(as, { tables: { [name]: [r] } });
    const rx = { ...x, client: fresh() }; if (m._setup) m._setup(rx);
    out[`invalid: ${label}`] = { push: outcome(res, name, r.id), rest: restFn ? st(await restFn(C[as], mutate(spec.row(rx), m, rx), rx)) : await rest(spec.create, C[as], mutate(spec.row(rx), m, rx), x) };
    if (restFn && out[`invalid: ${label}`].rest === undefined) out[`invalid: ${label}`].rest = null;
  }
  // a client off the caseload (nav2's only)
  if (clientCol && as === 'nav') {
    const r = spec.row({ ...x, client: x.other }); const res = await push(as, { tables: { [name]: [r] } });
    out['client off the caseload'] = { push: outcome(res, name, r.id), rest: await rest(spec.create, C[as], spec.row({ ...x, client: x.other }), x) };
  }
  // another worker's record: on a client both hold (or no client, for `unlinked` tables), created by nav2
  if (as === 'nav' && clientCol) {
    for (const [label, cid] of [['another worker\'s record on a shared client', x.shared], ...(spec.unlinked ? [['another worker\'s record with no client', null]] : [])]) {
      const theirs = () => { const b = { ...spec.row({ ...x, client: cid }), ...(cid ? {} : spec.unlinkedPatch || {}) }; for (const col of ['user_id', 'author_id', 'reported_by', 'assigned_to', 'created_by', 'handled_by', 'added_by', 'administered_by', 'assessed_by']) if (col in b) b[col] = U.nav2; return b; };
      const base = theirs(); const other = theirs();
      const made = await push('nav2', { tables: { [name]: [base, other] } }, 0);
      if (outcome(made, name, base.id) !== 'applied' && !String(outcome(made, name, base.id)).startsWith('flagged')) { out[label] = { push: `setup: ${outcome(made, name, base.id)}`, rest: null }; continue; }
      const edited = { ...base, ...spec.edit, ...ts(Date.now() + 1000) };
      const res = await push('nav', { tables: { [name]: [edited] } });
      const restRes = spec.update ? st(await spec.update(C.nav, other, api(spec.edit))) : null;
      out[label] = { push: outcome(res, name, base.id), rest: restRes };
      // ...and deleting it
      const tres = await push('nav', { tombstones: [{ table_name: name, id: base.id, deleted_at: iso(Date.now() + 2000) }] });
      const tr = (tres.rejected || []).find(y => y.id === base.id);
      out[`${label}: tombstone`] = { push: tr ? `rejected: ${tr.reason}` : (H.db.one(`SELECT 1 FROM ${name} WHERE id=?`, base.id) ? 'kept' : 'deleted'), rest: spec.del ? st(await spec.del(C.nav, other)) : null };
    }
  }
  // a role without the table's write permission
  if (spec.noPerm) {
    const holder = spec.noPerm;
    const cid = client('nav', holder); const r = spec.row({ ...x, client: cid });
    const res = await C[holder].post('/api/sync/push', { device_now: iso(), tables: { [name]: [r] } });
    out[`role without permission (${holder})`] = { push: res.status === 200 ? outcome(res.data, name, r.id) : `http ${res.status}`, rest: await rest(spec.create, C[holder], spec.row({ ...x, client: client('nav', holder) }), x) };
  }
  // the programme module switched off
  if (spec.module) {
    const was = H.db.getSetting(`module_${spec.module}`, null);
    H.db.setSetting(`module_${spec.module}`, '0');
    try {
      const r = spec.row({ ...x, client: fresh() }); const res = await push(as, { tables: { [name]: [r] } });
      out['module switched off'] = { push: outcome(res, name, r.id), rest: await rest(spec.create, C[as], spec.row({ ...x, client: fresh() }), x) };
    } finally { if (was === null) H.db.run(`DELETE FROM settings WHERE key=?`, `module_${spec.module}`); else H.db.setSetting(`module_${spec.module}`, was); }
  }
  // own record: tombstone
  {
    const r = spec.row({ ...x, client: fresh() });
    const made = await push(as, { tables: { [name]: [r] } });
    if (outcome(made, name, r.id) === 'applied' || String(outcome(made, name, r.id)).startsWith('flagged')) {
      const tres = await push(as, { tombstones: [{ table_name: name, id: r.id, deleted_at: iso(Date.now() + 2000) }] });
      const tr = (tres.rejected || []).find(y => y.id === r.id);
      const r2 = spec.row({ ...x, client: fresh() });
      await push(as, { tables: { [name]: [r2] } });
      out.tombstone = { push: tr ? `rejected: ${tr.reason}` : (H.db.one(`SELECT 1 FROM ${name} WHERE id=?`, r.id) ? 'kept' : 'deleted'), rest: spec.del ? st(await spec.del(C[as], r2)) : null };
    }
  }
  // a device clock two hours fast: the row lands, stamped in office time
  {
    const skew = 2 * 3600000;
    const r = { ...spec.row({ ...x, client: fresh() }), ...ts(Date.now() + skew) };
    const res = await push(as, { tables: { [name]: [r] } }, skew);
    const stored = H.db.one(`SELECT updated_at, created_at FROM ${name} WHERE id=?`, r.id);
    out['device clock two hours fast'] = { push: outcome(res, name, r.id) + (stored ? (stored.updated_at <= iso(Date.now() + 60000) && stored.created_at <= iso(Date.now() + 60000) ? ' (office time)' : ' (DEVICE TIME)') : ''), rest: null };
  }
  // a lost update: the office changed the row after the device's copy
  if (spec.edit) {
    const r = spec.row({ ...x, client: fresh() });
    const made = await push(as, { tables: { [name]: [r] } });
    if (outcome(made, name, r.id) === 'applied' || String(outcome(made, name, r.id)).startsWith('flagged')) {
      H.db.run(`UPDATE ${name} SET updated_at=? WHERE id=?`, iso(Date.now() + 60000), r.id);
      const res = await push(as, { tables: { [name]: [{ ...r, ...Object.fromEntries(Object.entries(spec.edit).map(([k, v]) => [k, resolve(v, x)])), ...ts(Date.now() + 1000) }] } });
      out['an older device edit'] = { push: outcome(res, name, r.id), rest: spec.update ? st(await spec.update(C[as], r, { ...api(spec.edit), if_updated_at: r.updated_at })) : null };
    }
  }
  return out;
}

// What each case does, first recorded against 1.13.0 (see the header). A "was:" comment marks a deliberate change.
const EXPECT = OBSERVE ? {} : require('./fixtures/sync-rules-expect.js');

const observed = {};
for (const [name, spec] of Object.entries(T)) {
  test(`sync push and REST agree on ${name}`, async () => {
    observed[name] = await runTable(name, spec);
    if (OBSERVE) return;
    const want = EXPECT[name];
    assert.ok(want, `no expectations recorded for ${name}`);
    assert.deepStrictEqual(observed[name], want);
  });
}
test('every synchronised table a device may write is covered here', () => {
  const SYNC = require('../server/sync-tables');
  const writable = SYNC.tables.filter(t => !t.serverOwned && t.name !== 'users').map(t => t.name);
  // Tables a device writes only as a by-product of another table's route (or with a file), covered by their
  // own tests: sync.test.js, sync-scope.test.js, clinical-depth.test.js, documents.test.js.
  const byProduct = ['resource_photos', 'caloms_records', 'note_addenda', 'disclosures', 'import_items', 'client_form_files', 'problem_history', 'care_plan_steps',
    // A visit's supply lines: written with the visit (routes/interventions.js planSupplies), pushed with it:
    // test/supplies.test.js and test/sync-rules-fixes.test.js.
    'intervention_supplies'];
  const missing = writable.filter(n => !T[n] && !byProduct.includes(n));
  assert.deepEqual(missing, [], 'add these tables to the harness (or name the test that covers them)');
});
after(() => {
  if (!OBSERVE) return;
  const file = process.env.SUDS_CHARACTERISE_OUT || require('node:path').join(require('node:os').tmpdir(), 'sync-rules-observed.js');
  require('node:fs').writeFileSync(file, `'use strict';\n// Observed by test/sync-rules.test.js (SUDS_CHARACTERISE=1).\nmodule.exports = ${JSON.stringify(observed, null, 2)};\n`);
  console.log(`[characterise] wrote ${file}`);
});
