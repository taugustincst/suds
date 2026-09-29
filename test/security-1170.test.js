'use strict';
// The security review of the 1.17.0 candidate (r10), the findings fixed before release:
//   M1  the import previews (spreadsheet and EHR) no longer say whether a person the caller cannot open is a
//       client here: no client code, no count, no "skipped" at commit; a supervisor is asked to compare instead,
//       and a preview is charged to the live duplicate check's per-worker limit.
//   L1  a sync push cannot sign an AI-assisted note without the author's review statement.
//   L2  a referral link is not opened for a removed or merged record or a closed referral, and the accounting
//       names the recipient the link was made for, whatever the directory entry is called later.
//   L3  a recipient's repeated acknowledgements update one to-do; unknown-token opens are summarised in the
//       audit log rather than written one hash-chained row each.
//   L4  a worker held to a caseload reaches only the CalOMS files they produced themselves.
// (L5, L6 and the copilot's counseling-note rule: test/ai-copilot.test.js.)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { encrypt, uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
let admin, sup, nav, held, clin, anon, heldSup;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  H.makeUser('s17_sup', 'supervisor'); H.makeUser('s17_nav', 'navigator'); H.makeCaseloadUser('s17_held', 'navigator'); H.makeUser('s17_clin', 'clinician');
  H.makeCaseloadUser('s17_heldsup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('s17_sup', PW);
  nav = H.client(); await nav.login('s17_nav', PW);
  held = H.client(); await held.login('s17_held', PW);
  clin = H.client(); await clin.login('s17_clin', PW);
  heldSup = H.client(); await heldSup.login('s17_heldsup', PW);
  anon = H.client();
  H.db.setSetting('referral_links_enabled', '1');
});
after(() => H.stop());

// ---------------------------------------------------------------------------------------------------- M1
const reviewTasks = (clientId) => H.db.all(`SELECT title_enc FROM tasks WHERE client_id=? AND assigned_to IS NULL AND priority='high'`, clientId).map(t => require('../server/crypto').decrypt(t.title_enc));

test('M1: a held worker\'s import previews do not reveal a client they cannot open; a supervisor is asked instead', async () => {
  const hidden = expect(await sup.post('/api/clients', { first_name: 'Hidden', last_name: 'Personx', dob: '1980-01-01', confirm_duplicate: true }), 201, 'a client the held worker cannot open').id;
  const code = H.db.one('SELECT client_code FROM clients WHERE id=?', hidden).client_code;
  assert.equal((await held.get(`/api/clients/${hidden}`)).status, 403);
  const own = expect(await held.post('/api/clients', { first_name: 'Visible', last_name: 'Ownrecord', confirm_duplicate: true }), 201, 'their own client').id;
  const ownCode = H.db.one('SELECT client_code FROM clients WHERE id=?', own).client_code;

  const csv = 'First name,Last name\nHidden,Personx\nNobody,Atallx\nVisible,Ownrecord\n';
  const p = expect(await held.post('/api/imports/data/preview?entity=clients', csv, { 'Content-Type': 'text/csv', 'X-Filename': 'x.csv' }), 200, 'csv preview');
  assert.deepEqual(p.rows.map(r => r.record._duplicate_of || null), [null, null, ownCode], 'a match they may open is shown; one they may not reads as no match');
  assert.ok(!JSON.stringify(p).includes(code), 'the hidden client code appears nowhere in the answer');
  const bundle = { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'p1', name: [{ use: 'official', family: 'Personx', given: ['Hidden'] }] } }] };
  const e = expect(await held.post('/api/imports/ehr/preview?entity=clients', { bundle: JSON.stringify(bundle) }), 200, 'EHR preview');
  assert.deepEqual(e.rows.map(r => r.record._duplicate_of || null), [null]);
  assert.ok(!JSON.stringify(e).includes(code));
  // A supervisor is asked to look, on the hidden record (so not on the held worker's own list), once.
  const tasks = reviewTasks(hidden).filter(t => /import preview/.test(t));
  assert.equal(tasks.length, 1, 'one review task on the hidden record, not one per preview');
  const mine = (await held.get('/api/tasks')).data;
  assert.ok(!JSON.stringify(mine).includes(code), 'the held worker does not see the task that names the code');
  // The audit entry has counts, never names or codes.
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='import.data.preview' ORDER BY id DESC LIMIT 1`).details;
  assert.deepEqual(JSON.parse(a).duplicates, { shown: 0, hidden: 1 });
  assert.ok(!a.includes('Personx') && !a.includes(code));

  // Commit with skip_duplicates: the hidden match is not "skipped" (that would answer the question); the row is
  // imported and a supervisor compares the two. A match the worker can open is skipped as before.
  const before = H.db.one(`SELECT COUNT(*) n FROM clients`).n;
  const c = expect(await held.post('/api/imports/data/commit', { entity: 'clients', skip_duplicates: true, records: [{ first_name: 'Hidden', last_name: 'Personx' }, { first_name: 'Visible', last_name: 'Ownrecord' }] }), 200, 'commit');
  assert.equal(c.created, 1); assert.equal(c.skipped, 1, 'only the visible duplicate is skipped');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM clients`).n, before + 1);
  const flagged = H.db.one(`SELECT details FROM audit_log WHERE action='client.possible_duplicate' ORDER BY id DESC LIMIT 1`);
  assert.ok(flagged && JSON.parse(flagged.details).source === 'import', 'flagged for a supervisor to compare');
  assert.ok(reviewTasks(hidden).some(t => /Possible duplicate record/.test(t)), 'with a review task on the hidden record');
});

