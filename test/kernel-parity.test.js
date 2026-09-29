'use strict';
// The same server code runs in two places: on the office server over node:sqlite, and in the browser as the
// local kernel (local/kernel.js, bundled with esbuild), over sql.js through local/shims/sqlite.js and the other
// shims. Until this test nothing in `npm test` ran the second: a shim that answered a query differently, or a
// server module that reached for something the browser does not have, was found by the browser suite at best.
//
// This bundles the CURRENT sources exactly as scripts/build-local.js does (scripts/kernel-build-options.js),
// loads the bundle in Node with sql.js and the few browser APIs it needs (test/fixtures/kernel-harness.js),
// and drives one representative flow through SUDS_LOCAL.handle — sign up (SUDS on this device), sign in, a
// client, a visit, a note, a consent, a referral that discloses under it, the funder report for internal use,
// the dashboard (Home and Reports), and a publication release of the month (1.14.0) — then runs the same flow
// against the office server's API and requires the same answers: the same release, id for id. A device that
// syncs with an office, and what the two hold after a round trip, is test/kernel-sync-parity.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller, strip } = require('./fixtures/kernel-harness');

let L; let cleanup;
before(async () => {
  // Bundle the current sources (not the committed public/local/kernel.js, which may lag them until
  // `npm run build:local`) the way the build script does. SUDS on this device (the published web app): Sign
  // up creates the account.
  ({ L, cleanup } = await loadKernel({ staticHost: true }));
  await H.start();
  // A new device database is a harm-reduction programme (server/programme.js DEFAULT_PROFILE); the office
  // server is given the same profile so the two answer under the same module switches.
  H.db.setSetting('programme_profile', require('../server/programme').DEFAULT_PROFILE);
});
after(async () => { await H.stop(); cleanup(); });

const kernelCall = (...a) => kernelCaller(L)(...a);

