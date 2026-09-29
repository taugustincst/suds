'use strict';
// CalOMS Tx automation (1.17.0; server/caloms-schedule.js, docs/compliance/CALOMS.md "Monthly automation"): the
// monthly run validates the month before and PREPARES its file (not a disclosure); producing it accounts exactly
// those bytes and stamps the records, refused when a record changed since; the submission log records who
// prepared, produced, downloaded and recorded the upload; the worklist assigns each error to the record's owner;
// county mode keeps per-provider NPIs and files. SUDS never contacts DHCS.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;

let admin, sup, nav, fin, navId;
const PROVIDER = '123456'; const SATELLITE = '654321';
const ADMISSION = {
  admission_transaction: '1', service_type: '01', referral_source: '01', days_waited: 3, prior_episodes: 0, mat_planned: 'N', calworks: 'N',
  sex_at_birth: 'F', gender_identity: '2', race: ['01'], ethnicity: '05', veteran: 'N', disability: ['1'], zip_code: '95814', education_grade: 12,
  children_under_18: 1, children_cps: 0, pregnant: 'N', primary_drug: '05', primary_route: '2', primary_age_first_use: 19, secondary_drug: '00', iv_use_12m: 'N',
  primary_days_used: 10, alcohol_days: 0, iv_use_30: 'N', employment_status: '3', paid_work_days: 0, school_enrolled: 'N', job_training: 'N', living_arrangement: '2',
  arrests_30: 0, jail_days_30: 0, prison_days_30: 0, er_visits_30: 0, hospital_nights_30: 0, physical_health_days_30: 2, mh_diagnosis: 'N', mh_er_visits_30: 0,
  psych_inpatient_days_30: 0, psych_meds: 'N', family_conflict_days_30: 1, social_support_days_30: 4, lives_with_user: 'N',
};
const SCHED = () => require('../server/caloms-schedule');
const today = () => require('../server/routes/budget').localDate();
let period;

async function admitted(provider, over = {}, opened = period.from.slice(0, 8) + '10') {
  const c = await nav.post('/api/clients', { first_name: 'Auto', last_name: `Mation${Math.random().toString(36).slice(2, 7)}`, dob: '1990-04-02', status: 'waitlist', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const e = await nav.post(`/api/clients/${c.data.id}/episodes`, { opened_at: opened, caloms: { provider_id: provider, answers: { ...ADMISSION, ...over } } });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return { client: c.data.id, episode: e.data.id, record: db.one(`SELECT id FROM caloms_records WHERE episode_id=?`, e.data.id).id };
}

before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('ca_sup', 'supervisor'); sup = H.client(); await sup.login('ca_sup', 'StaffPassw0rd!x');
  navId = H.makeUser('ca_nav', 'navigator').id; nav = H.client(); await nav.login('ca_nav', 'StaffPassw0rd!x');
  H.makeUser('ca_fin', 'finance'); fin = H.client(); await fin.login('ca_fin', 'StaffPassw0rd!x');
  period = SCHED().previousMonth(today());
});
after(async () => { await H.stop(); });

