'use strict';
// Migration 43: a court order's and a registered agreement's document reference ("court order, J. Smith case
// file") were plaintext. A database written by 1.11.0 (test/fixtures/release-v1.11.0.sql), with such
// references on file, upgrades with them encrypted, the plaintext columns gone, and the API field unchanged.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.SUDS_INDEX_KEY = '1'.repeat(64);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-docref-'));
const dbPath = path.join(dir, 'suds.db');
const ORDER_REF = 'Court order, Quintessa Marlowe case file';
const AGREEMENT_REF = 'QSOA binder, witnessed by Quintessa Marlowe';
const ids = {};

before(() => {
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.11.0.sql'), 'utf8');
  const expect = JSON.parse(/^-- expect: (.*)$/m.exec(sql)[1]);
  const { uuid, encrypt } = require('../server/crypto');
  const d = new DatabaseSync(dbPath);
  d.exec(sql);
  const user = d.prepare(`SELECT id FROM users ORDER BY created_at LIMIT 1`).get().id;
  ids.order = uuid(); ids.agreement = uuid(); ids.blank = uuid();
  d.prepare(`INSERT INTO court_orders(id,client_id,order_type,court_enc,issued_at,purpose_enc,scope_enc,document_ref,recorded_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(ids.order, expect.client.id, 'noncriminal_2_64', encrypt('Superior Court'), '2026-09-01', encrypt('Custody hearing'), encrypt('Attendance dates only'), ORDER_REF, user);
  d.prepare(`INSERT INTO court_orders(id,client_id,order_type,court_enc,issued_at,purpose_enc,scope_enc,document_ref,recorded_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(ids.blank, expect.client.id, 'noncriminal_2_64', encrypt('Superior Court'), '2026-09-02', encrypt('Custody hearing'), encrypt('Attendance dates only'), null, user);
  d.prepare(`INSERT INTO disclosure_agreements(id,kind,organisation,agreement_date,document_ref,created_by) VALUES(?,?,?,?,?,?)`)
    .run(ids.agreement, 'qsoa', 'Lakeside Lab Services', '2026-01-01', AGREEMENT_REF, user);
  d.close();
  require('../server/db').open(dbPath);
});
after(() => { require('../server/db').close(); fs.rmSync(dir, { recursive: true, force: true }); });

const db = () => require('../server/db');

test('existing plaintext document references are encrypted and the plaintext columns dropped', () => {
  const { decrypt } = require('../server/crypto');
  assert.equal(db().getSetting('schema_version'), String(db().LATEST_SCHEMA_VERSION));
  for (const t of ['court_orders', 'disclosure_agreements']) {
    const cols = db().all(`PRAGMA table_info(${t})`).map(c => c.name);
    assert.ok(!cols.includes('document_ref'), `${t}.document_ref is gone`);
    assert.ok(cols.includes('document_ref_enc'), `${t}.document_ref_enc exists`);
    assert.ok(!db().all(`SELECT * FROM ${t}`).some(r => Object.values(r).some(v => typeof v === 'string' && v.includes('Quintessa'))), `no plaintext left in ${t}`);
  }
  assert.equal(decrypt(db().one(`SELECT document_ref_enc FROM court_orders WHERE id=?`, ids.order).document_ref_enc), ORDER_REF);
  assert.equal(db().one(`SELECT document_ref_enc FROM court_orders WHERE id=?`, ids.blank).document_ref_enc, null, 'an empty reference stays empty');
  assert.equal(decrypt(db().one(`SELECT document_ref_enc FROM disclosure_agreements WHERE id=?`, ids.agreement).document_ref_enc), AGREEMENT_REF);
});

test('the upgraded rows read back through the presenters as document_ref', () => {
  const { presentOrder } = require('../server/routes/consents');
  const o = presentOrder(db().one(`SELECT * FROM court_orders WHERE id=?`, ids.order));
  assert.equal(o.document_ref, ORDER_REF);
  assert.equal(o.document_ref_enc, undefined);
});
