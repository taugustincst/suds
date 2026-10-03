'use strict';
// Browser-based first-run setup so administrators never need a terminal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const auth = require('../auth');
const listener = require('../listener');
const { badRequest, HttpError } = require('../http');
const { validate } = require('../validate');
const { hashPasswordAsync, uuid } = require('../crypto');
const selfsigned = require('../selfsigned');
const C = require('../constants');

// The wizard is only needed for self-managed installs. Deployments configured by environment variables
// (keys from env, or SUDS_SKIP_SETUP=1) use the bootstrap admin printed at first start instead.
function setupNeeded() { return !config.setupComplete && !config.isTest && config.keySource !== 'env' && !process.env.SUDS_SKIP_SETUP; }
function userCount() { return db.one(`SELECT COUNT(*) n FROM users`).n; }
// The placeholder is the first administrator server/bootstrap.js created: "guest" unless SUDS_ADMIN_USERNAME
// names another (1.12.4 renamed it and this check still looked for "admin", so a new server skipped the wizard).
const bootstrapName = () => require('../bootstrap').adminUsername();
function onlyBootstrapAdmin() { return db.one(`SELECT COUNT(*) n FROM users WHERE NOT (username=? AND must_change_password=1 AND last_login_at IS NULL)`, bootstrapName()).n === 0; }
/**
 * Defaults a production install gets from the wizard rather than from someone remembering to set them:
 * scheduled backups every 4 hours (a new install used to run with none until an administrator found the
 * Settings tab). Only where nothing has been chosen yet; returns the keys it set.
 */
const PRODUCTION_DEFAULTS = { backup_schedule_hours: '4' };
function applyProductionDefaults({ isProd = config.isProd } = {}) {
  const set = [];
  if (!isProd) return set;
  for (const [k, v] of Object.entries(PRODUCTION_DEFAULTS)) if (db.getSetting(k, null) === null) { db.setSetting(k, v); set.push(k); }
  return set;
}

/** The funding types and settlement categories the wizard offers, with their words. */
function fundOptions() {
  const kind = (code) => (code.startsWith('core_') ? 'Core strategy ' : code.startsWith('approved_') ? 'Approved use ' : '');
  return { types: C.FUNDING_TYPES.map(code => ({ value: code, label: require('../options').humanize(code) })),
    settlement_uses: C.SETTLEMENT_USES.map(x => ({ value: x.code, label: `${kind(x.code)}${x.label}` })),
    settlement_hiaa: [...C.SETTLEMENT_HIAA.map(x => ({ value: x.code, label: x.label })), { value: 'none', label: 'Not a High Impact Abatement Activity' }] };
}

/** Is the first-run wizard still the way in? The same answer /api/setup/status gives, for the startup banner. */
function isNeeded() { return setupNeeded() && onlyBootstrapAdmin(); }

