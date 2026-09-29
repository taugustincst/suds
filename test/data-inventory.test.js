'use strict';
// docs/security/DATA-INVENTORY.md is what a county privacy reviewer reads to learn where PHI is stored, whether it
// reaches devices and when it is deleted. It is written by hand, so this keeps it true: every encrypted (_enc)
// column in server/schema.sql is listed under its table (and nothing that is not one), and the Devices and
// Retention columns say what server/sync-tables.js and server/retention.js do.
process.env.SUDS_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'security', 'DATA-INVENTORY.md'), 'utf8');

/** Every table's _enc columns, from schema.sql loaded into an empty database. */
function schemaEnc() {
  const d = new DatabaseSync(':memory:');
  d.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
  const out = new Map();
  for (const { name } of d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()) {
    const enc = d.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name).filter(c => c.endsWith('_enc'));
    if (enc.length) out.set(name, enc.sort());
  }
  d.close();
  return out;
}

/** Section 2's table: `table` | columns | holds | devices | retention. */
function docRows() {
  const section = DOC.split(/^## /m).find(s => s.startsWith('2. Encrypted columns'));
  assert.ok(section, 'DATA-INVENTORY.md has section "2. Encrypted columns, table by table"');
  const rows = new Map();
  for (const line of section.split('\n')) {
    const m = line.match(/^\| `([a-z_0-9]+)` \|/);
    if (!m) continue;
    const cells = line.split(' | ').map(c => c.replace(/^\| /, '').replace(/ \|$/, '').trim());
    assert.equal(cells.length, 5, `the row for ${m[1]} has five cells`);
    assert.ok(!rows.has(m[1]), `${m[1]} is listed once`);
    rows.set(m[1], { enc: [...cells[1].matchAll(/`([a-z_0-9]+)`/g)].map(x => x[1]).sort(), devices: cells[3], retention: cells[4] });
  }
  return rows;
}

test('every encrypted column in schema.sql is in the data inventory, and nothing else is', () => {
  const schema = schemaEnc(); const doc = docRows();
  const problems = [];
  for (const [t, cols] of schema) {
    const row = doc.get(t);
    if (!row) { problems.push(`${t} has encrypted columns (${cols.join(', ')}) but no row in DATA-INVENTORY.md section 2`); continue; }
    for (const c of cols) if (!row.enc.includes(c)) problems.push(`${t}.${c} is encrypted in schema.sql but not listed in DATA-INVENTORY.md`);
    for (const c of row.enc) if (!cols.includes(c)) problems.push(`DATA-INVENTORY.md lists ${t}.${c}, which is not an _enc column of ${t} in schema.sql`);
  }
  for (const t of doc.keys()) if (!schema.has(t)) problems.push(`DATA-INVENTORY.md lists ${t}, which has no _enc column in schema.sql`);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the inventory says which tables reach devices as server/sync-tables.js does', () => {
  const S = require('../server/sync-tables');
  const synced = new Set(S.tables.map(t => t.name));
  const problems = [];
  for (const [t, row] of docRows()) {
    if (t === 'users') {
      // The row syncs (a device signs its people in offline); the secret never does: routes/sync.js sends null.
      if (!row.devices.startsWith('Row only')) problems.push('users: Devices must say "Row only" (mfa_secret_enc is never sent)');
      const sync = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'sync.js'), 'utf8');
      if (!/mfa_secret_enc:\s*null/.test(sync)) problems.push('server/routes/sync.js no longer blanks mfa_secret_enc on pull: update the inventory');
    } else if (synced.has(t)) {
      if (!row.devices.startsWith('Yes')) problems.push(`${t} syncs to devices (server/sync-tables.js) but the inventory says "${row.devices.slice(0, 40)}…"`);
    } else if (S.server_only.includes(t)) {
      if (!row.devices.startsWith('No (office only)')) problems.push(`${t} is office-only (sync-tables server_only): Devices must start "No (office only)"`);
    } else if (S.per_database.includes(t)) {
      if (!row.devices.startsWith('No (each database')) problems.push(`${t} is kept per database: Devices must start "No (each database"`);
    } else problems.push(`${t} is neither synced, office-only nor per-database in server/sync-tables.js`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the inventory says what retention does to each table as server/retention.js does', () => {
  const R = require('../server/retention');
  // purgeClient deletes the client row, its notes and their addenda itself, then DELETE_TABLES.
  const deleted = new Set(['clients', 'notes', 'note_addenda', ...R.DELETE_TABLES]);
  const problems = [];
  for (const [t, row] of docRows()) {
    const says = row.retention.startsWith('Deleted with the client record');
    if (deleted.has(t) && !says) problems.push(`${t} is deleted by the retention purge: Retention must start "Deleted with the client record"`);
    if (!deleted.has(t) && says) problems.push(`${t} is not deleted by the retention purge, but the inventory says it is`);
    const unlinked = R.UNLINK_TABLES.includes(t);
    if (unlinked !== row.retention.startsWith('Kept, unlinked')) problems.push(`${t}: Retention must ${unlinked ? '' : 'not '}start "Kept, unlinked" (retention.js UNLINK_TABLES)`);
  }
  assert.equal(R.CALOMS_FILE_DAYS, 90, 'the inventory says CalOMS files are cleared after 90 days');
  assert.deepEqual(problems, [], problems.join('\n'));
});
