'use strict';
// A SUDS Server upgraded from 1.19.0 with the upgrade.sh installed under /opt/suds/current was not given
// WEBAUTHN_RP_ID (docs/evidence/installer-container-run-2026-09-30-v1.20.0): passkeys then cannot work in production.
// The startup log and Security status (so the compliance report's app.passkeys line) name the exact lines to add, from
// the installer's domain (server/startup-checks.js passkeyRpProblem).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const checks = require('../server/startup-checks');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-rp-'));
const conf = path.join(dir, 'suds-server.conf');
fs.writeFileSync(conf, 'SUDS_TLS_MODE=caddy\nSUDS_DOMAIN=Suds.County.Example.gov\nSUDS_VERSION=1.19.0\n');
const on = { passkeySignin: true, passkeySigning: true };
const prod = (webauthn) => ({ isProd: true, local: false, webauthn });

test('a SUDS Server install without WEBAUTHN_RP_ID: the exact lines for /etc/suds/suds.env, from the installed domain', () => {
  const p = checks.passkeyRpProblem({ c: prod({ rpId: '', origins: [] }), policy: on, confFile: conf });
  assert.match(p, /^WEBAUTHN_RP_ID is not set/);
  assert.match(p, /\n {2}WEBAUTHN_RP_ID=suds\.county\.example\.gov\n {2}WEBAUTHN_ORIGINS=https:\/\/suds\.county\.example\.gov\n/);
  assert.match(p, /\/etc\/suds\/suds\.env and run: systemctl restart suds/);
  assert.equal(checks.installedDomain(conf), 'suds.county.example.gov');
});

test('elsewhere (Docker, the wizard) the sentence is general; set, off, or outside production nothing is said', () => {
  assert.match(checks.passkeyRpProblem({ c: prod({ rpId: '', origins: [] }), policy: on, confFile: path.join(dir, 'none') }), /Set WEBAUTHN_RP_ID to the server's name/);
  assert.equal(checks.passkeyRpProblem({ c: prod({ rpId: 'suds.example', origins: [] }), policy: on, confFile: conf }), null);
  assert.equal(checks.passkeyRpProblem({ c: prod({ rpId: '', origins: ['https://suds.example'] }), policy: on, confFile: conf }), null);
  assert.equal(checks.passkeyRpProblem({ c: prod({ rpId: '', origins: [] }), policy: { passkeySignin: false, passkeySigning: false }, confFile: conf }), null, 'passkeys turned off');
  assert.equal(checks.passkeyRpProblem({ c: { isProd: false, webauthn: { rpId: '', origins: [] } }, policy: on, confFile: conf }), null);
  assert.equal(checks.passkeyRpProblem({ c: { ...prod({ rpId: '', origins: [] }), local: true }, policy: on, confFile: conf }), null);
});

test('a domain that is not a host name is not repeated into the instructions', () => {
  const bad = path.join(dir, 'bad.conf');
  fs.writeFileSync(bad, 'SUDS_DOMAIN=evil.example; rm -rf /\n');
  assert.equal(checks.installedDomain(bad), '');
  assert.match(checks.passkeyRpProblem({ c: prod({ rpId: '', origins: [] }), policy: on, confFile: bad }), /Set WEBAUTHN_RP_ID to the server's name/);
  fs.rmSync(dir, { recursive: true, force: true });
});
