'use strict';
// Security review of 1.12.4, finding 2: readonly held forms:read, and caseloadRestricted() exempts the
// de-identified roles (clients:list-deidentified), so assertClientAccess let it open any client's filled
// forms — names, dates of birth, addresses — by id, as PDF, and their signed scans. A SCIM-provisioned person
// in no mapped group gets readonly. forms:read now means the template library; a client's filled forms need
// clients:read and the client on the caseload, and no client-scoped check passes for a role without
// clients:read. The sweep below hits every GET route the server has, with real record ids, as each role
// that lacks clients:read, and asserts nothing identifying comes back.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { decrypt } = require('../server/crypto');
const auth = require('../server/auth');

let ro, fin, sup, nav1;
before(async () => {
  await H.start();
  nav1 = H.makeUser('dnav1', 'navigator'); const nav2 = H.makeUser('dnav2', 'navigator');
  const clin = H.makeUser('dclin', 'clinician'); sup = H.makeUser('dsup', 'supervisor');
  fin = H.makeUser('dfin', 'finance'); ro = H.makeUser('dro', 'readonly');
  require('../server/demo').seed({ actor: sup.id, workers: [nav1.id, nav2.id], clinician: clin.id, supervisor: sup.id });
});
after(() => H.stop());

test('readonly cannot open a client\'s filled forms, their PDF or their attachments; the template library stays open', async () => {
  const c = H.client(); await c.login(ro.username, ro.password);
  const f = H.db.one(`SELECT f.id, f.client_id, x.id fid FROM client_forms f JOIN client_form_files x ON x.client_form_id=f.id LIMIT 1`);
  assert.ok(f, 'the demo data has a form with an attachment');
  assert.equal((await c.get(`/api/clients/${f.client_id}/forms`)).status, 403);
  assert.equal((await c.get(`/api/forms/${f.id}`)).status, 403);
  assert.equal((await c.raw(`/api/forms/${f.id}/pdf`)).status, 403);
  assert.equal((await c.raw(`/api/forms/${f.id}/files/${f.fid}`)).status, 403);
  const t = await c.get('/api/forms/templates');
  assert.equal(t.status, 200, 'readonly still reads the form library');
  assert.ok(t.data.templates.length);
  assert.equal((await c.raw(`/api/forms/templates/${t.data.templates[0].id}/blank.pdf`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE user_id=? AND action='authz.denied'`, ro.id), 'the refusals are audited');
});

test('a navigator still opens the forms of a client on their caseload, and not of one off it', async () => {
  const c = H.client(); await c.login(nav1.username, nav1.password);
  const mine = H.db.one(`SELECT f.id FROM client_forms f JOIN assignments a ON a.client_id=f.client_id AND a.user_id=? LIMIT 1`, nav1.id);
  const other = H.db.one(`SELECT f.id FROM client_forms f WHERE f.client_id NOT IN (SELECT client_id FROM assignments WHERE user_id=?) LIMIT 1`, nav1.id);
  assert.equal((await c.get(`/api/forms/${mine.id}`)).status, 200);
  if (other) assert.equal((await c.get(`/api/forms/${other.id}`)).status, 403);
});

test('no role without clients:read gets identified data back from any GET route', { timeout: 240_000 }, async () => {
  const { Router } = require('../server/http');
  const { ROUTE_MODULES, rateLimitReset } = require('../server/app');
  const roles = Object.keys(auth.PERMS).filter(r => !auth.hasPerm({ role: r }, 'clients:read'));
  assert.deepEqual(roles.sort(), ['finance', 'readonly']);
  // Needles: what identifies a client. First names alone collide with reference data (a resource named after
  // someone), so they are used only joined to the last name.
  const clients = H.db.all(`SELECT * FROM clients`);
  const reference = JSON.stringify(require('../server/constants')) + JSON.stringify(H.db.all(`SELECT * FROM resources`));
  const needles = new Set();
  for (const c of clients) {
    const first = decrypt(c.first_name_enc), last = decrypt(c.last_name_enc);
    for (const n of [`${first} ${last}`, last, c.phone_enc && decrypt(c.phone_enc), c.dob_enc && decrypt(c.dob_enc), c.address_enc && decrypt(c.address_enc), c.email_enc && decrypt(c.email_enc)]) if (n && n.length >= 5 && !reference.includes(n)) needles.add(n);
  }
  assert.ok(needles.size > 20);
  // Real record ids from every table that points at a client.
  const tables = H.db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(x => x.name).filter(t => H.db.all(`PRAGMA table_info(${t})`).some(c => c.name === 'client_id'));
  const ids = [];
  for (const t of tables) for (const r of H.db.all(`SELECT id FROM ${t} WHERE client_id IS NOT NULL LIMIT 3`)) ids.push(r.id);
  const clientIds = clients.slice(0, 4).map(c => c.id);
  const formFile = H.db.one(`SELECT id, client_form_id FROM client_form_files LIMIT 1`);
  const pats = []; const r = new Router(); const add = r.add.bind(r); r.add = (m, p, ...hs) => { pats.push([m, p]); return add(m, p, ...hs); };
  for (const m of ROUTE_MODULES) require('../server/routes/' + m)(r);
  // Routes that are not PHI reads, or cannot be reached with a session (FHIR/SCIM need their own tokens).
  const gets = pats.filter(([m]) => m === 'GET').map(x => x[1].replace(/\\\$/g, '$')).filter(p => !/^\/(fhir|scim)\/|oidc|\/admin\/backup|keys-backup|dr-drill|update\/check/.test(p));
  for (const role of roles) {
    const who = role === 'finance' ? fin : ro;
    const c = H.client(); await c.login(who.username, who.password);
    const leaks = []; let ok = 0;
    const probe = async (url) => {
      rateLimitReset('api:127.0.0.1');
      const res = await c.raw(url); const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
      if (res.status >= 300) return;
      ok++;
      const hit = [...needles].find(n => body.includes(n));
      if (hit) leaks.push(`${url.replace(/[0-9a-f-]{36}/g, ':id')} -> ${hit.replace(/./g, '*').slice(0, 6)}`);
    };
    for (const p of gets) {
      const keys = p.match(/:[a-zA-Z_]+/g) || [];
      if (!keys.length) { await probe(p); await probe(`${p}?client_id=${clientIds[0]}`); continue; }
      if (p === '/api/forms/:id/files/:fid') { await probe(`/api/forms/${formFile.client_form_id}/files/${formFile.id}`); continue; }
      if (keys.length > 1) continue;
      for (const id of p.startsWith('/api/clients/:id') ? clientIds : ids) await probe(p.replace(keys[0], id));
    }
    assert.ok(ok > 10, `${role} reached some routes (${ok})`);
    assert.deepEqual([...new Set(leaks)], [], `${role} got identified data back`);
  }
});