test('county mode: each provider carries its legal name and a checked NPI; the schedule is an administrator setting', async () => {
  const bad = await admin.put('/api/caloms/settings', { enabled: true, providers: [{ id: PROVIDER, name: 'Main', npi: '1234567890' }] });
  assert.equal(bad.status, 400); assert.ok(bad.data.fields['providers.0.npi'], 'the NPI check digit is verified');
  assert.equal((await sup.put('/api/caloms/settings', { schedule: 'monthly' })).status, 403);
  const ok = await admin.put('/api/caloms/settings', { enabled: true, start_date: '2020-01-01', schedule: 'monthly', schedule_day: 5, split_by_provider: false,
    providers: [{ id: PROVIDER, name: 'Main clinic', legal_name: 'Riverside Recovery Inc.', npi: '1234567893' }, { id: SATELLITE, name: 'Satellite', legal_name: 'Hill County Outreach LLC' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.providers[0].npi, '1234567893'); assert.equal(ok.data.providers[1].legal_name, 'Hill County Outreach LLC');
  assert.deepEqual({ f: ok.data.schedule.frequency, d: ok.data.schedule.day, s: ok.data.schedule.split_by_provider }, { f: 'monthly', d: 5, s: false });
  assert.equal((await admin.put('/api/caloms/settings', { schedule_day: 31 })).status, 400, 'the day is 1 to 28');
});

let main1, main2, bad, sat;
test('the monthly run validates the month before and prepares a file that is not yet a disclosure', async () => {
  main1 = await admitted(PROVIDER); main2 = await admitted(PROVIDER); sat = await admitted(SATELLITE);
  bad = await admitted(PROVIDER);
  // Break one record after saving it, as a record edited on a device might arrive: a fatal error.
  const C = require('../server/caloms');
  const rec = db.one(`SELECT * FROM caloms_records WHERE id=?`, bad.record);
  const ans = JSON.parse(require('../server/crypto').decrypt(rec.answers_enc)); ans.zip_code = '9';
  db.run(`UPDATE caloms_records SET answers_enc=? WHERE id=?`, require('../server/crypto').encrypt(JSON.stringify(ans)), bad.record);
  assert.ok(C.check(C.present(db.one(`SELECT * FROM caloms_records WHERE id=?`, bad.record)), C.contextFor(db.one(`SELECT * FROM episodes WHERE id=?`, bad.episode))).some(i => i.severity === 'fatal'));
  // Not before the configured day; once on it, for the month before; and only once.
  const early = `${today().slice(0, 7)}-04`;
  assert.equal(SCHED().runIfDue(early), null, 'before the fifth, nothing');
  const run = SCHED().runIfDue(`${today().slice(0, 7)}-05`);
  assert.ok(run, 'ran'); assert.equal(run.from, period.from); assert.equal(run.to, period.to);
  assert.equal(run.prepared.length, 1); assert.ok(run.fatal >= 1);
  assert.equal(SCHED().runIfDue(`${today().slice(0, 7)}-06`), null, 'once a month');
  const sub = db.one(`SELECT * FROM caloms_submissions WHERE id=?`, run.prepared[0]);
  assert.equal(sub.status, 'prepared'); assert.equal(sub.origin, 'scheduled'); assert.match(sub.file_enc, /^v1:/);
  assert.equal(JSON.parse(sub.record_ids).length, 3, 'the three clean records; the broken one is held back');
  assert.equal(db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='caloms'`).n, 0, 'preparing discloses nothing');
  assert.equal(db.one(`SELECT COUNT(*) n FROM caloms_records WHERE extracted_at IS NOT NULL`).n, 0, 'and marks nothing as sent');
  assert.equal(db.one(`SELECT action FROM caloms_submission_events WHERE submission_id=?`, sub.id).action, 'prepared');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='caloms.schedule.run'`));
  // A prepared file cannot be downloaded until it is produced.
  const dl = await sup.raw(`/api/caloms/submissions/${sub.id}/file`);
  assert.equal(dl.status, 409);
  const list = await sup.get('/api/caloms/submissions');
  assert.equal(list.data.rows.find(x => x.id === sub.id).status, 'prepared');
});

test('the worklist assigns each error to the record owner', async () => {
  const all = await sup.get(`/api/caloms/worklist?from=${period.from}&to=${period.to}`);
  assert.equal(all.status, 200, JSON.stringify(all.data));
  const row = all.data.rows.find(x => x.record_id === bad.record && x.severity === 'fatal');
  assert.ok(row, 'the broken record is on the worklist'); assert.equal(row.owner_id, navId); assert.equal(row.owner_name, 'ca_nav');
  assert.equal(row.mine, false, 'not the supervisor\'s');
  const mine = await nav.get(`/api/caloms/worklist?from=${period.from}&to=${period.to}&mine=1`);
  assert.equal(mine.status, 200); assert.ok(mine.data.rows.length >= 1 && mine.data.rows.every(x => x.mine));
  assert.ok(!JSON.stringify(mine.data).includes('95814'), 'codes, fields and dates only: no answers');
  assert.equal((await fin.get('/api/caloms/worklist')).status, 403);
});

test('producing a prepared file accounts exactly its bytes and stamps its records; the log records each step', async () => {
  const sub = db.one(`SELECT * FROM caloms_submissions WHERE status='prepared' ORDER BY created_at DESC LIMIT 1`);
  assert.equal((await nav.post(`/api/caloms/submissions/${sub.id}/produce`, {})).status, 403, 'export:identified');
  const p = await sup.post(`/api/caloms/submissions/${sub.id}/produce`, {});
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.clients_disclosed, 3); assert.equal(p.data.sha256, sub.sha256, 'the same bytes that were prepared');
  assert.equal(db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='caloms' AND source_ref=?`, `caloms:${sub.id}`).n, 3);
  assert.equal(db.one(`SELECT COUNT(*) n FROM caloms_records WHERE extracted_at IS NOT NULL`).n, 3, 'the existing extracted-date semantics');
  assert.equal((await sup.post(`/api/caloms/submissions/${sub.id}/produce`, {})).status, 409, 'once');
  const dl = await sup.raw(`/api/caloms/submissions/${sub.id}/file`);
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('x-suds-sha256'), sub.sha256);
  // Recording the upload: SUDS does not upload; a person records that they did.
  assert.equal((await sup.post(`/api/caloms/submissions/${sub.id}/uploaded`, { uploaded_on: '2999-01-01' })).status, 400);
  assert.equal((await sup.post(`/api/caloms/submissions/${sub.id}/uploaded`, { uploaded_on: today(), dhcs_reference: '<script>' })).status, 400);
  assert.equal((await nav.post(`/api/caloms/submissions/${sub.id}/uploaded`, { uploaded_on: today() })).status, 403);
  const up = await sup.post(`/api/caloms/submissions/${sub.id}/uploaded`, { uploaded_on: today(), dhcs_reference: 'BATCH-2026-0042' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const log = await sup.get(`/api/caloms/submissions/${sub.id}/events`);
  assert.equal(log.status, 200);
  assert.deepEqual(log.data.rows.map(x => x.action), ['prepared', 'produced', 'downloaded', 'uploaded']);
  assert.equal(log.data.rows[0].who, 'Scheduled run'); assert.equal(log.data.rows[1].who, 'ca_sup');
  assert.equal((await nav.get(`/api/caloms/submissions/${sub.id}/events`)).status, 403);
  const listed = (await sup.get('/api/caloms/submissions')).data.rows.find(x => x.id === sub.id);
  assert.equal(listed.dhcs_reference, 'BATCH-2026-0042'); assert.equal(listed.uploaded_by_name, 'ca_sup'); assert.equal(listed.downloads, 1);
});

test('a prepared file whose records changed since cannot be produced; it is discarded and prepared again', async () => {
  // The test above produced these records; as if they had not been sent, so that only the edit below makes the
  // file stale (a record already sent is stale on its own since 1.17.1: the M1 test below).
  db.run(`UPDATE caloms_records SET extracted_at=NULL`);
  const run = await sup.post('/api/caloms/schedule/run', { from: period.from, to: period.to });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const id = run.data.prepared[0];
  // A record in it is edited after it was prepared.
  db.run(`UPDATE caloms_records SET updated_at=? WHERE id=?`, new Date(Date.now() + 1000).toISOString(), main1.record);
  const p = await sup.post(`/api/caloms/submissions/${id}/produce`, {});
  assert.equal(p.status, 409); assert.equal(p.data.stale, 1);
  assert.equal((await nav.post(`/api/caloms/submissions/${id}/discard`, {})).status, 403);
  assert.equal((await sup.post(`/api/caloms/submissions/${id}/discard`, {})).status, 200);
  const row = db.one(`SELECT status, file_enc FROM caloms_submissions WHERE id=?`, id);
  assert.equal(row.status, 'discarded'); assert.equal(row.file_enc, null, 'the file goes with it');
  assert.equal((await sup.post(`/api/caloms/submissions/${id}/uploaded`, { uploaded_on: today() })).status, 409, 'a discarded file was never sent');
  assert.equal((await nav.post('/api/caloms/schedule/run', {})).status, 403);
});

test('county mode: one file per provider, with only that provider\'s records and activity', async () => {
  await admin.put('/api/caloms/settings', { split_by_provider: true });
  const run = await sup.post('/api/caloms/schedule/run', { from: period.from, to: period.to });
  assert.equal(run.status, 200);
  assert.equal(run.data.prepared.length, 2, 'one per provider');
  const subs = run.data.prepared.map(id => db.one(`SELECT * FROM caloms_submissions WHERE id=?`, id));
  const satFile = subs.find(s => s.provider_id === SATELLITE); const mainFile = subs.find(s => s.provider_id === PROVIDER);
  assert.deepEqual(JSON.parse(satFile.record_ids), [sat.record]);
  assert.equal(JSON.parse(mainFile.record_ids).length, 2);
  assert.match(satFile.file_name, new RegExp(`-${SATELLITE}-`));
  // By hand, for one provider.
  const one = await sup.post('/api/caloms/submissions', { from: period.from, to: period.to, provider_id: SATELLITE });
  assert.equal(one.status, 200, JSON.stringify(one.data)); assert.equal(one.data.clients_disclosed, 1);
  assert.equal((await sup.post('/api/caloms/submissions', { from: period.from, to: period.to, provider_id: 'NOPE99' })).status, 400);
  await admin.put('/api/caloms/settings', { split_by_provider: false, schedule: 'off' });
});

test('a purged client takes every prepared file with them', () => {
  db.run(`UPDATE caloms_submissions SET status='prepared' WHERE status='prepared'`);
  const kept = db.one(`SELECT COUNT(*) n FROM caloms_submissions WHERE status='prepared' AND file_enc IS NOT NULL`).n;
  assert.ok(kept >= 1);
  const R = require('../server/retention');
  db.run(`UPDATE clients SET status='closed', discharge_date='2000-01-01' WHERE id=?`, sat.client);
  R.purgeClient(db.one(`SELECT * FROM clients WHERE id=?`, sat.client), { user: null });
  assert.equal(db.one(`SELECT COUNT(*) n FROM caloms_submissions WHERE status='prepared' AND file_enc IS NOT NULL`).n, 0);
});

test('the scheduled run is idempotent per provider: a failed provider is tried again next hour, and no file is prepared twice', async () => {
  // Engineering review of the 1.17.0 candidate, L2: if preparing the second provider's file threw, the month was
  // never recorded as run, and the next hourly pass prepared the first provider's file again.
  await admin.put('/api/caloms/settings', { split_by_provider: true, schedule: 'monthly', schedule_day: 5 });
  await admitted(PROVIDER); await admitted(SATELLITE);
  db.run(`DELETE FROM settings WHERE key='caloms_schedule_last'`);
  const C = require('../server/caloms');
  const real = C.buildExtract;
  const scheduled = (p) => db.one(`SELECT COUNT(*) n FROM caloms_submissions WHERE period_from=? AND origin='scheduled' AND status='prepared' AND file_enc IS NOT NULL AND provider_id=?`, period.from, p).n;
  const day = `${today().slice(0, 7)}-05`;
  try {
    C.buildExtract = (o) => { if (o.providerId === SATELLITE) throw new Error('disk full'); return real(o); };
    const first = SCHED().runIfDue(day);
    assert.deepEqual(first.failed, [SATELLITE]);
    assert.equal(first.prepared.length, 1);
    assert.equal(scheduled(PROVIDER), 1); assert.equal(scheduled(SATELLITE), 0);
  } finally { C.buildExtract = real; }
  // The next pass: the month is not done; only the provider that failed is prepared.
  const second = SCHED().runIfDue(day);
  assert.ok(second, 'the month was not recorded as done');
  assert.deepEqual(second.failed, []);
  assert.equal(scheduled(PROVIDER), 1, 'the first provider\'s file is not prepared again');
  assert.equal(scheduled(SATELLITE), 1);
  assert.equal(second.prepared.length, 2, 'the summary lists both files');
  assert.equal(SCHED().runIfDue(day), null, 'then the month is done');
  // The month's record lost (a restored setting, say): the schedule's files waiting to be produced are kept, not
  // prepared again.
  db.run(`DELETE FROM settings WHERE key='caloms_schedule_last'`);
  SCHED().runIfDue(day);
  assert.equal(scheduled(PROVIDER), 1); assert.equal(scheduled(SATELLITE), 1);
  await admin.put('/api/caloms/settings', { split_by_provider: false, schedule: 'off' });
});

test('a scheduled file produced or discarded between passes is not prepared again, and a file of records already sent cannot be produced (1.17.1, M1)', async () => {
  // Engineering review of 1.17.0, M1: only a file still waiting counted as already prepared, so a provider's file
  // produced (or discarded) while another provider's failed was prepared again on the next hourly pass.
  await admin.put('/api/caloms/settings', { split_by_provider: true, schedule: 'monthly', schedule_day: 5 });
  const day = `${period.from.slice(0, 7)}-05`;          // a run last month covers the month before it
  const older = SCHED().previousMonth(day);
  const opened = `${older.from.slice(0, 8)}10`;
  const a = await admitted(PROVIDER, {}, opened); const b = await admitted(SATELLITE, {}, opened);
  const files = (p) => db.all(`SELECT id, status FROM caloms_submissions WHERE period_from=? AND origin='scheduled' AND provider_id=? ORDER BY created_at`, older.from, p);
  db.run(`DELETE FROM settings WHERE key='caloms_schedule_last'`);
  const C = require('../server/caloms');
  const real = C.buildExtract;
  try {
    C.buildExtract = (o) => { if (o.providerId === SATELLITE) throw new Error('disk full'); return real(o); };
    assert.deepEqual(SCHED().runIfDue(day).failed, [SATELLITE]);
  } finally { C.buildExtract = real; }
  const [mainFile] = files(PROVIDER);
  assert.ok(mainFile && mainFile.status === 'prepared');
  assert.deepEqual(JSON.parse(db.one(`SELECT record_ids FROM caloms_submissions WHERE id=?`, mainFile.id).record_ids), [a.record]);
  // Between the passes, a person produces the first provider's file.
  const p = await sup.post(`/api/caloms/submissions/${mainFile.id}/produce`, {});
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const second = SCHED().runIfDue(day);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(files(PROVIDER).map(f => f.status), ['produced'], 'the produced file is not prepared again');
  assert.deepEqual(files(SATELLITE).map(f => f.status), ['prepared'], 'only the provider that failed');
  assert.ok(second.prepared.includes(mainFile.id), 'the summary names the produced file as the month\'s');
  // A person discards the second provider's file; the month's record is lost (a restored setting, say): the
  // schedule does not silently make it again.
  const satFile = files(SATELLITE)[0];
  assert.equal((await sup.post(`/api/caloms/submissions/${satFile.id}/discard`, {})).status, 200);
  db.run(`DELETE FROM settings WHERE key='caloms_schedule_last'`);
  SCHED().runIfDue(day);
  assert.deepEqual(files(PROVIDER).map(f => f.status), ['produced']);
  assert.deepEqual(files(SATELLITE).map(f => f.status), ['discarded'], 'a discarded file is not regenerated by the schedule');
  // Checking and preparing by hand still makes new files; the first provider's holds a record already sent, so it
  // cannot be produced (it would be disclosed and sent twice); the second provider's can.
  const manual = await sup.post('/api/caloms/schedule/run', { from: older.from, to: older.to });
  assert.equal(manual.status, 200, JSON.stringify(manual.data));
  const again = manual.data.prepared.map(id => db.one(`SELECT id, provider_id FROM caloms_submissions WHERE id=?`, id));
  const dupe = again.find(x => x.provider_id === PROVIDER); const fresh = again.find(x => x.provider_id === SATELLITE);
  const refused = await sup.post(`/api/caloms/submissions/${dupe.id}/produce`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.data)); assert.equal(refused.data.stale, 1);
  assert.match(refused.data.error, /already sent in another file/);
  assert.equal(db.one(`SELECT COUNT(*) n FROM disclosures WHERE source_ref=?`, `caloms:${dupe.id}`).n, 0, 'nothing accounted');
  const ok = await sup.post(`/api/caloms/submissions/${fresh.id}/produce`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(db.one(`SELECT extracted_at FROM caloms_records WHERE id=?`, b.record).extracted_at);
  await admin.put('/api/caloms/settings', { split_by_provider: false, schedule: 'off' });
});

test('the upload date is checked against when the file was produced, not when it was prepared (1.17.1, L4)', async () => {
  const sub = db.one(`SELECT id FROM caloms_submissions WHERE status='produced' AND origin='scheduled' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(sub);
  // Prepared on the 5th, produced on the 12th: an upload on the 8th is refused, the 12th and later accepted.
  db.run(`UPDATE caloms_submissions SET created_at='2026-08-05T10:00:00.000Z' WHERE id=?`, sub.id);
  db.run(`UPDATE caloms_submission_events SET created_at='2026-08-12T10:00:00.000Z' WHERE submission_id=? AND action='produced'`, sub.id);
  const early = await sup.post(`/api/caloms/submissions/${sub.id}/uploaded`, { uploaded_on: '2026-08-08' });
  assert.equal(early.status, 400, JSON.stringify(early.data));
  assert.equal(early.data.fields.uploaded_on, 'before the file existed');
  const onTime = await sup.post(`/api/caloms/submissions/${sub.id}/uploaded`, { uploaded_on: '2026-08-12' });
  assert.equal(onTime.status, 200, JSON.stringify(onTime.data));
});
