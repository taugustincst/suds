'use strict';
const db = require('./db');
const config = require('./config');
const audit = require('./audit');
const { sha256, randomToken, verifyPassword, verifyPasswordAsync, verifyTotp, decrypt } = require('./crypto');
const { unauthorized, forbidden, HttpError } = require('./http');

// Security policy: settings table (editable in Administration) overrides environment defaults.
function policy() {
  // A blank or missing setting means the default. Zero is a real value only where zero means something
  // (a grace period of no days); for a timeout or a password age it would mean the default too, and the
  // Settings route refuses to store it so nobody is told "0" and given 15.
  const num = (k, d, { zero = false } = {}) => { const raw = db.getSetting(k, null); if (raw === null || String(raw).trim() === '') return d; const v = Number(raw); return Number.isFinite(v) && (v > 0 || (zero && v === 0)) ? v : d; };
  const roles = db.getSetting('mfa_required_roles', null);
  // "Every role, whatever the list says": an explicit switch an auditor can point at, rather than a list
  // someone has to read and compare with the role table (Settings → Security policy, mfa_require_all).
  const mfaAll = db.getSetting('mfa_require_all', '0') === '1';
  return {
    idleMinutes: num('session_idle_minutes', config.session.idleMinutes),
    absoluteHours: num('session_absolute_hours', config.session.absoluteHours),
    passwordMaxAgeDays: num('password_max_age_days', config.password.maxAgeDays),
    mfaRequiredRoles: mfaAll ? Object.keys(PERMS) : roles === null ? config.mfaRequiredRoles : roles.split(',').map(x => x.trim()).filter(Boolean),
    mfaRequireAll: mfaAll,
    // How long a new account in a role that requires two-step verification has to set it up. Without this
    // the very first administrator would be locked out the moment the setup wizard created them.
    mfaGraceDays: num('mfa_grace_days', config.mfaGraceDays, { zero: true }),
    ...ssoPolicy(),
  };
}

