'use strict';
// 1.25.2, BO11 and BO12: settings that only failed later are checked as they are saved. The offsite backup folder
// (an absolute path to an existing, writable directory, as a provisioning file requires), the backup interval (0 or
// a whole number of hours up to a week), the SCIM default role (never administrator) and the SSO emergency
// accounts (existing, active administrators).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');

let admin; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-offsite-'));
before(async () => {
  await H.start();
  H.makeUser('setchk_admin', 'admin'); H.makeUser('setchk_nav', 'navigator');
  const off = H.makeUser('setchk_gone', 'admin'); H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, off.id);
  admin = H.client(); await admin.login('setchk_admin', 'StaffPassw0rd!x');
});
after(() => { H.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const put = (body) => admin.put('/api/admin/settings', body);

test('the offsite backup folder must be an absolute, existing, writable directory', async () => {
  const file = path.join(tmp, 'a-file'); fs.writeFileSync(file, 'x');
  for (const [dir, why] of [['relative/dir', /absolute path/], [path.join(tmp, 'not-mounted'), /does not exist/], [file, /not a folder/]]) {
    const r = await put({ backup_offsite_dir: dir });
    assert.equal(r.status, 400, dir); assert.match(r.data.error, why);
  }
  assert.equal(H.db.getSetting('backup_offsite_dir', null), null, 'nothing was saved');
  assert.equal((await put({ backup_offsite_dir: tmp })).status, 200, 'an existing folder is saved');
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('.suds-write-test')), [], 'the write test leaves nothing behind');
  assert.equal(H.db.getSetting('backup_offsite_dir', null), tmp);
  assert.equal((await put({ backup_offsite_dir: '' })).status, 200, 'blank: local only');
});

test('the backup interval is 0 (off) or a whole number of hours from 1 to 168', async () => {
  for (const v of ['0.5', '100000', '169', '-1', 'often']) assert.equal((await put({ backup_schedule_hours: v })).status, 400, v);
  for (const v of ['0', '1', '4', '168']) assert.equal((await put({ backup_schedule_hours: v })).status, 200, v);
  assert.equal((await put({ backup_schedule_hours: '0' })).status, 200);
});

test('the SCIM default role is never administrator; the SSO emergency accounts must be active administrators', async () => {
  const r = await put({ scim_default_role: 'admin' });
  assert.equal(r.status, 400); assert.match(r.data.error, /map a group to the administrator role/);
  assert.equal((await put({ scim_default_role: 'readonly' })).status, 200);
  for (const [v, why] of [['nobody,ghost', /"nobody" does not exist/], ['setchk_nav', /must be an active administrator/], ['setchk_gone', /must be an active administrator/]]) {
    const e = await put({ sso_emergency_accounts: v });
    assert.equal(e.status, 400, v); assert.match(e.data.error, why);
  }
  assert.equal((await put({ sso_emergency_accounts: ' setchk_admin , setchk_admin ' })).status, 200);
  assert.equal(H.db.getSetting('sso_emergency_accounts', null), 'setchk_admin', 'saved trimmed, once');
  assert.equal((await put({ sso_emergency_accounts: '' })).status, 200);
});

test('BO15: "About this server" is given the retention in force and where the keys come from', async () => {
  assert.equal((await put({ client_retention_years: '9' })).status, 200);
  const s = (await admin.get('/api/admin/stats')).data;
  assert.equal(s.client_retention_years, 9, 'the client retention setting');
  assert.equal(s.audit_retention_days, require('../server/config').auditRetentionDays, 'the audit retention in force');
  assert.ok(['env', 'file', 'devfile'].includes(s.key_source), s.key_source);
  assert.equal((await put({ client_retention_years: '' })).status, 200);
  assert.equal((await admin.get('/api/admin/stats')).data.client_retention_years, require('../server/config').clientRetentionYears, 'blank: the default');
});

