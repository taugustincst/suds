'use strict';
const db = require('./db');
const config = require('./config');
const audit = require('./audit');
const { sha256, randomToken, verifyPassword, verifyPasswordAsync, verifyTotp, decrypt } = require('./crypto');
const { unauthorized, forbidden, HttpError } = require('./http');

// Security policy: settings table (editable in Administration) overrides environment defaults.
function policy() {
  const num = (k, d) => { const v = Number(db.getSetting(k, '')); return Number.isFinite(v) && v > 0 ? v : d; };
  const roles = db.getSetting('mfa_required_roles', null);
  return {
    idleMinutes: num('session_idle_minutes', config.session.idleMinutes),
    absoluteHours: num('session_absolute_hours', config.session.absoluteHours),
    passwordMaxAgeDays: num('password_max_age_days', config.password.maxAgeDays),
    mfaRequiredRoles: roles === null ? config.mfaRequiredRoles : roles.split(',').map(x => x.trim()).filter(Boolean),
  };
}

// ---- Role-based permissions (minimum necessary) ----
// clinical notes are visible only to clinical roles and supervisors; admins are system administrators,
// not treating staff, and must use break-glass (audited) to read clinical content.
const PERMS = {
  admin:      ['users:manage','settings:manage','audit:read','apikeys:manage','clients:read','clients:write','clients:all',
               'interventions:*','calls:*','time:read','time:write','time:all','time:approve','resources:*','referrals:*','tasks:*','budget:read','budget:write','budget:approve',
               'notes:admin:read','notes:admin:write','notes:clinical:breakglass','consents:*','imports:*','reports:read','assignments:manage','export:read','export:identified','forms:*',
               'notes:cosign','time:approve','episodes:*','overdose:*','clients:merge'],
  supervisor: ['clients:read','clients:write','clients:all','interventions:*','calls:*','time:read','time:write','time:all','time:approve','resources:*','referrals:*','tasks:*',
               'budget:read','budget:write','budget:approve','notes:admin:read','notes:admin:write','notes:clinical:read','notes:clinical:write',
               'consents:*','imports:*','reports:read','assignments:manage','audit:read','export:read','export:identified','users:read','forms:*',
               'notes:cosign','time:approve','episodes:*','overdose:*','clients:merge'],
  clinician:  ['clients:read','clients:write','interventions:*','calls:*','time:read','time:write','resources:read','referrals:*','tasks:*',
               'notes:admin:read','notes:admin:write','notes:clinical:read','notes:clinical:write','consents:*','imports:*','reports:read','users:read','forms:read','forms:write',
               'episodes:*','overdose:*'],
  navigator:  ['clients:read','clients:write','interventions:*','calls:*','time:read','time:write','resources:*','referrals:*','tasks:*',
               'budget:read','budget:write','notes:admin:read','notes:admin:write','consents:*','imports:*','reports:read','users:read','forms:read','forms:write',
               'episodes:*','overdose:*'],
  // finance sees money, not people: export:read without export:identified means every export it can run
  // comes out keyed by client_code. Do not add 'export:identified' here — docs/HIPAA.md promises otherwise.
  finance:    ['clients:list-deidentified','budget:read','budget:write','budget:approve','time:read','time:all','time:approve','reports:read','export:read','users:read'],
  readonly:   ['clients:read','clients:all','interventions:read','calls:read','referrals:read','tasks:read','resources:read','reports:read','users:read','forms:read'],
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
function canAccessClient(user, clientId) {
  if (!caseloadRestricted(user)) return true;
  const r = db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND (end_date IS NULL OR end_date >= date('now'))`, clientId, user.id);
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
  return { sql: `${col} IN (SELECT client_id FROM assignments WHERE user_id=? AND (end_date IS NULL OR end_date >= date('now')))`, params: [user.id] };
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
  const user = db.one(`SELECT id,username,display_name,email,title,role,is_active,mfa_enabled,must_change_password,password_changed_at,hourly_cost FROM users WHERE id=?`, s.user_id);
  if (!user || !user.is_active) return null;
  // throttle last_seen writes to once/minute
  if (now - Date.parse(s.last_seen_at) > 60_000) db.run(`UPDATE sessions SET last_seen_at=? WHERE id=?`, new Date(now).toISOString(), s.id);
  ctx.sessionToken = token;
  ctx.session = s;
  return user;
}

function requireAuth(ctx) {
  if (!ctx.user) throw unauthorized();
  if (ctx.session?.mfa_pending) throw new HttpError(401, 'MFA verification required', { mfaRequired: true });
  if (!ctx.path.startsWith('/api/auth/')) {
    // Roles the county marks as requiring two-factor cannot reach anything until it is set up. This used to
    // be advisory — the login response said so and nothing stopped the user from ignoring it.
    if (policy().mfaRequiredRoles.includes(ctx.user.role) && !ctx.user.mfa_enabled) {
      throw new HttpError(403, 'Two-step verification must be set up for your role before you can continue', { mfaSetupRequired: true });
    }
    if (ctx.user.must_change_password) throw new HttpError(403, 'Password change required', { passwordChangeRequired: true });
    const age = ctx.user.password_changed_at ? (Date.now() - Date.parse(ctx.user.password_changed_at)) / 86400000 : Infinity;
    const maxAge = policy().passwordMaxAgeDays; if (age > maxAge) throw new HttpError(403, `Password is older than ${maxAge} days and must be changed`, { passwordChangeRequired: true });
  }
}

// ---- Login ----
// Async because scrypt costs ~90ms: doing it synchronously stalls every other request in the process, and a
// few staff signing in at once is enough to be noticed.
async function login({ username, password, ctx }) {
  const user = db.one(`SELECT * FROM users WHERE username=?`, String(username || '').trim());
  const fail = (reason) => {
    audit.log({ user: user ? { id: user.id, username: user.username } : { username }, action: 'auth.login.failed', ip: ctx.ip, success: false, details: { reason } });
    throw unauthorized('Invalid username or password');
  };
  // An unknown username still pays the hashing cost, so response time does not reveal who has an account.
  if (!user) { await verifyPasswordAsync(password || '', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AA=='); fail('unknown user'); }
  if (!user.is_active) fail('inactive');
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    audit.log({ user, action: 'auth.login.locked', ip: ctx.ip, success: false });
    throw new HttpError(423, 'Account locked. Try again later or contact an administrator.');
  }
  if (!(await verifyPasswordAsync(password || '', user.password_hash))) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= config.lockout.maxAttempts ? new Date(Date.now() + config.lockout.minutes * 60000).toISOString() : null;
    db.run(`UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?`, lock ? 0 : attempts, lock, user.id);
    fail(lock ? 'locked after failures' : 'bad password');
  }
  db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?`, db.now(), user.id);
  const mfaRequiredForRole = policy().mfaRequiredRoles.includes(user.role);
  const mfaPending = !!user.mfa_enabled;
  const token = createSession(user, ctx, { mfaPending });
  audit.log({ user, action: mfaPending ? 'auth.login.mfa_pending' : 'auth.login', ip: ctx.ip });
  return { token, user: publicUser(user), mfaPending, mfaSetupRequired: mfaRequiredForRole && !user.mfa_enabled };
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
    mfa_required: policy().mfaRequiredRoles.includes(u.role), caseload_restricted: caseloadRestricted(u) };
}

function passwordPolicy(pw) {
  const errors = [];
  if (typeof pw !== 'string' || pw.length < config.password.minLength) errors.push(`at least ${config.password.minLength} characters`);
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) errors.push('upper and lower case letters');
  if (!/[0-9]/.test(pw)) errors.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push('a symbol');
  return errors;
}

module.exports = { policy, PERMS, hasPerm, requirePerm, requireAuth, canAccessClient, assertClientAccess, caseloadFilter, caseloadRestricted,
  createSession, cookieHeader, revokeSession, revokeAllForUser, resolveSession, login, verifyMfa, publicUser, passwordPolicy, COOKIE };
