'use strict';
// A client known only by a participant code (1.21.0, server/participant-code.js) wherever a record leaves the screen
// (the 1.21 review): a referral packet names them as the app does ("Participant CODE"), a CalOMS Tx record is refused
// with what is missing (the state format needs a legal name), a FHIR Patient carries the code as an identifier and no
// empty name, the identified client export has the code, and a merge of two records with different codes keeps the
// other one in the merge's revision and says so first.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { decrypt, uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
let admin; let nav;
before(async () => {
  await H.start();
  H.makeUser('pco_nav', 'navigator', PW);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('pco_nav', PW);
});
after(async () => { await H.stop(); });
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };
const coded = async (code, who = admin) => ok(await who.post('/api/clients', { participant_code: code, status: 'active', confirm_duplicate: true }), 201, `client ${code}`).id;
const lastAudit = (action) => { const r = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return r ? { ...r, details: JSON.parse(r.details || 'null') } : null; };

test('referral packet: a coded client is named "Participant CODE"', async () => {
  H.db.setSetting('referral_links_enabled', '1');
  const id = await coded('rl-4471', nav);
  const res = ok(await nav.post('/api/resources', { name: 'Coded Client Clinic', category: 'outpatient' }), 201, 'resource').id;
  const k = ok(await nav.post(`/api/clients/${id}/consents`, { type: 'part2_disclosure', recipient: 'Coded Client Clinic', purpose: 'Referral for treatment', signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01',
    signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true }), 201, 'consent').id;
  const ref = ok(await nav.post('/api/referrals', { client_id: id, resource_id: res, referred_at: '2026-09-03T09:00:00Z', status: 'pending', warm_handoff: false }), 201, 'referral').id;
  ok(await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: k }), 201, 'packet link');
  const packet = JSON.parse(decrypt(H.db.one(`SELECT packet_enc FROM referral_links WHERE referral_id=?`, ref).packet_enc)).packet;
  assert.equal(packet.client.name, 'Participant RL4471');
  // Lists that show a client's name show the same.
  const list = ok(await nav.get(`/api/referrals?client_id=${id}`), 200, 'referrals');
  const rows = list.referrals || list.rows || list;
  assert.ok(Array.isArray(rows) && rows.some((r) => r.client_name === 'Participant RL4471'), JSON.stringify(list).slice(0, 300));
});