// Single sign-on required: password sign-in is refused for every account except the named emergency
// (break-glass) administrators, so leavers are cut off at the county's identity provider and password
// policy lives there. Only in force while OIDC is actually configured — with no identity provider to send
// people to, enforcing it would lock everyone out, so it falls open and the Security status page says so.
// Never on a device (local mode has no identity provider).
function ssoPolicy() {
  const wanted = db.getSetting('sso_required', '0') === '1';
  const emergency = String(db.getSetting('sso_emergency_accounts', '') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return { ssoRequiredSetting: wanted, ssoRequired: wanted && !config.local && !!(config.oidc && config.oidc.enabled), ssoEmergencyAccounts: emergency };
}

// ---- Role-based permissions (minimum necessary) ----
// clinical notes are visible only to clinical roles and supervisors; admins are system administrators,
// not treating staff, and must use break-glass (audited) to read clinical content.
// careplan (the CalAIM problem list and care coordination plan) is everyday case-management work, held by
// every role that works with clients, as clients:write is; an administrator may read it. assessments (ASAM
// ratings and scored screening instruments such as the PHQ-9) are clinical content, held like clinical
// notes by clinicians and supervisors only.
const PERMS = {
  admin:      ['users:manage','settings:manage','audit:read','apikeys:manage','clients:read','clients:write','clients:all',
               'interventions:*','calls:*','time:read','time:write','time:all','time:approve','resources:*','referrals:*','tasks:*','budget:read','budget:write','budget:approve','budget:manage',
               'notes:admin:read','notes:admin:write','notes:clinical:breakglass','consents:*','imports:*','reports:read','assignments:manage','export:read','export:identified','forms:*',
               'notes:cosign','time:approve','episodes:*','overdose:*','clients:merge','documents:read','documents:write','disclosures:override','clients:legal-hold','patient-requests:*','careplan:read',
               'complaints:*','incidents:*','court-orders:*'],
  supervisor: ['clients:read','clients:write','clients:all','interventions:*','calls:*','time:read','time:write','time:all','time:approve','resources:*','referrals:*','tasks:*',
               'budget:read','budget:write','budget:approve','budget:manage','notes:admin:read','notes:admin:write','notes:clinical:read','notes:clinical:write',
               'consents:*','imports:*','reports:read','assignments:manage','audit:read','export:read','export:identified','users:read','forms:*',
               'notes:cosign','time:approve','episodes:*','overdose:*','clients:merge','documents:read','documents:write','disclosures:override','patient-requests:*',
               'careplan:*','assessments:*','complaints:*','incidents:*','court-orders:*'],
  // Front-line staff hold export:read so the Export buttons on their own screens work; without
  // export:identified every file they can produce is de-identified (Safe Harbor) and caseload-scoped.
  clinician:  ['clients:read','clients:write','interventions:*','calls:*','time:read','time:write','resources:read','referrals:*','tasks:*',
               'notes:admin:read','notes:admin:write','notes:clinical:read','notes:clinical:write','consents:*','imports:*','reports:read','users:read','forms:read','forms:write',
               'episodes:*','overdose:*','documents:read','patient-requests:*','export:read','careplan:*','assessments:*','court-orders:read'],
  navigator:  ['clients:read','clients:write','interventions:*','calls:*','time:read','time:write','resources:*','referrals:*','tasks:*',
               'budget:read','budget:write','notes:admin:read','notes:admin:write','consents:*','imports:*','reports:read','users:read','forms:read','forms:write',
               'episodes:*','overdose:*','documents:read','patient-requests:*','export:read','careplan:*','court-orders:read'],
  // finance sees money, not people: export:read without export:identified means every export it can run
  // comes out keyed by client_code. Do not add 'export:identified' here — docs/HIPAA.md promises otherwise.
  finance:    ['clients:list-deidentified','budget:read','budget:write','budget:approve','budget:manage','time:read','time:all','time:approve','reports:read','export:read','users:read','documents:read','documents:write'],
  // readonly is for oversight (a county analyst, an auditor's dashboard): aggregate reports and the resource
  // directory, keyed by client code. It holds neither clients:read nor export:read, so it can identify nobody
  // and take nothing off the system.
  readonly:   ['clients:list-deidentified','resources:read','reports:read','users:read','forms:read','documents:read'],
};

function hasPerm(user, perm) {
  if (!user) return false;
  const perms = PERMS[user.role] || [];
  if (perms.includes(perm)) return true;
  const [ns] = perm.split(':');
  if (perms.includes(`${ns}:*`)) return true;
  // 'x:*' grants covers x:read and x:write; 'x:write' implies 'x:read'
  if (perm.endsWith(':read') && perms.includes(perm.replace(/:read$/, ':write'))) return true;
  return false;
}

function requirePerm(...perms) {
  return (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (!perms.some(p => hasPerm(ctx.user, p))) {
      audit.log({ user: ctx.user, action: 'authz.denied', ip: ctx.ip, success: false, details: { perms, path: ctx.path } });
      throw forbidden('You do not have permission for this action');
    }
  };
}

// Caseload scoping: roles without clients:all only see clients assigned to them (setting can disable).
// A de-identified role (finance) is not caseload-scoped because it never sees who the client is — which is
// only true as long as it cannot run an identified export. That is enforced by 'export:identified', a
// separate permission finance does not hold; see datasets() in exports.js.
function caseloadRestricted(user) {
  if (hasPerm(user, 'clients:all') || hasPerm(user, 'clients:list-deidentified')) return false;
  return db.getSetting('caseload_restriction', '1') === '1';
}
// An assignment is over when its last day has passed, or the moment somebody ended it outright.
// The date alone is not enough: a supervisor taking a worker off a case means now, not at midnight.
// Parenthesised as a whole: callers drop it into WHERE clauses that may already contain an OR.
const ACTIVE_ASSIGNMENT = `((end_date IS NULL OR end_date >= date('now')) AND (ended_at IS NULL OR ended_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
const activeAssignment = (prefix = '') => ACTIVE_ASSIGNMENT.replace(/\b(end_date|ended_at)\b/g, `${prefix}$1`);

function canAccessClient(user, clientId) {
  if (!caseloadRestricted(user)) return true;
  const r = db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND ${activeAssignment()}`, clientId, user.id);
  return !!r;
}
function assertClientAccess(ctx, clientId) {
  if (!canAccessClient(ctx.user, clientId)) {
    audit.log({ user: ctx.user, action: 'authz.denied', entity: 'client', entityId: clientId, clientId, ip: ctx.ip, success: false, details: { reason: 'not on caseload' } });
    throw forbidden('This client is not on your caseload');
  }
}
// SQL fragment restricting a client column to the user's caseload
function caseloadFilter(user, col = 'c.id') {
  if (!caseloadRestricted(user)) return { sql: '1=1', params: [] };
  return { sql: `${col} IN (SELECT client_id FROM assignments WHERE user_id=? AND ${activeAssignment()})`, params: [user.id] };
}

