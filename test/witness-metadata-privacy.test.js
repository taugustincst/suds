'use strict';
// Migration 39: a consent's witness (usually someone the client knows) and an imported note's metadata (the
// client-name hints sniffed from its text) leave plaintext for witness_enc and metadata_enc. Stored encrypted,
// read back through the API, carried by sync (including from a kernel that still sends the old names), and
// never written into the audit log.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID: uuid } = require('node:crypto');
const { encrypt, decrypt } = require('../server/crypto');

const WITNESS = 'Marguerite Okonkwo-Witness';
const HINT = 'Bartholomew Quenby';

test('migration 39 moves consents.witness and import_items.metadata into encrypted columns', () => {
  const db = require('../server/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-m39-'));
  const file = path.join(dir, 'suds.db');
  try {
    db.open(file);
    const latest = db.LATEST_SCHEMA_VERSION;
    assert.ok(latest >= 39);
    const d = db.get();
    const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    // Back to the shape before migration 39.
    for (const [t, from, to] of [['consents', 'witness', 'witness_enc'], ['import_items', 'metadata', 'metadata_enc']]) {
      if (cols(t).includes(to)) d.exec(`ALTER TABLE ${t} DROP COLUMN ${to}`);
      if (!cols(t).includes(from)) d.exec(`ALTER TABLE ${t} ADD COLUMN ${from} TEXT`);
    }
    const user = uuid(), client = uuid(), consent = uuid(), blank = uuid(), imp = uuid(), item = uuid();
    d.prepare(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`).run(user, 'm39', 'x', 'M39', 'supervisor');
    d.prepare(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,created_by) VALUES(?,?,?,?,?,?)`).run(client, 'M26-9039', encrypt('A'), encrypt('B'), 'active', user);
    d.prepare(`INSERT INTO consents(id,client_id,type,signed_at,witness,created_by) VALUES(?,?,?,?,?,?)`).run(consent, client, 'roi', '2026-01-01', WITNESS, user);
    d.prepare(`INSERT INTO consents(id,client_id,type,signed_at,witness,created_by) VALUES(?,?,?,?,?,?)`).run(blank, client, 'roi', '2026-01-01', '', user);
    d.prepare(`INSERT INTO imports(id,source,imported_by) VALUES(?,?,?)`).run(imp, 'onenote_file', user);
    d.prepare(`INSERT INTO import_items(id,import_id,content_enc,metadata) VALUES(?,?,?,?)`).run(item, imp, encrypt('x'), JSON.stringify({ source: 'onenote', hints: { codes: [], names: [HINT] } }));
    d.prepare(`UPDATE settings SET value=? WHERE key='schema_version'`).run('38');
    db.close();
    db.open(file);
    assert.equal(db.getSetting('schema_version'), String(latest));
    assert.ok(!db.all(`PRAGMA table_info(consents)`).some(c => c.name === 'witness'), 'plaintext witness is gone');
    assert.ok(!db.all(`PRAGMA table_info(import_items)`).some(c => c.name === 'metadata'), 'plaintext metadata is gone');
    const w = db.one(`SELECT witness_enc FROM consents WHERE id=?`, consent).witness_enc;
    assert.match(w, /^v1:/); assert.equal(decrypt(w), WITNESS);
    assert.equal(db.one(`SELECT witness_enc FROM consents WHERE id=?`, blank).witness_enc, null, 'blank stays blank');
    const m = db.one(`SELECT metadata_enc FROM import_items WHERE id=?`, item).metadata_enc;
    assert.match(m, /^v1:/); assert.equal(JSON.parse(decrypt(m)).hints.names[0], HINT);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

let H, admin, nav, navId;
after(async () => { if (H) await H.stop(); });

test('API: a witness is stored encrypted, read back, printed, and kept out of the audit log', async () => {
  H = require('./helpers');
  await H.start();
  require('../server/config').localModeEnabled = true;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  navId = H.makeUser('m39nav', 'navigator').id;
  nav = H.client(); await nav.login('m39nav', 'StaffPassw0rd!x');
  const c = (await nav.post('/api/clients', { first_name: 'Wit', last_name: 'Ness', confirm_duplicate: true })).data.id;
  const k = await nav.post(`/api/clients/${c}/consents`, { type: 'roi', recipient: 'Clinic', purpose: 'Care', signed_at: '2026-09-01', witness: WITNESS });
  assert.equal(k.status, 201, JSON.stringify(k.data));
  const row = H.db.one(`SELECT * FROM consents WHERE id=?`, k.data.id);
  assert.equal(row.witness, undefined);
  assert.match(row.witness_enc, /^v1:/); assert.equal(decrypt(row.witness_enc), WITNESS);
  const list = (await nav.get(`/api/clients/${c}/consents`)).data.consents;
  const got = list.find(x => x.id === k.data.id);
  assert.equal(got.witness, WITNESS); assert.equal(got.witness_enc, undefined, 'ciphertext is not sent');
  const pdf = Buffer.from(await (await nav.raw(`/api/consents/${k.data.id}/pdf`)).arrayBuffer()).toString('latin1');
  assert.ok(pdf.includes(`Witness: ${WITNESS}`), 'the printed consent still names the witness');
  // A Part 2 consent whose only evidence of signature is a witness still satisfies §2.31.
  const p2 = await nav.post(`/api/clients/${c}/consents`, { type: 'part2_disclosure', recipient: 'County Behavioral Health', purpose: 'Treatment', scope: 'Everything', signed_at: '2026-09-01', expires_at: '2027-09-01', witness: WITNESS, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true });
  assert.equal(p2.status, 201, JSON.stringify(p2.data));
  const disclosure = require('../server/disclosure');
  assert.deepEqual(disclosure.consentElementProblems(H.db.one(`SELECT * FROM consents WHERE id=?`, p2.data.id)), [], 'the encrypted witness is read when the §2.31 elements are re-checked');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE details LIKE ?`, `%${WITNESS}%`).n, 0, 'the witness never reaches the audit log');
});

test('API: an import item\'s metadata (client-name hints) is stored encrypted and still suggests the client', async () => {
  const up = await nav.post('/api/imports/upload', { source: 'pocket_ai', filename: 'export.json', text: JSON.stringify([{ id: 'p1', title: 'Check-in', transcript: `Met with ${HINT} about housing.`, created_at: '2026-09-06T15:00:00Z' }]) });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const item = H.db.one(`SELECT * FROM import_items WHERE import_id=?`, up.data.id);
  assert.equal(item.metadata, undefined);
  assert.match(item.metadata_enc, /^v1:/);
  assert.ok(!JSON.stringify(item).includes('Bartholomew'), 'no plaintext hint in the row');
  assert.deepEqual(JSON.parse(decrypt(item.metadata_enc)).hints.names, [HINT]);
  const view = (await nav.get(`/api/imports/${up.data.id}`)).data.items[0];
  assert.deepEqual(view.hints.names, [HINT]); assert.equal(view.metadata_enc, undefined);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE details LIKE ?`, `%Bartholomew%`).n, 0);
});

