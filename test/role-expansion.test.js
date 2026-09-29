'use strict';
// 1.16.0: the owner widened two roles' defaults (expansion only; nobody lost a permission).
//   navigator  + clients:all (outreach engages whoever walks in) + notes:clinical:read (read only)
//   clinician  + clients:all (coverage, on-call)                 + budget:read (no budget:write)
// With clients:all a navigator or clinician is no longer caseload-scoped. A programme that wants a person held
// to their caseload denies them clients:all with a per-user override (1.15.0, server/auth.js effectivePerms),
// and this file checks that the deny restores the scoping everywhere it applied: the client list and search,
// a record and its timeline, the duplicate check at intake, exports, the dashboard, sync, and another worker's
// records with no client. Likewise a deny of notes:clinical:read takes clinical notes away from a navigator
// again, on every path that shows them.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const auth = require('../server/auth');

const PW = 'StaffPassw0rd!x';
let sup, clinU, navA, navB, scoped, noClin;
const c = {};
const ids = {};
const rowsIn = (csv) => (csv.trim() ? csv.trim().split('\n').length - 1 : 0);

async function pullAll(cl) {
  const tables = {}; let cursor = '';
  for (let i = 0; i < 50; i++) {
    const r = await cl.get('/api/sync/pull' + (cursor ? '?since=' + encodeURIComponent(cursor) : ''));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const [k, v] of Object.entries(r.data.tables)) (tables[k] = tables[k] || []).push(...v);
    cursor = r.data.cursor; if (r.data.complete) break;
  }
  return tables;
}

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  sup = H.makeUser('rx_sup', 'supervisor'); clinU = H.makeUser('rx_clin', 'clinician');
  navA = H.makeUser('rx_navA', 'navigator'); navB = H.makeUser('rx_navB', 'navigator');
  // The same navigator role, held to their caseload by the programme: clients:all denied (and, separately,
  // a navigator with clinical notes denied).
  scoped = H.deny(H.makeUser('rx_scoped', 'navigator'), 'clients:all');
  noClin = H.deny(H.makeUser('rx_noclin', 'navigator'), 'notes:clinical:read');
  for (const u of [sup, clinU, navA, navB, scoped, noClin]) { c[u.username] = H.client(); await c[u.username].login(u.username, PW); }
  const mk = async (who, path, body) => { const r = await c[who].post(path, body); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.data)}`); return r.data.id; };
  // navB's client (not on the scoped navigator's caseload) and the scoped navigator's own client.
  ids.theirs = await mk('rx_navB', '/api/clients', { first_name: 'Quincy', last_name: 'Rxtheirs', dob: '1980-02-03', phone: '916-555-0142' });
  ids.own = await mk('rx_scoped', '/api/clients', { first_name: 'Olive', last_name: 'Rxownclient', dob: '1985-04-05' });
  // A clinician's clinical note on navB's client, and navB's crisis call with no client.
  ids.clinical = await mk('rx_clin', '/api/notes', { client_id: ids.theirs, kind: 'clinical', format: 'narrative', title: 'Rx clinical session', content: 'Rx clinical content: discussed relapse triggers', occurred_at: new Date().toISOString() });
  ids.call = await mk('rx_navB', '/api/calls', { direction: 'inbound', method: 'phone', started_at: new Date().toISOString(), contact_name: 'Rx Walkin Caller', phone: '916-555-0199', summary: 'wants detox', crisis: true });
});
after(() => H.stop());

test('the role matrix: exactly the four grants, and nothing else moved', () => {
  const P = auth.PERMS;
  for (const p of ['clients:all', 'notes:clinical:read']) assert.ok(P.navigator.includes(p), `navigator holds ${p}`);
  for (const p of ['notes:clinical:write', 'assessments:*', 'budget:approve', 'budget:manage', 'export:identified', 'assignments:manage', 'notes:cosign']) assert.ok(!P.navigator.includes(p), `navigator does not hold ${p}`);
  for (const p of ['clients:all', 'budget:read']) assert.ok(P.clinician.includes(p), `clinician holds ${p}`);
  for (const p of ['budget:write', 'budget:approve', 'budget:manage', 'export:identified', 'assignments:manage', 'notes:cosign']) assert.ok(!P.clinician.includes(p), `clinician does not hold ${p}`);
  for (const p of ['notes:clinical:write', 'budget:write', 'budget:approve', 'budget:manage', 'clients:all', 'export:identified']) assert.ok(P.supervisor.includes(p), `supervisor keeps ${p}`);
  for (const p of ['export:identified', 'clients:read', 'clients:all']) assert.ok(!P.finance.includes(p), `finance never holds ${p}`);
  assert.ok(!P.admin.includes('notes:clinical:read'), 'an administrator still reads clinical notes only by break-glass');
  assert.ok(!P.readonly.includes('clients:all') && !P.readonly.includes('clients:read'));
  // Every role's list without the 1.16.0 additions (auth.WIDENED_1_16) is the 1.15.3 matrix, byte for byte:
  // nothing else was added, removed or reordered. The digest was taken from 1.15.3's server/auth.js PERMS.
  assert.deepEqual(auth.WIDENED_1_16, { navigator: ['clients:all', 'notes:clinical:read'], clinician: ['clients:all', 'budget:read'] });
  for (const [role, added] of Object.entries(auth.WIDENED_1_16)) for (const p of added) assert.ok(P[role].includes(p));
  // records:manage-others (1.16.0) is what supervisors and administrators held through clients:all before: new to
  // them as a string, not as a power, and held by no other role.
  for (const r of ['admin', 'supervisor']) assert.ok(P[r].includes('records:manage-others'), `${r} holds records:manage-others`);
  for (const r of ['navigator', 'clinician', 'finance', 'readonly']) assert.ok(!P[r].includes('records:manage-others'), `${r} does not`);
  // ai:draft (1.17.0, the AI documentation copilot) is a new power, not a widening of an old one: left out here
  // and pinned to its roles in test/ai-copilot.test.js.
  const before = Object.fromEntries(Object.entries(P).map(([r, l]) => [r, l.filter(p => !(auth.WIDENED_1_16[r] || []).includes(p) && p !== 'records:manage-others' && p !== 'ai:draft')]));
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(before)).digest('hex'), 'b3d0a221beace6b231f76250d399b836bdd4d8f3e92899f67dfda9396c292eb4', 'the rest of the matrix is 1.15.3\'s');
});

test('a navigator now sees every client: another worker\'s client opens, lists, searches and syncs', async () => {
  assert.equal((await c.rx_navA.get(`/api/clients/${ids.theirs}`)).status, 200);
  assert.equal((await c.rx_navA.get(`/api/clients/${ids.theirs}/timeline`)).status, 200);
  const s = await c.rx_navA.get('/api/clients?q=Rxtheirs');
  assert.ok(s.data.clients.some(x => x.id === ids.theirs), 'search finds them');
  const me = await c.rx_navA.get('/api/auth/me');
  assert.equal(me.data.user.caseload_restricted, false);
  const pull = await pullAll(c.rx_navA);
  assert.ok(pull.clients.some(x => x.id === ids.theirs), 'and a device pulls them');
  const dup = await c.rx_navA.post('/api/clients/check-duplicates', { first_name: 'Quincy', last_name: 'Rxtheirs', dob: '1980-02-03' });
  assert.ok(dup.data.matches.some(m => m.id === ids.theirs), 'the duplicate check at intake shows the record itself');
  assert.equal((await c.rx_navA.get(`/api/calls/${ids.call}`)).status, 200, 'and another worker\'s call with no client (the unlinked-record rule follows clients:all)');
});

test('a clinician sees every client and the budget, and still cannot record spending', async () => {
  assert.equal((await c.rx_clin.get(`/api/clients/${ids.own}`)).status, 200);
  assert.equal((await c.rx_clin.get('/api/budget/summary')).status, 200, 'budget:read');
  const funds = await c.rx_clin.get('/api/budget/funds');
  assert.equal(funds.status, 200);
  const e = await c.rx_clin.post('/api/budget/expenditures', { spent_at: new Date().toISOString().slice(0, 10), amount: 5, category: 'client_assistance' });
  assert.equal(e.status, 403, 'no budget:write');
});

test('a navigator reads a clinical note (list, by id, timeline, sync) but cannot write, sign or add to one', async () => {
  const one = await c.rx_navA.get(`/api/notes/${ids.clinical}`);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.match(one.data.note.content, /relapse triggers/);
  const list = await c.rx_navA.get(`/api/notes?client_id=${ids.theirs}`);
  assert.ok(JSON.stringify(list.data).includes(ids.clinical), 'listed');
  const tl = await c.rx_navA.get(`/api/clients/${ids.theirs}/timeline`);
  assert.ok(JSON.stringify(tl.data).includes(ids.clinical), 'on the timeline');
  const pull = await pullAll(c.rx_navA);
  assert.ok(pull.notes.some(n => n.id === ids.clinical), 'synced to their device');
  const w = await c.rx_navA.post('/api/notes', { client_id: ids.theirs, kind: 'clinical', format: 'narrative', title: 'x', content: 'x', occurred_at: new Date().toISOString() });
  assert.equal(w.status, 403, 'writing one is notes:clinical:write');
  const put = await c.rx_navA.put(`/api/notes/${ids.clinical}`, { content: 'changed' });
  assert.equal(put.status, 403, 'editing one too');
  const add = await c.rx_navA.post(`/api/notes/${ids.clinical}/addenda`, { content: 'late entry' });
  assert.ok(add.status === 403 || add.status === 400, `no addendum to a clinical note (${add.status})`);
});

test('override deny of clients:all restores caseload scoping: record, timeline, list, search, duplicate check', async () => {
  const s = c.rx_scoped;
  assert.equal((await s.get('/api/auth/me')).data.user.caseload_restricted, true);
  assert.equal((await s.get(`/api/clients/${ids.theirs}`)).status, 403);
  assert.equal((await s.get(`/api/clients/${ids.theirs}/timeline`)).status, 403);
  assert.equal((await s.get(`/api/clients/${ids.own}`)).status, 200, 'their own client still opens');
  const list = await s.get('/api/clients?status=all&limit=500');
  assert.deepEqual(list.data.clients.map(x => x.id), [ids.own], 'the list holds only their caseload');
  assert.equal((await s.get('/api/clients?q=Rxtheirs')).data.clients.length, 0, 'search does not find another caseload\'s client');
  const dup = await s.post('/api/clients/check-duplicates', { first_name: 'Quincy', last_name: 'Rxtheirs', dob: '1980-02-03' });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.matches.length, 0, 'the duplicate check shows nothing it cannot open');
  assert.ok(!JSON.stringify(dup.data).includes('Rxtheirs'));
  assert.equal((await s.get(`/api/calls/${ids.call}`)).status, 403, 'another worker\'s call with no client is theirs again');
  assert.equal((await s.get(`/api/notes/${ids.clinical}`)).status, 403, 'a note on a client off the caseload');
});

test('override deny of clients:all restores caseload scoping: exports, dashboard and reports', async () => {
  const exp = async (cl) => { const r = await cl.raw('/api/reports/export/clients?from=2000-01-01&to=2040-12-31'); assert.equal(r.status, 200); return rowsIn(await r.text()); };
  assert.equal(await exp(c.rx_scoped), 1, 'the de-identified clients export holds their one client');
  assert.equal(await exp(c.rx_navA), await exp(c.rx_sup), 'a navigator with the default role exports the whole programme, as a supervisor does');
  const dash = async (cl) => { const r = await cl.get('/api/reports/dashboard'); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.clients; };
  const [mine, all] = [await dash(c.rx_scoped), await dash(c.rx_sup)];
  assert.ok(mine.active <= 1 && all.active >= 2, `the dashboard counts only their caseload (${mine.active} of ${all.active})`);
  assert.equal((await dash(c.rx_navA)).active, all.active, 'the default navigator\'s dashboard is the programme\'s');
  // Home's to-do counts stay a front-line worker's own: the team's are for someone who supervises (countersigns).
  assert.equal((await c.rx_navA.get('/api/reports/dashboard')).data.tasks.team, false, 'a navigator\'s Home counts their own to-dos');
  assert.equal((await c.rx_sup.get('/api/reports/dashboard')).data.tasks.team, true, 'a supervisor\'s counts the team\'s');
  assert.equal(auth.reportRunAllowed({ id: scoped.id, role: 'navigator' }), false, 'no whole-programme internal report run');
  assert.equal(auth.reportRunAllowed({ id: scoped.id, role: 'navigator' }, { caseloadScoped: true }), true, 'its own caseload\'s, as before');
});

test('override deny of clients:all restores caseload scoping on sync', async () => {
  const pull = await pullAll(c.rx_scoped);
  const clientIds = pull.clients.map(x => x.id);
  assert.ok(clientIds.includes(ids.own) && !clientIds.includes(ids.theirs), 'only their caseload travels');
  assert.ok(!(pull.notes || []).some(n => n.id === ids.clinical));
  assert.ok(!(pull.calls || []).some(x => x.id === ids.call), 'nor another worker\'s unlinked call');
  // And a push touching another caseload's client is refused, as before.
  const push = await c.rx_scoped.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { interventions: [{ id: require('node:crypto').randomUUID(), client_id: ids.theirs, user_id: scoped.id, type: 'outreach', occurred_at: new Date().toISOString(), updated_at: new Date().toISOString() }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.equal(push.data.rejected.length, 1, 'refused as off the caseload');
  assert.ok(!H.db.one(`SELECT 1 FROM interventions WHERE client_id=? AND user_id=?`, ids.theirs, scoped.id), 'the pushed visit on another caseload was not stored');
});

test('override deny of notes:clinical:read takes clinical notes away from a navigator again, everywhere', async () => {
  const n = c.rx_noclin;
  assert.equal((await n.get(`/api/clients/${ids.theirs}`)).status, 200, 'still sees every client');
  assert.equal((await n.get(`/api/notes/${ids.clinical}`)).status, 403);
  assert.ok(!JSON.stringify((await n.get(`/api/notes?client_id=${ids.theirs}`)).data).includes(ids.clinical), 'not listed');
  assert.ok(!JSON.stringify((await n.get(`/api/clients/${ids.theirs}/timeline`)).data).includes('Rx clinical session'), 'not on the timeline');
  const pull = await pullAll(n);
  assert.ok(!(pull.notes || []).some(x => x.id === ids.clinical), 'and not synced');
});

test('a client a navigator creates is still assigned to them, over REST and from a device, though they see everyone', async () => {
  const rest = await c.rx_navA.post('/api/clients', { first_name: 'Rita', last_name: 'Rxrestmade', dob: '1990-06-07' });
  assert.equal(rest.status, 201);
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=?`, rest.data.id, navA.id), 'POST /api/clients assigns the creator');
  const id = require('node:crypto').randomUUID(); const now = new Date().toISOString();
  const r = await c.rx_navA.post('/api/sync/push', { device_now: now, tables: { clients: [{ id, client_code: 'RX-dev', first_name_enc: 'Devon', last_name_enc: 'Rxdevicemade', status: 'active', created_at: now, updated_at: now }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.rejected, []);
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=?`, id, navA.id), 'and so does a device\'s new client (server/rules/clients.js), so denying clients:all later leaves it on their caseload');
});

// A device that synced before 1.16.0 holds what the 1.15 defaults allowed. Its first pull after the upgrade says
// so (scope=legacy, local/sync.js) and the office starts that pull again from the beginning when the person may
// now read more, so the device does not end up with the rest of the programme only as its rows happen to change
// (server/routes/sync.js syncScopeKey). A person the programme held to the old scope before the device synced
// again sees no change at all.
test('a device from before 1.16.0: widened defaults restart its pull; a person held to the old scope sees no change', async () => {
  const first = async (cl, since, scope) => { const r = await cl.get(`/api/sync/pull?since=${encodeURIComponent(since)}${scope ? '&scope=' + encodeURIComponent(scope) : ''}`); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  const later = new Date(Date.now() + 60_000).toISOString(); // a cursor after every row here
  const nA = await first(c.rx_navA, later, 'legacy');
  assert.equal(nA.scope_widened, true, 'a default navigator may now read more');
  assert.ok(nA.tables.clients.some(x => x.id === ids.theirs), 'so the pull starts again and sends another worker\'s client');
  assert.ok(nA.tables.notes.some(x => x.id === ids.clinical), 'and the clinical note');
  assert.equal(nA.dropped_clients.length + nA.dropped_rows.length, 0, 'and removes nothing');
  const cl = await first(c.rx_clin, later, 'legacy');
  assert.equal(cl.scope_widened, true, 'a clinician too (clients:all, budget:read)');
  const both = H.deny(H.makeUser('rx_both', 'navigator'), 'clients:all', 'notes:clinical:read');
  const cb = H.client(); await cb.login('rx_both', PW);
  const kept = await first(cb, later, 'legacy');
  assert.ok(!kept.scope_changed, 'denied both before syncing again: nothing to change');
  assert.equal(kept.tables.clients.length, 0, 'and the pull carries on from the device\'s cursor');
  // The key the office sent last time, sent back unchanged, is no change either.
  const now = await first(c.rx_navA, later, nA.scope);
  assert.ok(!now.scope_changed && now.tables.clients.length === 0);
  // Denied clients:all after syncing with it: every client off their caseload is named for removal.
  const s = await first(c.rx_scoped, later, nA.scope);
  assert.equal(s.scope_changed, true);
  assert.ok(s.dropped_clients.includes(ids.theirs) && !s.dropped_clients.includes(ids.own), 'another worker\'s client goes; their own stays');
  assert.ok(s.dropped_rows.some(([t, id]) => t === 'calls' && id === ids.call), 'and another worker\'s call with no client');
  assert.ok(!s.dropped_rows.some(([t]) => t === 'notes'), 'clinical notes stay: only clients:all was denied');
  // Each pull carries the person's own overrides, for the device's kernel to apply.
  assert.deepEqual(s.permission_overrides.map(o => [o.permission, o.mode]), [['clients:all', 'deny']]);
  assert.equal(s.settings.caseload_restriction, '1');
});

// Self-assignment must not undo a deny of clients:all: a person held to their caseload cannot put themselves on
// another worker's client and so reach it (security review of 1.15.3, M1). A navigator never holds
// assignments:manage; a supervisor held to a caseload does, and the office refuses them a client they cannot reach
// (1.15.4, server/routes/assignments.js and server/rules/assignments.js), over REST and from a device.
test('a deny of clients:all holds against self-assignment', async () => {
  const self = await c.rx_scoped.post(`/api/clients/${ids.theirs}/assignments`, { user_id: scoped.id, role_on_case: 'primary' });
  assert.equal(self.status, 403, 'a navigator cannot assign themselves (no assignments:manage)');
  assert.equal((await c.rx_scoped.get(`/api/clients/${ids.theirs}`)).status, 403, 'and still cannot open the client');
});
test('a supervisor held to a caseload cannot assign themselves past it', async () => {
  const heldSup = H.deny(H.makeUser('rx_heldsup', 'supervisor'), 'clients:all');
  const hs = H.client(); await hs.login('rx_heldsup', PW);
  const r = await hs.post(`/api/clients/${ids.theirs}/assignments`, { user_id: heldSup.id, role_on_case: 'primary' });
  assert.ok([403, 404].includes(r.status), `a supervisor held to a caseload cannot assign themselves to a client off it (${r.status})`);
  assert.ok(!H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=?`, ids.theirs, heldSup.id), 'no assignment was made');
  assert.equal((await hs.get(`/api/clients/${ids.theirs}`)).status, 403);
  const push = await hs.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { assignments: [{ id: require('node:crypto').randomUUID(), client_id: ids.theirs, user_id: heldSup.id, role_on_case: 'primary', start_date: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() }] } });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.ok(!H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=?`, ids.theirs, heldSup.id), 'nor from a device');
});

// The owner's decision for 1.16.0: navigators and clinicians SEE every client and add their own work to any
// record, but do not manage other workers' records. That power is records:manage-others (supervisors and
// administrators, who held it through clients:all before): changing or deleting another worker's visits, calls,
// overdose reports, to-dos and draft notes, recording work under another worker's name, soft-deleting a client,
// and seeing another worker's staged imports. REST and sync push enforce it from the same rules (server/rules/*).
test('see everyone, change only your own: navigators and clinicians add to any client but cannot manage others\' records', async () => {
  const now = () => new Date().toISOString();
  const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
  // navB's records on navB's client.
  const mine = {};
  mine.visit = expect(await c.rx_navB.post('/api/interventions', { client_id: ids.theirs, type: 'outreach', occurred_at: now(), duration_minutes: 10 }), 201, 'navB visit').id;
  mine.call = expect(await c.rx_navB.post('/api/calls', { client_id: ids.theirs, direction: 'outbound', method: 'phone', started_at: now(), summary: 'check-in' }), 201, 'navB call').id;
  mine.od = expect(await c.rx_navB.post('/api/overdose-events', { client_id: ids.theirs, occurred_at: now(), kind: 'reversal' }), 201, 'navB overdose').id;
  mine.task = expect(await c.rx_navB.post('/api/tasks', { client_id: ids.theirs, title: 'Rx follow up' }), 201, 'navB task').id;
  mine.note = expect(await c.rx_navB.post('/api/notes', { client_id: ids.theirs, kind: 'admin', format: 'narrative', title: 'Rx draft', content: 'draft by navB', occurred_at: now() }), 201, 'navB draft note').id;
  const row = (t, id) => H.db.one(`SELECT * FROM ${t} WHERE id=?`, id);
  for (const who of ['rx_navA', 'rx_clin']) {
    const cl = c[who];
    // Sees, and adds their own work.
    expect(await cl.get(`/api/clients/${ids.theirs}`), 200, `${who} opens the client`);
    expect(await cl.post('/api/interventions', { client_id: ids.theirs, type: 'outreach', occurred_at: now(), duration_minutes: 5 }), 201, `${who} adds a visit`);
    expect(await cl.post('/api/notes', { client_id: ids.theirs, kind: 'admin', format: 'narrative', title: 'mine', content: `${who} note`, occurred_at: now() }), 201, `${who} adds a note`);
    // Cannot change or delete another worker's records.
    for (const [path, body] of [[`/api/interventions/${mine.visit}`, { duration_minutes: 99 }], [`/api/calls/${mine.call}`, { summary: 'changed' }], [`/api/overdose-events/${mine.od}`, { kind: 'overdose' }], [`/api/tasks/${mine.task}`, { title: 'changed' }], [`/api/notes/${mine.note}`, { content: 'changed' }]]) {
      assert.equal((await cl.put(path, body)).status, 403, `${who} PUT ${path}`);
      assert.equal((await cl.del(path)).status, 403, `${who} DELETE ${path}`);
    }
    assert.equal(row('interventions', mine.visit).duration_minutes, 10, 'the visit is unchanged');
    // Cannot record work under another worker's name: REST puts it under their own; sync push refuses it.
    const as = expect(await cl.post('/api/interventions', { client_id: ids.theirs, type: 'outreach', occurred_at: now(), duration_minutes: 5, user_id: navB.id }), 201, `${who} names another worker`);
    const me = who === 'rx_navA' ? navA : clinU;
    assert.equal(row('interventions', as.id).user_id, me.id, 'recorded under their own name, not navB\'s');
    const id = require('node:crypto').randomUUID();
    const p = expect(await cl.post('/api/sync/push', { device_now: now(), tables: { interventions: [{ id, client_id: ids.theirs, user_id: navB.id, type: 'outreach', occurred_at: now(), duration_minutes: 5, updated_at: now() }] } }), 200, 'push');
    assert.ok(p.rejected.some(x => x.id === id && /another user/.test(x.reason)), `${who}: a device cannot attribute a visit to navB (${JSON.stringify(p.rejected)})`);
    // Nor edit or delete another worker's visit from a device.
    const v = row('interventions', mine.visit);
    const pe = expect(await cl.post('/api/sync/push', { device_now: now(), tables: { interventions: [{ ...v, duration_minutes: 77, updated_at: new Date(Date.now() + 1000).toISOString() }] } }), 200, 'push edit');
    assert.ok(pe.rejected.some(x => x.id === mine.visit && /not permitted/.test(x.reason)), `${who}: push edit refused (${JSON.stringify(pe.rejected)})`);
    const pd = expect(await cl.post('/api/sync/push', { device_now: now(), tombstones: [{ table_name: 'interventions', id: mine.visit, deleted_at: now() }] }), 200, 'push tombstone');
    assert.ok(pd.rejected.some(x => x.id === mine.visit && /not permitted/.test(x.reason)), `${who}: push delete refused (${JSON.stringify(pd.rejected)})`);
    assert.equal(row('interventions', mine.visit).duration_minutes, 10);
    // Cannot soft-delete a client record.
    assert.equal((await cl.del(`/api/clients/${ids.theirs}`, { reason: 'entered in error by test' })).status, 403, `${who} cannot remove a client`);
    const pc = expect(await cl.post('/api/sync/push', { device_now: now(), tables: { clients: [{ ...row('clients', ids.theirs), deleted_at: now(), removed_reason_enc: 'test', updated_at: new Date(Date.now() + 2000).toISOString() }] } }), 200, 'push client delete');
    assert.ok(!row('clients', ids.theirs).deleted_at, `${who}: a device cannot remove the client either (${JSON.stringify(pc.rejected)})`);
  }
  // A supervisor and an administrator still can.
  for (const [cl, label] of [[c.rx_sup, 'supervisor'], [null, 'admin']]) {
    const k = cl || H.client(); if (!cl) await k.login('admin', 'AdminPassw0rd!x');
    assert.equal((await k.put(`/api/interventions/${mine.visit}`, { duration_minutes: label === 'admin' ? 12 : 11 })).status, 200, `${label} edits another worker's visit`);
    assert.equal((await k.put(`/api/tasks/${mine.task}`, { title: `edited by ${label}` })).status, 200, `${label} edits another worker's to-do`);
  }
  assert.equal((await c.rx_sup.del(`/api/calls/${mine.call}`)).status, 200, 'a supervisor deletes another worker\'s call');
  const gone = expect(await c.rx_navB.post('/api/clients', { first_name: 'Remy', last_name: 'Rxremoved' }), 201, 'a client to remove').id;
  assert.equal((await c.rx_sup.del(`/api/clients/${gone}`, { reason: 'entered in error by test' })).status, 200, 'a supervisor removes a client record');
});

