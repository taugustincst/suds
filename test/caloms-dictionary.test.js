'use strict';
// CalOMS Tx dictionary verification (1.25.0): every code in server/caloms-spec.js SETS asserted against
// the DHCS CalOMS Tx Data Dictionary, File Version 3.0 (October 2024). If DHCS issues a new dictionary,
// these are the assertions to re-check.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../server/caloms-spec');

const codes = (set) => S.SETS[set].map(c => c.code);
const labels = (set) => Object.fromEntries(S.SETS[set].map(c => [c.code, c.label]));

test('SPEC_VERSION marks the dictionary verification', () => {
  assert.match(S.SPEC_VERSION, /2026\.2/);
  assert.match(S.SPEC_VERSION, /Data Dictionary v3\.0, Oct 2024/);
});

test('ADM-4 Type of Service: codes 1-7 (dictionary p.13)', () => {
  assert.deepEqual(codes('SERVICE_TYPES'), ['1', '2', '3', '4', '5', '6', '7']);
  const l = labels('SERVICE_TYPES');
  assert.equal(l['1'], 'Non-Residential'); assert.equal(l['7'], 'Narcotic Treatment Program');
});

test('ADM-5 Source of Referral: codes 1-14 (dictionary p.14)', () => {
  assert.deepEqual(codes('REFERRAL_SOURCES'), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14']);
  const l = labels('REFERRAL_SOURCES');
  assert.equal(l['1'], 'Individual, including self-referral');
  assert.equal(l['8'], 'Post-Release Community Supervision (AB 109)');
  assert.equal(l['14'], 'Child Protective Services');
});

test('ADU-1a Primary Drug: unpadded 0-20, 99901, 99903 (dictionary pp.21-22)', () => {
  assert.deepEqual(codes('DRUGS'), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '99901', '99903']);
  const l = labels('DRUGS');
  assert.equal(l['1'], 'Heroin'); assert.equal(l['5'], 'Methamphetamine');
  assert.ok(!codes('DRUGS').includes('21') && !codes('DRUGS').includes('99'), 'fentanyl and "other" are 99903');
});

test('ADU-3 Route: 1-4, 99902, 99903 (dictionary p.25)', () => {
  assert.deepEqual(codes('ROUTES'), ['1', '2', '3', '4', '99902', '99903']);
  assert.equal(labels('ROUTES')['4'], 'Injection (IV or intramuscular)');
});

test('CID-3 Gender: 1-6, 99900, 99903; no sex-at-birth element (dictionary p.40)', () => {
  assert.deepEqual(codes('GENDER_IDENTITY'), ['1', '2', '3', '4', '5', '6', '99900', '99903']);
  const l = labels('GENDER_IDENTITY');
  assert.equal(l['1'], 'Male'); assert.equal(l['2'], 'Female'); assert.equal(l['6'], 'Not Available');
  assert.ok(!S.SETS.SEX_AT_BIRTH, 'SEX_AT_BIRTH is deleted: the dictionary has no such element');
  assert.ok(!S.FIELD.sex_at_birth, 'no sex_at_birth field');
});

test('CID-20 Sexual Orientation: 1-6 and 8-12, no 7 (dictionary p.59)', () => {
  assert.deepEqual(codes('SEXUAL_ORIENTATION'), ['1', '2', '3', '4', '5', '6', '8', '9', '10', '11', '12']);
});

test('CID-15 Race: zero-padded 01-19 plus 99900, at most 5 (dictionary p.53)', () => {
  assert.deepEqual(codes('RACES'), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '99900']);
  const l = labels('RACES');
  assert.equal(l['17'], 'Other Race'); assert.equal(l['18'], 'Multi Racial'); assert.equal(l['19'], 'Race Not Available');
  assert.equal(S.FIELD.race.multi_max, 5, 'CID-15 validation rule 2: no more than five races');
});

test('CID-16 Ethnicity: 1-6 plus 99900 (dictionary p.55)', () => {
  assert.deepEqual(codes('ETHNICITIES'), ['1', '2', '3', '4', '5', '6', '99900']);
  const l = labels('ETHNICITIES');
  assert.equal(l['1'], 'Not Hispanic'); assert.equal(l['2'], 'Mexican / Mexican American');
});

test('CID-18 Disability: 1-8, 99900, 99904, at most 7 (dictionary p.57)', () => {
  assert.deepEqual(codes('DISABILITIES'), ['1', '2', '3', '4', '5', '6', '7', '8', '99900', '99904']);
  const l = labels('DISABILITIES');
  assert.equal(l['7'], 'Developmentally Disabled'); assert.equal(l['8'], 'Other Disability (not SUD)');
  assert.equal(S.FIELD.disability.multi_max, 7, 'CID-18 format: up to 7 codes');
});

test('LEG-1 Criminal Justice Status: 1-7 plus 99904 (dictionary p.66)', () => {
  assert.deepEqual(codes('CRIMINAL_JUSTICE'), ['1', '2', '3', '4', '5', '6', '7', '99904']);
  assert.equal(labels('CRIMINAL_JUSTICE')['1'], 'No criminal justice involvement');
  assert.ok(S.FIELD.criminal_justice.in.includes('admission'));
});

