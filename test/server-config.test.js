'use strict';
// Settings › Server configuration (1.27.0; server/server-config.js, server/routes/server-config.js): what an office
// server took only from its environment until then, set by an administrator in the browser. Administrators only; the
// environment wins; a secret is kept encrypted and never returned, logged or audited; a credential, or a setting that
// decides where data or sign-in goes, needs the password again; a change takes effect without a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const config = require('../server/config');

let admin, nav, sup;
before(async () => {
  await H.start();
  H.makeUser('sc.nav', 'navigator'); H.makeUser('sc.sup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('sc.nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('sc.sup', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

const PW = { password: 'AdminPassw0rd!x' };
const entry = async (name) => (await admin.get('/api/admin/server-config')).data.entries.find((e) => e.name === name);
const lastAudit = (action) => H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action);

test('administrators only: a navigator and a supervisor are refused', async () => {
  for (const c of [nav, sup]) {
    assert.equal((await c.get('/api/admin/server-config')).status, 403);
    assert.equal((await c.put('/api/admin/server-config/API_RATE_LIMIT', { value: 900 })).status, 403);
    assert.equal((await c.del('/api/admin/server-config/API_RATE_LIMIT')).status, 403);
  }
  const r = await admin.get('/api/admin/server-config');
  assert.equal(r.status, 200);
  assert.ok(r.data.groups.some((g) => g.id === 'ai') && r.data.env_only.length, 'groups and what stays in the environment');
  assert.equal((await admin.put('/api/admin/server-config/SUDS_ENCRYPTION_KEY', { value: 'x' })).status, 404, 'a key that opens the database is not a setting here');
});

test('a plain setting: saved, in force at once, audited with its value, and removed back to the default', async () => {
  assert.equal(config.apiRateLimit, 600);
  const r = await admin.put('/api/admin/server-config/API_RATE_LIMIT', { value: 900 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(config.apiRateLimit, 900, 'no restart needed');
  const e = await entry('API_RATE_LIMIT');
  assert.deepEqual([e.source, e.value], ['here', 900]);
  assert.deepEqual(JSON.parse(lastAudit('server_config.update').details), { name: 'API_RATE_LIMIT', value: 900 });
  assert.equal((await admin.del('/api/admin/server-config/API_RATE_LIMIT')).status, 200);
  assert.equal(config.apiRateLimit, 600);
  assert.equal((await entry('API_RATE_LIMIT')).source, 'default');
  assert.equal(JSON.parse(lastAudit('server_config.clear').details).name, 'API_RATE_LIMIT');
});

test('values are checked: range, choices, addresses', async () => {
  const bad = async (name, value) => { const r = await admin.put(`/api/admin/server-config/${name}`, { value, ...PW }); assert.equal(r.status, 400, `${name}=${JSON.stringify(value)}: ${JSON.stringify(r.data)}`); return r.data.error; };
  assert.match(await bad('API_RATE_LIMIT', 5), /from 60 to 100000/);
  assert.match(await bad('API_RATE_LIMIT', 'lots'), /whole number/);
  assert.match(await bad('SUDS_AI_PROVIDER', 'openai'), /anthropic, bedrock, vertex/);
  assert.match(await bad('UPDATE_FEED_URL', 'http://example.org/feed'), /https/);
  assert.match(await bad('OIDC_ISSUER', 'https://user:pw@idp.example.org'), /user name or password/);
  assert.match(await bad('AUDIT_RETENTION_DAYS', 30), /from 2190/, 'never under six years');
  assert.match(await bad('AUDIT_SYSLOG', 'tcp://siem:514'), /udp:\/\/host:port/);
  assert.match(await bad('SUDS_AI_VERTEX_CREDENTIALS', '{"type":"service_account"}'), /client_email or private_key/);
  assert.match(await bad('PUBLIC_APP_INFO', 'yes'), /on or off/);
});

test('a secret: needs the password again, is kept encrypted, and is never returned, logged or audited', async () => {
  const KEY = 'sk-ant-test-0123456789abcdefSECRET';
  const was = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    const AI = require('../server/ai-copilot');
    assert.equal(AI.keyConfigured(), false);
    // A value that cannot be saved is refused before the password is asked for, so a typo costs no attempt.
    const typo = await admin.put('/api/admin/server-config/ANTHROPIC_API_KEY', { value: 'has a space' });
    assert.equal(typo.status, 400);
    // Without the password again: refused, nothing kept.
    const noPw = await admin.put('/api/admin/server-config/ANTHROPIC_API_KEY', { value: KEY });
    assert.ok(noPw.status === 401 || noPw.status === 403, `refused without the password: ${noPw.status}`);
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM server_config WHERE name='ANTHROPIC_API_KEY'`).n, 0);
    const wrong = await admin.put('/api/admin/server-config/ANTHROPIC_API_KEY', { value: KEY, password: 'not-the-password' });
    assert.ok(wrong.status >= 400 && wrong.status < 500);
    assert.equal(lastAudit('server_config.update.failed').success, 0, 'a failed confirmation is audited');
    // With it: kept, encrypted, in force at once.
    const ok = await admin.put('/api/admin/server-config/ANTHROPIC_API_KEY', { value: KEY, ...PW });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(!JSON.stringify(ok.data).includes(KEY), 'not in the answer');
    const row = H.db.one(`SELECT value, value_enc FROM server_config WHERE name='ANTHROPIC_API_KEY'`);
    assert.equal(row.value, null); assert.ok(row.value_enc && !row.value_enc.includes(KEY), 'kept encrypted');
    assert.equal(config.ai.apiKey, KEY); assert.equal(AI.keyConfigured(), true, 'the copilot has its key without a restart');
    const listed = await admin.get('/api/admin/server-config');
    assert.ok(!JSON.stringify(listed.data).includes(KEY), 'never listed');
    const e = listed.data.entries.find((x) => x.name === 'ANTHROPIC_API_KEY');
    assert.deepEqual([e.source, e.set, 'value' in e], ['here', true, false]);
    assert.ok(!H.db.all(`SELECT details FROM audit_log WHERE action LIKE 'server_config.%'`).some((a) => String(a.details).includes(KEY)), 'never audited');
    assert.deepEqual(JSON.parse(lastAudit('server_config.update').details), { name: 'ANTHROPIC_API_KEY', secret: true, method: 'password' });
    // Removing it needs the password too.
    assert.notEqual((await admin.del('/api/admin/server-config/ANTHROPIC_API_KEY')).status, 200);
    assert.equal((await admin.del('/api/admin/server-config/ANTHROPIC_API_KEY', PW)).status, 200);
    assert.equal(AI.keyConfigured(), false);
  } finally { if (was !== undefined) process.env.ANTHROPIC_API_KEY = was; }
});

test('the environment wins: shown as such, and not changeable here', async () => {
  process.env.OIDC_LABEL = 'County sign-in (from the environment)';
  try {
    const e = await entry('OIDC_LABEL');
    assert.deepEqual([e.source, e.value], ['environment', 'County sign-in (from the environment)']);
    const r = await admin.put('/api/admin/server-config/OIDC_LABEL', { value: 'Mine' });
    assert.equal(r.status, 409); assert.match(r.data.error, /environment.*wins/);
    assert.equal(config.oidc.label, 'County sign-in (from the environment)');
  } finally { delete process.env.OIDC_LABEL; }
});

test('single sign-on set up from the browser: on once all four are set, without a restart', async () => {
  for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']) delete process.env[k];
  assert.equal((await admin.get('/api/auth/oidc/status')).data.enabled, false);
  const set = { OIDC_ISSUER: 'https://idp.county.example/realm', OIDC_CLIENT_ID: 'suds', OIDC_CLIENT_SECRET: 's3cret-value', OIDC_REDIRECT_URI: 'https://suds.county.example/api/auth/oidc/callback' };
  for (const [k, v] of Object.entries(set)) assert.equal((await admin.put(`/api/admin/server-config/${k}`, { value: v, ...PW })).status, 200, k);
  assert.equal(config.oidc.enabled, true);
  assert.equal((await admin.get('/api/auth/oidc/status')).data.enabled, true);
  for (const k of Object.keys(set)) await admin.del(`/api/admin/server-config/${k}`, PW);
  assert.equal(config.oidc.enabled, false);
});

test('a value read before the database is open is the default, and opens nothing', () => {
  const SC = require('../server/server-config');
  const db = require('../server/db');
  const isOpen = db.isOpen; db.isOpen = () => false;
  try { assert.equal(SC.storedValue('API_RATE_LIMIT'), undefined); } finally { db.isOpen = isOpen; }
});

test('a sensitive setting the environment sets is shown as set, never with its value', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIA-FROM-THE-MACHINE';
  try {
    const r = await admin.get('/api/admin/server-config');
    assert.ok(!JSON.stringify(r.data).includes('AKIA-FROM-THE-MACHINE'), 'never sent to the browser');
    const e = r.data.entries.find((x) => x.name === 'AWS_ACCESS_KEY_ID');
    assert.deepEqual([e.source, e.set, e.value], ['environment', true, null]);
  } finally { delete process.env.AWS_ACCESS_KEY_ID; }
});
