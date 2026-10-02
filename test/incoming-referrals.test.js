'use strict';
// Incoming referrals (built for 1.24.0; server/incoming-referrals.js, server/routes/incoming-referrals.js): the intake
// queue of people referred to the programme. Who may see and work it (intake:read / intake:write), validation, the
// workflow (new -> contacting -> accepted / declined / unable to reach / referred elsewhere, and reopen), accepting into
// an existing client (found by the duplicate check, one the worker may open) or a new one, time to first contact, the
// audit trail (no PHI in its details), the PHI encrypted at rest, retention, and the device that syncs with an office.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let nav, sup, clin, fin, ro, scoped, navUser, supUser, scopedUser;
const BODY = { source_type: 'er_hospital', referring_org: 'Mercy General ED', referrer_name: 'Dana Social-Worker', referrer_phone: '555-0170', referrer_email: 'dana@mercy.example',
  received_via: 'phone', urgency: 'urgent', reason: 'Opioid overdose, revived, asking for MAT', first_name: 'Teodoro', last_name: 'Intakeson', dob: '1987-04-12', phone: '555-0199', notes: 'Prefers texts after 5pm' };
const PHI = ['Dana Social-Worker', '555-0170', 'dana@mercy.example', 'Opioid overdose', 'Teodoro', 'Intakeson', '1987-04-12', '555-0199', 'Prefers texts'];
const audits = (id) => H.db.all(`SELECT * FROM audit_log WHERE entity_id=? ORDER BY id`, id);
const make = async (who = nav, extra = {}) => { const r = await who.post('/api/incoming-referrals', { ...BODY, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };

before(async () => {
  await H.start();
  navUser = H.makeUser('ir_nav', 'navigator'); supUser = H.makeUser('ir_sup', 'supervisor'); H.makeUser('ir_clin', 'clinician');
  H.makeUser('ir_fin', 'finance'); H.makeUser('ir_ro', 'readonly'); scopedUser = H.makeCaseloadUser('ir_scoped', 'navigator');
  const login = async (u) => { const c = H.client(); await c.login(u, 'StaffPassw0rd!x'); return c; };
  nav = await login('ir_nav'); sup = await login('ir_sup'); clin = await login('ir_clin'); fin = await login('ir_fin'); ro = await login('ir_ro'); scoped = await login('ir_scoped');
});
after(async () => { await H.stop(); });

test('the role defaults: navigators, clinicians, supervisors and administrators; never finance or read-only, nor granted to them', async () => {
  const { PERMS, hasPerm } = require('../server/auth');
  for (const r of ['admin', 'supervisor', 'clinician', 'navigator']) for (const p of ['intake:read', 'intake:write']) assert.ok(PERMS[r].includes(p), `${r} holds ${p}`);
  for (const r of ['finance', 'readonly']) assert.ok(!hasPerm({ role: r }, 'intake:read'), `${r} does not`);
  const { grantProblem, PERMISSION_CATALOG } = require('../server/permissions');
  for (const r of ['finance', 'readonly']) assert.ok(grantProblem(r, PERMS[r], 'intake:read'), `${r} cannot be granted intake:read`);
  for (const p of ['intake:read', 'intake:write']) assert.equal(PERMISSION_CATALOG.find(x => x.name === p).risk, 'sensitive', `${p} is in the catalogue the admin page edits, marked sensitive`);
  for (const c of [fin, ro]) {
    assert.equal((await c.get('/api/incoming-referrals')).status, 403);
    assert.equal((await c.get('/api/incoming-referrals/summary')).status, 403);
    assert.equal((await c.post('/api/incoming-referrals', BODY)).status, 403);
  }
  assert.equal((await H.client().get('/api/incoming-referrals')).status, 401, 'signed out');
});

test('an administrator can deny intake per person: a denied intake:write takes the queue away (a denied write denies its read)', async () => {
  const u = H.makeUser('ir_denied_nav', 'navigator'); H.deny(u, 'intake:write');
  const c = H.client(); await c.login('ir_denied_nav', 'StaffPassw0rd!x');
  const id = await make();
  assert.equal((await c.get(`/api/incoming-referrals/${id}`)).status, 403);
  assert.equal((await c.post('/api/incoming-referrals', BODY)).status, 403, 'cannot record one');
  assert.equal((await c.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone', outcome: 'no_answer' })).status, 403, 'nor log an attempt');
  const v = H.makeUser('ir_nointake', 'navigator'); H.deny(v, 'intake:read');
  const d = H.client(); await d.login('ir_nointake', 'StaffPassw0rd!x');
  assert.equal((await d.get('/api/incoming-referrals')).status, 403);
  assert.equal((await d.post('/api/incoming-referrals', BODY)).status, 403, 'a denied read leaves writing nothing to write into');
});

test('recording one: validation, defaults, encrypted at rest, audited without PHI', async () => {
  const bad = async (body, field) => { const r = await nav.post('/api/incoming-referrals', body); assert.equal(r.status, 400, JSON.stringify(r.data)); if (field) assert.ok(r.data.fields && r.data.fields[field], `${field}: ${JSON.stringify(r.data)}`); };
  await bad({ ...BODY, source_type: undefined }, 'source_type');
  await bad({ ...BODY, source_type: 'pharmacy' }, 'source_type');
  await bad({ ...BODY, received_via: 'pigeon' }, 'received_via');
  await bad({ ...BODY, urgency: 'yesterday' }, 'urgency');
  await bad({ ...BODY, first_name: '', last_name: '', phone: '' }, 'last_name');
  await bad({ ...BODY, dob: '2999-01-01' }, 'dob');
  await bad({ ...BODY, received_at: new Date(Date.now() + 86400000).toISOString() }, 'received_at');
  await bad({ ...BODY, referrer_email: 'not an email' }, 'referrer_email');
  await bad({ ...BODY, assigned_to: 'nobody' }, 'assigned_to');
  const finUser = H.db.one(`SELECT id FROM users WHERE username='ir_fin'`);
  await bad({ ...BODY, assigned_to: finUser.id }, 'assigned_to');
  // A phone number alone is enough to try to reach someone.
  const phoneOnly = await make(nav, { first_name: undefined, last_name: undefined, urgency: undefined, source_type: 'self', referring_org: undefined });
  const p = (await nav.get(`/api/incoming-referrals/${phoneOnly}`)).data.row;
  assert.equal(p.urgency, 'routine'); assert.equal(p.status, 'new'); assert.ok(p.received_at, 'received now by default'); assert.equal(p.display_name, 'Name not given');

  const id = await make(nav, { assigned_to: navUser.id });
  const stored = H.db.one(`SELECT * FROM incoming_referrals WHERE id=?`, id);
  const raw = JSON.stringify(stored);
  for (const x of PHI) assert.ok(!raw.includes(x), `"${x}" is not stored in the clear`);
  for (const c of ['first_name_enc', 'last_name_enc', 'dob_enc', 'phone_enc', 'reason_enc', 'notes_enc', 'referrer_name_enc', 'referrer_phone_enc', 'referrer_email_enc']) assert.match(stored[c], /^v1:/, c);
  assert.equal(stored.referring_org, 'Mercy General ED', 'the organisation is not PHI');
  assert.equal(stored.last_name_idx, require('../server/crypto').blindIndex('Intakeson'));
  const row = (await nav.get(`/api/incoming-referrals/${id}`)).data.row;
  assert.equal(row.first_name, 'Teodoro'); assert.equal(row.referrer_email, 'dana@mercy.example'); assert.equal(row.assignee_name, 'ir_nav'); assert.equal(row.source_label, 'Emergency department or hospital');
  const a = audits(id);
  assert.deepEqual(a.map(x => x.action), ['incoming_referral.create', 'incoming_referral.read']);
  assert.equal(JSON.parse(a[0].details).source_type, 'er_hospital');
  for (const x of a) for (const v of PHI) assert.ok(!String(x.details || '').includes(v), `no "${v}" in ${x.action}'s details`);
});

test('the queue: the whole queue for intake (a caseload-scoped worker too), filters, surname search, ordering', async () => {
  const routine = await make(sup, { urgency: 'routine', last_name: 'Queueorder', received_at: new Date(Date.now() - 3 * 86400000).toISOString() });
  const urgent = await make(sup, { urgency: 'urgent', last_name: 'Queueorder', assigned_to: supUser.id });
  const list = await scoped.get('/api/incoming-referrals?q=queueorder');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.rows.map(r => r.id), [urgent, routine], 'a caseload-scoped navigator sees referrals nobody gave them; urgent first');
  assert.equal(list.data.total, 2);
  assert.deepEqual((await nav.get('/api/incoming-referrals?q=Queueorder&urgency=routine')).data.rows.map(r => r.id), [routine]);
  assert.deepEqual((await sup.get('/api/incoming-referrals?q=Queueorder&assigned_to=me')).data.rows.map(r => r.id), [urgent]);
  assert.deepEqual((await sup.get('/api/incoming-referrals?q=Queueorder&assigned_to=none')).data.rows.map(r => r.id), [routine]);
  assert.ok((await nav.get('/api/incoming-referrals?q=Mercy')).data.rows.length >= 2, 'the referring organisation is searched too');
  assert.equal((await nav.get('/api/incoming-referrals?status=bogus')).status, 400);
  const last = H.db.one(`SELECT details FROM audit_log WHERE action='incoming_referral.list' ORDER BY id DESC LIMIT 1`);
  assert.equal(JSON.parse(last.details).q, '[redacted]', 'the search is not in the audit trail');
  const s = (await nav.get('/api/incoming-referrals/summary')).data;
  assert.ok(s.new >= 2 && s.urgent >= 1 && s.unassigned >= 1, JSON.stringify(s));
  assert.ok(!JSON.stringify(s).includes('Queueorder'), 'counts only');
});

test('attempts: the first moves new to contacting and fixes the time to first contact; validation', async () => {
  const received = new Date(Date.now() - 5 * 3600000).toISOString();
  const id = await make(nav, { received_at: received });
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/attempts`, { method: 'smoke', outcome: 'no_answer' })).status, 400);
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone' })).status, 400, 'an outcome is required');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone', outcome: 'no_answer', attempted_at: new Date(Date.now() + 86400000).toISOString() })).status, 400, 'not in the future');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone', outcome: 'no_answer', attempted_at: new Date(Date.now() - 86400000).toISOString() })).status, 400, 'not before it was received');
  const firstAt = new Date(Date.now() - 3 * 3600000).toISOString();
  const r = await nav.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone', outcome: 'left_message', attempted_at: firstAt, notes: 'Voicemail to sister Rosa' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.row.status, 'contacting');
  assert.equal(r.data.row.first_contact_at, firstAt);
  assert.equal(r.data.row.hours_to_first_contact, 2);
  await clin.post(`/api/incoming-referrals/${id}/attempts`, { method: 'text', outcome: 'reached' });
  const d = (await nav.get(`/api/incoming-referrals/${id}`)).data;
  assert.equal(d.attempts.length, 2); assert.equal(d.attempts[0].notes, 'Voicemail to sister Rosa'); assert.equal(d.attempts[1].user_name, 'ir_clin');
  assert.equal(d.row.first_contact_at, firstAt, 'a later attempt does not move the first contact');
  assert.match(H.db.one(`SELECT notes_enc FROM incoming_referral_attempts WHERE referral_id=? AND notes_enc IS NOT NULL`, id).notes_enc, /^v1:/);
  const at = audits(id).filter(x => x.action === 'incoming_referral.attempt');
  assert.equal(at.length, 2); assert.equal(JSON.parse(at[0].details).first, true);
  for (const x of at) assert.ok(!x.details.includes('Rosa'));
  const s = (await nav.get('/api/incoming-referrals/summary')).data.first_contact;
  assert.ok(s.contacted >= 1 && s.median_hours !== null && s.within_24h >= 1, JSON.stringify(s));
});

test('editing and assigning an open referral; a closed one is not edited', async () => {
  const id = await make();
  const r = await nav.put(`/api/incoming-referrals/${id}`, { urgency: 'soon', reason: 'Also needs housing', assigned_to: supUser.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.row.urgency, 'soon'); assert.equal(r.data.row.reason, 'Also needs housing'); assert.equal(r.data.row.assigned_to, supUser.id);
  const a = audits(id);
  assert.deepEqual(JSON.parse(a.find(x => x.action === 'incoming_referral.update').details).fields.sort(), ['reason', 'urgency']);
  assert.equal(JSON.parse(a.find(x => x.action === 'incoming_referral.assign').details).assigned_to, supUser.id);
  assert.ok(!a.some(x => String(x.details || '').includes('housing')));
  assert.equal((await nav.put(`/api/incoming-referrals/${id}`, { assigned_to: null })).data.row.assigned_to, null, 'unassigned');
  assert.equal((await nav.put(`/api/incoming-referrals/${id}`, { first_name: '', last_name: '', phone: '' })).status, 400, 'still someone to reach');
  assert.equal((await nav.put(`/api/incoming-referrals/${id}`, { source_type: null })).status, 400);
  await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'unable_to_reach' });
  assert.equal((await nav.put(`/api/incoming-referrals/${id}`, { urgency: 'urgent' })).status, 409);
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone', outcome: 'no_answer' })).status, 409);
});

test('closing without a client: declined needs a reason, referred elsewhere says where; reopen; accepted is final', async () => {
  const id = await make();
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'declined' })).status, 400, 'a decline says why');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'referred_elsewhere' })).status, 400, 'and a referral on says where');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'accepted' })).status, 400, 'accepting is its own action');
  const c = await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'declined', reason: 'Lives out of county; wants Sacramento services' });
  assert.equal(c.status, 200); assert.equal(c.data.row.status, 'declined'); assert.equal(c.data.row.outcome_reason, 'Lives out of county; wants Sacramento services'); assert.equal(c.data.row.closed_by_name, 'ir_nav');
  assert.match(H.db.one(`SELECT outcome_reason_enc FROM incoming_referrals WHERE id=?`, id).outcome_reason_enc, /^v1:/);
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'unable_to_reach' })).status, 409, 'already closed');
  const re = await nav.post(`/api/incoming-referrals/${id}/reopen`, {});
  assert.equal(re.status, 200); assert.equal(re.data.row.status, 'new'); assert.equal(re.data.row.outcome_reason, null); assert.equal(re.data.row.closed_at, null);
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/reopen`, {})).status, 409, 'already open');
  const r2 = await nav.post(`/api/incoming-referrals/${id}/close`, { status: 'referred_elsewhere', reason: 'Sacramento County Access line' });
  assert.equal(r2.data.row.status, 'referred_elsewhere');
  const acts = audits(id).map(x => x.action);
  for (const a of ['incoming_referral.close', 'incoming_referral.reopen']) assert.ok(acts.includes(a), a);
  assert.ok(!audits(id).some(x => /Sacramento/.test(x.details || '')));
});