// ---- Sessions ----
const COOKIE = 'suds_session';
function createSession(user, ctx, { mfaPending = false } = {}) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + policy().absoluteHours * 3600 * 1000);
  db.run(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_pending,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)`,
    sha256(token), user.id, now.toISOString(), now.toISOString(), expires.toISOString(), mfaPending ? 1 : 0, ctx.ip, (ctx.headers['user-agent'] || '').slice(0, 200));
  return token;
}
function cookieHeader(token, { clear = false } = {}) {
  const secure = config.tls.cert || config.isProd ? '; Secure' : '';
  if (clear) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${policy().absoluteHours * 3600}${secure}`;
}
function revokeSession(token) { if (token) db.run(`UPDATE sessions SET revoked_at=? WHERE id=?`, db.now(), sha256(token)); }
function revokeAllForUser(userId) { db.run(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, db.now(), userId); }

function resolveSession(ctx) {
  let token = ctx.cookies[COOKIE];
  const authz = ctx.headers['authorization'];
  if (!token && authz && authz.startsWith('Bearer ')) token = authz.slice(7).trim();
  if (!token) return null;
  const s = db.one(`SELECT * FROM sessions WHERE id=? AND revoked_at IS NULL`, sha256(token));
  if (!s) return null;
  const now = Date.now();
  if (Date.parse(s.expires_at) < now) return null;
  const idleMs = policy().idleMinutes * 60 * 1000;
  if (now - Date.parse(s.last_seen_at) > idleMs) {
    db.run(`UPDATE sessions SET revoked_at=? WHERE id=?`, db.now(), s.id);
    return null;
  }
  const user = db.one(`SELECT id,username,display_name,email,title,role,is_active,mfa_enabled,must_change_password,password_changed_at,hourly_cost,created_at,requires_cosign,supervisor_id FROM users WHERE id=?`, s.user_id);
  if (!user || !user.is_active) return null;
  // throttle last_seen writes to once/minute — and a background request (the reminder bell's poll, the
  // dashboard's auto-refresh; `X-Background: 1` from public/app.js) is not the person being present, so it
  // never counts towards idle: without this a tab left open on the dashboard could never time out.
  if (ctx.headers['x-background'] !== '1' && now - Date.parse(s.last_seen_at) > 60_000) db.run(`UPDATE sessions SET last_seen_at=? WHERE id=?`, new Date(now).toISOString(), s.id);
  ctx.sessionToken = token;
  ctx.session = s;
  return user;
}