test('another worker\'s staged imports stay theirs; records:manage-others is granted only to a role that records client work', async () => {
  const imp = require('node:crypto').randomUUID();
  H.db.run(`INSERT INTO imports(id,source,imported_by) VALUES(?,?,?)`, imp, 'onenote', navB.id);
  const listed = async (cl) => JSON.stringify((await cl.get('/api/imports')).data).includes(imp);
  assert.equal(await listed(c.rx_navA), false, 'a navigator does not see another worker\'s import');
  assert.equal(await listed(c.rx_clin), false, 'nor a clinician');
  assert.equal(await listed(c.rx_navB), true, 'its importer does');
  assert.equal(await listed(c.rx_sup), true, 'a supervisor does');
  assert.ok(!(await pullAll(c.rx_navA)).imports?.some(x => x.id === imp), 'and it does not sync to another navigator\'s device');
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  const fin = H.makeUser('rx_fin', 'finance');
  assert.equal((await admin.post(`/api/users/${fin.id}/permissions`, { permission: 'records:manage-others', mode: 'grant', reason: 'test: should be refused' })).status, 400, 'never to finance');
  assert.equal((await admin.post(`/api/users/${navA.id}/permissions`, { permission: 'records:manage-others', mode: 'grant', reason: 'team lead covering for a supervisor' })).status, 200, 'a navigator may be granted it');
  assert.equal(await listed(c.rx_navA), true, 'and then sees other workers\' imports');
  assert.equal((await admin.del(`/api/users/${navA.id}/permissions/records:manage-others`, { reason: 'cover ended, back to own work' })).status, 200);
  const cat = (await admin.get('/api/permissions/catalog')).data.permissions.find(p => p.name === 'records:manage-others');
  assert.equal(cat.risk, 'sensitive');
});