test('accept into an existing client found by the duplicate check: only records the worker may open', async () => {
  const existing = await nav.post('/api/clients', { first_name: 'Mirela', last_name: 'Linkexisting', dob: '1979-09-09', phone: '555-0123', confirm_duplicate: true });
  assert.equal(existing.status, 201);
  const id = await make(nav, { first_name: 'Mirela', last_name: 'Linkexisting', dob: '1979-09-09', phone: '555-0123' });
  const m = await nav.get(`/api/incoming-referrals/${id}/matches`);
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.ok(m.data.matches.some(x => x.id === existing.data.id && x.reasons.includes('same surname and date of birth')), JSON.stringify(m.data));
  const dupAudit = H.db.one(`SELECT details FROM audit_log WHERE action='client.duplicate_check' AND entity_id=? ORDER BY id DESC LIMIT 1`, id);
  assert.equal(JSON.parse(dupAudit.details).source, 'incoming_referral'); assert.ok(!dupAudit.details.includes('Mirela'));
  // A caseload-scoped worker is not shown, and cannot link, a record that is not theirs.
  assert.deepEqual((await scoped.get(`/api/incoming-referrals/${id}/matches`)).data.matches, [], 'not shown, not counted');
  assert.equal((await scoped.post(`/api/incoming-referrals/${id}/accept`, { client_id: existing.data.id })).status, 403);
  assert.equal(H.db.one(`SELECT status FROM incoming_referrals WHERE id=?`, id).status, 'new');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/accept`, {})).status, 400, 'a client is required');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/accept`, { client_id: 'no-such-client' })).status, 400);
  const ok = await nav.post(`/api/incoming-referrals/${id}/accept`, { client_id: existing.data.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.row.status, 'accepted'); assert.equal(ok.data.row.accepted_as, 'existing'); assert.equal(ok.data.row.client_id, existing.data.id); assert.ok(ok.data.row.client_code);
  const acc = audits(id).find(x => x.action === 'incoming_referral.accept');
  assert.equal(acc.client_id, existing.data.id); assert.equal(JSON.parse(acc.details).accepted_as, 'existing');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/accept`, { client_id: existing.data.id })).status, 409, 'once');
  assert.equal((await nav.post(`/api/incoming-referrals/${id}/reopen`, {})).status, 409, 'an accepted referral is not reopened');
  // Receiving and accepting a referral is not a disclosure: no accounting row for the client.
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=?`, existing.data.id).n, 0);
});

