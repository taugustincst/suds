'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = require('../server/db');

let admin, nav, sup;
before(async () => {
  await H.start();
  H.makeUser('nav1', 'navigator'); H.makeUser('sup1', 'supervisor'); H.makeUser('clin1', 'clinician');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('sup1', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('sample data: admin loads it, staff see it, it is removed cleanly with tombstones', async () => {
  assert.equal((await nav.get('/api/admin/demo')).status, 403);
  const st0 = (await admin.get('/api/admin/demo')).data;
  assert.equal(st0.loaded, false); assert.equal(st0.clients_total, 0);
  const r = await admin.post('/api/admin/demo', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.loaded, true); assert.equal(r.data.counts.clients, 12); assert.ok(r.data.counts.interventions > 50);
  assert.equal((await admin.post('/api/admin/demo', {})).status, 400);
  // navigator carries part of the sample caseload; codes are marked DEMO-
  const mine = (await nav.get('/api/caseload')).data.caseload; assert.ok(mine.length >= 3, 'navigator has sample caseload');
  const list = (await sup.get('/api/clients')).data; assert.equal(list.clients.length, 12); assert.ok(list.clients.every(c => c.client_code.startsWith('DEMO-')));
  const detail = (await sup.get(`/api/clients/${mine[0].id}`)).data; assert.ok(detail.client.first_name && detail.client.dob, 'PHI decrypts');
  const dash = (await sup.get('/api/reports/dashboard')).data; assert.ok(dash.interventions.total_30d > 0 || dash.clients.active > 0);
  const funds = (await sup.get('/api/budget/funds')).data.funds; assert.equal(funds.length, 2);
  // The sample records are ones SUDS itself would accept: each client's Part 2 consent carries the §2.31
  // elements and names every agency the client was referred to (a consent covers only who it names).
  const D = require('../server/disclosure');
  for (const c of db.all(`SELECT id FROM clients`)) {
    const k = db.one(`SELECT * FROM consents WHERE client_id=? AND type='part2_tpo'`, c.id);
    assert.ok(k, 'every sample client has a TPO consent'); assert.deepEqual(D.consentElementProblems(k), []);
    for (const ref of db.all(`SELECT res.name FROM referrals r JOIN resources res ON res.id=r.resource_id WHERE r.client_id=?`, c.id)) {
      assert.ok(D.consentNamesRecipient({ type: k.type, recipient: require('../server/crypto').decrypt(k.recipient_enc) }, [ref.name]), `the consent names ${ref.name}`);
    }
    // 1.23.1: every referral that told its agency who the client is cites that consent and has its accounting row,
    // as one made in SUDS does (evaluation of 1.23.0: none had, and editing an open one asked for a consent).
    for (const ref of db.all(`SELECT * FROM referrals WHERE client_id=? AND (status<>'pending' OR warm_handoff=1)`, c.id)) {
      assert.equal(ref.consent_id, k.id, 'a shared sample referral cites the client\'s consent');
      const acc = db.all(`SELECT * FROM disclosures WHERE source='referral' AND source_ref=?`, ref.id);
      assert.equal(acc.length, 1, 'and has one accounting row'); assert.equal(acc[0].consent_id, k.id); assert.equal(acc[0].basis, 'consent');
      assert.ok(acc[0].disclosed_at === ref.referred_at && k.signed_at <= ref.referred_at.slice(0, 10), 'disclosed when referred, after the consent was signed');
    }
  }
  // An open sample referral can be edited as the worker would: a new follow-up date, and its status moved on.
  const open = db.one(`SELECT r.* FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.status IN ('contacted','scheduled','waitlisted','accepted') ORDER BY r.referred_at LIMIT 1`);
  assert.ok(open, 'the sample data has an open referral');
  const cur = (await sup.get(`/api/referrals/${open.id}`)).data.row;
  const moved = await sup.put(`/api/referrals/${open.id}`, { follow_up_due: '2099-01-15', status: open.status === 'scheduled' ? 'admitted' : 'scheduled', if_updated_at: cur.updated_at });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  // Every sample client is found as any client is: its blind indexes are the ones clients-model computes (the
  // preferred name's was not written until 1.14.0; the 1.13.0 upgrade fixture found it).
  const M = require('../server/clients-model'); const { decrypt } = require('../server/crypto');
  let prefs = 0;
  for (const c of db.all(`SELECT * FROM clients`)) {
    const plain = { first_name: decrypt(c.first_name_enc), last_name: decrypt(c.last_name_enc), preferred_name: c.preferred_name_enc ? decrypt(c.preferred_name_enc) : null, dob: c.dob_enc ? decrypt(c.dob_enc) : null, phone: c.phone_enc ? decrypt(c.phone_enc) : null };
    if (plain.preferred_name) prefs++;
    for (const [col, v] of Object.entries(M.clientIndexes(plain))) assert.equal(c[col], v, `${c.client_code}: ${col}`);
  }
  assert.ok(prefs > 0, 'some sample clients have a preferred name');
  // remove
  const rm = await admin.del('/api/admin/demo'); assert.equal(rm.status, 200); assert.ok(rm.data.removed > 300, `removed ${rm.data.removed}`);
  assert.equal((await sup.get('/api/clients')).data.clients.length, 0);
  assert.equal((await sup.get('/api/resources')).data.rows.length, 0);
  assert.equal(db.one(`SELECT COUNT(*) n FROM tombstones WHERE table_name='clients'`).n, 12);
  assert.equal((await admin.get('/api/admin/demo')).data.loaded, false);
  // refuses once real clients exist
  assert.equal((await nav.post('/api/clients', { first_name: 'Real', last_name: 'Person' })).status, 201);
  assert.equal((await admin.post('/api/admin/demo', {})).status, 400);
});

test('sample data beside existing clients: refused where records may be real, allowed on the static demo, removed cleanly', async () => {
  // Runs after the test above, which leaves one real client ("Real Person") behind.
  const demo = require('../server/demo');
  const st = demo.status();
  assert.ok(st.clients_total > 0 && !st.loaded);
  // The office server (and a browser copy it hands out) says why, and the screens are told not to offer it.
  const offered = (await admin.get('/api/admin/demo')).data;
  assert.equal(offered.can_load, false); assert.equal(offered.alongside, false);
  assert.match(demo.loadRefusal(st), /only be added while there are no clients/);
  // The static demo build (local/kernel.js passes alongside when window.SUDS_STATIC_HOST is set) holds
  // nothing real, so it may add sample data beside what someone typed in while trying SUDS out.
  assert.equal(demo.loadRefusal(st, { alongside: true }), null);
  const realIds = db.all(`SELECT id FROM clients WHERE deleted_at IS NULL`).map(r => r.id);
  const adminId = db.one(`SELECT id FROM users WHERE username='admin'`).id;
  const out = demo.seed({ actor: adminId, workers: [adminId], clinician: null, supervisor: adminId });
  assert.equal(out.loaded, true); assert.equal(out.counts.clients, 12);
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n, realIds.length + 12, 'the sample clients sit beside the real one');
  assert.match(demo.loadRefusal(demo.status(), { alongside: true }), /already loaded/, 'but only once');
  // Every sample row is tagged, so removing them leaves what the person entered themselves.
  demo.remove({ actor: adminId });
  assert.deepEqual(db.all(`SELECT id FROM clients WHERE deleted_at IS NULL`).map(r => r.id).sort(), [...realIds].sort());
  assert.equal(demo.offer({ alongside: true }).can_load, true);
});