test('MED-7 Medication Prescribed: 1-5 plus 99903 (dictionary p.81)', () => {
  assert.deepEqual(codes('MEDICATIONS'), ['1', '2', '3', '4', '5', '99903']);
  const l = labels('MEDICATIONS');
  assert.equal(l['4'], 'Buprenorphine (Subutex)'); assert.equal(l['5'], 'Buprenorphine (Suboxone)');
  assert.ok(!S.FIELD.mat_planned, 'mat_planned is replaced by the MED-7 medication element');
});

test('CID-19 Consent: strictly 1/0 and required (dictionary p.58)', () => {
  assert.deepEqual(codes('CONSENT'), ['1', '0']);
  assert.equal(S.FIELD.consent.req, 'always');
});

test('yes/no answers are numeric 1/0 with per-element 999xx specials; no Y/N anywhere', () => {
  for (const set of Object.keys(S.SETS)) for (const c of S.SETS[set]) assert.ok(!['Y', 'N', 'D', 'U'].includes(c.code), `${set} still has letter code ${c.code}`);
  assert.deepEqual(codes('CALWORKS'), ['1', '0', '99901']);            // ADM-8 p.17
  assert.deepEqual(codes('PREGNANT'), ['1', '0', '99901']);             // MED-5 p.79
  assert.deepEqual(codes('IV_USE_12M'), ['1', '0', '99904']);          // ADU-11 p.36
  assert.deepEqual(codes('SCHOOL_ENROLLED'), ['1', '0', '99900', '99904']); // EMP-3 p.64, EMP-4 p.65
  assert.deepEqual(codes('VETERAN'), ['1', '0', '99900', '99904']);    // CID-17 p.56
  assert.deepEqual(codes('MH_DIAGNOSIS'), ['1', '0', '99900', '99904']); // MHD-1 p.86
  assert.ok(!S.SETS.YES_NO && !S.SETS.YES_NO_DECLINED && !S.SETS.YES_NO_UNKNOWN, 'the old letter sets are gone');
});

test('TRN-1 record codes: admission 1, discharge 4, annual update 7 (dictionary p.104)', () => {
  assert.deepEqual(S.RECORD_CODE, { admission: '1', discharge: '4', annual_update: '7' });
});

test('EMP-1 Employment and SOC-2 Living Arrangement labels match the dictionary', () => {
  assert.deepEqual(codes('EMPLOYMENT'), ['1', '2', '3', '4', '5']);
  const e = labels('EMPLOYMENT');
  assert.equal(e['1'], 'Employed Full time (35 hours or more)');
  assert.equal(e['2'], 'Employed Part time (less than 35 hrs.)');
  assert.deepEqual(codes('LIVING'), ['1', '2', '3']);
  assert.equal(labels('LIVING')['1'], 'Homeless');
});

test('numeric elements carry their dictionary 999xx alternatives', () => {
  const alt = (key) => S.FIELD[key].alt || [];
  assert.deepEqual(alt('days_waited'), [99901, 99904]);            // ADM-6
  assert.deepEqual(alt('prior_episodes'), [99900, 99901, 99904]);  // ADM-7
  assert.deepEqual(alt('primary_days_used'), [99902]);             // ADU-2
  assert.deepEqual(alt('iv_use_30'), [99900, 99904]);              // ADU-10 p.35
  assert.deepEqual(alt('lives_with_user'), [99900, 99904]);       // SOC-3 p.93
  assert.deepEqual(alt('paid_work_days'), [99900, 99904]);        // EMP-2
  assert.deepEqual(alt('arrests_30'), [99904]);                    // LEG-3
  assert.deepEqual(alt('er_visits_30'), [99904]);                  // MED-2
  assert.deepEqual(alt('physical_health_days_30'), [99904]);      // MED-4
  assert.deepEqual(alt('psych_meds'), [99904]);                    // MHD-4 p.89 (a day count, not yes/no)
  assert.deepEqual(alt('family_conflict_days_30'), [99900, 99904]); // SOC-4
  assert.deepEqual(alt('children_under_18'), [99904]);             // SOC-5
  assert.deepEqual(alt('primary_age_first_use'), [99904]);         // ADU-4
  assert.equal(S.FIELD.primary_age_first_use.min, 5, 'ADU-4: ages 5-105');
  assert.equal(S.FIELD.primary_age_first_use.max, 105);
  assert.equal(S.FIELD.arrests_30.max, 30, 'LEG-3: 0-30');
  assert.equal(S.FIELD.children_under_18.max, 30, 'SOC-5: 0-30');
  for (const [code, label] of Object.entries(S.ALT_LABELS)) assert.ok(label, `alt label for ${code}`);
});

test('every field cites its dictionary element', () => {
  for (const f of S.FIELDS) {
    if (['admission_transaction', 'discharge_status', 'last_service_date', 'employment_status', 'living_arrangement', 'alcohol_days'].includes(f.key)) continue;
    assert.ok(f.dict, `${f.key} has no dictionary citation`);
  }
});