test('M1: a preview of clients counts against the live duplicate check\'s per-worker limit', async () => {
  const u = H.makeCaseloadUser('s17_limit', 'navigator'); const c = H.client(); await c.login(u.username, PW);
  const { DUPLICATE_CHECKS } = require('../server/routes/clients');
  for (let i = 0; i < DUPLICATE_CHECKS; i++) expect(await c.post('/api/clients/check-duplicates', { first_name: 'A', last_name: `B${i}` }), 200, 'check');
  const r = await c.post('/api/imports/data/preview?entity=clients', 'First name,Last name\nA,B\n', { 'Content-Type': 'text/csv', 'X-Filename': 'x.csv' });
  assert.equal(r.status, 429, 'the same bucket');
  // Other kinds of import are not name lookups and are not limited by it.
  assert.equal((await c.post('/api/imports/data/preview?entity=tasks', 'Title\nCall back\n', { 'Content-Type': 'text/csv', 'X-Filename': 'x.csv' })).status, 200);
});

// ---------------------------------------------------------------------------------------------------- L1
test('L1: a sync push cannot sign an AI-assisted note without the review statement', async () => {
  const cl = expect(await clin.post('/api/clients', { first_name: 'Ai', last_name: 'Pushsign', confirm_duplicate: true }), 201, 'client');
  const n = expect(await clin.post('/api/notes', { client_id: cl.id, kind: 'clinical', content: 'AI drafted text', occurred_at: iso(), ai_assisted: true }), 201, 'note');
  const row = H.db.one('SELECT * FROM notes WHERE id=?', n.id);
  const pushed = (extra) => ({ device_now: iso(), tables: { notes: [{ ...row, content_enc: 'AI drafted text', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'signed', signed_by: row.author_id, signed_at: iso(), updated_at: iso(Date.now() + 1000), ...extra }] } });
  const p = expect(await clin.post('/api/sync/push', pushed({})), 200, 'push');
  assert.equal(p.rejected.length, 1, JSON.stringify(p)); assert.match(p.rejected[0].reason, /review/i);
  assert.equal(H.db.one('SELECT status FROM notes WHERE id=?', n.id).status, 'draft', 'still a draft');
  // With the statement (the device's own sign route asked for it): signed, and audited as REST audits it.
  const ok = expect(await clin.post('/api/sync/push', pushed({ ai_reviewed: true, updated_at: iso(Date.now() + 2000) })), 200, 'push with statement');
  assert.equal(ok.rejected.length, 0, JSON.stringify(ok));
  assert.equal(H.db.one('SELECT status FROM notes WHERE id=?', n.id).status, 'signed');
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=? ORDER BY id DESC LIMIT 1`, n.id).details);
  assert.equal(a.via, 'sync'); assert.equal(a.ai_assisted, true); assert.equal(a.ai_reviewed, true);
  // A note the push itself marks AI-assisted is held to the same rule.
  const n2 = expect(await clin.post('/api/notes', { client_id: cl.id, kind: 'clinical', content: 'Plain text', occurred_at: iso() }), 201, 'note 2');
  const row2 = H.db.one('SELECT * FROM notes WHERE id=?', n2.id);
  const p2 = expect(await clin.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row2, content_enc: 'Plain text', title_enc: null, structured_enc: null, cosign_note_enc: null, ai_assisted: 1, status: 'signed', signed_by: row2.author_id, signed_at: iso(), updated_at: iso(Date.now() + 1000) }] } }), 200, 'push 2');
  assert.equal(p2.rejected.length, 1, JSON.stringify(p2));
});

// ---------------------------------------------------------------------------------------------------- L2 / L3
async function linkSetup(name) {
  const c = expect(await nav.post('/api/clients', { first_name: 'Link', last_name: name, dob: '1991-02-03', phone: '555-0142', status: 'active', confirm_duplicate: true }), 201, 'client').id;
  const res = expect(await nav.post('/api/resources', { name: `Clinic ${name}`, category: 'outpatient' }), 201, 'resource').id;
  const consent = expect(await nav.post(`/api/clients/${c}/consents`, { type: 'part2_disclosure', recipient: `Clinic ${name}`, purpose: 'Referral for treatment', ...ELEMENTS }), 201, 'consent').id;
  const ref = expect(await nav.post('/api/referrals', { client_id: c, resource_id: res, referred_at: '2026-09-03T09:00:00Z', status: 'pending', warm_handoff: false }), 201, 'referral').id;
  const made = expect(await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: consent }), 201, 'link');
  return { client: c, res, consent, ref, made, token: made.path.split('#')[1] };
}
const disclosures = (clientId) => H.db.one('SELECT COUNT(*) n FROM disclosures WHERE client_id=?', clientId).n;

test('L2: a link is not opened for a removed or merged record, or a closed referral', async () => {
  const removed = await linkSetup('Removedx');
  H.db.run(`UPDATE clients SET deleted_at=? WHERE id=?`, iso(), removed.client);
  const o1 = expect(await anon.post('/api/referral-links/open', { token: removed.token, code: removed.made.code }), 200, 'open, removed');
  assert.equal(o1.withheld, true); assert.equal(o1.packet, undefined); assert.equal(disclosures(removed.client), 0, 'nothing accounted');

  const merged = await linkSetup('Mergedx');
  const keeper = await linkSetup('Keeperx');
  H.db.run(`UPDATE clients SET merged_into=? WHERE id=?`, keeper.client, merged.client);
  const o2 = expect(await anon.post('/api/referral-links/open', { token: merged.token, code: merged.made.code }), 200, 'open, merged');
  assert.equal(o2.withheld, true); assert.equal(o2.packet, undefined);

  const closed = await linkSetup('Closedx');
  H.db.run(`UPDATE referrals SET status='declined_by_client' WHERE id=?`, closed.ref);
  const o3 = expect(await anon.post('/api/referral-links/open', { token: closed.token, code: closed.made.code }), 200, 'open, closed referral');
  assert.equal(o3.withheld, true); assert.equal(disclosures(closed.client), 0);
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='referral_link.open' AND entity_id=? ORDER BY id DESC LIMIT 1`, closed.made.id).details);
  assert.equal(a.reason, 'referral_closed');
});

