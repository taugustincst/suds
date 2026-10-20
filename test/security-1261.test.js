'use strict';
// The security fixes of 1.26.1 (the code evaluation of 1.26.0, 2026-10-20), each with the attack that found it:
//   H1  wrong passwords sent at once all passed the sign-in limit and the account lockout, and a right one among them
//       signed in (server/auth.js signInLimiter `attempt`, oneAtATime; recordPasswordFailure never clears a lock);
//   H2  an uploaded ZIP (xlsx, docx) was inflated with no cap: 1 MB became 1 GB (server/importers/text.js unzip);
//   M1  a cookie that is not valid percent-encoding left the request unanswered (server/http.js parseCookies);
//   L1  a document update whose file was not a string answered 500;
//   L2  a hand-recorded sign-off dated the programme's tomorrow was accepted after 5 pm in California.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const H = require('./helpers');
const config = require('../server/config');
const { unzip } = require('../server/importers/text');

let admin, sup;
let u = {};
before(async () => {
  await H.start();
  u.race = H.makeUser('race.nav', 'navigator');
  u.change = H.makeUser('race.change', 'navigator');
  u.sup = H.makeUser('sec.sup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('sec.sup', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

const RIGHT = 'StaffPassw0rd!x';
const login = (username, password) => H.client().post('/api/auth/login', { username, password });
const lockedUntil = (id) => H.db.one(`SELECT locked_until FROM users WHERE id=?`, id).locked_until;

test('H1: wrong passwords sent at once meet the lockout, and a right one behind them does not sign in', async () => {
  const max = config.lockout.maxAttempts;
  const burst = await Promise.all([...Array.from({ length: 4 * max }, (_, i) => login('race.nav', `Wrong-guess-${i}`)), login('race.nav', RIGHT)]);
  const statuses = burst.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, max, `exactly ${max} wrong passwords are checked: ${statuses.join(',')}`);
  assert.ok(statuses.slice(max).every((s) => s === 423), `the rest find the account locked: ${statuses.join(',')}`);
  assert.equal(burst.at(-1).status, 423, 'the right password, sent with them, does not sign in');
  assert.ok(Date.parse(lockedUntil(u.race.id)) > Date.now(), 'and the lock stands: no failure in flight cleared it');
});

test('H1: a failure never clears a lock (it wrote locked_until=NULL below the threshold)', () => {
  const auth = require('../server/auth');
  const until = new Date(Date.now() + 10 * 60000).toISOString();
  H.db.run(`UPDATE users SET failed_attempts=0, locked_until=? WHERE id=?`, until, u.change.id);
  assert.equal(auth.recordPasswordFailure({ id: u.change.id }), false);
  assert.equal(lockedUntil(u.change.id), until);
  H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, u.change.id);
});

test('H1: the current password given to change it meets the lockout the same way', async () => {
  const c = H.client(); await c.login('race.change', RIGHT);
  const max = config.lockout.maxAttempts;
  const tries = await Promise.all(Array.from({ length: 3 * max }, (_, i) => c.post('/api/auth/password', { current_password: `Wrong-guess-${i}`, new_password: 'Brand-new-passw0rd!x' })));
  const statuses = tries.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, max - 1, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 423).length, 3 * max - (max - 1), statuses.join(','));
  assert.ok(Date.parse(lockedUntil(u.change.id)) > Date.now());
  H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, u.change.id);
});

test('H1: the sign-in limit counts an attempt as it arrives, not after its password is checked', async () => {
  const was = config.loginRateLimit;
  config.loginRateLimit = 3;
  try {
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => login('nobody.limit', `Wrong-guess-${i}`)));
    const statuses = burst.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 429).length, 9, `3 are checked, 9 refused at once: ${statuses.join(',')}`);
    // A success gives its attempt back: an office signing in from one address is not counted against itself.
    H.makeUser('limit.ok', 'navigator');
    for (let i = 0; i < 5; i++) assert.equal((await login('limit.ok', RIGHT)).status, 200, `sign-in ${i + 1}`);
  } finally { config.loginRateLimit = was; }
});

// A ZIP with one deflated entry `name` holding `raw`.
function zip(name, raw) {
  const c = zlib.deflateRawSync(raw); const nb = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(c.length, 18); lh.writeUInt16LE(nb.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(c.length, 20); cd.writeUInt16LE(nb.length, 28);
  const local = Buffer.concat([lh, nb, c]); const dir = Buffer.concat([cd, nb]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, dir, end]);
}

test('H2: an archive that inflates past the cap is refused, quickly and without the memory', () => {
  const bomb = zip('xl/worksheets/sheet1.xml', Buffer.alloc(300 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024, 'under 1 MB uploaded');
  const t = Date.now();
  assert.throws(() => unzip(bomb), /expands to more than SUDS reads/);
  assert.ok(Date.now() - t < 5000, 'refused in well under the time inflating it all took');
  assert.equal(unzip(zip('a.xml', Buffer.from('hello'))).get('a.xml').toString(), 'hello', 'an ordinary archive still reads');
  assert.equal(unzip(zip('word/media/image1.png', Buffer.from('x')), { only: (n) => n.endsWith('.xml') }).size, 0, 'entries a reader does not need are left unread');
});

test('H2: the PowerDMS report and the spreadsheet import answer a bomb with 400, and the server carries on', async () => {
  const bomb = zip('xl/workbook.xml', Buffer.alloc(200 * 1024 * 1024));
  const url = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + bomb.toString('base64');
  assert.equal((await sup.post('/api/policies/report/preview', { file_url: url, filename: 'report.xlsx' })).status, 400);
  assert.equal((await admin.get('/api/auth/me')).status, 200, 'the server still answers');
});

test('M1: a cookie that is not valid percent-encoding gets an answer, not a hung request', async () => {
  const base = await H.start();
  const { status } = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/auth/me`, { headers: { Cookie: 'suds_session=%E0%A4', 'X-Requested-With': 'suds' }, timeout: 5000 }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('timeout', () => { req.destroy(); reject(new Error('no answer within 5 s')); });
    req.on('error', reject);
  });
  assert.equal(status, 401, 'treated as no session');
});

test('L1: a document update whose file is not a string is a 400, not a 500', async () => {
  const d = await admin.post('/api/documents', { title: 'Security patch policy', category: 'policy', powerdms_url: 'https://powerdms.com/ui/document/900200' });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  const id = d.data.id || (d.data.document && d.data.document.id);
  const r = await admin.put(`/api/documents/${id}`, { file: { not: 'a string' } });
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('L2: a sign-off dated the programme\'s tomorrow is refused, whatever the UTC date', async () => {
  const LD = require('../server/local-date');
  const doc = await admin.post('/api/documents', { title: 'Sign-off date policy', category: 'policy', powerdms_url: 'https://powerdms.com/ui/document/900201', ack_roles: ['navigator'] });
  const document_id = doc.data.id || (doc.data.document && doc.data.document.id);
  const body = (acknowledged_at) => ({ document_id, user_id: u.race.id, acknowledged_at });
  const tomorrow = await sup.post('/api/policies/acknowledgements', body(LD.addDays(LD.today(), 1)));
  assert.equal(tomorrow.status, 400, JSON.stringify(tomorrow.data));
  assert.equal((await sup.post('/api/policies/acknowledgements', body(LD.today()))).status, 201, 'the programme\'s today is accepted');
});
