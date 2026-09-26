'use strict';
// The second hands-on frontline review (1.12.4): a consent recorded from the referral form that names the
// provider, the referral list's client names and consent wording, the dashboard's small counts of people for
// roles that run publication releases only (and per-worker rows for those who supervise staff), proper
// labels for coded choices, the default Location, an overdose saved with no doses, and search by either part
// of a double surname (with the one-time re-index of clients recorded before).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral information', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
let admin, nav, sup, fin, ro, clientId, resourceId;
before(async () => {
  await H.start();
  H.makeUser('frnav', 'navigator'); H.makeUser('frsup', 'supervisor'); H.makeUser('frfin', 'finance'); H.makeUser('frro', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('frnav', PW);
  sup = H.client(); await sup.login('frsup', PW);
  fin = H.client(); await fin.login('frfin', PW);
  ro = H.client(); await ro.login('frro', PW);
  clientId = (await nav.post('/api/clients', { first_name: 'Rosalind', last_name: 'Quintero-Vasquez', primary_substance: 'opioids_heroin', status: 'active' })).data.id;
  resourceId = (await nav.post('/api/resources', { name: 'Hope Street Detox', category: 'detox_withdrawal_mgmt' })).data.id;
});
after(H.stop);

test('a TPO consent with the class wording does not back a referral; one recorded naming the provider does, and is suggested', async () => {
  const tpo = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_tpo', recipient: 'My treating providers, health plans, third-party payers, and people helping to operate this program', purpose: 'For treatment, payment, and health care operations', ...ELEMENTS });
  assert.equal(tpo.status, 201, JSON.stringify(tpo.data));
  const refused = await nav.post('/api/referrals', { client_id: clientId, resource_id: resourceId, referred_at: new Date().toISOString(), status: 'contacted', consent_id: tpo.data.id });
  assert.equal(refused.status, 409, 'the class wording names nobody SUDS can check');
  assert.equal(refused.data.recipientNotCovered, true, 'and the form is told why, so it can offer to record one naming the provider');
  // What the referral form's "Record a consent naming Hope Street Detox" sends.
  const named = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'Hope Street Detox', purpose: 'Referral and care coordination', info_categories: ['demographics', 'referrals'], ...ELEMENTS });
  assert.equal(named.status, 201); assert.ok(named.data.id, 'the new consent\'s id comes back, so the referral can select it');
  const list = (await nav.get(`/api/clients/${clientId}/consents?resource_id=${resourceId}`)).data;
  assert.equal(list.suggested_consent_id, named.data.id, 'the one live consent naming the provider is suggested');
  assert.equal(list.consents.find(c => c.id === named.data.id).names_resource, true);
  assert.equal(list.consents.find(c => c.id === tpo.data.id).names_resource, false);
  const ok = await nav.post('/api/referrals', { client_id: clientId, resource_id: resourceId, referred_at: new Date().toISOString(), status: 'contacted', consent_id: named.data.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});

test('the usual consent can be saved by an administrator (the Home checklist) and is read back for new consents', async () => {
  assert.equal((await nav.put('/api/consent-template', { type: 'part2_tpo', recipient: 'x' })).status, 403, 'not by a navigator');
  const body = { type: 'part2_tpo', recipient: 'My treating providers, including Hope Street Detox, Riverbend OTP', purpose: 'For treatment, payment, and health care operations', expires_days: 365, info_categories: ['demographics', 'referrals'] };
  assert.equal((await admin.put('/api/consent-template', body)).status, 200);
  const t = (await nav.get('/api/consent-template')).data.template;
  assert.equal(t.expires_days, 365); assert.deepEqual(t.info_categories, ['demographics', 'referrals']);
});

test('the referral list names the client for a role that can open them, and says "consent on file" only for a consent naming the provider', async () => {
  const other = (await nav.post('/api/resources', { name: 'Northside IOP', category: 'intensive_outpatient' })).data.id;
  assert.equal((await nav.post('/api/referrals', { client_id: clientId, resource_id: other, referred_at: new Date().toISOString(), status: 'pending' })).status, 201);
  const rows = (await nav.get(`/api/referrals?client_id=${clientId}&limit=50`)).data.rows;
  const hope = rows.find(r => r.resource_id === resourceId); const iop = rows.find(r => r.resource_id === other);
  assert.equal(hope.client_name, 'Quintero-Vasquez, Rosalind', 'the name, for a navigator');
  assert.ok(!('c_first_name_enc' in hope) && !('c_last_name_enc' in hope), 'no ciphertext in the row');
  assert.equal(hope.consent_on_file, true, 'a live Part 2 consent names Hope Street Detox');
  assert.equal(iop.consent_on_file, false, 'nothing on file names Northside IOP (the TPO class wording does not)');
});

test('the dashboard masks small counts of people for finance and read-only, and shows visits by worker only to supervisors', async () => {
  // Enough visits that the counts of visits (not people) show exactly.
  for (let i = 0; i < 3; i++) assert.equal((await nav.post('/api/interventions', { client_id: clientId, type: 'crisis_response', occurred_at: new Date().toISOString(), duration_minutes: 25 })).status, 201);
  for (const [who, c] of [['finance', fin], ['readonly', ro]]) {
    const d = (await c.get('/api/reports/dashboard')).data;
    assert.equal(d.clients.active, '<11', `${who}: one active client is "<11"`);
    assert.ok(d.clients.by_substance.every(x => x.n === '<11' || x.n === 0), `${who}: primary substance rows are masked`);
    assert.equal(d.interventions.total >= 3, true, `${who}: visits are not people and stay exact`);
    assert.equal(d.interventions.by_worker, null, `${who}: no per-worker rows`);
    assert.deepEqual(d.consents_expiring, [], `${who}: no consent rows (client codes, recipients)`);
    assert.equal(d.small_cells.threshold, 11);
    const m = (await c.get('/api/reports/monthly?months=1')).data;
    assert.ok(m.intakes.every(x => x.n === '<11' || x.n === 0 || x.n >= 11), `${who}: monthly intakes are masked`);
    assert.ok(m.interventions.every(x => typeof x.n === 'number'), `${who}: monthly visit counts stay exact`);
  }
  const n = (await nav.get('/api/reports/dashboard')).data;
  assert.equal(typeof n.clients.active, 'number', 'a navigator counts their own caseload exactly');
  assert.equal(n.interventions.by_worker, null, 'but sees no named staff member\'s activity');
  const s = (await sup.get('/api/reports/dashboard')).data;
  assert.equal(typeof s.clients.active, 'number', 'a supervisor sees exact counts');
  assert.ok(Array.isArray(s.interventions.by_worker) && s.interventions.by_worker.length, 'and visits by worker');
  assert.equal(s.small_cells, undefined);
});

test('coded choices carry proper labels, and Location starts on the street for a harm-reduction program', async () => {
  const meta = (await nav.get('/api/meta/constants')).data;
  const label = (list, code) => meta.option_lists[list].find(e => e.code === code).label;
  assert.equal(label('INTERVENTION_TYPES', 'court_or_probation'), 'Court or Probation');
  assert.equal(label('INTERVENTION_TYPES', 'screening_sbirt'), 'Screening (SBIRT)');
  assert.equal(label('REFERRAL_STATUSES', 'declined_by_client'), 'Declined by Client');
  assert.equal(meta.CODE_LABELS.detox_withdrawal_mgmt, 'Detox / Withdrawal Management');
  assert.equal(label('LOCATIONS', 'street'), 'Street / Outdoor');
  assert.equal(meta.DEFAULT_LOCATION, 'office', 'the suite runs as a treatment-adjacent program');
  assert.deepEqual(meta.REMOTE_LOCATIONS, ['phone', 'telehealth']);
  H.db.setSetting('programme_profile', 'harm_reduction');
  try {
    assert.equal((await nav.get('/api/meta/constants')).data.DEFAULT_LOCATION, 'street');
    assert.equal((await admin.put('/api/admin/lists/LOCATIONS/entries/street', { hidden: true })).status, 200);
    assert.equal((await nav.get('/api/meta/constants')).data.DEFAULT_LOCATION, 'office', 'a hidden choice is never the default');
    assert.equal((await admin.put('/api/admin/lists/LOCATIONS/entries/street', { hidden: false })).status, 200);
  } finally { H.db.setSetting('programme_profile', 'treatment'); }
  const v = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'street', occurred_at: new Date().toISOString() });
  assert.equal(v.status, 201, 'a visit can be recorded on the street');
});