test('L2: the accounting names the recipient the link was made for, even after the directory entry is renamed', async () => {
  const s = await linkSetup('Gammax');
  expect(await nav.put(`/api/resources/${s.res}`, { name: 'Totally Different Org', organization: 'Clinic Gammax', category: 'outpatient' }), 200, 'rename');
  const o = expect(await anon.post('/api/referral-links/open', { token: s.token, code: s.made.code }), 200, 'open');
  assert.equal(o.packet.recipient, 'Clinic Gammax');
  assert.equal(o.recipient, 'Clinic Gammax', 'the page names the recipient the link was made for');
  const d = H.db.one('SELECT recipient_enc FROM disclosures WHERE client_id=? ORDER BY rowid DESC LIMIT 1', s.client);
  assert.equal(require('../server/crypto').decrypt(d.recipient_enc), 'Clinic Gammax', 'accounted to the recipient named at creation');
  assert.equal(o.packet.recipient_names, undefined, 'the snapshot is the office\'s, not shown to the recipient');
});

test('L3: repeated acknowledgements update one to-do; unknown-token opens are summarised, not one audit row each', async () => {
  const s = await linkSetup('Ackx');
  const good = expect(await anon.post('/api/referral-links/open', { token: s.token, code: s.made.code }), 200, 'open');
  for (let i = 0; i < 10; i++) expect(await anon.post('/api/referral-links/ack', { token: s.token, claim: good.claim, status: i % 2 ? 'declined' : 'received', by: `x${i}`, note: 'n' }), 200, `ack ${i}`);
  const tasks = H.db.all(`SELECT priority, title_enc FROM tasks WHERE referral_id=? AND status IN ('open','in_progress')`, s.ref).filter(t => require('../server/crypto').decrypt(t.title_enc).includes(s.made.reference));
  assert.equal(tasks.length, 1, 'one open to-do for the link');
  assert.match(require('../server/crypto').decrypt(tasks[0].title_enc), /declined/, 'saying what they said last');
  assert.equal(tasks[0].priority, 'high');

  const RL = require('../server/referral-links');
  RL.flushRefusals(); // start from an empty window
  const before = H.db.one('SELECT COUNT(*) n FROM audit_log').n;
  const n = RL.REFUSALS_LOGGED_PER_HOUR + 12;
  // Called directly, so the per-address HTTP limit does not stop the flood first; open throws for an unknown token.
  for (let i = 0; i < n; i++) assert.throws(() => RL.open({ token: 'A'.repeat(43), ip: `10.0.0.${i % 3}` }), /not valid/);
  const added = H.db.one('SELECT COUNT(*) n FROM audit_log').n - before;
  assert.equal(added, RL.REFUSALS_LOGGED_PER_HOUR + 1, 'the first few individually, then one note that the rest are being counted');
  RL.flushRefusals();
  const summary = H.db.one(`SELECT details FROM audit_log WHERE action='referral_link.open' ORDER BY id DESC LIMIT 1`);
  const d = JSON.parse(summary.details);
  assert.equal(d.reason, 'unknown_summary'); assert.equal(d.count, 12); assert.ok(Array.isArray(d.addresses) && d.addresses.length === 3, 'with the addresses, for incident response');
});

