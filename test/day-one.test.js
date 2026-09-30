'use strict';
// A new server's first day (found by the installer run in a systemd container, 1.19.0): the first scheduled
// backup and the first recovery drill have not run yet. For a bounded time after they were scheduled that is
// expected, and every surface says so the same way the host compliance check already did — "pending first run
// (expected on day one)", a warning: Security status (and so the app lines of the compliance report) and
// /api/health, which answers ok with a warning instead of 503 (a monitor would alarm on every new install).
// After the window, "never" fails as before. And the first drill on a server with an offsite share, where no
// backup exists anywhere yet, passes by restoring the offsite copy of the backup it takes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-day-one-'));
process.env.SUDS_DATA_DIR = dir;
const H = require('./helpers');
const db = require('../server/db');

let c;
before(async () => { await H.start(); c = H.client(); });
after(async () => { await H.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const PENDING = 'pending first run (expected on day one)';
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const setAt = (key, value, iso) => { db.setSetting(key, value); db.run(`UPDATE settings SET updated_at=? WHERE key=?`, iso, key); };
const item = (name) => require('../server/security-status').status({ host: false }).items.find((i) => i.name === name);
const app = (id) => require('../scripts/compliance/app-checks').fromStatus(require('../server/security-status').status({ host: false })).find((x) => x.id === id);
const clear = () => db.run(`DELETE FROM settings WHERE key IN ('backup_schedule_hours','last_scheduled_backup_at','last_scheduled_backup_status','dr_drill_monthly','dr_last_drill','backup_offsite_dir')`);

test('backups scheduled an hour ago and never run: a warning everywhere, and /api/health answers ok with the warning', async () => {
  clear();
  setAt('backup_schedule_hours', '4', agoIso(3600_000));
  try {
    const i = item('Scheduled encrypted backups');
    assert.equal(i.level, 'warn', JSON.stringify(i));
    assert.ok(i.value.includes(PENDING), i.value);
    assert.equal(app('app.backups').result, 'warn');
    const h = await c.get('/api/health');
    assert.equal(h.status, 200, JSON.stringify(h.data));
    assert.equal(h.data.ok, true);
    assert.equal(h.data.warnings.length, 1);
    assert.ok(h.data.warnings[0].includes(PENDING), h.data.warnings[0]);
  } finally { clear(); }
});

test('after twice the interval with no backup, "never" fails as before: Security status bad, /api/health 503', async () => {
  clear();
  setAt('backup_schedule_hours', '4', agoIso(9 * 3600_000));
  try {
    assert.equal(item('Scheduled encrypted backups').level, 'bad');
    assert.equal(app('app.backups').result, 'fail');
    const h = await c.get('/api/health');
    assert.equal(h.status, 503); assert.equal(h.data.ok, false);
    assert.match(h.data.warnings.join(' '), /has never run/);
  } finally { clear(); }
});

test('a pending first backup does not hide a real problem: another warning still makes /api/health 503', async () => {
  clear();
  setAt('backup_schedule_hours', '4', agoIso(600_000));
  db.setSetting('audit_verify_failed_at', '2026-09-01T00:00:00.000Z');
  try {
    const h = await c.get('/api/health');
    assert.equal(h.status, 503); assert.equal(h.data.ok, false);
    assert.equal(h.data.warnings.length, 2);
  } finally { clear(); db.run(`DELETE FROM settings WHERE key='audit_verify_failed_at'`); }
});

test('the monthly drill turned on and not yet run: a warning for 31 days, then a failure; with the monthly drill off, a failure', () => {
  clear();
  try {
    setAt('dr_drill_monthly', '1', agoIso(2 * 86400_000));
    const i = item('Last recovery drill');
    assert.equal(i.level, 'warn'); assert.ok(i.value.includes(PENDING), i.value);
    assert.equal(app('app.dr_drill').result, 'warn');
    setAt('dr_drill_monthly', '1', agoIso(32 * 86400_000));
    assert.equal(item('Last recovery drill').level, 'bad');
    assert.equal(app('app.dr_drill').result, 'fail');
    setAt('dr_drill_monthly', '0', agoIso(60_000));
    assert.equal(item('Last recovery drill').level, 'bad', 'nothing scheduled: nothing pending');
  } finally { clear(); }
});

test('the first drill on a new server with an offsite share (no backup anywhere yet) takes one, restores its offsite copy and passes', async () => {
  clear();
  const offsite = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-day-one-offsite-'));
  fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true });
  try {
    db.setSetting('backup_schedule_hours', '4'); db.setSetting('backup_offsite_dir', offsite); db.setSetting('dr_drill_monthly', '1');
    const err = console.error; console.error = () => {};
    let r; try { r = await require('../server/dr-drill').run({ copy: 'offsite', by: { username: 'test' }, trigger: 'test' }); } finally { console.error = err; }
    assert.equal(r.report.ok, true, JSON.stringify(r.report.failures));
    assert.equal(r.report.backup.copy, 'offsite');
    assert.equal(r.report.backup.made_for_drill, true);
    assert.ok(fs.readdirSync(offsite).some((f) => /^suds-\d.*\.db\.enc$/.test(f)));
    // The backup it took is the first scheduled one: nothing is pending any more.
    assert.equal(item('Scheduled encrypted backups').level, 'ok');
    assert.equal(item('Last recovery drill').level, 'ok');
    // With the share holding no backup and a local one on disk, a drill still fails for the missing offsite copy.
    for (const f of fs.readdirSync(offsite)) fs.rmSync(path.join(offsite, f));
    console.error = () => {};
    let r2; try { r2 = await require('../server/dr-drill').run({ copy: 'offsite', by: { username: 'test' }, trigger: 'test' }); } finally { console.error = err; }
    assert.equal(r2.report.ok, false);
    assert.match(r2.report.failures.join(' '), /holds no backup/);
  } finally { clear(); fs.rmSync(offsite, { recursive: true, force: true }); }
});
