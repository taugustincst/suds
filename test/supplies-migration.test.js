'use strict';
// Migration 44 (docs/SUPPLIES.md): the single-number cupboard becomes items, a main office site and a ledger,
// each old count carried in as an opening balance, and nothing a report reads from a visit changes.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.SUDS_INDEX_KEY = '1'.repeat(64);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-supplies-migrate-'));
const dbPath = path.join(dir, 'suds.db');
const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v1.11.0.sql'), 'utf8');
let adminId; let visitsBefore;

before(() => {
  // A 1.11 database (the cupboard has been one number per item since 1.8), with a stocked cupboard.
  const d = new DatabaseSync(dbPath);
  d.exec(sql);
  adminId = d.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get().id;
  const add = d.prepare(`INSERT INTO supply_stock(id,item,quantity,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?)`);
  add.run('stock-nal', 'Naloxone kit', 42, adminId, '2026-01-02T10:00:00.000Z', '2026-08-15T17:30:00.000Z');
  add.run('stock-fts', 'Fentanyl test strips', 180, null, '2026-01-02T10:00:00.000Z', '2026-08-01T09:00:00.000Z');
  add.run('stock-xyl', 'Xylazine test strips', 0, adminId, '2026-01-02T10:00:00.000Z', '2026-07-01T09:00:00.000Z');
  add.run('stock-sy', 'Syringes 1cc', 500, 'a-user-long-gone', '2026-01-02T10:00:00.000Z', '2026-06-01T09:00:00.000Z');
  d.prepare(`INSERT INTO tombstones(table_name,id,deleted_at) VALUES('supply_stock','old-row','2026-05-01T00:00:00.000Z')`).run();
  visitsBefore = d.prepare(`SELECT id, naloxone_kits, fentanyl_strips FROM interventions ORDER BY id`).all().map(r => ({ ...r }));
  d.close();
  require('../server/db').open(dbPath);
});
after(() => { require('../server/db').close(); fs.rmSync(dir, { recursive: true, force: true }); });

const db = () => require('../server/db');

test('each old count becomes an opening balance at the main office, and each item keeps its id', () => {
  assert.equal(db().getSetting('schema_version'), String(db().LATEST_SCHEMA_VERSION));
  assert.ok(!db().one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='supply_stock'`), 'the single-number table is gone');
  assert.ok(db().one(`SELECT 1 FROM supply_sites WHERE id='site-main' AND name='Main office' AND is_active=1`));
  const items = Object.fromEntries(db().all(`SELECT * FROM supply_items`).map(i => [i.id, i]));
  assert.deepEqual(Object.keys(items).sort(), ['stock-fts', 'stock-nal', 'stock-sy', 'stock-xyl']);
  assert.deepEqual([items['stock-nal'].name, items['stock-nal'].category, items['stock-nal'].unit, items['stock-nal'].quick], ['Naloxone kit', 'naloxone', 'kit', 1]);
  assert.equal(items['stock-fts'].category, 'fentanyl_test_strips'); assert.equal(items['stock-fts'].quick, 1);
  assert.equal(items['stock-xyl'].category, 'xylazine_test_strips');
  assert.equal(items['stock-sy'].category, 'syringes');
  const opening = Object.fromEntries(db().all(`SELECT * FROM supply_ledger`).map(e => [e.item_id, e]));
  assert.deepEqual(Object.keys(opening).sort(), ['stock-fts', 'stock-nal', 'stock-sy'], 'a count of zero needs no opening balance');
  const nal = opening['stock-nal'];
  assert.deepEqual([nal.kind, nal.quantity, nal.site_id, nal.occurred_on, nal.user_id, nal.lot_number, nal.expires_on], ['opening', 42, 'site-main', '2026-08-15', adminId, '', null]);
  assert.equal(opening['stock-fts'].quantity, 180);
  assert.equal(opening['stock-fts'].user_id, adminId, 'no one recorded: the first administrator');
  assert.equal(opening['stock-sy'].user_id, adminId, 'an account that no longer exists: likewise');
  const S = require('../server/supplies');
  assert.equal(S.onHand('stock-nal', 'site-main'), 42);
  assert.ok(!db().one(`SELECT 1 FROM tombstones WHERE table_name='supply_stock'`), 'tombstones for the old table go with it');
  assert.deepEqual(db().all('PRAGMA foreign_key_check'), []);
});

test('the visits are as they were: their counts, and no items drawn for them', () => {
  const now = db().all(`SELECT id, naloxone_kits, fentanyl_strips FROM interventions ORDER BY id`).map(r => ({ ...r }));
  assert.deepEqual(now, visitsBefore);
  assert.equal(db().one(`SELECT COUNT(*) n FROM intervention_supplies`).n, 0);
  assert.equal(db().one(`SELECT COUNT(*) n FROM supply_ledger WHERE kind='distributed'`).n, 0);
  const v = db().one(`SELECT syringes_returned, returns_estimated, supply_site_id FROM interventions LIMIT 1`);
  assert.deepEqual([v.syringes_returned, v.returns_estimated, v.supply_site_id], [0, 0, null]);
});

test('running the migration again changes nothing (it is idempotent)', () => {
  const count = () => ['supply_items', 'supply_sites', 'supply_ledger', 'intervention_supplies'].map(t => db().one(`SELECT COUNT(*) n FROM ${t}`).n);
  const was = count();
  const schemaText = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
  db().transaction(() => db().migrateSupplies(db().get(), schemaText));
  assert.deepEqual(count(), was);
});
