'use strict';
// A device that syncs with an office server (local mode, not SUDS on this device): the browser kernel, bundled
// from the current sources (test/fixtures/kernel-harness.js), sets itself up with an office account, syncs,
// records work of its own and syncs again, and the office edits a record the device then pulls. After the round
// trip the two hold the same records, so they must give the same answers: the records themselves, the
// dashboard (Home and Reports), the funder report, and the same publication release of the month, id for id
// (docs/architecture/ADR-0009: the kernel audits inline, the office in its worker thread).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller, strip } = require('./fixtures/kernel-harness');

let L; let cleanup; let base; let office;
const USER = 'syncadmin'; const PASSWORD = 'Orchid-Lamp-77!x';
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true; // devices may sync with this office
  H.db.setSetting('programme_profile', require('../server/programme').DEFAULT_PROFILE);
  H.makeUser(USER, 'admin', PASSWORD);
  office = H.client(); await office.login(USER, PASSWORD);
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const sync = async () => ok(await device('POST', '/api/local/sync', { server: base, username: USER, password: PASSWORD }), 200, 'sync');
const views = (call) => ({
  client: async (id) => { const d = ok(await call('GET', `/api/clients/${id}`), 200, 'read client'); const c = d.client || d; return { first_name: c.first_name, last_name: c.last_name, dob: c.dob, phone: c.phone, gender: c.gender, goals: c.goals, status: c.status }; },
  visits: async (id) => { const d = ok(await call('GET', `/api/interventions?client_id=${id}`), 200, 'visits'); return (d.interventions || d.rows || d).map(v => ({ type: v.type, occurred_at: v.occurred_at, minutes: v.duration_minutes, kits: v.naloxone_kits, summary: v.summary })).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)); },
});
const MONTH = 'from=2026-08-01&to=2026-08-31';

test('a sync round trip: what the office holds reaches the device, what the device records reaches the office, and the two then report the same', async () => {
  // ---- the office's records: 20 people served in August ----
  const officeIds = [];
  for (let i = 0; i < 20; i++) {
    const c = ok(await office.post('/api/clients', { first_name: `Office${i}`, last_name: 'Sync', gender: i % 3 ? 'male' : 'female', status: 'active', intake_date: '2026-08-01', confirm_duplicate: true }), 201, 'office client');
    ok(await office.post('/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: `2026-08-${String(2 + (i % 25)).padStart(2, '0')}T16:00:00.000Z`, duration_minutes: 10 + i, naloxone_kits: i % 4 === 0 ? 1 : 0 }), 201, 'office visit');
    officeIds.push(c.id);
  }
  // ---- the device sets itself up with the office account and syncs for the first time ----
  ok(await device('POST', '/api/local/setup', { display_name: 'Sync Admin', username: USER, password: PASSWORD, role: 'admin' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: USER, password: PASSWORD }), 200, 'device sign-in');
  const s1 = await sync();
  assert.ok(s1.ok && s1.pulled.clients >= 20, `pulled ${JSON.stringify(s1.pulled)}`);
  const D = views(device); const O = views((m, p, b) => office.req(m, p, b));
  assert.deepEqual(await D.client(officeIds[3]), await O.client(officeIds[3]), 'an office client reads the same on the device');
  assert.deepEqual(await D.visits(officeIds[3]), await O.visits(officeIds[3]));
  // ---- the device records work of its own, offline, and the office edits a record ----
  const mine = ok(await device('POST', '/api/clients', { first_name: 'Device', last_name: 'Made', dob: '1990-01-02', phone: '(555) 010-0144', gender: 'female', status: 'active', intake_date: '2026-08-05' }), 201, 'device client');
  ok(await device('POST', '/api/interventions', { client_id: mine.id, type: 'naloxone_distribution', occurred_at: '2026-08-06T15:00:00.000Z', duration_minutes: 25, naloxone_kits: 3, summary: 'Three kits at the shelter' }), 201, 'device visit');
  ok(await device('POST', '/api/interventions', { client_id: officeIds[5], type: 'outreach', occurred_at: '2026-08-07T15:00:00.000Z', duration_minutes: 5 }), 201, 'device visit to an office client');
  ok(await office.put(`/api/clients/${officeIds[7]}`, { goals: 'Set at the office' }), 200, 'office edit');
  const s2 = await sync();
  assert.equal((s2.rejected || []).length, 0, `rejected ${JSON.stringify(s2.rejected)}`);
  assert.ok(s2.pushed.clients >= 1 && s2.pushed.interventions >= 2, `pushed ${JSON.stringify(s2.pushed)}`);
  // ---- both hold the same records ----
  assert.deepEqual(await O.client(mine.id), await D.client(mine.id), 'the device\'s client reached the office');
  assert.deepEqual(await O.visits(mine.id), await D.visits(mine.id), 'and its visit');
  assert.deepEqual(await O.visits(officeIds[5]), await D.visits(officeIds[5]), 'a visit the device logged for an office client');
  assert.equal((await D.client(officeIds[7])).goals, 'Set at the office', 'the office edit reached the device');
  // ---- and report the same ----
  const both = async (p) => Promise.all([device('GET', p), office.get(p)]).then(([d, o]) => [ok(d, 200, `device ${p}`), ok(o, 200, `office ${p}`)]);
  const [dd, od] = await both(`/api/reports/dashboard?${MONTH}`);
  assert.deepEqual(strip(dd), strip(od), 'the dashboard');
  assert.equal(dd.interventions.total, 22); assert.equal(dd.clients.new_in_range, 21);
  const [df, of] = await both(`/api/reports/funder?${MONTH}&purpose=internal`);
  assert.deepEqual(strip(df), strip(of), 'the funder report (internal)');
  const [dp, op] = await both(`/api/reports/funder?${MONTH}&purpose=publication`);
  assert.equal(dp.release.id, op.release.id, 'the same publication release');
  assert.deepEqual(strip(dp), strip(op), 'printed the same');
  assert.equal(dp.unduplicated.served, 21, 'with its headline');
  const [dn, on] = await both(`/api/reports/naloxone-ndp?${MONTH}&purpose=publication`);
  assert.equal(dn.release.id, dp.release.id); assert.equal(on.release.id, op.release.id);
  assert.deepEqual(strip(dn), strip(on), 'the NDP log of the release');
});

test('on a device that syncs with an office, rulings are refused up front: approvals and countersignatures are the office\'s (1.15.4, H1)', async () => {
  // Sync never carries a ruling to the office (server/rules/shared.js officeRuling), so making one on the device
  // would look done and be undone at the next sync. The routes say so instead.
  for (const [p, body] of [['/api/time/any-id/approve', { decision: 'approved' }], ['/api/time/approve-batch', { ids: ['any-id'], decision: 'approved' }],
    ['/api/budget/expenditures/any-id/approve', { status: 'approved' }], ['/api/notes/any-id/cosign', {}],
    // The office's possible-duplicate mark (1.24.0): sync does not carry clearing it, so it is cleared at the office.
    ['/api/time/any-id/not-duplicate', {}]]) {
    const r = await device('POST', p, body);
    assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.rulingAtOffice, true, p);
    assert.match(r.data.error, /office SUDS/);
  }
});
