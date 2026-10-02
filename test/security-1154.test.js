'use strict';
// The independent security review of 1.15.3, fixed in 1.15.4 (CHANGELOG "Security"). One section per finding,
// each written to fail on 1.15.3:
//   H1  sync push let a device approve time and spending (its own included): rulings are the office's
//   H2  a de-identified role (finance, readonly) could ask /api/clients?q= whether a named person is a client
//   M1  permission overrides broke caseload scoping; assignments:manage let its holder put themselves on any client
//   M2  privileged grants survived a role change, so a demoted account could promote itself back
//   L2  override hygiene: a bounded reason kept out of the audit trail, a reason to revoke, denies audited as such
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const today = new Date().toISOString().slice(0, 10);
const later = (ms = 5000) => ({ updated_at: iso(Date.now() + ms) });
const U = {}; const C = {};
let admin;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [k, role] of [['nav', 'navigator'], ['nav2', 'navigator'], ['sup', 'supervisor'], ['sup2', 'supervisor'], ['fin', 'finance'], ['ro', 'readonly'], ['trainee', 'clinician']]) {
    const u = H.makeUser(`s154_${k}`, role); U[k] = u.id;
    C[k] = H.client(); await C[k].login(u.username, u.password);
  }
  H.db.run(`UPDATE users SET requires_cosign=1 WHERE id=?`, U.trainee);
});
after(() => H.stop());