module.exports = (r) => {
  // Before setup this is the wizard's own status call, and there is no account to ask for. Afterwards the
  // listener's addresses, the hostname, where the keys live and the version are a description of the
  // office network, so a caller with no session learns only that setup is done.
  r.get('/api/setup/status', (ctx) => {
    const needed = setupNeeded() && onlyBootstrapAdmin();
    if (!needed && !ctx.user) return { needed: false, setupComplete: true };
    // port_env: the port is fixed by the PORT environment variable, so the wizard does not offer to change it
    // (Settings → Network & devices says the same once setup is done).
    // local_mode_env: LOCAL_MODE_ENABLED decides the offline-copy question, so the wizard shows the answer instead of asking.
    // fund_options: the wizard's "What kind of funding is it?" and, for opioid settlement money, its allowable
    // use (the page has no session to read /api/meta/constants with).
    return { needed, setupComplete: !needed, listener: listener.describe(), hostname: require('node:os').hostname(), keySource: config.keySource, env: config.env, version: config.version, port_env: !!process.env.PORT, local_mode_env: config.localModeFromEnv, local_mode: config.localModeEnabled,
      ...(needed ? { fund_options: fundOptions() } : {}) };
  });

  r.post('/api/setup/complete', async (ctx) => {
    if (!(setupNeeded() && onlyBootstrapAdmin())) throw new HttpError(403, 'Setup has already been completed');
    // Setup may only be performed from the machine running SUDS (loopback) to prevent a stranger on the network
    // from claiming a freshly installed instance.
    const ip = ctx.req.socket.remoteAddress || '';
    if (!/^(127\.|::1|::ffff:127\.)/.test(ip)) throw new HttpError(403, 'Setup must be completed from a browser on the computer running SUDS');
    const v = validate(ctx.body, {
      org_name: { type: 'string', required: true, maxLen: 200 }, county_name: { type: 'string', maxLen: 120 }, program_contact: { type: 'string', maxLen: 200 },
      admin_username: { type: 'string', required: true, maxLen: 60, pattern: /^[a-zA-Z0-9._@-]+$/ }, admin_display_name: { type: 'string', required: true, maxLen: 120 }, admin_password: { type: 'string', required: true, maxLen: 500 },
      network: { type: 'string', required: true, enum: ['local', 'lan'] }, port: { type: 'number', integer: true, min: 1, max: 65535 }, https: { type: 'boolean' }, extra_hosts: { type: 'string', maxLen: 300 },
      // "Allow staff to keep an offline copy on their devices?" — omitted means No: without an answer local mode stays off
      // (the wizard itself recommends Yes for a harm-reduction programme and No for a treatment-adjacent one).
      local_mode: { type: 'boolean' },
      // What kind of programme this is (server/programme.js); omitted means harm reduction & outreach.
      programme_profile: { type: 'string', enum: Object.keys(require('../programme').PROFILES) },
      // "Outreach records use a participant code by default" (1.21.0): offered for a harm-reduction programme; omitted
      // (or any other profile) means off, the default everywhere.
      participant_code_default: { type: 'boolean' },
      // The programme's main fund (optional): created and made the default fund for new visits.
      main_fund_name: { type: 'string', maxLen: 200 },
      // What kind of money it is (C.FUNDING_TYPES), and for opioid settlement money the settlement report's
      // category (Exhibit E allowable use, California HIAA), as Funding & spending asks.
      main_fund_type: { type: 'string', enum: C.FUNDING_TYPES }, main_fund_settlement_use: { type: 'string', enum: C.SETTLEMENT_USES.map(x => x.code) },
      main_fund_settlement_hiaa: { type: 'string', enum: [...C.SETTLEMENT_HIAA.map(x => x.code), 'none'] },
      // port omitted → 'auto' (standard port with fallback)
    });
    const pwProblem = auth.passwordProblem(v.admin_password, { username: v.admin_username, display_name: v.admin_display_name });
    if (pwProblem) throw badRequest(pwProblem, { fields: { admin_password: pwProblem } });

    // 1. keys: if they came from dev key files rather than the environment, consolidate them into keys.json
    if (config.keySource !== 'env' && !fs.existsSync(config.keysJsonPath)) {
      const keys = { SUDS_ENCRYPTION_KEY: config.encryptionKey.toString('hex'), SUDS_INDEX_KEY: config.indexKey.toString('hex'), SUDS_SIGNING_KEY: config.signingKey.toString('hex'), created_at: new Date().toISOString() };
      fs.writeFileSync(config.keysJsonPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
    }
    // 2. admin account (replace bootstrap admin). Hashed off the event loop; a second submission that arrived
    // while this one was hashing finds the wizard already answered.
    const adminHash = await hashPasswordAsync(v.admin_password);
    if (!(setupNeeded() && onlyBootstrapAdmin())) throw new HttpError(403, 'Setup has already been completed');
    // The wizard replaces the bootstrap administrator, so the password file left for it (server/bootstrap.js) is retired with it.
    require('../bootstrap').discardPasswordFile();
    let mainFund = null;
    db.transaction(() => {
      db.run(`DELETE FROM users WHERE username=? AND must_change_password=1 AND last_login_at IS NULL`, bootstrapName());
      db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,0,?)`, uuid(), v.admin_username, adminHash, v.admin_display_name, 'admin', db.now());
      db.setSetting('org_name', v.org_name); if (v.county_name) db.setSetting('county_name', v.county_name); if (v.program_contact) db.setSetting('program_contact', v.program_contact);
      db.setSetting('caseload_restriction', '1');
      db.setSetting('programme_profile', v.programme_profile || require('../programme').DEFAULT_PROFILE);
      if (v.participant_code_default === true && (v.programme_profile || require('../programme').DEFAULT_PROFILE) === 'harm_reduction') db.setSetting('participant_code_default', '1');
      mainFund = require('./budget').createProgrammeFund(v.main_fund_name, { type: v.main_fund_type || 'other', settlement_use: v.main_fund_settlement_use || null, settlement_hiaa: v.main_fund_settlement_hiaa || null });
    });
    const defaults = applyProductionDefaults();
    // 3. network + TLS
    // With PORT set in the environment the port is IT's decision, not the wizard's: keep listening on it.
    const port = process.env.PORT ? config.port : (v.port || 'auto');
    const host = v.network === 'lan' ? '0.0.0.0' : '127.0.0.1';
    let tls = 'none';
    // The browser form already refuses this; the API must too, or a request that skips the form puts PHI on
    // plain HTTP for the whole office. Behind a TLS-terminating proxy the proxy is the HTTPS.
    if (v.network === 'lan' && !v.https && !process.env.TLS_CERT_PATH && !config.trustProxy) throw badRequest('HTTPS is required when other devices can connect');
    if (v.https && !process.env.TLS_CERT_PATH) {
      const hosts = ['localhost', '127.0.0.1', 'suds.local', require('node:os').hostname(), require('node:os').hostname() + '.local', ...listener.lanAddresses().map(a => a.address), ...String(v.extra_hosts || '').split(/[\s,]+/).filter(Boolean)];
      const c = selfsigned.generate({ commonName: v.org_name.slice(0, 60), org: v.org_name.slice(0, 60), hosts: [...new Set(hosts)] });
      const dir = path.join(config.dataDir, 'certs'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'suds.crt'), c.cert, { mode: 0o600 }); fs.writeFileSync(path.join(dir, 'suds.key'), c.key, { mode: 0o600 }); fs.writeFileSync(path.join(dir, 'suds-ca.crt'), c.ca, { mode: 0o644 });
      tls = 'selfsigned';
    } else if (process.env.TLS_CERT_PATH) tls = 'custom';
    
    // The offline copy (/?local=1): stored in server.json and honoured from now on, unless LOCAL_MODE_ENABLED
    // in the environment decides it — then the environment keeps winning and the answer is only recorded.
    const localMode = v.local_mode === true;
    if (!config.localModeFromEnv) config.localModeEnabled = localMode;
    audit.log({ user: { username: v.admin_username }, action: 'setup.complete', ip: ctx.ip, details: { network: v.network, port, tls, local_mode: config.localModeEnabled, programme_profile: require('../programme').profile(), defaults, main_fund: mainFund } });
    // (network switch below persists the final port)
    // 4. switch listener
    let desc;
    try {
      desc = await listener.relisten({ host, port, certPath: tls === 'selfsigned' ? path.join(config.dataDir, 'certs', 'suds.crt') : (config.tls.cert || ''), keyPath: tls === 'selfsigned' ? path.join(config.dataDir, 'certs', 'suds.key') : (config.tls.key || '') });
      config.saveServerJson({ setupComplete: true, host, port: desc.port, tls, localModeEnabled: localMode, completedAt: new Date().toISOString() });
      // The listener now serves HTTPS in place: config.tls (read once at start) says so too, or the hardening
      // checklist, Security status and HSTS would say HTTPS is off until a restart (as Network & devices does).
      if (tls === 'selfsigned') Object.assign(config.tls, { cert: path.join(config.dataDir, 'certs', 'suds.crt'), key: path.join(config.dataDir, 'certs', 'suds.key'), mode: tls });
    } catch (e) {
      config.saveServerJson({ setupComplete: true, host: '127.0.0.1', port: config.port, tls: 'none', localModeEnabled: localMode, completedAt: new Date().toISOString() });
      throw new HttpError(500, `Could not start on the network: ${e.message}. Setup saved with local-only access; change this later in Settings → Network & devices.`);
    }
    return { ok: true, listener: desc, keys_file: config.keySource === 'env' ? null : config.keysJsonPath, local_mode: config.localModeEnabled };
  });
};
module.exports.isNeeded = isNeeded;
module.exports.fundOptions = fundOptions;
module.exports.applyProductionDefaults = applyProductionDefaults;
