'use strict';
// Security review of 1.12.4, finding 3: FHIR search worked out whether there was a next page before the
// consent filter, so Patient?family=X&birthdate=Y&_count=0 carried a "next" link exactly when X was a client
// of the programme — with or without a consent covering the caller. Pages are now drawn from covered rows
// only, and a PHI search with _count=0 never gets a next link.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let base, get;
before(async () => {
  base = await H.start();
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  const mk = async (f, l) => (await admin.post('/api/clients', { first_name: f, last_name: l, dob: '1985-06-15', status: 'active', confirm_duplicate: true })).data.id;
  await mk('Nora', 'Noconsent'); await mk('Nell', 'Noconsent');
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'County EHR', recipient: 'County Behavioral Health', purpose: 'TREAT', scopes: ['system/*.read'], rate_limit: 5000 })).data;
  const tok = await (await fetch(base + '/fhir/R4/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${c.id}&client_secret=${encodeURIComponent(c.key)}` })).json();
  get = async (p) => (await fetch(base + p, { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
});
after(() => H.stop());

const shape = (b) => ({ links: (b.link || []).map(l => l.relation).sort(), entries: (b.entry || []).filter(e => e.resource.resourceType !== 'OperationOutcome').length });

test('a search for an unconsented client looks exactly like a search for nobody, at any _count', async () => {
  for (const n of [0, 1]) {
    const client = shape(await get(`/fhir/R4/Patient?_count=${n}&family=Noconsent&birthdate=1985-06-15`));
    const nobody = shape(await get(`/fhir/R4/Patient?_count=${n}&family=Nobodyhere&birthdate=1985-06-15`));
    assert.deepEqual(client, nobody, `_count=${n}`);
    assert.ok(!client.links.includes('next'), `_count=${n}: no next page of people the caller may not see`);
  }
});

test('a non-identifying search still pages over covered patients only, and says how many were withheld', async () => {
  const b = await get('/fhir/R4/Patient?_count=1');
  assert.ok(!(b.link || []).some(l => l.relation === 'next'), 'no covered patient, so no next page');
  const oo = b.entry.find(e => e.resource.resourceType === 'OperationOutcome').resource;
  assert.match(oo.issue.find(i => i.code === 'suppressed').diagnostics, /^2 patient\(s\)/);
});