// records:manage-others under the 1.15.4 M2 invariant (permissions.js grantProblem): a grant a role may not hold is
// refused, removed when the role changes (audited, cause role_change) and ignored at request time, so a navigator
// given it who is later made finance or read-only does not keep it, and a row put in by hand does nothing.
test('records:manage-others does not survive a role change to one that records no client work, and a stray grant does nothing', async () => {
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  const lead = H.makeUser('rx_lead', 'navigator');
  const cl = H.client(); await cl.login('rx_lead', PW);
  const gr = await admin.post(`/api/users/${lead.id}/permissions`, { permission: 'records:manage-others', mode: 'grant', reason: 'team lead covering for a supervisor' });
  assert.equal(gr.status, 200, JSON.stringify(gr.data));
  assert.ok((await cl.get('/api/auth/me')).data.user.permissions.includes('records:manage-others'), 'a navigator holds the grant');
  // A move between roles that record client work keeps it.
  assert.equal((await admin.put(`/api/users/${lead.id}`, { role: 'clinician' })).status, 200);
  let p = (await admin.get(`/api/users/${lead.id}/permissions`)).data;
  assert.ok(p.effective.includes('records:manage-others') && p.overrides.some(o => o.permission === 'records:manage-others'), 'navigator to clinician keeps it');
  // To finance: removed, and the removal audited.
  assert.equal((await admin.put(`/api/users/${lead.id}`, { role: 'finance' })).status, 200);
  p = (await admin.get(`/api/users/${lead.id}/permissions`)).data;
  assert.ok(!p.effective.includes('records:manage-others'), JSON.stringify(p.effective));
  assert.ok(!p.overrides.some(o => o.permission === 'records:manage-others'), 'the grant was removed');
  const rm = H.db.all(`SELECT details FROM audit_log WHERE action='user.permission.revoke' AND entity_id=?`, lead.id);
  assert.ok(rm.some(x => /records:manage-others/.test(x.details) && /"cause":"role_change"/.test(x.details)), JSON.stringify(rm));
  // A row put back by hand (or left from before) is ignored at request time and marked as having no effect.
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'records:manage-others', 'grant', 'hand-edited')`, lead.id);
  const imp = require('node:crypto').randomUUID();
  H.db.run(`INSERT INTO imports(id,source,imported_by) VALUES(?,?,?)`, imp, 'onenote', navB.id);
  const fin = H.client(); await fin.login('rx_lead', PW);
  assert.ok(!(await fin.get('/api/auth/me')).data.user.permissions.includes('records:manage-others'), 'ignored at request time');
  const imps = await fin.get('/api/imports');
  assert.ok(!JSON.stringify(imps.data || '').includes(imp), 'and it opens nobody else\'s import');
  p = (await admin.get(`/api/users/${lead.id}/permissions`)).data;
  assert.ok(p.overrides.find(o => o.permission === 'records:manage-others').no_effect, 'Users & permissions says the row does nothing');
  // Read-only is refused it too, and a deny is always allowed.
  const ro = H.makeUser('rx_ro', 'readonly');
  assert.equal((await admin.post(`/api/users/${ro.id}/permissions`, { permission: 'records:manage-others', mode: 'grant', reason: 'test: should be refused' })).status, 400, 'never to read-only');
  assert.equal((await admin.post(`/api/users/${sup.id}/permissions`, { permission: 'records:manage-others', mode: 'deny', reason: 'supervisor limited to own work' })).status, 200, 'a deny is allowed');
  const sc = H.client(); await sc.login('rx_sup', PW);
  assert.equal(JSON.stringify((await sc.get('/api/imports')).data).includes(imp), false, 'and a supervisor denied it no longer sees another worker\'s import');
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id IN (?,?)`, sup.id, lead.id);
});