function requireAuth(ctx) {
  if (!ctx.user) throw unauthorized();
  if (ctx.session?.mfa_pending) throw new HttpError(401, 'MFA verification required', { mfaRequired: true });
  if (!ctx.path.startsWith('/api/auth/')) {
    // Roles the county marks as requiring two-step verification cannot reach anything once their grace
    // period has run out. This used to be advisory — the login response said so and nothing stopped the
    // user from ignoring it — but enforcing it from the first second would lock out the administrator the
    // setup wizard just created, before they had any chance to enrol.
    const due = mfaDeadline(ctx.user);
    if (due && Date.now() > Date.parse(due)) {
      throw new HttpError(403, 'Two-step verification must be set up for your role before you can continue', { mfaSetupRequired: true, mfaSetupDeadline: due });
    }
    // The page that lets someone change their password still needs the reference data and preferences the
    // app shell loads first; refusing those too meant a brand-new account (or an expired password) was
    // bounced straight back to the sign-in form, forever. Reads of those two, and nothing else, get through.
    const shellOnly = ctx.method === 'GET' && (ctx.path === '/api/meta/constants' || ctx.path === '/api/me/prefs');
    if (ctx.user.must_change_password && !shellOnly) throw new HttpError(403, 'Password change required', { passwordChangeRequired: true });
    const age = ctx.user.password_changed_at ? (Date.now() - Date.parse(ctx.user.password_changed_at)) / 86400000 : Infinity;
    const maxAge = policy().passwordMaxAgeDays; if (age > maxAge && !shellOnly) throw new HttpError(403, `Password is older than ${maxAge} days and must be changed`, { passwordChangeRequired: true });
  }
}

/**
 * When this user must have two-step verification in place, or null if it is not required of them (or is
 * already set up). Measured from the account's creation.
 */
function mfaDeadline(user) {
  if (!user || user.mfa_enabled) return null;
  if (!policy().mfaRequiredRoles.includes(user.role)) return null;
  const created = Date.parse(user.created_at || 0) || Date.now();
  return new Date(created + policy().mfaGraceDays * 86400000).toISOString();
}

// ---- Login ----
/**
 * What a failed sign-in's audit row records as the username. Someone who exists is named; a username
 * nobody has is whatever the caller typed, so it is cut short and hashed instead of being written into a
 * log that is kept for years and read by administrators.
 */
