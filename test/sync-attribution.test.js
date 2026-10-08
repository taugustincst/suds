'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// Security review of 1.16.0 (r6), H2: sync push stored every column a device sent, so a device could write
// columns no REST route lets a person set -- who created a record (and so who may delete it), who made a
// disclosure, an attachment's content type. A device now writes only a table's declared columns (its rules'
// fields and deviceColumns, its client, parent and owner columns); the columns that say who created a row are
// the office's, set from the account that syncs when the row is new and kept as they are afterwards.
//
// Table-driven over every synchronised table: the structural test holds each table's declaration to it, and
// the push test sends a new row and an edit naming someone else as its creator for every table with one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');
const SYNC = require('../server/sync-tables');
const rules = require('../server/rules');

const PW = 'StaffPassw0rd!x';
const U = {}; const C = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => LD.addDays(LD.today(), d);
let enc;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc } = require('../server/crypto'));
  for (const [k, role] of [['navA', 'navigator'], ['navB', 'navigator'], ['clin', 'clinician'], ['sup', 'supervisor'], ['sup2', 'supervisor']]) {
    const u = H.makeUser(`sa_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
  for (const m of ['careplan', 'caloms', 'suprt', 'assessments']) H.db.setSetting(`module_${m}`, '1');
});
after(() => H.stop());

async function push(as, body) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
function mkClient(owner) {
  const id = randomUUID();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'SA-' + id.slice(0, 8), enc('Pat'), enc('Attrib'), 'active', day(-30), U[owner]);
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), id, U[owner], 'primary', day(-30), U.sup);
  return id;
}

// User references a device legitimately names: who a row is about or for (the worker on a care team, a
// to-do's assignee, a step's owner, a request's handler), each checked by its table's rules; and the columns
// the table's rules set for themselves on push (a signature, a ruling, the visit's worker on a supply line).
const DEVICE_NAMES = new Set([
  'assignments.user_id', 'tasks.assigned_to', 'care_plan_steps.owner_user_id', 'patient_requests.handled_by',
  'notes.signed_by', 'notes.cosigned_by', 'time_entries.approved_by', 'expenditures.approved_by',
]);
// Columns the table's rules set from another record, whatever a device sends: a supply line's worker is its visit's
// (1.16.2, security review of 1.16.1, L1).
const OFFICE_SETS = new Set(['intervention_supplies.user_id']);

test('every synchronised table: a device may name only the user columns its rules check; the creator columns are the office\'s', () => {
  for (const t of SYNC.tables) {
    const R = rules.forTable(t.name);
    if (R.pushable === false || t.serverOwned) continue;
    assert.ok(R.writable instanceof Set, `${t.name}: rules expose the columns a device may write`);
    for (const [table, col] of SYNC.user_refs.filter(([x]) => x === t.name)) {
      const key = `${table}.${col}`;
      const stamped = (R.createdBy || []).includes(col) || (R.updatedBy || []).includes(col);
      const owner = R.owner && R.owner.col === col;
      if (DEVICE_NAMES.has(key) || owner) assert.ok(R.writable.has(col), `${key} is a column a device names (checked by the rules)`);
      else assert.ok(!R.writable.has(col) && (stamped || OFFICE_SETS.has(key) || col === 'revoked_by' || col === 'completed_by' || col === 'closed_by' || col === 'approved_by'),
        `${key}: a device must not write it; it is the office's (createdBy/updatedBy, or set by the table's own rules)`);
    }
    // Stored file metadata and blobs are the office's to work out from the file.
    for (const col of t.blob || []) assert.ok(!R.writable.has(col), `${t.name}.${col}: a blob arrives by the blob route, never in a row`);
  }
});

// One new row per table with a creator column, pushed by `as` naming `other` as its creator. `col` is the
// creator column; the row is otherwise one the table's rules accept.
const FIXTURES = {
  clients: () => ({ as: 'navA', col: 'created_by', row: { client_code: 'SA-N' + randomUUID().slice(0, 6), first_name_enc: 'New', last_name_enc: 'Attrib', status: 'active', intake_date: day(0) } }),
  assignments: null, // assignments:manage (a supervisor): created_by covered by the structural test and the edit below
  episodes: (cid) => ({ as: 'navA', col: 'opened_by', row: { client_id: cid, opened_at: day(0), status: 'open' } }),
  caloms_records: (cid) => { const e = randomUUID(); H.db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by) VALUES(?,?,?,?)`, e, cid, day(-3), U.navA); return { as: 'navA', col: 'created_by', row: { client_id: cid, episode_id: e, record_type: 'annual_update', record_date: day(0), answers_enc: '{}' } }; },
  consents: (cid) => ({ as: 'navA', col: 'created_by', row: { client_id: cid, type: 'photo_media', signed_at: day(0) } }),
  court_orders: (cid) => ({ as: 'sup', col: 'recorded_by', row: { client_id: cid, order_type: 'noncriminal_2_64', court_enc: 'Superior Court', purpose_enc: 'p', scope_enc: 's', issued_at: day(-1) } }),
  part2_notices: (cid) => ({ as: 'navA', col: 'given_by', row: { client_id: cid, given_at: day(0), method: 'in_person_paper' } }),
  tasks: (cid) => ({ as: 'navA', col: 'created_by', row: { client_id: cid, title_enc: 'Call back', assigned_to: U.navA, status: 'open', priority: 'normal' } }),
  // A note's author (1.16.2, security review of 1.16.1, H1): nobody writes a note in someone else's name.
  notes: (cid) => ({ as: 'clin', col: 'author_id', row: { client_id: cid, kind: 'clinical', format: 'narrative', content_enc: 'A draft', occurred_at: iso(), status: 'draft', part2_protected: 1 } }),
  note_addenda: (cid) => { const n = randomUUID(); H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,signed_by,signed_at) VALUES(?,?,?,?,?,?,?,?,?)`, n, cid, U.navA, 'admin', enc('x'), iso(), 'signed', U.navA, iso()); return { as: 'navA', col: 'author_id', row: { note_id: n, content_enc: 'Addendum' } }; },
  disclosures: (cid) => ({ as: 'navA', col: 'disclosed_by', row: { client_id: cid, recipient_enc: 'County', purpose_enc: 'x', what_enc: 'y', disclosed_at: iso(), basis: 'medical_emergency', justification_enc: 'z' } }),
  imports: () => ({ as: 'navA', col: 'imported_by', row: { source: 'generic', status: 'staged', filename_enc: 'x.txt' } }),
  form_templates: () => ({ as: 'sup', col: 'uploaded_by', row: { name: 'SA template', is_active: 1, fields_json: '[]' } }),
  client_forms: (cid) => ({ as: 'navA', col: 'created_by', row: { client_id: cid, template_name: 'T', values_enc: '{}', fields_json: '[]', status: 'draft' } }),
  client_form_files: (cid) => { const f = randomUUID(); H.db.run(`INSERT INTO client_forms(id,client_id,template_name,values_enc,status,created_by) VALUES(?,?,?,?,?,?)`, f, cid, 'T', enc('{}'), 'draft', U.navA); return { as: 'navA', col: 'uploaded_by', row: { client_form_id: f, client_id: cid, content_type: 'image/png', filename_enc: 'a.png' } }; },
  patient_requests: (cid) => ({ as: 'navA', col: 'created_by', row: { client_id: cid, kind: 'access', received_at: day(0), due_at: day(30), status: 'open' } }),
  problems: (cid) => ({ as: 'clin', col: 'added_by', row: { client_id: cid, problem_enc: 'Housing', status: 'active' } }),
  problem_history: (cid) => { const p = randomUUID(); H.db.run(`INSERT INTO problems(id,client_id,problem_enc,added_by) VALUES(?,?,?,?)`, p, cid, enc('x'), U.clin); return { as: 'clin', col: 'changed_by', row: { problem_id: p, client_id: cid, action: 'updated', changes_enc: '{}' } }; },
  care_plan_goals: (cid) => ({ as: 'navA', col: 'created_by', row: { client_id: cid, goal_enc: 'Stable housing', status: 'active' } }),
  care_plan_steps: (cid) => { const g = randomUUID(); H.db.run(`INSERT INTO care_plan_goals(id,client_id,goal_enc,created_by) VALUES(?,?,?,?)`, g, cid, enc('g'), U.navA); return { as: 'navA', col: 'created_by', row: { goal_id: g, client_id: cid, step_enc: 'Apply', status: 'open' } }; },
  asam_assessments: (cid) => ({ as: 'clin', col: 'assessed_by', row: { client_id: cid, assessed_at: day(0), d1_rating: 1, d2_rating: 1, d3_rating: 1, d4_rating: 1, d5_rating: 1, d6_rating: 1 } }),
  outcome_measures: (cid) => ({ as: 'clin', col: 'administered_by', row: { client_id: cid, instrument: 'gad7', administered_at: day(0), responses_enc: '[0,0,0,0,0,0,0]' } }),
  suprt_assessments: (cid) => ({ as: 'navA', col: 'created_by', row: { client_id: cid, assessment_type: 'baseline', assessment_date: day(0), status: 'draft', answers_enc: '{}' } }),
  resource_photos: () => { const r = randomUUID(); H.db.run(`INSERT INTO resources(id,name,category) VALUES(?,?,?)`, r, 'SA clinic', 'other'); return { as: 'navA', col: 'uploaded_by', row: { resource_id: r, content_type: 'image/png', sort_order: 0 } }; },
  policy_documents: () => ({ as: 'sup', col: 'uploaded_by', row: { title: 'SA policy', category: 'policy', content_type: 'application/pdf' } }),
  supply_ledger: null, // stock movements: user_id covered by the structural test (docs/SUPPLIES.md fixtures live in supplies tests)
};

test('every table with a creator column: a device\'s new row is its syncing user\'s, whoever it names, and an edit cannot move it', async () => {
  const tables = SYNC.tables.filter(t => { const R = rules.forTable(t.name); return R.pushable !== false && !t.serverOwned && (R.createdBy || []).length; });
  assert.ok(tables.length >= 20, 'the creator columns are declared');
  for (const t of tables) {
    assert.ok(t.name in FIXTURES, `${t.name} has a creator column: give it a fixture here`);
    if (!FIXTURES[t.name]) continue;
    const cid = mkClient('navB');
    const { as, col, row } = FIXTURES[t.name](cid);
    const other = as === 'sup' ? U.sup2 : U.sup;
    const id = randomUUID();
    const res = await push(as, { tables: { [t.name]: [{ id, ...row, [col]: other, updated_at: iso() }] } });
    assert.deepEqual(res.rejected, [], `${t.name}: ${JSON.stringify(res.rejected)}`);
    const stored = H.db.one(`SELECT * FROM ${t.name} WHERE id=?`, id);
    assert.ok(stored, `${t.name}: the row landed`);
    assert.equal(stored[col], U[as], `${t.name}.${col} is the syncing user, not the one the device named`);
    assert.ok(res.warnings.some(w => w.id === id && /recorded as/.test(w.reason)), `${t.name}: the device is told (${JSON.stringify(res)})`);
    // An edit naming someone else as the creator (a takeover) leaves it as it was.
    const again = await push(as, { tables: { [t.name]: [{ ...H.db.one(`SELECT * FROM ${t.name} WHERE id=?`, id), ...row, id, [col]: other, updated_at: iso(Date.now() + 5000) }] } });
    assert.ok(!again.rejected.some(r => r.id === id && !/immutable|not permitted/.test(r.reason)), `${t.name}: ${JSON.stringify(again.rejected)}`);
    assert.equal(H.db.one(`SELECT ${col} FROM ${t.name} WHERE id=?`, id)[col], U[as], `${t.name}.${col} cannot be moved by an edit`);
  }
});

test('a column no rule declares is not stored from a device (an office bookkeeping column, an attachment\'s size)', async () => {
  const cid = mkClient('navA');
  const g = randomUUID();
  const res = await push('navA', { tables: { care_plan_goals: [{ id: g, client_id: cid, goal_enc: 'Own goal', status: 'active', reviewed_at: day(0), updated_by: U.sup, updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  const row = H.db.one(`SELECT * FROM care_plan_goals WHERE id=?`, g);
  assert.equal(row.updated_by, U.navA, 'updated_by is the syncing user');
  assert.equal(row.reviewed_at, day(0), 'a declared device column is kept');
  // resource_photos: data_b64 is a blob (uploaded on its own, checked there), never taken from a row.
  const r = randomUUID(); H.db.run(`INSERT INTO resources(id,name,category) VALUES(?,?,?)`, r, 'SA blob', 'other');
  const p = randomUUID();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await push('navA', { tables: { resource_photos: [{ id: p, resource_id: r, content_type: 'image/png', data_b64: png, sort_order: 0, updated_at: iso() }] } });
  assert.equal(H.db.one(`SELECT data_b64 FROM resource_photos WHERE id=?`, p).data_b64, null);
});

test('goal takeover: a device cannot make another worker\'s goal its own and then delete it (report H2 reproduction)', async () => {
  const cid = mkClient('navB');
  const made = await C.navB.post(`/api/clients/${cid}/goals`, { goal: 'B goal' });
  assert.equal(made.status, 201);
  assert.equal((await C.navA.del(`/api/goals/${made.data.id}`)).status, 403, 'REST refuses');
  const row = H.db.one(`SELECT * FROM care_plan_goals WHERE id=?`, made.data.id);
  await push('navA', { tables: { care_plan_goals: [{ ...row, goal_enc: 'B goal', created_by: U.navA, updated_at: iso(Date.now() + 5000) }] } });
  assert.equal(H.db.one(`SELECT created_by FROM care_plan_goals WHERE id=?`, made.data.id).created_by, U.navB);
  const del = await push('navA', { tombstones: [{ table_name: 'care_plan_goals', id: made.data.id, deleted_at: iso(Date.now() + 60000) }] });
  assert.ok(del.rejected.some(r => r.id === made.data.id), 'sync refuses too');
  assert.ok(H.db.one(`SELECT 1 FROM care_plan_goals WHERE id=?`, made.data.id));
});
