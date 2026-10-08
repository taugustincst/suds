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