test('an overdose event with "Doses given" left empty saves', async () => {
  const r = await nav.post('/api/overdose-events', { kind: 'reversal', occurred_at: new Date().toISOString(), naloxone_doses: null, location_type: 'street' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = H.db.one(`SELECT naloxone_doses, naloxone_used, location_type FROM overdose_events WHERE id=?`, r.data.id);
  assert.deepEqual({ ...row }, { naloxone_doses: 0, naloxone_used: 1, location_type: 'street' });
});

test('either part of a double surname finds the client, by exact word, prefix or spelling', async () => {
  const find = async (q, extra = '') => (await nav.get(`/api/clients?status=all&q=${encodeURIComponent(q)}${extra}`)).data.clients.map(c => c.id);
  for (const q of ['Vasquez', 'vasquez', 'Vas', 'Vazquez', 'Quintero', 'Quintero-Vasquez', 'Rosalind Vasquez', 'Vasquez, Rosalind']) assert.ok((await find(q)).includes(clientId), `"${q}" finds Quintero-Vasquez`);
  assert.ok((await find('Vasquez', '&exact=1')).includes(clientId), 'an exact search by one part finds them too');
  assert.ok(!(await find('Vazquez', '&exact=1')).includes(clientId), 'but not by a misspelling');
  const other = (await nav.post('/api/clients', { first_name: 'Ana', last_name: 'Vega' })).data.id;
  assert.ok(!(await find('Vasquez')).includes(other), 'and nobody else');
  // The column holds HMACs only.
  const idx = H.db.one(`SELECT name_phonetic_idx FROM clients WHERE id=?`, clientId).name_phonetic_idx;
  assert.ok(idx.split(' ').length > 1 && idx.split(' ').every(t => /^[0-9a-f]{64}$/.test(t)), 'space-separated blind indexes, nothing in the clear');
  // An update to the surname re-derives the tokens.
  assert.equal((await nav.put(`/api/clients/${other}`, { last_name: 'Vega-Morales' })).status, 200);
  assert.ok((await find('Morales')).includes(other), 'an updated surname is searchable by its new part');
});

test('clients recorded before are re-indexed once, at the next start', async () => {
  const M = require('../server/clients-model');
  const id = (await nav.post('/api/clients', { first_name: 'Luz', last_name: 'Garcia Lopez' })).data.id;
  // What an earlier version stored: the whole surname's code only.
  const old = require('../server/crypto').blindIndex('snd:G624');
  H.db.run(`UPDATE clients SET name_phonetic_idx=? WHERE id=?`, old, id);
  H.db.run(`DELETE FROM settings WHERE key='name_parts_indexed'`);
  const find = async (q) => (await nav.get(`/api/clients?status=all&q=${encodeURIComponent(q)}`)).data.clients.map(c => c.id);
  assert.ok(!(await find('Lopez')).includes(id), 'before the re-index, the second part finds nobody');
  H.db.reindexNameParts(H.db.get());
  assert.equal(H.db.one(`SELECT name_phonetic_idx FROM clients WHERE id=?`, id).name_phonetic_idx, M.namePhoneticIndex('Garcia Lopez'));
  assert.ok(H.db.getSetting('name_parts_indexed'), 'and it is recorded as done');
  assert.ok((await find('Lopez')).includes(id), 'after it, "Lopez" finds Garcia Lopez');
});