async function push(as, body) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const flagFor = (r, id) => (r.warnings || []).find(w => w.id === id && w.flagged);
const lastAudit = (action, entityId) => H.db.one(`SELECT * FROM audit_log WHERE action=? ${entityId ? 'AND entity_id=?' : ''} ORDER BY rowid DESC LIMIT 1`, action, ...(entityId ? [entityId] : []));
/** A client made at the office through REST (a real client code, name, date of birth and phone). */
async function officeClient(first, last, dob, phone) {
  const r = await admin.post('/api/clients', { first_name: first, last_name: last, dob, phone, status: 'active', no_episode: true, confirm_duplicate: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const assign = (clientId, userId) => H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), clientId, userId, 'primary', today, U.sup);

// ------------------------------------------------------------------------------------------------ H1
async function timeEntry(as, minutes = 60) {
  const r = await C[as].post('/api/time', { work_date: today, minutes, category: 'admin', description: 'H1 test' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
const timeRow = (id) => H.db.one(`SELECT * FROM time_entries WHERE id=?`, id);

test('H1: a navigator\'s device cannot approve its own time: the ruling is flagged and not applied', async () => {
  const id = await timeEntry('nav', 600);
  const r = await push('nav', { tables: { time_entries: [{ id, user_id: U.nav, work_date: today, minutes: 600, category: 'admin', status: 'approved', approved_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const t = timeRow(id);
  assert.equal(t.status, 'draft', 'still a draft: approval is the office\'s');
  assert.equal(t.approved_at, null); assert.equal(t.approved_by, null);
  const f = flagFor(r, id);
  assert.ok(f, `the device is told (${JSON.stringify(r)})`);
  assert.match(f.reason, /approv/i);
  const a = lastAudit('sync.conflict', id);
  assert.ok(a && /"flagged":"ruling"/.test(a.details), 'and the audit trail says a ruling was refused');
});

test('H1: a supervisor\'s device cannot approve the supervisor\'s own time, nor rule on anyone\'s', async () => {
  const own = await timeEntry('sup', 480);
  const r = await push('sup', { tables: { time_entries: [{ id: own, user_id: U.sup, work_date: today, minutes: 480, category: 'admin', status: 'approved', approved_by: U.sup, approved_at: iso(), ...later() }] } });
  assert.equal(timeRow(own).status, 'draft');
  assert.equal(timeRow(own).approved_by, null);
  assert.ok(flagFor(r, own), 'flagged');
  // Someone else's submitted time: approving it is POST /api/time/:id/approve at the office, not a push.
  const theirs = await timeEntry('nav', 30);
  assert.equal((await C.nav.post(`/api/time/${theirs}/submit`, {})).status, 200);
  const r2 = await push('sup', { tables: { time_entries: [{ id: theirs, status: 'approved', approved_by: U.sup, approved_at: iso(), ...later(7000) }] } });
  assert.equal(timeRow(theirs).status, 'submitted');
  assert.ok(flagFor(r2, theirs), 'flagged');
  // The office route still works for it.
  assert.equal((await C.sup.post(`/api/time/${theirs}/approve`, { decision: 'approved' })).status, 200);
  assert.equal(timeRow(theirs).status, 'approved');
});

test('H1: a device still submits time (draft -> submitted, and a returned entry resubmitted); a new row cannot arrive approved', async () => {
  const id = await timeEntry('nav', 45);
  const r = await push('nav', { tables: { time_entries: [{ id, status: 'submitted', ...later() }] } });
  assert.deepEqual(r.rejected, []); assert.ok(!flagFor(r, id), 'submitting is not a ruling');
  assert.equal(timeRow(id).status, 'submitted');
  assert.equal((await C.sup.post(`/api/time/${id}/approve`, { decision: 'rejected', note: 'Wrong fund, please fix' })).status, 200);
  // A device that has not seen the return (its copy has no ruling on it) does not resubmit over it unseen...
  const stale = await push('nav', { tables: { time_entries: [{ id, minutes: 41, status: 'submitted', approved_at: null, ...later(7000) }] } });
  assert.deepEqual(stale.rejected, []);
  assert.equal(timeRow(id).status, 'rejected'); assert.equal(timeRow(id).minutes, 41);
  // ...one that pulled the returned entry (the ruling's date as the office has it) corrects and resubmits it.
  const r2 = await push('nav', { tables: { time_entries: [{ id, minutes: 40, status: 'submitted', approved_by: U.sup, approved_at: timeRow(id).approved_at, ...later(9000) }] } });
  assert.deepEqual(r2.rejected, []); assert.ok(!flagFor(r2, id), 'resubmitting is not a ruling');
  assert.equal(timeRow(id).status, 'submitted'); assert.equal(timeRow(id).minutes, 40);
  const nid = randomUUID();
  const r3 = await push('nav', { tables: { time_entries: [{ id: nid, user_id: U.nav, work_date: today, minutes: 20, category: 'admin', status: 'approved', approved_by: U.sup, approved_at: iso(), ...later() }] } });
  assert.deepEqual(r3.rejected, []);
  assert.equal(timeRow(nid).status, 'draft'); assert.equal(timeRow(nid).approved_by, null);
  assert.ok(flagFor(r3, nid));
});

test('H1: an approver\'s device cannot approve its own spending, or rule on anyone\'s: flagged, not applied', async () => {
  const fund = randomUUID();
  H.db.run(`INSERT INTO funding_sources(id,name,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?)`, fund, 'H1 fund', '2020-01-01', '2035-12-31', 10000);
  const e = await C.sup.post('/api/budget/expenditures', { funding_source_id: fund, amount: 5000, spent_at: today, category: 'other', description: 'laptop' });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  // Over REST it is refused (separation of duties)...
  assert.equal((await C.sup.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' })).status, 400);
  // ...and by push it used to land.
  const r = await push('sup', { tables: { expenditures: [{ id: e.data.id, status: 'approved', approved_by: U.sup, approved_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const row = H.db.one(`SELECT * FROM expenditures WHERE id=?`, e.data.id);
  assert.equal(row.status, 'pending'); assert.equal(row.approved_by, null);
  assert.ok(flagFor(r, e.data.id), 'flagged');
  // Another's approved item marked reimbursed from a device: the office's act too.
  const x = randomUUID();
  H.db.run(`INSERT INTO expenditures(id,funding_source_id,user_id,spent_at,amount,category,status,approved_by,approved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, x, fund, U.nav, today, 20, 'supplies', 'approved', U.sup2, iso(), iso(Date.now() - 60000));
  const r2 = await push('sup', { tables: { expenditures: [{ id: x, status: 'reimbursed', ...later(8000) }] } });
  assert.deepEqual(r2.rejected, []);
  assert.equal(H.db.one(`SELECT status FROM expenditures WHERE id=?`, x).status, 'approved');
  assert.ok(flagFor(r2, x));
  // A new expenditure cannot arrive approved either.
  const n = randomUUID();
  const r3 = await push('sup', { tables: { expenditures: [{ id: n, funding_source_id: fund, user_id: U.sup, spent_at: today, amount: 10, category: 'other', status: 'approved', approved_by: U.sup, approved_at: iso(), ...later() }] } });
  assert.deepEqual(r3.rejected, []);
  assert.equal(H.db.one(`SELECT status FROM expenditures WHERE id=?`, n).status, 'pending');
  assert.ok(flagFor(r3, n));
});

test('H1: a note\'s countersignature and whether it needs one are the office\'s: a trainee\'s device cannot drop the requirement or assert a countersignature', async () => {
  const cl = await officeClient('Cosign', 'Case', '1980-01-01', '5550001111'); assign(cl.id, U.trainee);
  const id = randomUUID();
  const r = await push('trainee', { tables: { notes: [{ id, client_id: cl.id, author_id: U.trainee, kind: 'clinical', content_enc: 'Seen today', occurred_at: iso(), status: 'draft', cosign_required: 0, cosigned_by: U.sup, cosigned_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const n = H.db.one(`SELECT * FROM notes WHERE id=?`, id);
  assert.equal(n.cosign_required, 1, 'the author\'s account says every note needs a countersignature');
  assert.equal(n.cosigned_by, null); assert.equal(n.cosigned_at, null);
  assert.ok(flagFor(r, id), 'the asserted countersignature is flagged');
  const r2 = await push('trainee', { tables: { notes: [{ id, cosign_required: 0, content_enc: 'Seen today, edited', ...later(9000) }] } });
  assert.deepEqual(r2.rejected, []);
  assert.equal(H.db.one(`SELECT cosign_required FROM notes WHERE id=?`, id).cosign_required, 1, 'nor lowered on a later edit');
});

test('H1: a CalOMS record\'s extract date is the office\'s: a device can neither clear it (the record would go to DHCS again) nor set it', async () => {
  const cl = await officeClient('Calm', 'Records', '1979-05-05', '5550005555'); assign(cl.id, U.sup);
  const ep = randomUUID(); H.db.run(`INSERT INTO episodes(id,client_id,opened_at,status) VALUES(?,?,?,?)`, ep, cl.id, today, 'open');
  const rec = randomUUID(); const stamp = iso(Date.now() - 3600e3);
  H.db.run(`INSERT INTO caloms_records(id,client_id,episode_id,record_type,record_date,answers_enc,extracted_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, rec, cl.id, ep, 'admission', today, require('../server/crypto').encrypt('{}'), stamp, iso(Date.now() - 60000));
  const r = await push('sup', { tables: { caloms_records: [{ id: rec, client_id: cl.id, episode_id: ep, record_type: 'admission', record_date: today, answers_enc: '{}', provider_id: '1234', extracted_at: null, ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const row = H.db.one(`SELECT extracted_at, provider_id FROM caloms_records WHERE id=?`, rec);
  assert.equal(row.provider_id, '1234', 'the edit lands');
  assert.equal(row.extracted_at, stamp, 'the extract date stands');
  const nid = randomUUID();
  const r2 = await push('sup', { tables: { caloms_records: [{ id: nid, client_id: cl.id, episode_id: ep, record_type: 'annual_update', record_date: today, answers_enc: '{}', extracted_at: iso(), ...later() }] } });
  assert.deepEqual(r2.rejected, []);
  assert.equal(H.db.one(`SELECT extracted_at FROM caloms_records WHERE id=?`, nid).extracted_at, null);
  assert.ok(flagFor(r2, nid), 'an asserted extract date is flagged');
});

// ------------------------------------------------------------------------------------------------ H2
let known;
test('H2: a de-identified role\'s client search matches a client code only: a name, date of birth or phone finds nobody', async () => {
  known = await officeClient('Harriet', 'Whitfieldson', '1975-04-12', '555-010-4477');
  for (const who of ['fin', 'ro']) {
    for (const q of ['Whitfieldson', 'Harriet Whitfieldson', 'Whitfieldson, Harriet', 'whi', 'Witfeldson', '1975-04-12', '555-010-4477', '5550104477']) {
      for (const extra of ['', '&rank=1', '&exact=1']) {
        const r = await C[who].get(`/api/clients?q=${encodeURIComponent(q)}${extra}`);
        assert.equal(r.status, 200, `${who} q=${q}${extra}`);
        assert.equal(r.data.total, 0, `${who}: "${q}"${extra} finds nobody`);
        assert.deepEqual(r.data.clients, [], `${who}: "${q}"${extra} lists nobody`);
      }
    }
    const byCode = await C[who].get(`/api/clients?q=${encodeURIComponent(known.client_code)}`);
    assert.equal(byCode.data.total, 1, `${who}: the client code still finds the record`);
    assert.equal(byCode.data.clients[0].client_code, known.client_code);
    assert.equal(byCode.data.clients[0].first_name, undefined, 'code only');
    assert.equal((await C[who].get(`/api/clients?q=${encodeURIComponent(known.client_code.toLowerCase())}`)).data.total, 1, 'in any case');
  }
});

test('H2: the search is audited by which field it searched, never by what was typed', async () => {
  await C.fin.get(`/api/clients?q=${encodeURIComponent('Harriet Whitfieldson')}`);
  let a = lastAudit('client.list');
  assert.ok(!/Whitfieldson|Harriet/i.test(a.details), 'the name is not in the audit log');
  let d = JSON.parse(a.details);
  assert.deepEqual(d.searched, [], 'a de-identified role searched nothing');
  assert.equal(d.search_refused, 'identifier', 'and the log says an identifier search was refused');
  await C.fin.get(`/api/clients?q=${encodeURIComponent(known.client_code)}`);
  d = JSON.parse(lastAudit('client.list').details);
  assert.deepEqual(d.searched, ['client_code']);
  await C.sup.get(`/api/clients?q=${encodeURIComponent('1975-04-12')}`);
  a = lastAudit('client.list'); d = JSON.parse(a.details);
  assert.deepEqual(d.searched, ['dob']);
  assert.ok(!a.details.includes('1975-04-12'), 'never the value');
  await C.sup.get(`/api/clients?q=Whitfieldson`);
  assert.deepEqual(JSON.parse(lastAudit('client.list').details).searched, ['name']);
  // A role that may open records still finds the person by name.
  assert.equal((await C.sup.get(`/api/clients?q=Whitfieldson`)).data.total, 1);
});

// ------------------------------------------------------------------------------------------------ M1
const grant = (id, permission, mode = 'grant', reason = 'security review test reason') => admin.post(`/api/users/${id}/permissions`, { permission, mode, reason });

test('M1: grants that would let a de-identified role identify clients are refused at grant time', async () => {
  for (const [who, perm] of [['fin', 'clients:read'], ['fin', 'export:identified'], ['ro', 'clients:read'], ['ro', 'export:identified'], ['fin', 'clients:write']]) {
    const r = await grant(U[who], perm);
    assert.equal(r.status, 400, `${perm} to ${who}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, /de-identified|client code/i);
  }
  const r = await grant(U.nav, 'clients:list-deidentified');
  assert.equal(r.status, 400, 'clients:list-deidentified to a role that opens records');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM user_permission_overrides WHERE user_id IN (?,?,?)`, U.fin, U.ro, U.nav).n, 0, 'nothing was stored');
  // Denying them is always allowed (it only takes away).
  assert.equal((await grant(U.nav, 'clients:list-deidentified', 'deny')).status, 200);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, U.nav);
});

test('M1: an override row that breaks those rules (from before 1.15.4) has no effect', async () => {
  const cl = await officeClient('Legacy', 'Override', '1970-02-02', '5550002222');
  // A finance account granted clients:read and export:identified before the check existed.
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'clients:read', 'grant', 'legacy'), (?, 'export:identified', 'grant', 'legacy')`, U.fin, U.fin);
  const fin = H.client(); await fin.login('s154_fin', 'StaffPassw0rd!x');
  assert.equal((await fin.get(`/api/clients/${cl.id}`)).status, 403, 'finance still cannot open a client record');
  const list = await fin.get('/api/clients?limit=5');
  assert.ok(list.data.clients.every(c => c.first_name === undefined && c.last_name === undefined), 'and lists codes only');
  const me = (await fin.get('/api/auth/me')).data.user.permissions;
  assert.ok(!me.includes('clients:read') && !me.includes('export:identified'), JSON.stringify(me));
  const listed = (await admin.get(`/api/users/${U.fin}/permissions`)).data;
  assert.deepEqual(listed.overrides.filter(o => o.no_effect).map(o => o.permission).sort(), ['clients:read', 'export:identified'], 'Users & permissions says the rows do nothing');
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, U.fin);
  // A navigator granted clients:list-deidentified is still scoped to its caseload (it used to see everyone).
  // (From 1.16.0 a navigator holds clients:all by default; one held to their caseload has it denied.)
  H.deny({ id: U.nav2 }, 'clients:all');
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'clients:list-deidentified', 'grant', 'legacy')`, U.nav2);
  const nav2 = H.client(); await nav2.login('s154_nav2', 'StaffPassw0rd!x');
  assert.equal((await nav2.get(`/api/clients/${cl.id}`)).status, 403, 'not on its caseload');
  const l2 = await nav2.get('/api/clients?limit=200');
  assert.ok(!l2.data.clients.some(c => c.id === cl.id), 'nor in its list');
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, U.nav2);
});

test('M1: deny clients:all restores caseload scoping everywhere, and the holder of assignments:manage cannot put themselves on a client they cannot reach', async () => {
  const mine = await officeClient('Mine', 'Onlist', '1981-03-03', '5550003333'); assign(mine.id, U.sup2);
  const other = await officeClient('Other', 'Offlist', '1982-04-04', '5550004444');
  assert.equal((await grant(U.sup2, 'clients:all', 'deny', 'restrict to own caseload')).status, 200);
  const s = H.client(); await s.login('s154_sup2', 'StaffPassw0rd!x');
  assert.equal((await s.get(`/api/clients/${other.id}`)).status, 403, 'REST: another client is out of reach');
  const list = await s.get('/api/clients?limit=500');
  assert.ok(list.data.clients.some(c => c.id === mine.id) && !list.data.clients.some(c => c.id === other.id), 'the list is the caseload');
  assert.equal((await s.get(`/api/clients?q=Offlist`)).data.total, 0, 'search too');
  const pull = await s.get('/api/sync/pull');
  assert.equal(pull.status, 200);
  assert.ok(!(pull.data.tables.clients || []).some(c => c.id === other.id), 'sync pull too');
  assert.equal((await s.get('/api/auth/me')).data.user.caseload_restricted, true);
  const ex = await s.get('/api/reports/export/clients?from=2000-01-01&to=2100-01-01');
  assert.equal(ex.status, 200);
  const lines = String(ex.data).trim().split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  assert.equal(lines.length, 2, `exports too: a header and the one client on the caseload (${lines.length - 1} rows)`);
  // The reviewer's repro: deny clients:all, then self-assign.
  const self = await s.post(`/api/clients/${other.id}/assignments`, { user_id: U.sup2, role_on_case: 'secondary' });
  assert.equal(self.status, 403, JSON.stringify(self.data));
  assert.equal((await s.get(`/api/clients/${other.id}`)).status, 403, 'still out of reach');
  // Nor put anyone else on it, and not by sync either.
  assert.equal((await s.post(`/api/clients/${other.id}/assignments`, { user_id: U.nav, role_on_case: 'secondary' })).status, 403);
  const p = await s.post('/api/sync/push', { device_now: iso(), tables: { assignments: [{ id: randomUUID(), client_id: other.id, user_id: U.sup2, role_on_case: 'secondary', start_date: today, ...later() }] } });
  assert.equal(p.data.rejected.length, 1, JSON.stringify(p.data));
  // Nor move another worker's caseload to themselves ("Move a caseload"): only clients they can reach move.
  assign(other.id, U.nav2);
  const tr = await s.post('/api/caseload/transfer', { from_user_id: U.nav2, to_user_id: U.sup2, client_ids: [other.id] });
  assert.equal(tr.status, 200, JSON.stringify(tr.data));
  assert.equal(tr.data.transferred, 0); assert.equal(tr.data.not_on_caseload, 1);
  assert.equal((await s.get(`/api/clients/${other.id}`)).status, 403, 'still out of reach after a transfer');
  // On a client on the caseload, managing the team works as before.
  assert.equal((await s.post(`/api/clients/${mine.id}/assignments`, { user_id: U.nav, role_on_case: 'secondary' })).status, 201);
  // And with clients:all (the role default), any client.
  assert.equal((await C.sup.post(`/api/clients/${other.id}/assignments`, { user_id: U.nav2, role_on_case: 'secondary' })).status, 201);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, U.sup2);
});

test('M1: assignments:manage, clients:read and clients:list-deidentified are rated sensitive in the catalog', async () => {
  const cat = (await admin.get('/api/permissions/catalog')).data.permissions;
  for (const p of ['assignments:manage', 'clients:read', 'clients:list-deidentified']) assert.equal(cat.find(x => x.name === p).risk, 'sensitive', p);
});

// ------------------------------------------------------------------------------------------------ M2
test('M2: privileged grants do not survive a role change, and a demoted account cannot promote itself back (the reviewer\'s repro)', async () => {
  const nu = await admin.post('/api/users', { username: 's154_evil2', display_name: 'Evil Two', role: 'admin', password: 'Lantern2026!!x' });
  assert.equal(nu.status, 201, JSON.stringify(nu.data));
  assert.equal((await grant(nu.data.id, 'users:manage', 'grant', 'belt and braces grant')).status, 200);
  assert.equal((await grant(nu.data.id, 'settings:manage', 'grant', 'belt and braces grant')).status, 200);
  assert.equal((await admin.put(`/api/users/${nu.data.id}`, { role: 'navigator' })).status, 200);
  const p = await admin.get(`/api/users/${nu.data.id}/permissions`);
  assert.equal(p.data.role, 'navigator');
  assert.ok(!p.data.effective.includes('users:manage') && !p.data.effective.includes('settings:manage'), JSON.stringify(p.data.effective));
  assert.ok(!p.data.overrides.some(o => ['users:manage', 'settings:manage'].includes(o.permission)), 'the grants were removed');
  const rm = H.db.all(`SELECT details FROM audit_log WHERE action='user.permission.revoke' AND entity_id=?`, nu.data.id);
  assert.equal(rm.length, 2, 'each removal is audited');
  assert.ok(rm.every(x => /"cause":"role_change"/.test(x.details)));
  // Even a row put back by hand does nothing for a non-administrator.
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'users:manage', 'grant', 'hand-edited')`, nu.data.id);
  H.db.run(`UPDATE users SET must_change_password=0 WHERE id=?`, nu.data.id);
  const evil = H.client(); await evil.login('s154_evil2', 'Lantern2026!!x');
  assert.equal((await evil.get('/api/users')).data.users[0].username, undefined, 'the directory only, not the admin list');
  const self = await evil.put(`/api/users/${nu.data.id}`, { role: 'admin' });
  assert.equal(self.status, 403, 'self-promotion refused');
  assert.equal(H.db.one(`SELECT role FROM users WHERE id=?`, nu.data.id).role, 'navigator');
});

// Until 1.23.5 an administrator could not change their own role at all. The owner's decision after it: they may,
// while another active account can manage users (auth.lockoutProblem; test/admin-self-permissions.test.js); once
// demoted they cannot promote themselves back, as the repro above shows (users:manage is an administrator's alone).
test('M2: an administrator may change their own role while another administrator remains, and cannot undo it themselves', async () => {
  const a2 = H.makeUser('s154_admin2', 'admin');
  const c = H.client(); await c.login(a2.username, a2.password);
  // Saving their own profile with the role unchanged is fine, as before.
  assert.equal((await c.put(`/api/users/${a2.id}`, { role: 'admin', title: 'Director' })).status, 200);
  assert.equal((await c.put(`/api/users/${a2.id}`, { role: 'supervisor' })).status, 200);
  assert.equal((await c.put(`/api/users/${a2.id}`, { role: 'admin' })).status, 403, 'no way back on their own');
  assert.equal(H.db.one(`SELECT role FROM users WHERE id=?`, a2.id).role, 'supervisor');
});

// ------------------------------------------------------------------------------------------------ L2
test('L2: an override reason is bounded and kept out of the audit log; a deny is audited as a deny; revoking needs a reason', async () => {
  const long = 'x'.repeat(301);
  assert.equal((await grant(U.nav, 'audit:read', 'grant', long)).status, 400, 'over 300 characters');
  const reason = 'Covers the privacy officer while on leave';
  assert.equal((await grant(U.nav, 'audit:read', 'grant', reason)).status, 200);
  let a = lastAudit('user.permission.grant', U.nav);
  assert.ok(!a.details.includes('privacy officer'), 'not the reason itself');
  assert.equal(JSON.parse(a.details).reason_length, reason.length);
  assert.equal(JSON.parse(a.details).reason_sha256, require('node:crypto').createHash('sha256').update(reason).digest('hex'), 'and a hash to check a stated reason against');
  assert.equal((await grant(U.nav, 'calls:*', 'deny', 'Front desk only for now')).status, 200);
  a = lastAudit('user.permission.deny', U.nav);
  assert.ok(a, 'a deny is audited as user.permission.deny');
  assert.equal(JSON.parse(a.details).permission, 'calls:*');
  assert.ok(!lastAudit('user.permission.grant', U.nav).details.includes('calls:*'), 'and not as a grant');
  // Revoking: a reason, the same bounds.
  assert.equal((await admin.del(`/api/users/${U.nav}/permissions/audit:read`)).status, 400, 'no reason');
  assert.equal((await admin.del(`/api/users/${U.nav}/permissions/audit:read`, { reason: 'short' })).status, 400, 'too short');
  assert.equal((await admin.del(`/api/users/${U.nav}/permissions/audit:read`, { reason: long })).status, 400, 'too long');
  const ok = await admin.del(`/api/users/${U.nav}/permissions/audit:read`, { reason: 'Privacy officer is back from leave' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  a = lastAudit('user.permission.revoke', U.nav);
  const d = JSON.parse(a.details);
  assert.equal(d.permission, 'audit:read'); assert.equal(d.mode, 'grant');
  assert.ok(!a.details.includes('leave'), 'neither reason in the audit log');
  assert.equal(d.revoke_reason_length, 'Privacy officer is back from leave'.length);
  await admin.del(`/api/users/${U.nav}/permissions/calls:*`, { reason: 'Back to the full role' });
});