// One flow, written once, run against both. Returns what the two must agree on.
async function flow(call) {
  const out = {};
  const expectStatus = (r, s, what) => { assert.equal(r.status, s, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
  const client = expectStatus(await call('POST', '/api/clients', { first_name: 'Parity', last_name: 'Client', dob: '1985-03-02', phone: '(555) 010-0177', primary_substance: 'opioids_fentanyl', risk_level: 'high', status: 'active', intake_date: '2026-08-01' }), 201, 'create client');
  const gotBody = expectStatus(await call('GET', `/api/clients/${client.id}`), 200, 'read client'); const got = gotBody.client || gotBody;
  out.client = { first_name: got.first_name, last_name: got.last_name, dob: got.dob, phone: got.phone, risk_level: got.risk_level, status: got.status, primary_substance: got.primary_substance, code_shape: String(got.client_code).replace(/\d/g, '9').replace(/^[A-Z]/, 'X') }; // a device numbers its clients M…, the office C…, by design
  const visit = expectStatus(await call('POST', '/api/interventions', { client_id: client.id, type: 'naloxone_distribution', occurred_at: '2026-08-02T15:00:00.000Z', duration_minutes: 20, naloxone_kits: 2, summary: 'Two kits at the library' }), 201, 'log visit');
  const visits = expectStatus(await call('GET', `/api/interventions?client_id=${client.id}`), 200, 'list visits');
  const v = (visits.interventions || visits.rows || visits).find((x) => x.id === visit.id);
  out.visit = { type: v.type, naloxone_kits: v.naloxone_kits, duration_minutes: v.duration_minutes, summary: v.summary, occurred_at: v.occurred_at };
  const note = expectStatus(await call('POST', '/api/notes', { client_id: client.id, kind: 'admin', title: 'Follow-up', content: 'Asked about MAT; prefers texts.', occurred_at: '2026-08-02T15:30:00.000Z' }), 201, 'write note');
  const noteBody = expectStatus(await call('GET', `/api/notes/${note.id}`), 200, 'read note'); const n = noteBody.note || noteBody;
  out.note = { kind: n.kind, title: n.title, content: n.content, status: n.status };
  const consent = expectStatus(await call('POST', `/api/clients/${client.id}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT referral', signed_at: '2026-08-01', scope: 'Referral summary and MAT status', expires_at: '2027-08-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true }), 201, 'record consent');
  const resource = expectStatus(await call('POST', '/api/resources', { name: 'County OTP', category: 'mat_otp', phone: '555-0199', accepts_medicaid: true }), 201, 'add resource');
  const noConsent = await call('POST', '/api/referrals', { client_id: client.id, resource_id: resource.id, referred_at: '2026-08-03T09:00:00.000Z', urgency: 'urgent', warm_handoff: true });
  out.refusedWithoutConsent = noConsent.status;
  const referral = expectStatus(await call('POST', '/api/referrals', { client_id: client.id, resource_id: resource.id, referred_at: '2026-08-03T09:00:00.000Z', urgency: 'urgent', warm_handoff: true, consent_id: consent.id }), 201, 'refer');
  const acc = expectStatus(await call('GET', `/api/clients/${client.id}/disclosures/accounting`), 200, 'accounting of disclosures');
  const rows = acc.disclosures || acc.rows || acc;
  out.accounting = rows.map((d) => ({ recipient: d.recipient, consent: d.consent_id === consent.id, source: d.source, referral: d.source_ref === referral.id }));
  const report = expectStatus(await call('GET', '/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=internal'), 200, 'funder report (internal)');
  out.funder = strip(report);
  // And with exact counts (the programme's own submission): with one client every internal count is "<11".
  out.funderExact = strip(expectStatus(await call('GET', '/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=submission&counts=exact'), 200, 'funder report (exact)'));
  // The dashboard's totals (Home and Reports) over the month.
  out.dashboard = strip(expectStatus(await call('GET', '/api/reports/dashboard?from=2026-08-01&to=2026-08-31'), 200, 'dashboard'));
  // Visits by worker are by the worker's name, and the device's account and the office's are different people.
  if (out.dashboard.interventions && out.dashboard.interventions.by_worker) out.dashboard.interventions.by_worker = out.dashboard.interventions.by_worker.map(({ k, ...x }) => x);
  // Enough people for a publication release of August to print its headline; both sides must print the same
  // release (the audit runs in the office's worker thread, and inline in the kernel).
  for (let i = 0; i < 24; i++) {
    const c = expectStatus(await call('POST', '/api/clients', { first_name: `Pub${i}`, last_name: 'Parity', gender: i % 3 ? 'male' : 'female', status: 'active', intake_date: '2026-08-01', confirm_duplicate: true }), 201, 'client');
    expectStatus(await call('POST', '/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: `2026-08-${String(3 + (i % 20)).padStart(2, '0')}T15:00:00.000Z`, duration_minutes: 15 }), 201, 'visit');
  }
  const PUB = 'from=2026-08-01&to=2026-08-31&purpose=publication';
  const pub = await call('GET', `/api/reports/funder?${PUB}`);
  const ndp = await call('GET', `/api/reports/naloxone-ndp?${PUB}`);
  out.publication = { status: pub.status, release: pub.data.release && pub.data.release.id, ndpRelease: ndp.data.release && ndp.data.release.id, funder: strip(pub.data), ndp: strip(ndp.data) };
  return out;
}
test('the browser kernel (sql.js and the shims) answers a representative flow exactly as the office server does', async () => {
  // SUDS on this device: the first Sign up creates the device's account, then it signs in.
  const signup = await kernelCall('POST', '/api/local/signup', { display_name: 'Parity Admin', username: 'parity', password: 'ParityPassw0rd!x', role: 'admin', storage_ack: true });
  assert.equal(signup.status, 200, JSON.stringify(signup.data));
  const login = await kernelCall('POST', '/api/auth/login', { username: 'parity', password: 'ParityPassw0rd!x' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const device = await flow(kernelCall);

  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  const office = await flow((m, p, b) => admin.req(m, p, b));

  // PARITY_DEBUG=1 prints both answers; PARITY_DEBUG=<file.json> writes them there.
  if (process.env.PARITY_DEBUG) { if (/[\/]/.test(process.env.PARITY_DEBUG)) require('node:fs').writeFileSync(process.env.PARITY_DEBUG, JSON.stringify({ device, office })); else console.log(JSON.stringify({ device, office }, null, 1)); }
  assert.equal(device.refusedWithoutConsent, 400, 'a warm hand-off without consent is refused on the device too');
  assert.deepEqual(device.client, office.client, 'the client reads back the same');
  assert.deepEqual(device.visit, office.visit);
  assert.deepEqual(device.note, office.note);
  assert.deepEqual(device.accounting, office.accounting, 'the referral wrote the same accounting of disclosures');
  assert.ok(device.accounting.length >= 1 && device.accounting[0].consent);
  assert.deepEqual(device.funder, office.funder, 'the funder report (internal, suppressed) counts the same');
  assert.deepEqual(device.funderExact, office.funderExact, 'and with exact counts');
  assert.deepEqual(device.dashboard, office.dashboard, 'the dashboard counts the same');
  assert.equal(device.dashboard.interventions.total, 1); assert.equal(device.dashboard.interventions.naloxone_kits, 2); assert.equal(device.dashboard.clients.new_in_range, 1);
  assert.equal(device.publication.status, 200, JSON.stringify(device.publication.funder).slice(0, 300));
  assert.equal(device.publication.release, office.publication.release, 'the same publication release, by its id');
  assert.equal(device.publication.ndpRelease, device.publication.release, 'the NDP log is part of it');
  assert.deepEqual(device.publication.funder, office.publication.funder, 'printed the same');
  assert.deepEqual(device.publication.ndp, office.publication.ndp);
  assert.equal(device.publication.funder.unduplicated.served, 25, 'and it prints its headline');
  // Not two identical empty answers: the flow's own records are in them.
  assert.equal(device.client.first_name, 'Parity'); assert.equal(device.client.dob, '1985-03-02');
  assert.equal(device.note.content, 'Asked about MAT; prefers texts.');
  assert.equal(device.funder.unduplicated.served, '<11', 'one client is a small cell for internal use');
  assert.equal(device.funderExact.unduplicated.served, 1);
  assert.equal(device.funderExact.unduplicated.with_a_referral, 1);
  assert.equal(device.funderExact.naloxone_distribution.kits, 2);
});

test('a save during the funder report does not drop its working table (sql.js export reopens the database)', async () => {
  // Found by the parity test on a loaded machine: the report keeps its served set in a TEMP table across the
  // event-loop turns it yields between phases, and a coalesced save in one of those turns (sql.js export()
  // closes and reopens the database, dropping TEMP tables) failed it with "no such table". Here a save is
  // asked for at every point where the report lets the event loop go (server/funder-report.js breathe(), which
  // is setImmediate here), instead of waiting for a busy machine to line one up.
  await L.flush({ force: true }); // nothing in flight, so the next save exports at once
  const realSetImmediate = globalThis.setImmediate;
  let turns = 0;
  globalThis.setImmediate = (f, ...a) => realSetImmediate(() => { turns++; L.flush({ force: true }).catch(() => {}); f(...a); });
  let r;
  try { r = await L.handle('GET', '/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=submission&counts=exact', null); }
  finally { globalThis.setImmediate = realSetImmediate; }
  assert.ok(turns > 0, 'the report yielded (and a save was asked for) at least once');
  assert.equal(r.status, 200, `the report survived ${turns} save attempts: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.unduplicated.served, 25, 'the 25 people of the flow (1.14.0 added 24 for the publication release)');
  await L.flush({ force: true });
  assert.equal(L.isDirty(), false, 'and the deferred save still happens once the report is done');
});

test('the device database is really sql.js behind the shim, sealed in the store it was given', async () => {
  // Guard against the test passing because the kernel quietly fell back to something else: the device
  // saved its database sealed (no SQLite header in the clear) under its epoch, with the vault that opens it.
  await L.flush({ force: true });
  const stored = await new Promise((res) => {
    const r = globalThis.indexedDB.open('suds-local', 1);
    r.onsuccess = () => { const t = r.result.transaction('kv', 'readonly'); const s = t.objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll(); v.onsuccess = () => res(k.result.map((key, i) => [key, v.result[i]])); };
  });
  const keys = stored.map(([k]) => k);
  assert.ok(keys.includes('epoch') && keys.includes('vault'), `store keys: ${keys.join(', ')}`);
  const image = stored.find(([k]) => String(k).startsWith('db2:'));
  assert.ok(image, 'the database image is stored under its epoch');
  const sealed = image[1];
  assert.ok(sealed && sealed.iv instanceof Uint8Array && sealed.ct instanceof Uint8Array && sealed.ct.length > 4096, 'as a sealed image (local/vault.js)');
  assert.ok(!Buffer.from(sealed.ct).includes('SQLite format 3'), 'and not in the clear');
});

test('the device kernel enforces permission grants and denies exactly like the office server', async () => {
  // The kernel bundles server/auth.js with the Task 2-4 permission work. The bundle exports only start()
  // (no direct handle on its auth module) and the device keeps its own database, so the brief's sketch of
  // seeding H.db and calling the kernel's hasPerm cannot work: instead this drives a grant/deny round-trip
  // through each side's REST API and requires identical enforcement answers.
  const step = async (name, d, o, expected) => {
    assert.equal(d.status, expected, `device ${name}: ${JSON.stringify(d.data)}`);
    assert.equal(o.status, expected, `office ${name}: ${JSON.stringify(o.data)}`);
    assert.equal(d.status, o.status, `device and office agree on ${name}`);
  };

  // Device: first account if this test runs alone, otherwise the earlier test's admin. (Signup does not
  // sign in, so an explicit login follows either way; the kernel keeps the session token in memory and
  // re-login switches which user subsequent handle() calls act as.)
  const su = await kernelCall('POST', '/api/local/signup', { display_name: 'Perm Admin', username: 'permadmin', password: 'PermAdminPassw0rd!x', role: 'admin', storage_ack: true });
  const deviceAdmin = su.status === 200 ? { username: 'permadmin', password: 'PermAdminPassw0rd!x' } : { username: 'parity', password: 'ParityPassw0rd!x' };
  assert.equal((await kernelCall('POST', '/api/auth/login', deviceAdmin)).status, 200, 'device admin login');
  // Office: the test server's admin.
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');

  // A navigator on each side. Accounts created via POST /api/users must change their password before
  // doing anything else (must_change_password=1), so both navigators change it first, identically.
  const navBody = { username: 'permnav', display_name: 'Perm Nav', role: 'navigator', password: 'PermNavPassw0rd!x' };
  const dNav = await kernelCall('POST', '/api/users', navBody);
  assert.equal(dNav.status, 201, `device create navigator: ${JSON.stringify(dNav.data)}`);
  const oNav = await admin.post('/api/users', navBody);
  assert.equal(oNav.status, 201, `office create navigator: ${JSON.stringify(oNav.data)}`);
  const navOffice = H.client(); await navOffice.login('permnav', 'PermNavPassw0rd!x');
  assert.equal((await kernelCall('POST', '/api/auth/login', { username: 'permnav', password: 'PermNavPassw0rd!x' })).status, 200, 'device navigator login');
  const pwBody = { current_password: 'PermNavPassw0rd!x', new_password: 'PermNavPassw0rd!y' };
  assert.equal((await navOffice.post('/api/auth/password', pwBody)).status, 200, 'office password change');
  assert.equal((await kernelCall('POST', '/api/auth/password', pwBody)).status, 200, 'device password change');
  const navCreds = { username: 'permnav', password: 'PermNavPassw0rd!y' };

  // The break-glass queue is closed to the navigator before the grant, on both sides.
  await step('break-glass before grant',
    await kernelCall('GET', '/api/supervision/breakglass'),
    await navOffice.get('/api/supervision/breakglass'), 403);

  // Grant audit:read to the navigator on each side; the queue opens on both.
  const grantBody = { permission: 'audit:read', mode: 'grant', reason: 'kernel parity check reviews break-glass queue' };
  assert.equal((await kernelCall('POST', '/api/auth/login', deviceAdmin)).status, 200, 'device admin re-login');
  assert.equal((await kernelCall('POST', `/api/users/${dNav.data.id}/permissions`, grantBody)).status, 200, 'device grant');
  assert.equal((await admin.post(`/api/users/${oNav.data.id}/permissions`, grantBody)).status, 200, 'office grant');
  assert.equal((await kernelCall('POST', '/api/auth/login', navCreds)).status, 200, 'device navigator re-login');
  await step('break-glass after grant',
    await kernelCall('GET', '/api/supervision/breakglass'),
    await navOffice.get('/api/supervision/breakglass'), 200);

  // The client list is open before the deny, then closed by it, on both sides.
  await step('clients before deny',
    await kernelCall('GET', '/api/clients'),
    await navOffice.get('/api/clients'), 200);
  const denyBody = { permission: 'clients:read', mode: 'deny', reason: 'kernel parity check denies client reads' };
  assert.equal((await kernelCall('POST', '/api/auth/login', deviceAdmin)).status, 200, 'device admin re-login');
  assert.equal((await kernelCall('POST', `/api/users/${dNav.data.id}/permissions`, denyBody)).status, 200, 'device deny');
  assert.equal((await admin.post(`/api/users/${oNav.data.id}/permissions`, denyBody)).status, 200, 'office deny');
  assert.equal((await kernelCall('POST', '/api/auth/login', navCreds)).status, 200, 'device navigator re-login');
  await step('clients after deny',
    await kernelCall('GET', '/api/clients'),
    await navOffice.get('/api/clients'), 403);

  // Revoke the deny on each side; the client list opens again on both.
  assert.equal((await kernelCall('POST', '/api/auth/login', deviceAdmin)).status, 200, 'device admin re-login');
  assert.equal((await kernelCall('DELETE', `/api/users/${dNav.data.id}/permissions/clients:read`, { reason: 'parity check revoke reason' })).status, 200, 'device revoke');
  assert.equal((await admin.del(`/api/users/${oNav.data.id}/permissions/clients:read`, { reason: 'parity check revoke reason' })).status, 200, 'office revoke');
  assert.equal((await kernelCall('POST', '/api/auth/login', navCreds)).status, 200, 'device navigator re-login');
  await step('clients after revoke',
    await kernelCall('GET', '/api/clients'),
    await navOffice.get('/api/clients'), 200);
});
