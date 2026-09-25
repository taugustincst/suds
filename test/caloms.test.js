'use strict';
// CalOMS Tx state reporting and the county EHR hand-off (county review: "CalOMS Tx reporting: no admission,
// discharge or annual-update records; no fatal-error validation or monthly provider accounting" and "Drug
// Medi-Cal claims: no 837"). SUDS does not bill; it collects and validates CalOMS Tx records, extracts them
// for DHCS as an accounted disclosure, and hands encounters to the county EHR.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const H = require('./helpers');
const db = H.db;

let admin, sup, clin, fin, nav, clinId;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
const PROVIDER = '123456';

// A complete, valid admission. Every test that wants one fatal error starts from here and breaks one thing.
const ADMISSION = {
  admission_transaction: '1', service_type: '01', referral_source: '01', days_waited: 3, prior_episodes: 0, mat_planned: 'N', calworks: 'N',
  sex_at_birth: 'F', gender_identity: '2', race: ['01'], ethnicity: '05', veteran: 'N', disability: ['1'], zip_code: '95814', education_grade: 12,
  children_under_18: 1, children_cps: 0, pregnant: 'N', primary_drug: '05', primary_route: '2', primary_age_first_use: 19, secondary_drug: '00', iv_use_12m: 'N',
};
const MEASURES = {
  primary_days_used: 10, alcohol_days: 0, iv_use_30: 'N', employment_status: '3', paid_work_days: 0, school_enrolled: 'N', job_training: 'N', living_arrangement: '2',
  arrests_30: 0, jail_days_30: 0, prison_days_30: 0, er_visits_30: 0, hospital_nights_30: 0, physical_health_days_30: 2, mh_diagnosis: 'N', mh_er_visits_30: 0,
  psych_inpatient_days_30: 0, psych_meds: 'N', family_conflict_days_30: 1, social_support_days_30: 4, lives_with_user: 'N',
};
const admission = (over = {}) => ({ ...ADMISSION, ...MEASURES, ...over });