test('CalOMS: a record for a client with no legal name is refused from the file with what is missing; never sent blank', async () => {
  const C = require('../server/caloms');
  const id = await coded('CAL-9001');
  const ep = uuid(); H.db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by,status) VALUES(?,?,?,?,?)`, ep, id, '2026-02-01', H.db.one(`SELECT id FROM users WHERE username='admin'`).id, 'open');
  const ctx = C.contextFor(H.db.one(`SELECT * FROM episodes WHERE id=?`, ep));
  assert.deepEqual(ctx.missingName, ['first name', 'last name']);
  const issues = C.check({ record_type: 'admission', provider_id: 'x', record_date: '2026-02-01', answers: {} }, ctx);
  const name = issues.find((i) => i.code === 'name_missing');
  assert.ok(name, 'refused'); assert.equal(name.severity, 'fatal'); assert.match(name.message, /first name and last name are not recorded/);
  assert.ok(!C.blocking([name]).length, 'the record may still be saved; it stays out of the file until the name is added');
  // With a name added, the problem is gone.
  ok(await admin.put(`/api/clients/${id}`, { first_name: 'Cal', last_name: 'Omsname' }), 200, 'name added');
  assert.deepEqual(C.contextFor(H.db.one(`SELECT * FROM episodes WHERE id=?`, ep)).missingName, []);
});

test('FHIR Patient: the participant code is an identifier, and a client with no name has no Patient.name', async () => {
  const R = require('../server/fhir/resources');
  const id = await coded('fh-2323');
  const p = R.DEFS.Patient.map(H.db.one(`SELECT * FROM clients WHERE id=?`, id));
  assert.equal(p.name, undefined, 'no empty HumanName');
  const pc = p.identifier.find((x) => x.system === 'urn:suds:participant-code');
  assert.ok(pc); assert.equal(pc.value, 'FH2323');
  ok(await admin.put(`/api/clients/${id}`, { first_name: 'Fhir', last_name: 'Named' }), 200, 'name added');
  const named = R.DEFS.Patient.map(H.db.one(`SELECT * FROM clients WHERE id=?`, id));
  assert.deepEqual(named.name, [{ use: 'official', family: 'Named', given: ['Fhir'] }]);
});

test('the identified client export has the participant code; a de-identified one never does', async () => {
  const X = require('../server/exports');
  await coded('EXP-7788');
  const user = H.db.one(`SELECT * FROM users WHERE username='admin'`);
  const ctx = { user };
  const idf = X.datasets(ctx, { from: '2000-01-01', to: '2100-01-01', ts: () => '1=1', tsP: [], identified: true }).clients;
  assert.ok(idf.columns.includes('participant_code'));
  assert.ok(idf.rows().some((r) => r.participant_code === 'EXP7788'));
  const deid = X.datasets(ctx, { from: '2000-01-01', to: '2100-01-01', ts: () => '1=1', tsP: [], identified: false }).clients;
  assert.ok(!deid.columns.includes('participant_code'));
});

test('merge with two different participant codes: said in the preview, the kept code stays, the other is in the merge revision (encrypted), not the audit', async () => {
  const keep = await coded('MKEEP-111');
  const other = await coded('MOTHER-222');
  const pv = ok(await admin.get(`/api/clients/${keep}/merge/preview?source_id=${other}`), 200, 'preview');
  assert.equal(pv.participant_codes_differ, true);
  assert.match(pv.notices[0], /different participant codes \(this record: MKEEP111; the other: MOTHER222\)/);
  assert.ok(!JSON.stringify(lastAudit('client.merge.preview').details).includes('MOTHER222'), 'the preview audit has no code');
  assert.equal((await nav.get(`/api/clients/${keep}/merge/preview?source_id=${other}`)).status, 403, 'clients:merge only');
  const m = ok(await admin.post(`/api/clients/${keep}/merge`, { source_id: other, reason: 'same person' }), 200, 'merge');
  assert.match(m.notices[0], /different participant codes/);
  assert.equal(ok(await admin.get(`/api/clients/${keep}`), 200, 'kept').client.participant_code, 'MKEEP111');
  const merge = lastAudit('client.merge');
  assert.ok(!JSON.stringify(merge.details).includes('MOTHER222') && !JSON.stringify(merge.details).includes('MKEEP111'), 'no code in the audit details');
  const rev = H.db.one(`SELECT * FROM client_revisions WHERE id=?`, merge.details.revision);
  assert.ok(rev && !rev.changes_enc.includes('MOTHER222'), 'the revision is encrypted');
  const hist = ok(await admin.get(`/api/clients/${keep}/history`), 200, 'history').revisions;
  const ch = hist.find((r) => r.id === rev.id).changes.find((c) => c.field === 'participant_code');
  assert.deepEqual([ch.before, ch.after], ['MOTHER222', 'MKEEP111']);
  // Put back: the duplicate's code becomes the record's own.
  ok(await admin.post(`/api/clients/${keep}/history/${rev.id}/revert`, { fields: ['participant_code'] }), 200, 'put back');
  assert.equal(ok(await admin.get(`/api/clients/${keep}`), 200, 'kept').client.participant_code, 'MOTHER222');
  // The same code on both, or one only: no notice.
  const a = await coded('SAME-3333'); const b = await coded('SAME-3333');
  assert.equal(ok(await admin.get(`/api/clients/${a}/merge/preview?source_id=${b}`), 200, 'same').participant_codes_differ, false);
});
