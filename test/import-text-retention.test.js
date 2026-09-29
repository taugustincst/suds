'use strict';
// An imported page (a OneNote export, a Pocket AI transcript) that is filed as a note must not keep a second
// copy of its text in import_items: the note is the system of record, and the copy outlived the client's
// retention purge and the import's own purge (evidence-pack review of 1.16.4). Filing clears it at both doors
// (REST commit, sync push), the daily retention pass clears copies left by earlier versions, and a client's
// purge takes every import item filed against or suggested for that client with it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const MARK = 'Zbigniew-Quatermass-IMPORTMARK';
let sup, nav, U = {};
let enc, dec;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc, decrypt: dec } = require('../server/crypto'));
  const s = H.makeUser('itr_sup', 'supervisor'); U.sup = s.id; sup = H.client(); await sup.login(s.username, PW);
  const n = H.makeUser('itr_nav', 'navigator'); U.nav = n.id; nav = H.client(); await nav.login(n.username, PW);
});
after(() => H.stop());

function mkClient(owner = U.sup) {
  const id = randomUUID();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'ITR-' + id.slice(0, 6), enc('Pat'), enc('Import'), 'active', day(-30), owner);
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), id, owner, 'primary', day(-30), U.sup);
  return id;
}
async function upload(as, text) {
  const up = await as.post('/api/imports/upload', { source: 'generic', filename: `${MARK}.txt`, text });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  return H.db.all(`SELECT * FROM import_items WHERE import_id=? ORDER BY created_at`, up.data.id).map(r => ({ ...r, import_id: up.data.id }));
}
const blank = (id) => {
  const r = H.db.one(`SELECT content_enc, title_enc, metadata_enc FROM import_items WHERE id=?`, id);
  return r && r.content_enc === '' && r.title_enc === null && r.metadata_enc === null;
};
// No trace of the marker in any audit row's details.
const auditClean = () => assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE details LIKE ?`, `%${MARK}%`).n, 0, 'no text in the audit log');

test('an import item filed as a note keeps no copy of its text; the note has it', async () => {
  const cid = mkClient();
  const [it] = await upload(sup, `${MARK} visit\n\nMet ${MARK} at the shelter.`);
  assert.ok(!blank(it.id), 'staged: the text is there to review');
  const before = H.db.one(`SELECT updated_at FROM import_items WHERE id=?`, it.id).updated_at;
  const r = await sup.post(`/api/imports/items/${it.id}/commit`, { client_id: cid, kind: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(blank(it.id), 'committed: content, title and hints cleared');
  const row = H.db.one(`SELECT status, note_id, updated_at FROM import_items WHERE id=?`, it.id);
  assert.equal(row.status, 'committed'); assert.equal(row.note_id, r.data.note_id);
  assert.ok(row.updated_at > before, 'updated_at moves, so devices pull the blanked row');
  assert.match(dec(H.db.one(`SELECT content_enc FROM notes WHERE id=?`, r.data.note_id).content_enc), new RegExp(MARK), 'the filed note is the record');
  // The batch still lists it, without text.
  const view = await sup.get(`/api/imports/${it.import_id}`);
  assert.equal(view.status, 200);
  const shown = view.data.items.find(x => x.id === it.id);
  assert.equal(shown.content, ''); assert.equal(shown.title, null);
  auditClean();
});

test('a device that pushes a committed import item with its text: the office stores it without the text', async () => {
  const [it] = await upload(nav, `${MARK} pushed page`);
  const res = await nav.post('/api/sync/push', { device_now: iso(), tables: { import_items: [{ id: it.id, import_id: it.import_id, content_enc: `${MARK} pushed page`, title_enc: `${MARK} title`, metadata_enc: JSON.stringify({ hints: { names: [MARK] } }), status: 'committed', note_id: randomUUID(), updated_at: iso(Date.now() + 1000) }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(!res.data.rejected.some(r => r.id === it.id), JSON.stringify(res.data.rejected));
  assert.equal(H.db.one(`SELECT status FROM import_items WHERE id=?`, it.id).status, 'committed');
  assert.ok(blank(it.id), 'the pushed text was not stored');
  auditClean();
});

test('purging a client takes the import items filed against or suggested for them; others stay', async () => {
  const cid = mkClient(); const other = mkClient();
  const [filed] = await upload(sup, `${MARK} one`);
  const [suggested] = await upload(sup, `${MARK} two`);
  const [elsewhere] = await upload(sup, `${MARK} three`);
  const r = await sup.post(`/api/imports/items/${filed.id}/commit`, { client_id: cid, kind: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  H.db.run(`UPDATE import_items SET suggested_client_id=? WHERE id=?`, cid, suggested.id);
  H.db.run(`UPDATE import_items SET suggested_client_id=? WHERE id=?`, other, elsewhere.id);
  // An item from before this fix: committed with its text still on it.
  H.db.run(`UPDATE import_items SET content_enc=?, title_enc=? WHERE id=?`, enc(`${MARK} legacy copy`), enc(MARK), filed.id);
  const counts = require('../server/retention').purgeClient({ id: cid, client_code: 'ITR-PURGE' });
  assert.equal(counts.import_items, 2, JSON.stringify(counts));
  for (const id of [filed.id, suggested.id]) {
    assert.equal(H.db.one(`SELECT 1 x FROM import_items WHERE id=?`, id), undefined, 'gone');
    assert.ok(H.db.one(`SELECT 1 x FROM tombstones WHERE table_name='import_items' AND id=?`, id), 'and devices are told');
  }
  assert.ok(H.db.one(`SELECT 1 x FROM import_items WHERE id=?`, elsewhere.id), 'another client\'s page stays');
  // Nothing left anywhere in import_items that decrypts to the purged client's pages.
  for (const row of H.db.all(`SELECT content_enc FROM import_items WHERE id IN (?,?)`, filed.id, suggested.id)) assert.ok(!dec(row.content_enc).includes(MARK));
  auditClean();
});

test('the retention pass clears text left on committed items by earlier versions, once, and audits a count only', async () => {
  const cid = mkClient();
  const [a] = await upload(sup, `${MARK} alpha`);
  const [b] = await upload(sup, `${MARK} beta`);
  const r = await sup.post(`/api/imports/items/${a.id}/commit`, { client_id: cid, kind: 'admin' });
  assert.equal(r.status, 200);
  // As 1.16.4 left it: the committed row still carries the text.
  H.db.run(`UPDATE import_items SET content_enc=?, title_enc=?, metadata_enc=? WHERE id=?`, enc(`${MARK} alpha`), enc(MARK), enc('{"hints":{"names":["x"]}}'), a.id);
  assert.ok(!blank(a.id));
  const retention = require('../server/retention');
  H.db.setSetting('client_retention_ran_at', '');
  retention.runIfDue();
  assert.ok(blank(a.id), 'cleared by the retention pass');
  assert.ok(!blank(b.id), 'a staged page is untouched');
  const aud = H.db.one(`SELECT details FROM audit_log WHERE action='import.committed_text_cleared' ORDER BY id DESC LIMIT 1`);
  assert.ok(aud, 'audited');
  assert.ok(JSON.parse(aud.details).items >= 1, aud.details);
  // Nothing more to clear: no second audit row.
  const n = H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='import.committed_text_cleared'`).n;
  assert.equal(retention.clearCommittedImportText(), 0);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='import.committed_text_cleared'`).n, n);
  auditClean();
});

test('purging an import batch clears any committed item\'s text too', async () => {
  const cid = mkClient();
  const [a] = await upload(sup, `${MARK} batch`);
  await sup.post(`/api/imports/items/${a.id}/commit`, { client_id: cid, kind: 'admin' });
  H.db.run(`UPDATE import_items SET content_enc=? WHERE id=?`, enc(`${MARK} batch`), a.id);
  assert.equal((await sup.del(`/api/imports/${a.import_id}`)).status, 200);
  assert.ok(blank(a.id));
});