// 1.25.5, H3: the "offsite" folder could be the server's own data directory or its backups folder, and Security status
// then said "ok" and the hardening checklist "done". Such a folder is refused (as server/audit-anchor.js refuses
// anchors there); one on the same disk as the data is saved, but the answer, Security status and the checklist say so.
test('the offsite folder may not be the data directory, its backups folder, a folder holding it, or a link to it', async () => {
  const data = require('../server/config').dataDir;
  const backups = path.join(data, 'backups'); fs.mkdirSync(backups, { recursive: true });
  const dirs = [data, backups, path.dirname(data)];
  if (process.platform !== 'win32') { const link = path.join(tmp, 'link-to-backups'); fs.symlinkSync(backups, link); dirs.push(link); }
  for (const dir of dirs) {
    const r = await put({ backup_offsite_dir: dir });
    assert.equal(r.status, 400, dir); assert.match(r.data.error, /inside the data directory \(or contains it\), so it is not an offsite copy/);
    assert.match(r.data.fields.backup_offsite_dir, /not an offsite copy/);
  }
  assert.equal(H.db.getSetting('backup_offsite_dir', null), null, 'nothing was saved');
  // Saved before this release (or by hand in the database): Security status and the checklist say it is no offsite copy.
  H.db.setSetting('backup_offsite_dir', backups);
  try {
    const st = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.name === 'Offsite copy');
    assert.equal(st.level, 'bad'); assert.match(st.detail, /inside the data directory/);
    H.db.setSetting('backup_schedule_hours', '4');
    const hard = (await admin.get('/api/admin/security/hardening')).data.items.find((i) => i.id === 'backups');
    assert.equal(hard.done, false); assert.match(hard.status, /inside the data directory/);
  } finally { H.db.run(`DELETE FROM settings WHERE key IN ('backup_offsite_dir','backup_schedule_hours')`); }
});

test('an offsite folder on the same disk as the data is saved with a warning, and Security status and the checklist say so', async () => {
  const data = require('../server/config').dataDir;
  const sameDisk = fs.mkdtempSync(path.join(path.dirname(data), '.suds-same-disk-'));
  try {
    const r = await put({ backup_offsite_dir: sameDisk, backup_schedule_hours: '4' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.warnings.join(' '), /is on the same disk as the data, so it is not an offsite copy/);
    assert.equal(H.db.getSetting('backup_offsite_dir', null), sameDisk, 'saved: a warning, not a refusal');
    const st = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.name === 'Offsite copy');
    assert.equal(st.level, 'warn'); assert.match(st.detail, /same disk as the data/);
    const hard = (await admin.get('/api/admin/security/hardening')).data.items.find((i) => i.id === 'backups');
    assert.equal(hard.done, false); assert.match(hard.why, /same disk as the data, so it is not an offsite copy/); assert.match(hard.status, /same disk/);
    // Another filesystem (a tmpfs here) is a copy off the data's disk: no warning, and the item is done.
    let other = null; try { other = fs.mkdtempSync('/dev/shm/suds-offsite-'); } catch {}
    if (other && fs.statSync(other).dev !== fs.statSync(data).dev) {
      try {
        const o = await put({ backup_offsite_dir: other });
        assert.equal(o.status, 200); assert.equal(o.data.warnings, undefined);
        assert.equal((await admin.get('/api/admin/security/status')).data.items.find((i) => i.name === 'Offsite copy').level, 'ok');
        assert.equal((await admin.get('/api/admin/security/hardening')).data.items.find((i) => i.id === 'backups').done, true);
      } finally { fs.rmSync(other, { recursive: true, force: true }); }
    } else if (other) fs.rmSync(other, { recursive: true, force: true });
    assert.equal((await H.client().get('/api/admin/security/status')).status, 401, 'and none of it without signing in');
  } finally { await put({ backup_offsite_dir: '', backup_schedule_hours: '0' }); fs.rmSync(sameDisk, { recursive: true, force: true }); }
});