test('accept into a new client made from the referral\'s details', async () => {
  const id = await make(clin, { first_name: 'Nadia', last_name: 'Brandnewclient', dob: '1990-01-30', phone: '555-0111' });
  // The worker opens New client prefilled from the referral (views/incoming.js), saves it, and the referral is linked.
  const c = await clin.post('/api/clients', { first_name: 'Nadia', last_name: 'Brandnewclient', dob: '1990-01-30', phone: '555-0111', referral_source: 'Emergency department or hospital — Mercy General ED', status: 'active' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const ok = await clin.post(`/api/incoming-referrals/${id}/accept`, { client_id: c.data.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.row.accepted_as, 'new');
  assert.equal(ok.data.row.status, 'accepted'); assert.ok(ok.data.row.closed_at);
  assert.equal((await clin.get(`/api/clients/${c.data.id}`)).status, 200, 'the client opens for the worker who accepted it');
});

test('a merge carries an accepted referral to the record kept; the retention purge removes it with the client, and closed unaccepted ones on their own clock', async () => {
  const R = require('../server/retention');
  const id = await make(sup, { first_name: 'Purgo', last_name: 'Retentio' });
  const c = await sup.post('/api/clients', { first_name: 'Purgo', last_name: 'Retentio', status: 'closed', intake_date: '2010-01-01', discharge_date: '2010-02-01', confirm_duplicate: true, no_episode: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  await sup.post(`/api/incoming-referrals/${id}/attempts`, { method: 'phone', outcome: 'reached' });
  await sup.post(`/api/incoming-referrals/${id}/accept`, { client_id: c.data.id });
  H.db.run(`UPDATE incoming_referrals SET received_at='2010-01-01T00:00:00.000Z' WHERE id=?`, id);
  H.db.run(`UPDATE incoming_referral_attempts SET attempted_at='2010-01-01T01:00:00.000Z' WHERE referral_id=?`, id);
  H.db.run(`UPDATE tasks SET status='cancelled' WHERE client_id=?`, c.data.id);
  assert.ok(R.expiredClients().some(x => x.id === c.data.id), 'due');
  R.purgeClient(R.expiredClients().find(x => x.id === c.data.id));
  assert.ok(!H.db.one(`SELECT 1 x FROM incoming_referrals WHERE id=?`, id), 'the referral went with the record');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM incoming_referral_attempts WHERE referral_id=?`, id).n, 0, 'and its attempts');
  // Received recently, a referral keeps a closed record (it is activity on it).
  const keep = await sup.post('/api/clients', { first_name: 'Keepo', last_name: 'Recentio', status: 'closed', intake_date: '2010-01-01', discharge_date: '2010-02-01', confirm_duplicate: true, no_episode: true });
  const kid = await make(sup, { first_name: 'Keepo', last_name: 'Recentio' });
  H.db.run(`UPDATE tasks SET status='cancelled' WHERE client_id=?`, keep.data.id);
  assert.ok(R.expiredClients().some(x => x.id === keep.data.id), 'due before the referral is accepted');
  await sup.post(`/api/incoming-referrals/${kid}/accept`, { client_id: keep.data.id });
  assert.ok(!R.expiredClients().some(x => x.id === keep.data.id), 'a referral received today keeps it');

  const old = await make(sup); const open = await make(sup); const recent = await make(sup);
  await sup.post(`/api/incoming-referrals/${old}/close`, { status: 'unable_to_reach' });
  await sup.post(`/api/incoming-referrals/${recent}/close`, { status: 'unable_to_reach' });
  await sup.post(`/api/incoming-referrals/${old}/attempts`, { method: 'phone', outcome: 'no_answer' }).catch(() => {});
  H.db.run(`UPDATE incoming_referrals SET received_at='2010-01-01T00:00:00.000Z', closed_at='2010-02-01T00:00:00.000Z' WHERE id IN (?,?)`, old, open);
  const n = R.purgeExpiredIncomingReferrals();
  assert.ok(n >= 1);
  assert.ok(!H.db.one(`SELECT 1 x FROM incoming_referrals WHERE id=?`, old), 'closed long ago without a client: purged');
  assert.ok(H.db.one(`SELECT 1 x FROM incoming_referrals WHERE id=?`, open), 'an open one is never due, however old');
  assert.ok(H.db.one(`SELECT 1 x FROM incoming_referrals WHERE id=?`, recent), 'closed recently: kept');
  const p = H.db.one(`SELECT details FROM audit_log WHERE action='incoming_referral.purge' ORDER BY id DESC LIMIT 1`);
  assert.ok(JSON.parse(p.details).referrals >= 1);
});

test('a device that syncs with an office refuses the queue; SUDS on this device keeps its own', async () => {
  const config = require('../server/config');
  const was = config.local;
  try {
    config.local = true;
    const r = await nav.get('/api/incoming-referrals');
    assert.equal(r.status, 403); assert.equal(r.data.officeOnly, true);
    globalThis.SUDS_STATIC_HOST = true;
    assert.equal((await nav.get('/api/incoming-referrals')).status, 200, 'SUDS on this device');
  } finally { config.local = was; delete globalThis.SUDS_STATIC_HOST; }
});