async function newClient(who, extra = {}) {
  const r = await who.post('/api/clients', { first_name: 'Cal', last_name: `Oms${Math.random().toString(36).slice(2, 7)}`, dob: '1990-04-02', status: 'waitlist', confirm_duplicate: true, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
const codeOf = (id) => db.one(`SELECT client_code FROM clients WHERE id=?`, id).client_code;
function unzip(buf) {
  const out = {}; let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18); const nameLen = buf.readUInt16LE(i + 26); const extra = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString(); const start = i + 30 + nameLen + extra;
    out[name] = zlib.inflateRawSync(buf.slice(start, start + size)).toString('utf8').replace(/^﻿/, '');
    i = start + size;
  }
  return out;
}

before(async () => {
  await H.start();
  sup = H.client(); H.makeUser('co_sup', 'supervisor'); await sup.login('co_sup', 'StaffPassw0rd!x');
  clinId = H.makeUser('co_clin', 'clinician').id; clin = H.client(); await clin.login('co_clin', 'StaffPassw0rd!x');
  fin = H.client(); H.makeUser('co_fin', 'finance'); await fin.login('co_fin', 'StaffPassw0rd!x');
  nav = H.client(); H.makeUser('co_nav', 'navigator'); await nav.login('co_nav', 'StaffPassw0rd!x');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(async () => { await H.stop(); });

// ---- settings ----
test('CalOMS is off by default, and any signed-in role can read the configuration and layout', async () => {
  const c = await fin.get('/api/caloms/config');
  assert.equal(c.status, 200);
  assert.equal(c.data.enabled, false, 'off by default so a prevention programme is never asked');
  assert.ok(c.data.spec.fields.length > 40 && c.data.spec.sets.DRUGS.length > 10);
  assert.match(c.data.spec.source, /to verify/i, 'the layout says it is unverified against the DHCS dictionary');
});

test('only an administrator turns CalOMS on, and only with a valid provider ID', async () => {
  assert.equal((await sup.put('/api/caloms/settings', { enabled: true, providers: [{ id: PROVIDER, name: 'Main' }] })).status, 403);
  assert.equal((await clin.put('/api/caloms/settings', { enabled: true, providers: [{ id: PROVIDER }] })).status, 403);
  const none = await admin.put('/api/caloms/settings', { enabled: true, providers: [] });
  assert.equal(none.status, 400); assert.ok(none.data.fields.providers);
  const bad = await admin.put('/api/caloms/settings', { enabled: true, providers: [{ id: '12-34', name: 'x' }] });
  assert.equal(bad.status, 400); assert.ok(bad.data.fields['providers.0.id']);
  const dup = await admin.put('/api/caloms/settings', { enabled: true, providers: [{ id: PROVIDER }, { id: PROVIDER }] });
  assert.equal(dup.status, 400);
  const ok = await admin.put('/api/caloms/settings', { enabled: true, providers: [{ id: PROVIDER, name: 'Main clinic' }, { id: '654321', name: 'Satellite' }], start_date: '2020-01-01' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.enabled, true); assert.equal(ok.data.providers.length, 2); assert.equal(ok.data.start_date, '2020-01-01');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='caloms.settings.update'`));
});

// ---- admission ----
test('with CalOMS on, an admission needs the CalOMS answers, and they are stored encrypted', async () => {
  const id = await newClient(nav);
  const missing = await nav.post(`/api/clients/${id}/episodes`, { opened_at: TODAY });
  assert.equal(missing.status, 400); assert.match(missing.data.error, /CalOMS admission/);
  assert.ok(!db.one(`SELECT 1 FROM episodes WHERE client_id=?`, id), 'no episode without its admission record');
  const r = await nav.post(`/api/clients/${id}/episodes`, { opened_at: TODAY, caloms: { provider_id: PROVIDER, answers: admission({ pregnant: 'Y', race: ['01', '07'] }) } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = db.one(`SELECT * FROM caloms_records WHERE episode_id=?`, r.data.id);
  assert.equal(row.record_type, 'admission'); assert.equal(row.record_date, TODAY); assert.equal(row.provider_id, PROVIDER); assert.equal(row.service_type, '01');
  assert.match(row.answers_enc, /^v1:/, 'answers are encrypted');
  assert.doesNotMatch(row.answers_enc, /95814|pregnant/);
  const audits = db.all(`SELECT details FROM audit_log WHERE action='caloms.record.save' AND client_id=?`, id).map(a => a.details || '').join(' ');
  assert.doesNotMatch(audits, /95814|pregnant|"Y"/, 'no answers in the audit trail');
  const view = await nav.get(`/api/episodes/${r.data.id}/caloms`);
  assert.equal(view.status, 200);
  assert.equal(view.data.records[0].answers.zip_code, '95814');
  assert.deepEqual(view.data.records[0].issues.filter(i => i.severity === 'fatal'), []);
  assert.equal((await clin.get(`/api/episodes/${r.data.id}/caloms`)).status, 403, 'caseload-scoped');
});

test('a fatal edit-check error blocks the save and names the field', async () => {
  const id = await newClient(nav);
  const r = await nav.post(`/api/clients/${id}/episodes`, { opened_at: TODAY, caloms: { provider_id: PROVIDER, answers: admission({ sex_at_birth: 'M', pregnant: 'Y' }) } });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.caloms_pregnant, JSON.stringify(r.data));
  assert.ok(!db.one(`SELECT 1 FROM episodes WHERE client_id=?`, id), 'the admission is rolled back with its record');
  const unknown = await nav.post(`/api/clients/${id}/episodes`, { opened_at: TODAY, caloms: { provider_id: '999999', answers: admission() } });
  assert.equal(unknown.status, 400); assert.ok(unknown.data.fields.caloms_provider_id);
});

// Each fatal error the edit checks derive from the guide, one at a time, against the checker itself.
test('every fatal edit check fires on its own', () => {
  const C = require('../server/caloms');
  const ctx = { dob: '1990-04-02', episode: { opened_at: '2026-01-10' }, providers: [PROVIDER], today: '2026-09-25', admission: null };
  const adm = (over = {}, rec = {}) => C.check({ record_type: 'admission', provider_id: PROVIDER, record_date: '2026-01-10', answers: { ...admission(), ...over }, ...rec }, ctx);
  const fatalCodes = (issues) => issues.filter(i => i.severity === 'fatal').map(i => `${i.field}:${i.code}`);
  assert.deepEqual(fatalCodes(adm()), [], 'the fixture is clean');
  const cases = [
    [adm({ service_type: undefined }), 'service_type:required'],
    [adm({ referral_source: 'XX' }), 'referral_source:invalid_code'],
    [adm({ days_waited: -1 }), 'days_waited:out_of_range'],
    [adm({ primary_days_used: 31 }), 'primary_days_used:out_of_range'],
    [adm({ education_grade: 'twelve' }), 'education_grade:not_a_number'],
    [adm({ zip_code: '958' }), 'zip_code:zip_invalid'],
    [adm({ race: ['01', '02', '03', '05', '06', '07'] }), 'race:too_many_codes'],
    [adm({ race: ['01', '01'] }), 'race:duplicate_code'],
    [adm({ disability: ['1', '2'] }), 'disability:exclusive_code_combined'],
    [adm({}, { provider_id: '' }), 'provider_id:provider_missing'],
    [adm({}, { provider_id: '000000' }), 'provider_id:provider_unknown'],
    [adm({}, { record_date: '2026-13-01' }), 'record_date:date_invalid'],
    [adm({}, { record_date: '2026-12-01' }), 'record_date:date_future'],
    [C.check({ record_type: 'admission', provider_id: PROVIDER, record_date: '2026-01-10', answers: admission() }, { ...ctx, dob: null }), 'dob:dob_missing'],
    [C.check({ record_type: 'admission', provider_id: PROVIDER, record_date: '1989-01-10', answers: admission() }, ctx), 'dob:admission_before_birth'],
    [C.check({ record_type: 'admission', provider_id: PROVIDER, record_date: '2026-01-10', answers: admission() }, { ...ctx, dob: '1900-01-01' }), 'dob:age_out_of_range'],
    [adm({ primary_age_first_use: 50 }), 'primary_age_first_use:first_use_after_admission'],
    [adm({ sex_at_birth: 'M', pregnant: 'Y' }), 'pregnant:pregnant_not_female'],
    [adm({ primary_drug: '00' }), 'primary_drug:primary_drug_none'],
    [adm({ secondary_drug: '05', secondary_route: '1', secondary_age_first_use: 20, secondary_days_used: 1 }), 'secondary_drug:secondary_same_as_primary'],
    [adm({ secondary_drug: '02' }), 'secondary_route:required'],
    [adm({ secondary_drug: '02', secondary_route: '1' }), 'secondary_age_first_use:required'],
    [adm({ secondary_days_used: 4 }), 'secondary_days_used:secondary_days_without_drug'],
    [adm({ iv_use_30: 'Y', iv_use_12m: 'N' }), 'iv_use_12m:needle_use_inconsistent'],
    [adm({ children_under_18: 1, children_cps: 2 }), 'children_cps:children_cps_exceeds'],
    [adm({ jail_days_30: 20, prison_days_30: 11 }), 'prison_days_30:jail_prison_over_30'],
  ];
  for (const [issues, want] of cases) assert.ok(fatalCodes(issues).includes(want), `${want} expected, got ${JSON.stringify(fatalCodes(issues))}`);

  // Discharge and annual update checks.
  const withAdm = { ...ctx, admission: admission(), admissionDate: '2026-01-10' };
  const dis = (answers, date = '2026-09-01', c = withAdm) => fatalCodes(C.check({ record_type: 'discharge', provider_id: PROVIDER, record_date: date, answers }, c));
  assert.deepEqual(dis({ ...MEASURES, discharge_status: '1', last_service_date: '2026-08-30' }), []);
  assert.deepEqual(dis({ discharge_status: '6', last_service_date: '2026-08-30' }), [], 'an administrative discharge needs no repeated measures');
  assert.ok(dis({ discharge_status: '1', last_service_date: '2026-08-30' }).includes('employment_status:required'), 'a standard discharge does');
  assert.ok(dis({ discharge_status: '9', last_service_date: '2026-08-30' }).includes('discharge_status:invalid_code'));
  assert.ok(dis({ last_service_date: '2026-08-30' }).includes('discharge_status:required'));
  assert.ok(dis({ discharge_status: '6', last_service_date: '2026-08-30' }, '2026-01-01').includes('record_date:discharge_before_admission'));
  assert.ok(dis({ discharge_status: '6', last_service_date: '2026-09-10' }).includes('last_service_date:last_service_outside_episode'));
  assert.ok(dis({ discharge_status: '6', last_service_date: '2026-08-30' }, '2026-09-01', { ...ctx }).includes('record_type:no_admission'));
  assert.ok(dis({ discharge_status: '6', last_service_date: '2026-08-30' }, '2026-09-01', { ...withAdm, admissionFatal: true }).includes('record_type:admission_has_errors'));
  const upd = (date, c = withAdm) => fatalCodes(C.check({ record_type: 'annual_update', provider_id: PROVIDER, record_date: date, answers: MEASURES }, { ...c, today: '2027-12-31' }));
  assert.ok(upd('2026-06-01').includes('record_date:annual_update_too_early'));
  assert.deepEqual(upd('2027-01-05'), []);
  assert.ok(upd('2027-01-05', { ...withAdm, dischargeDate: '2026-12-01' }).includes('record_date:annual_update_after_discharge'));
  // A warning is not fatal.
  const young = C.check({ record_type: 'admission', provider_id: PROVIDER, record_date: '2026-01-10', answers: admission({ primary_age_first_use: 8 }) }, { ...ctx, dob: '2016-01-01' });
  assert.ok(young.some(i => i.code === 'age_under_12' && i.severity === 'warning'));
});

// ---- discharge, annual update, re-admission ----
test('a discharge needs its CalOMS record, dated by the discharge; a problem undoes the whole discharge', async () => {
  const id = await newClient(nav);
  const ep = (await nav.post(`/api/clients/${id}/episodes`, { opened_at: day(-40), caloms: { provider_id: PROVIDER, answers: admission() } })).data.id;
  const none = await nav.post(`/api/episodes/${ep}/close`, { discharge_reason: 'completed', closed_at: day(-1) });
  assert.equal(none.status, 400);
  const bad = await nav.post(`/api/episodes/${ep}/close`, { discharge_reason: 'completed', closed_at: day(-1), caloms: { answers: { discharge_status: '1', last_service_date: day(-2) } } });
  assert.equal(bad.status, 400, 'a standard discharge without the repeated measures');
  assert.ok(bad.data.fields.caloms_employment_status);
  assert.equal(db.one(`SELECT status FROM episodes WHERE id=?`, ep).status, 'open', 'the discharge was rolled back');
  const ok = await nav.post(`/api/episodes/${ep}/close`, { discharge_reason: 'completed', closed_at: day(-1), caloms: { answers: { ...MEASURES, discharge_status: '1', last_service_date: day(-2) } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const rec = db.one(`SELECT * FROM caloms_records WHERE episode_id=? AND record_type='discharge'`, ep);
  assert.equal(rec.record_date, day(-1)); assert.equal(rec.provider_id, PROVIDER, 'reported under the provider that admitted the client');
  assert.equal(rec.discharge_status, '1');
  // Re-admitting on the same episode (a discharge in error) removes the discharge record. (The discharge
  // ended the navigator's assignment, so a supervisor re-admits.)
  const re = await sup.post(`/api/episodes/${ep}/reopen`, { reason: 'discharged by mistake' });
  assert.equal(re.status, 200);
  assert.ok(!db.one(`SELECT 1 FROM caloms_records WHERE episode_id=? AND record_type='discharge'`, ep));
  assert.ok(db.one(`SELECT 1 FROM tombstones WHERE table_name='caloms_records' AND id=?`, rec.id), 'and devices are told');
  // Administrative discharge: status and last service date only.
  const adm = await sup.post(`/api/episodes/${ep}/close`, { discharge_reason: 'lost_contact', closed_at: day(-1), caloms: { provider_id: PROVIDER, answers: { discharge_status: '6', last_service_date: day(-10) } } });
  assert.equal(adm.status, 200, JSON.stringify(adm.data));
});

test('annual updates: recorded against a long episode, refused too early', async () => {
  const id = await newClient(nav);
  const ep = (await nav.post(`/api/clients/${id}/episodes`, { opened_at: day(-400), caloms: { provider_id: PROVIDER, answers: admission() } })).data.id;
  const early = await nav.post(`/api/episodes/${ep}/caloms`, { record_type: 'annual_update', provider_id: PROVIDER, record_date: day(-300), answers: MEASURES });
  assert.equal(early.status, 400); assert.ok(early.data.fields.caloms_record_date);
  const due = (await nav.get(`/api/episodes/${ep}/caloms`)).data.expected;
  assert.ok(due.some(x => x.record_type === 'annual_update'), 'the anniversary shows as due');
  const ok = await nav.post(`/api/episodes/${ep}/caloms`, { record_type: 'annual_update', provider_id: PROVIDER, record_date: day(-30), answers: MEASURES });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(!(await nav.get(`/api/episodes/${ep}/caloms`)).data.expected.some(x => x.record_type === 'annual_update'));
  const disc = await nav.post(`/api/episodes/${ep}/caloms`, { record_type: 'discharge', answers: { discharge_status: '6' } });
  assert.equal(disc.status, 400, 'a discharge record is only made by discharging');
  assert.equal((await fin.post(`/api/episodes/${ep}/caloms`, { record_type: 'annual_update', answers: MEASURES })).status, 403);
  // Edit and delete.
  const put = await nav.put(`/api/caloms/records/${ok.data.id}`, { provider_id: '654321', record_date: day(-29), answers: { ...MEASURES, arrests_30: 1 } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(db.one(`SELECT provider_id FROM caloms_records WHERE id=?`, ok.data.id).provider_id, '654321');
  assert.equal((await clin.del(`/api/caloms/records/${ok.data.id}`)).status, 403, 'not on the clinician\'s caseload');
  assert.equal((await nav.del(`/api/caloms/records/${ok.data.id}`)).status, 200);
});

// ---- validation report ----
let goodClient, badClient, missingClient;
test('the validation report lists each problem by client code and field, including missing records', async () => {
  goodClient = await newClient(sup);
  await sup.post(`/api/clients/${goodClient}/episodes`, { opened_at: day(-20), caloms: { provider_id: PROVIDER, answers: admission() } });
  // An admission that saved (warnings only) but whose client's date of birth was later removed: a fatal
  // error found only by the report, so the extract must hold it back.
  badClient = await newClient(sup);
  await sup.post(`/api/clients/${badClient}/episodes`, { opened_at: day(-20), caloms: { provider_id: PROVIDER, answers: admission() } });
  db.run(`UPDATE clients SET dob_enc=NULL WHERE id=?`, badClient);
  // Intake with CalOMS on opens an episode with no admission record yet.
  missingClient = (await sup.post('/api/clients', { first_name: 'No', last_name: 'Record', dob: '1985-01-01', confirm_duplicate: true, intake_date: day(-5) })).data.id;
  const r = await sup.get(`/api/caloms/validation?from=${day(-60)}&to=${TODAY}`);
  assert.equal(r.status, 200);
  const rows = r.data.rows;
  assert.ok(rows.some(x => x.client_code === codeOf(badClient) && x.field === 'dob' && x.code === 'dob_missing' && x.severity === 'fatal'));
  assert.ok(rows.some(x => x.client_code === codeOf(missingClient) && x.code === 'missing_admission'));
  assert.ok(!rows.some(x => x.client_code === codeOf(goodClient) && x.severity === 'fatal'), 'a clean record has nothing listed');
  assert.ok(r.data.summary.blocked >= 1 && r.data.summary.ready >= 1);
  assert.doesNotMatch(JSON.stringify(rows), /95814|Oms[a-z0-9]{5}/, 'codes and fields only — no answers, no names');
  const csv = await sup.get(`/api/caloms/validation?from=${day(-60)}&to=${TODAY}&format=csv`);
  assert.equal(csv.status, 200); assert.match(csv.data, /Client Code/); assert.match(csv.data, new RegExp(codeOf(badClient)));
  // Caseload scoping: a clinician sees only their own clients' problems; finance cannot see the report.
  const mine = await clin.get(`/api/caloms/validation?from=${day(-60)}&to=${TODAY}`);
  assert.equal(mine.status, 200); assert.equal(mine.data.rows.length, 0);
  assert.equal((await fin.get(`/api/caloms/validation?from=${day(-60)}&to=${TODAY}`)).status, 403);
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='caloms.validate'`));
});

// ---- extract ----
test('the extract is identified-export only, holds back fatal records, and is accounted for per client', async () => {
  const from = day(-60);
  assert.equal((await clin.get(`/api/caloms/extract?from=${from}&to=${TODAY}`)).status, 403, 'a clinician cannot make an identified export');
  assert.equal((await fin.get(`/api/caloms/extract?from=${from}&to=${TODAY}`)).status, 403);
  assert.equal((await nav.get(`/api/caloms/extract?from=${from}&to=${TODAY}`)).status, 403);
  // helpers' client decodes bodies as text, which corrupts a zip; fetch the bytes with the same cookie.
  const login = await fetch(`${await H.start()}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ username: 'co_sup', password: 'StaffPassw0rd!x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const x = await fetch(`${await H.start()}/api/caloms/extract?from=${from}&to=${TODAY}`, { headers: { Cookie: cookie, 'X-Requested-With': 'suds' } });
  assert.equal(x.status, 200);
  assert.equal(x.headers.get('content-type'), 'application/zip');
  assert.match(x.headers.get('x-suds-export'), /Identified - PHI\. CalOMS Tx/);
  const files = unzip(Buffer.from(await x.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['README.txt', 'admissions.csv', 'annual_updates.csv', 'discharges.csv', 'provider_activity.csv']);
  const adm = files['admissions.csv'];
  const header = adm.split('\r\n')[0].split(',');
  assert.deepEqual(header.slice(0, 8), ['RecordType', 'ProviderID', 'ProviderClientID', 'ClientLastName', 'ClientFirstName', 'DateOfBirth', 'AdmissionDate', 'AdmissionTransactionDate']);
  assert.ok(header.includes('Race1') && header.includes('Race5') && header.includes('PregnantAtAdmission'));
  assert.match(adm, new RegExp(`A,${PROVIDER},${codeOf(goodClient)},Oms`), 'the clean admission is in');
  assert.ok(!adm.includes(codeOf(badClient)), 'the admission with a fatal error is held back');
  assert.match(files['discharges.csv'], /^RecordType,ProviderID/);
  // Provider activity: both providers, every month; the satellite reported nothing, so "no activity".
  const act = files['provider_activity.csv'].split('\r\n');
  assert.equal(act[0], 'ProviderID,ReportMonth,Admissions,Discharges,AnnualUpdates,NoActivity');
  assert.ok(act.some(l => l.startsWith(`654321,${TODAY.slice(0, 7).replace('-', '')},0,0,0,Y`)));
  assert.ok(act.some(l => l.startsWith(`${PROVIDER},`) && l.endsWith(',N')));
  assert.match(files['README.txt'], /NOT been verified against the current DHCS CalOMS Tx data dictionary/);
  assert.match(files['README.txt'], /held back because of fatal errors: [1-9]/);
  // The same 2024 §2.32 notice every identified file carries, in the README and (abbreviated) the header.
  const C = require('../server/constants');
  assert.ok(files['README.txt'].includes(`NOTICE TO RECIPIENT (42 CFR §2.32): ${C.PART2_REDISCLOSURE_NOTICE}`), 'the README carries the §2.32 notice');
  assert.ok(x.headers.get('x-suds-export').includes(C.PART2_NOTICE_SHORT));
  // Downloading the file is not submitting it: audited, labelled a test/preview, and nobody's accounting
  // of disclosures changes until someone records that the file was actually submitted to DHCS.
  assert.match(x.headers.get('x-suds-export'), /Test \/ preview/);
  assert.ok(!db.one(`SELECT 1 FROM disclosures WHERE client_id=? AND source='caloms'`, goodClient), 'a download alone is not accounted');
  assert.equal(db.one(`SELECT extracted_at FROM caloms_records WHERE client_id=?`, goodClient).extracted_at, null, 'nor marked as sent');
  assert.match(db.one(`SELECT details FROM audit_log WHERE action='caloms.extract' ORDER BY id DESC`).details, /"preview":true/);
  assert.equal((await nav.post('/api/caloms/submissions', { from, to: TODAY })).status, 403, 'marking it submitted is the same permission as making it');
  const sub = await sup.post('/api/caloms/submissions', { from, to: TODAY });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.ok(sub.data.clients_disclosed >= 1);
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='caloms.submitted'`));
  // The accounting of disclosures: one state-reporting row per client in the file, none for the one held back.
  const d = db.one(`SELECT * FROM disclosures WHERE client_id=? AND source='caloms'`, goodClient);
  assert.ok(d, 'the disclosure is accounted for');
  assert.equal(d.basis, 'state_reporting'); assert.equal(d.consent_id, null);
  assert.equal(d.notice_version, '2024'); assert.equal(d.legal_proceeding, 0); assert.equal(d.counseling_notes, 0);
  assert.match(require('../server/crypto').decrypt(d.recipient_enc), /DHCS/);
  assert.ok(!db.one(`SELECT 1 FROM disclosures WHERE client_id=? AND source='caloms'`, badClient));
  const acct = await sup.get(`/api/clients/${goodClient}/disclosures/accounting`);
  assert.equal(acct.status, 200);
  const listed = acct.data.disclosures.find(x => x.source === 'caloms');
  assert.ok(listed && listed.basis === 'state_reporting' && /CalOMS Tx/.test(listed.purpose), 'and it appears in the client\'s accounting of disclosures');
  assert.ok(db.one(`SELECT extracted_at FROM caloms_records WHERE client_id=?`, goodClient).extracted_at);
  assert.equal(db.one(`SELECT extracted_at FROM caloms_records WHERE client_id=?`, badClient).extracted_at, null);
  const audit = db.one(`SELECT details FROM audit_log WHERE action='caloms.submitted' ORDER BY id DESC`).details;
  assert.match(audit, /"held_back":[1-9]/); assert.doesNotMatch(audit, /Oms[a-z0-9]{5}|1990-04-02/);
});

test('no extract while CalOMS is off', async () => {
  const cfg = (await admin.get('/api/caloms/config')).data;
  assert.equal((await admin.put('/api/caloms/settings', { enabled: false })).status, 200);
  assert.equal((await sup.get(`/api/caloms/extract?from=${day(-30)}&to=${TODAY}`)).status, 400);
  // Off again means the admission form asks nothing: an episode opens with no CalOMS answers.
  const id = await newClient(nav);
  assert.equal((await nav.post(`/api/clients/${id}/episodes`, { opened_at: TODAY })).status, 201);
  assert.equal((await admin.put('/api/caloms/settings', { enabled: true, providers: cfg.providers })).status, 200);
});

// ---- county EHR hand-off ----
test('the county EHR hand-off: identified, consent-checked, accounted, and not a claim', async () => {
  const withConsent = await newClient(sup, { status: 'active', medicaid_id: '91234567A' });
  const without = await newClient(sup, { status: 'active' });
  const roiOnly = await newClient(sup, { status: 'active' });
  for (const [cid, mins] of [[withConsent, 30], [withConsent, 45], [without, 20], [roiOnly, 15]]) {
    const r = await sup.post('/api/interventions', { client_id: cid, type: 'case_management', occurred_at: `${day(-3)}T18:00:00.000Z`, duration_minutes: mins, location: 'office', modality: 'in_person' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  // The 2024 single consent for treatment, payment and operations is what a billing hand-off rests on.
  const c = await sup.post(`/api/clients/${withConsent}/consents`, { type: 'part2_tpo', recipient: 'County EHR billing unit', purpose: 'Treatment, payment and health care operations', signed_at: day(-10),
    signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true, scope: 'Service dates, types and minutes', expires_at: '2099-01-01' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  // A general release is not a Part 2 consent while this is a Part 2 programme: that client is left out.
  assert.equal((await sup.post(`/api/clients/${roiOnly}/consents`, { type: 'roi', recipient: 'County EHR billing unit', purpose: 'Billing', signed_at: day(-10) })).status, 201);
  const q = `from=${day(-7)}&to=${TODAY}`;
  assert.equal((await clin.get(`/api/handoff/summary?${q}`)).status, 403);
  assert.equal((await fin.get(`/api/handoff/export?${q}&recipient=x&purpose=y`)).status, 403, 'finance never gets names');
  const sum = await sup.get(`/api/handoff/summary?${q}`);
  assert.equal(sum.status, 200);
  assert.ok(sum.data.without_consent.includes(codeOf(without)) && !sum.data.without_consent.includes(codeOf(withConsent)));
  assert.ok(sum.data.without_consent.includes(codeOf(roiOnly)), 'a general release does not count as consent');
  assert.match(sum.data.not_a_claim, /does not submit Drug Medi-Cal/);
  assert.equal((await sup.get(`/api/handoff/export?${q}`)).status, 400, 'recipient and purpose are required');
  // "Other" is not a basis an identified file can be made under (requireExportBasis): a supervisor's written
  // justification would otherwise release every client's identified encounters with no consent of their own.
  const JUSTIFIED = encodeURIComponent('The county billing unit asked for the whole month to reconcile claims before the deadline.');
  const other = await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&basis=other&justification=${JUSTIFIED}`);
  assert.equal(other.status, 400, JSON.stringify(other.data)); assert.match(other.data.error, /"other" is not a basis/);
  assert.ok(!db.one(`SELECT 1 FROM disclosures WHERE source='ehr_handoff' AND basis='other'`), 'nothing accounted, nothing released');
  const adminOther = await admin.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&basis=other&justification=${JUSTIFIED}`);
  assert.equal(adminOther.status, 400, 'not for an administrator either');
  const x = await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR%20billing&purpose=Encounter%20entry%20for%20billing`);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('x-suds-export'), /Not a claim/);
  assert.equal(x.headers.get('x-suds-handoff-excluded'), [codeOf(without), codeOf(roiOnly)].sort().join(','), 'the clients with no Part 2 consent are left out, and named by code');
  assert.match(x.headers.get('x-suds-export'), /42 CFR part 2 prohibits/);
  const C = require('../server/constants');
  const lastRow = x.data.trimEnd().split('\r\n').pop();
  assert.ok(lastRow.includes(`NOTICE TO RECIPIENT (42 CFR §2.32): ${C.PART2_REDISCLOSURE_NOTICE}`), 'the CSV carries the §2.32 notice as its last row');
  const lines = x.data.replace(/^﻿/, '').split('\r\n');
  assert.match(lines[0], /^Service Date,Client Code,Last Name,First Name,Date Of Birth,Medi-Cal ID/);
  const mine = lines.filter(l => l.includes(codeOf(withConsent)));
  assert.equal(mine.length, 1, 'two services the same day by the same worker are one encounter row');
  assert.match(mine[0], /91234567A/); assert.match(mine[0], /,2,75,/, 'two contacts, 75 minutes');
  assert.ok(!x.data.includes(codeOf(without)));
  const d = db.one(`SELECT * FROM disclosures WHERE client_id=? AND source='ehr_handoff'`, withConsent);
  assert.ok(d); assert.equal(d.basis, 'consent'); assert.equal(d.consent_id, c.data.id, 'the consent relied on is recorded');
  assert.equal(d.notice_version, '2024'); assert.equal(d.legal_proceeding, 0); assert.equal(d.counseling_notes, 0);
  assert.equal((await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&legal_proceeding=1`)).status, 400, 'never a file for a legal proceeding');
  assert.ok(!db.one(`SELECT 1 FROM disclosures WHERE client_id=? AND source='ehr_handoff'`, without));
  // A QSOA covers the whole file, so nobody is left out — once the agreement with the recipient is on file.
  assert.equal((await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&basis=qsoa`)).status, 400, 'no QSOA on file');
  await H.agreement(sup, 'County EHR', 'qsoa');
  const qsoa = await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&basis=qsoa&format=xlsx`);
  assert.equal(qsoa.status, 200); assert.equal(qsoa.headers.get('x-suds-handoff-excluded'), '');
  assert.ok(db.one(`SELECT 1 FROM disclosures WHERE client_id=? AND source='ehr_handoff' AND basis='qsoa'`, without));
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='handoff.export'`));
  // An agreed restriction must be confirmed before the file is made, as for any identified export; and a
  // file past the mass-export threshold opens a draft incident.
  db.run(`INSERT INTO patient_requests(id,client_id,kind,received_at,due_at,status,created_by) VALUES(?,?,?,?,?,?,?)`, require('node:crypto').randomUUID(), without, 'restriction', day(-5), day(25), 'fulfilled', db.one(`SELECT id FROM users WHERE username='admin'`).id);
  const refused = await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&basis=qsoa`);
  assert.equal(refused.status, 400); assert.equal(refused.data.restrictionReview, true);
  assert.equal((await sup.get(`/api/handoff/summary?${q}`)).data.restricted, 1);
  db.setSetting('mass_export_threshold', '2');
  try {
    assert.equal((await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR&purpose=Billing&basis=qsoa&restriction_reviewed=1`)).status, 200);
    assert.ok(db.one(`SELECT 1 FROM privacy_incidents WHERE source='mass_export' AND source_ref LIKE 'ehr-handoff:%'`), 'a draft incident for review');
  } finally { db.setSetting('mass_export_threshold', ''); }
});

test('CalOMS records are client data everywhere else too: synced, merged, purged', () => {
  const SYNC = require('../server/sync-tables');
  const t = SYNC.tables.find(x => x.name === 'caloms_records');
  assert.deepEqual(t.enc, ['answers_enc']);
  assert.ok(SYNC.settings_keys.includes('caloms_enabled') && SYNC.settings_keys.includes('caloms_providers'));
  const R = require('../server/retention');
  assert.ok(R.DELETE_TABLES.indexOf('caloms_records') < R.DELETE_TABLES.indexOf('episodes'), 'purged before the episode it hangs off');
});