test('sync: witness and metadata travel decrypted and are re-encrypted; an older kernel\'s plaintext names still land', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Sync', last_name: 'Witness', confirm_duplicate: true })).data.id;
  const now = new Date().toISOString();
  const legacyConsent = uuid(); const imp = uuid(); const legacyItem = uuid();
  const r = await nav.post('/api/sync/push', { device_now: now, tables: {
    consents: [{ id: legacyConsent, client_id: c, type: 'roi', signed_at: '2026-09-01', witness: WITNESS, created_by: navId, created_at: now, updated_at: now }],
    imports: [{ id: imp, source: 'pocket_ai', imported_by: navId, created_at: now, updated_at: now }],
    import_items: [{ id: legacyItem, import_id: imp, content_enc: 'body', metadata: JSON.stringify({ hints: { names: [HINT] } }), created_at: now, updated_at: now }],
  } });
  assert.equal(r.status, 200); assert.deepEqual(r.data.rejected, []);
  assert.equal(decrypt(H.db.one(`SELECT witness_enc FROM consents WHERE id=?`, legacyConsent).witness_enc), WITNESS);
  assert.equal(JSON.parse(decrypt(H.db.one(`SELECT metadata_enc FROM import_items WHERE id=?`, legacyItem).metadata_enc)).hints.names[0], HINT);
  const pulled = (await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).data;
  const pc = pulled.tables.consents.find(x => x.id === legacyConsent);
  assert.equal(pc.witness_enc, WITNESS, 'decrypted for transport like every _enc column');
  const pi = pulled.tables.import_items.find(x => x.id === legacyItem);
  assert.equal(JSON.parse(pi.metadata_enc).hints.names[0], HINT);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE details LIKE ? OR details LIKE ?`, `%${WITNESS}%`, `%Bartholomew%`).n, 0);
});