// ---------------------------------------------------------------------------------------------------- L4
test('L4: a worker held to a caseload reaches only the CalOMS files they produced themselves', async () => {
  const adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  const heldId = H.db.one(`SELECT id FROM users WHERE username='s17_heldsup'`).id;
  const mk = (status, origin, by) => { const id = uuid(); H.db.run(`INSERT INTO caloms_submissions(id,period_from,period_to,file_name,sha256,bytes,clients,file_enc,created_by,status,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, '2026-08-01', '2026-08-31', `f-${id.slice(0, 6)}.zip`, 'a'.repeat(64), 3, 1, encrypt('eHl6'), by, status, origin); return id; };
  const whole = mk('produced', 'scheduled', adminId); const prepared = mk('prepared', 'scheduled', adminId); const theirs = mk('produced', 'manual', heldId);
  const list = expect(await heldSup.get('/api/caloms/submissions'), 200, 'list');
  assert.deepEqual(list.rows.map(r => r.id), [theirs], 'only their own file is listed');
  assert.equal((await heldSup.get(`/api/caloms/submissions/${whole}/file`)).status, 403);
  assert.equal((await heldSup.get(`/api/caloms/submissions/${whole}/events`)).status, 403);
  assert.equal((await heldSup.post(`/api/caloms/submissions/${whole}/uploaded`, { uploaded_on: '2026-09-01' })).status, 403);
  assert.equal((await heldSup.post(`/api/caloms/submissions/${prepared}/discard`, {})).status, 403);
  assert.equal(H.db.one('SELECT status FROM caloms_submissions WHERE id=?', prepared).status, 'prepared', 'not discarded');
  assert.equal((await heldSup.get(`/api/caloms/submissions/${theirs}/events`)).status, 200, 'their own file is theirs to follow');
  // Not held: the whole programme's files, as before.
  assert.ok((await sup.get('/api/caloms/submissions')).data.rows.some(r => r.id === whole));
});