function auditUsername(username) {
  const u = String(username || '');
  return `unknown:${u.slice(0, 8)}${u.length > 8 ? '…' : ''}#${sha256(u).slice(0, 12)}`;
}
// Async because scrypt costs ~90ms: doing it synchronously stalls every other request in the process, and a
// few staff signing in at once is enough to be noticed.
async function login({ username, password, ctx }) {
  const user = db.one(`SELECT * FROM users WHERE username=?`, String(username || '').trim());
  // A sync client (a local-mode device) identifies itself with a stable device id, separate from the short-lived
  // session a sync run creates and destroys. A lost/stolen phone is handled here, before any session for it
  // is created at all — see server/devices.js and Administration -> Users -> Devices.
  //
  // The device's state is looked at before the credentials are, deliberately. Offboarding goes "deactivate
  // the account, then wipe the phone" as often as the other way round, and a wipe that is only delivered
  // to a device whose password still works is a wipe the ex-employee's phone never receives: it would be
  // told "inactive" and keep every record it holds. So a known device with a wipe (or revocation) pending
  // gets that answer whatever the username and password say. The reply says nothing about the account —
  // the same device gets the same answer whether the username exists, is inactive, or the password is wrong.
  //
  // What the reply does NOT do is consume the wipe. Knowing a device id proves nothing, and the row used to
  // be marked wiped (revoked, wipe cleared) for anyone who sent one — a way to make the server believe a
  // stolen phone had erased itself. Now the pending wipe is cleared only when the credentials sent from
  // the device verify (the phone is in the hands of someone who can unlock the account), or when the
  // device posts back the one-time token this response carries (POST /api/devices/wipe-ack).
  const devices = require('./devices');
  const deviceId = ctx.headers['x-sync-client'] && ctx.headers['x-device-id'] ? String(ctx.headers['x-device-id']).slice(0, 100) : null;
  const who = user ? { id: user.id, username: user.username } : { username: auditUsername(username) };
  let pendingWipe = null;
  if (deviceId) {
    const known = db.one(`SELECT * FROM devices WHERE id=?`, deviceId);
    if (known && known.revoked_at) {
      // A revoked device that was once told to wipe is told again: the erase may not have completed.
      audit.log({ user: who, action: 'auth.login.device_revoked', entity: 'device', entityId: known.id, ip: ctx.ip, success: false, details: { device_user: known.user_id, wipe_requested: !!known.wipe_requested_at } });
      throw new HttpError(403, 'This device has been revoked and can no longer sync. Contact your administrator.', { deviceRevoked: true, wipeRequested: !!known.wipe_requested_at, deviceWipeRequired: !!known.wipe_requested_at || undefined });
    }
    if (known && known.wipe_requested_at) pendingWipe = known;
  }
  /** The one answer a device with a wipe pending gets. `verified`: the credentials checked out, so the wipe is consumed. */
  const wipeRequired = (verified) => {
    const extra = { deviceWipeRequired: true };
    if (verified) {
      devices.markWiped(pendingWipe.id);
      audit.log({ user: who, action: 'auth.login.device_wiped', entity: 'device', entityId: pendingWipe.id, ip: ctx.ip, success: false, details: { device_user: pendingWipe.user_id } });
    } else {
      extra.wipeAckToken = devices.issueWipeToken(pendingWipe.id);
      audit.log({ user: who, action: 'auth.login.device_wipe_pending', entity: 'device', entityId: pendingWipe.id, ip: ctx.ip, success: false, details: { device_user: pendingWipe.user_id } });
    }
    throw new HttpError(403, 'An administrator has remotely wiped this device. It must be set up again before it can sync.', extra);
  };
  const fail = (reason) => {
    // The username of an account that does not exist is attacker-chosen text; the audit log keeps a
    // truncated, hashed form of it rather than the string itself (see auditUsername).
    audit.log({ user: who, action: 'auth.login.failed', ip: ctx.ip, success: false, details: { reason } });
    if (pendingWipe) wipeRequired(false);
    throw unauthorized('Invalid username or password');
  };
  // An unknown username still pays the hashing cost, so response time does not reveal who has an account.
  if (!user) { await verifyPasswordAsync(password || '', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AA=='); fail('unknown user'); }
  if (!user.is_active && (user.access_status === 'pending' || user.access_status === 'declined') && !pendingWipe) {
    // A self sign-up an administrator has not approved (yet). Only someone who knows the password they
    // chose is told where the request stands; anyone else gets the same answer as for any bad sign-in.
    if (!(await verifyPasswordAsync(password || '', user.password_hash))) fail('bad password');
    audit.log({ user: who, action: 'auth.login.access_' + user.access_status, ip: ctx.ip, success: false });
    throw new HttpError(403, user.access_status === 'pending'
      ? 'Your request is waiting for an administrator to approve it. You can sign in once it has been approved.'
      : 'Your request for an account was not approved. Ask your administrator if you think this is a mistake.', { accessPending: user.access_status === 'pending', accessDeclined: user.access_status === 'declined' });
  }
  if (!user.is_active) {
    // With a wipe pending, a correct password on the deactivated account is still proof that the phone is
    // in the hands of the person the account belonged to — enough to consume the wipe.
    if (pendingWipe && await verifyPasswordAsync(password || '', user.password_hash)) wipeRequired(true);
    fail('inactive');
  }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    audit.log({ user, action: 'auth.login.locked', ip: ctx.ip, success: false });
    if (pendingWipe) wipeRequired(false);
    throw new HttpError(423, 'Account locked. Try again later or contact an administrator.');
  }
  if (!(await verifyPasswordAsync(password || '', user.password_hash))) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= config.lockout.maxAttempts ? new Date(Date.now() + config.lockout.minutes * 60000).toISOString() : null;
    db.run(`UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?`, lock ? 0 : attempts, lock, user.id);
    fail(lock ? 'locked after failures' : 'bad password');
  }
  if (pendingWipe) wipeRequired(true);
  // Checked only once the password is right, so the answer says nothing about accounts to someone guessing.
  const pol = policy();
  const emergency = pol.ssoRequired && pol.ssoEmergencyAccounts.includes(String(user.username).toLowerCase());
  if (pol.ssoRequired && !emergency) {
    audit.log({ user, action: 'auth.login.sso_required', ip: ctx.ip, success: false });
    throw new HttpError(403, 'This organisation requires single sign-on. Use the county sign-in button instead of a password.', { ssoRequired: true });
  }
  db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?`, db.now(), user.id);
  // Only a device that has just proven who holds it is recorded (or reattributed) as that person's. The
  // flags are read again from the row touch() returns: an administrator acting between the check above
  // and this point still gets the device stopped on this very login.
  if (deviceId) {
    const device = devices.touch(user, deviceId, ctx);
    if (device.revoked_at) {
      audit.log({ user, action: 'auth.login.device_revoked', entity: 'device', entityId: device.id, ip: ctx.ip, success: false, details: { wipe_requested: !!device.wipe_requested_at } });
      throw new HttpError(403, 'This device has been revoked and can no longer sync. Contact your administrator.', { deviceRevoked: true, wipeRequested: !!device.wipe_requested_at, deviceWipeRequired: !!device.wipe_requested_at || undefined });
    }
    if (device.wipe_requested_at) { pendingWipe = device; wipeRequired(true); }
  }
  const mfaRequiredForRole = policy().mfaRequiredRoles.includes(user.role);
  const mfaPending = !!user.mfa_enabled;
  const token = createSession(user, ctx, { mfaPending });
  // A password sign-in while SSO is required is the break-glass path: said so in the audit trail and the log.
  if (emergency) console.warn(`[suds] emergency (break-glass) password sign-in by ${user.username} while single sign-on is required`);
  audit.log({ user, action: mfaPending ? 'auth.login.mfa_pending' : 'auth.login', ip: ctx.ip, details: emergency ? { emergency_account: true } : undefined });
  const deadline = mfaDeadline(user);
  return { token, user: publicUser(user), mfaPending, mfaSetupRequired: mfaRequiredForRole && !user.mfa_enabled, mfaSetupDeadline: deadline };
}

function verifyMfa(ctx, code) {
  if (!ctx.session) throw unauthorized();
  const user = db.one(`SELECT * FROM users WHERE id=?`, ctx.user.id);
  const secret = decrypt(user.mfa_secret_enc);
  if (!verifyTotp(secret, code)) {
    audit.log({ user, action: 'auth.mfa.failed', ip: ctx.ip, success: false });
    throw unauthorized('Invalid verification code');
  }
  db.run(`UPDATE sessions SET mfa_pending=0 WHERE id=?`, ctx.session.id);
  audit.log({ user, action: 'auth.login', ip: ctx.ip, details: { mfa: true } });
  return publicUser(user);
}

function publicUser(u) {
  const perms = PERMS[u.role] || [];
  return { id: u.id, username: u.username, display_name: u.display_name, email: u.email, title: u.title, role: u.role,
    mfa_enabled: !!u.mfa_enabled, must_change_password: !!u.must_change_password, permissions: perms,
    mfa_required: policy().mfaRequiredRoles.includes(u.role), mfa_setup_deadline: mfaDeadline(u), caseload_restricted: caseloadRestricted(u) };
}

function passwordPolicy(pw) {
  const errors = [];
  if (typeof pw !== 'string' || pw.length < config.password.minLength) errors.push(`at least ${config.password.minLength} characters`);
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) errors.push('upper and lower case letters');
  if (!/[0-9]/.test(pw)) errors.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push('a symbol');
  return errors;
}

module.exports = { auditUsername, policy, PERMS, hasPerm, activeAssignment, requirePerm, requireAuth, mfaDeadline, canAccessClient, assertClientAccess, caseloadFilter, caseloadRestricted,
  createSession, cookieHeader, revokeSession, revokeAllForUser, resolveSession, login, verifyMfa, publicUser, passwordPolicy, COOKIE };
