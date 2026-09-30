'use strict';
const db = require('./db');
const config = require('./config');
const audit = require('./audit');
const { sha256, randomToken, verifyPassword, verifyPasswordAsync, totpStep, decrypt } = require('./crypto');
const { unauthorized, forbidden, badRequest, HttpError } = require('./http');

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
    // How long after proving who they are (signing in, or giving the password or code again) a person may
    // sign a note with a confirmation alone. 0: the password (or code) every time. At most an hour.
    signReauthMinutes: Math.min(60, num('sign_reauth_minutes', 10, { zero: true })),
    ...ssoPolicy(),
    ...passkeyPolicy(),
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

// Fingerprint sign-in and signing with passkeys (docs/FINGERPRINT.md, server/passkeys.js). Office server only: SUDS on
// a device offers neither. passkeySignin: "Sign in with fingerprint", which also counts as two-step verification;
// passkeySigning: "Confirm with fingerprint" for signatures and approvals. Both on unless switched off.
// signStrongRequired: a signature or approval needs a fingerprint or an authenticator code, not the password alone
// (off unless switched on); the quick-signing window then counts only when a fingerprint or code opened it.
function passkeyPolicy() {
  if (config.local) return { passkeySignin: false, passkeySigning: false, signStrongRequired: false };
  return { passkeySignin: db.getSetting('passkey_signin', '1') !== '0', passkeySigning: db.getSetting('passkey_signing', '1') !== '0', signStrongRequired: db.getSetting('sign_strong_required', '0') === '1' };
}
/** How many passkeys this user has that can still be used (not flagged as a possible copy). 0 on a device. */
function passkeyCount(userId) {
  if (config.local || !userId) return 0;
  // Not disabled as a possible copy, and accepted by the authenticator allow-list when it is on (server/passkeys.js
  // usableCount): a passkey the list refuses is not this account's second factor.
  try { return require('./passkeys').usableCount(userId); } catch { return 0; }
}

// ---- Role-based permissions (minimum necessary) ----
// clinical notes are written by clinicians and supervisors and read by them and (1.16.0, read only) navigators;
// admins are system administrators, not treating staff, and must use break-glass (audited) to read clinical
// content.
// clients:all (1.16.0: navigators and clinicians too, by the owner's decision: outreach engages whoever walks
// in, clinicians cover for each other) takes a role out of caseload scoping: it is seeing, and adding one's own
// work to, every client. A programme that wants a person held to their caseload denies them clients:all with a
// per-user override (effectivePerms below), which restores the scoping everywhere (test/role-expansion.test.js).
// records:manage-others (1.16.0) is the "or a manager" power that clients:all used to carry, separated from it by
// the owner's decision: changing or deleting another worker's visits, calls, referrals, overdose reports, to-dos,
// care-plan goals and steps, assessments, outcome measures, rights requests and draft notes; recording work under
// another worker's name; soft-deleting a client record; and seeing another worker's staged imports
// (server/rules/*, server/crud.js, sync push). Held by supervisors and administrators, who held it through
// clients:all before, so nobody lost anything; a navigator or clinician edits only their own work.
// careplan (the CalAIM problem list and care coordination plan) is everyday case-management work, held by
// every role that works with clients, as clients:write is; an administrator may read it. assessments (ASAM
// ratings and scored screening instruments such as the PHQ-9) are clinical content, held like clinical
// notes by clinicians and supervisors only.
// reports:internal lets the funder report, the NDP log and the settlement report be run as anything but a
// publication release (purpose internal or submission: a custom range, one fund, a period not yet ended).
// Suppression inside one report cannot stop two being subtracted from each other (August's release minus
// 1-30 August is whoever was served on the 31st), so such runs are for people who can already see client-level
// data or run the programme: supervisors and administrators, and (1.16.0) navigators and clinicians, who hold
// clients:all. A caseload-scoped role (one denied clients:all) may run one that counts only its own caseload,
// whose records it can open anyway (reportRunAllowed).
// Finance and readonly get publication releases only; finance's money and hours are exact in those and on
// Budget / Time, and it needs no people counts beyond them.
// graph:import: browse and fetch the shared OneNote notebook the server's Microsoft Graph credentials open
// (every worker's pages); front-line roles import only what they upload (server/routes/imports.js).
// reports:exact lets such a run use exact counts instead of small-cell suppression, for the programme's own
// submission to its funder (server/routes/reports.js); publication always suppresses. It is only ever held
// with reports:internal, since exact counts are never a publication release.
// reports:funder (1.14.0) lets a role write the funder report without seeing anyone: the programme's own
// SUBMISSION runs of the funder report, the NDP log and the settlement report — exact aggregate counts, by
// fund and for any range — and nothing else. In a small organisation the grants or finance person writes the
// funder report, and before this needed the supervisor role, which opens every client record. It is not
// reports:internal (no purpose=internal runs) nor reports:exact: the dashboard and monthly trends stay
// masked for it (server/dashboard-mask.js reads reportRunAllowed, which it does not change), and it unlocks
// no identified export and no client-level screen. Every such run is audited with the purpose, fund and period.
// ai:draft (1.17.0, docs/AI-COPILOT.md) asks the AI documentation copilot for a draft: a progress note, the six
// assessment dimensions, care plan suggestions, CalOMS answers. Held by the roles that write that documentation:
// clinicians and supervisors, and navigators, whose notes are administrative (each draft also needs the
// permission to write what it drafts: notes:<kind>:write, assessments:write, careplan:write, episodes:write).
// Not administrators: they are not treating staff. The copilot itself is off until an administrator records
// the programme's agreement with the provider and switches it on (server/ai-copilot.js).
// supplies (docs/SUPPLIES.md): supplies:read is the stock on hand, by site and lot, and its history, for the
// staff who hand supplies out; supplies:receive records stock that arrived (a delivery at their site), which
// field staff do; supplies:manage is the rest of running the cupboard (items, sites, transfers between sites,
// adjustments after a count, disposal of expired stock), held by supervisors and administrators. A visit's own
// draw-down needs only interventions:write, as it always has.
// county:view and county:manage (the county view, docs/COUNTY-VIEW.md) are for a county that runs SUDS to see the
// signed submissions its funded programmes send it: county:view sees the combined view (exact aggregate figures per
// programme, summed; no client of any programme, ever), county:manage registers the programmes' keys and imports
// and withdraws their files. Administrators hold both; supervisors and finance hold county:view, as they hold
// exact submission counts (reports:exact, reports:funder) here already. Read-only does not: its reports are
// publication releases only, and the county view's exact small counts are not for publication, so neither is
// ever granted to a role without exact counts (permissions.js grantProblem). A programme's own server holds them
// too but has nothing to show until it registers a programme; its Send to the county file needs reports:funder.
const PERMS = {
  admin:      ['users:manage','settings:manage','audit:read','apikeys:manage','clients:read','clients:write','clients:all','records:manage-others',
               'interventions:*','calls:*','time:read','time:write','time:all','time:approve','resources:*','referrals:*','tasks:*','budget:read','budget:write','budget:approve','budget:manage',
               'notes:admin:read','notes:admin:write','notes:clinical:breakglass','consents:*','imports:*','graph:import','reports:read','assignments:manage','export:read','export:identified','forms:*',
               'notes:cosign','time:approve','episodes:*','overdose:*','clients:merge','documents:read','documents:write','disclosures:override','clients:legal-hold','patient-requests:*','careplan:read',
               'complaints:*','incidents:*','court-orders:*','agreements:*','reports:internal','reports:exact','reports:funder','supplies:*','county:view','county:manage'],
  supervisor: ['clients:read','clients:write','clients:all','records:manage-others','interventions:*','calls:*','time:read','time:write','time:all','time:approve','resources:*','referrals:*','tasks:*',
               'budget:read','budget:write','budget:approve','budget:manage','notes:admin:read','notes:admin:write','notes:clinical:read','notes:clinical:write',
               'consents:*','imports:*','graph:import','reports:read','assignments:manage','audit:read','export:read','export:identified','users:read','forms:*',
               'notes:cosign','time:approve','episodes:*','overdose:*','clients:merge','documents:read','documents:write','disclosures:override','patient-requests:*',
               'careplan:*','assessments:*','complaints:*','incidents:*','court-orders:*','agreements:*','reports:internal','reports:exact','reports:funder','supplies:*','ai:draft','county:view'],
  // Front-line staff hold export:read so the Export buttons on their own screens work; without
  // export:identified every file they can produce is de-identified (Safe Harbor), and caseload-scoped for a
  // person denied clients:all. budget:read (1.16.0): a clinician sees programme spending; no budget:write.
  clinician:  ['clients:read','clients:write','clients:all','interventions:*','calls:*','time:read','time:write','resources:read','referrals:*','tasks:*',
               'budget:read','notes:admin:read','notes:admin:write','notes:clinical:read','notes:clinical:write','consents:*','imports:*','reports:read','users:read','forms:read','forms:write',
               'episodes:*','overdose:*','documents:read','patient-requests:*','export:read','careplan:*','assessments:*','court-orders:read','agreements:read','supplies:read','supplies:receive','ai:draft'],
  navigator:  ['clients:read','clients:write','clients:all','interventions:*','calls:*','time:read','time:write','resources:*','referrals:*','tasks:*',
               'budget:read','budget:write','notes:admin:read','notes:admin:write','notes:clinical:read','consents:*','imports:*','reports:read','users:read','forms:read','forms:write',
               'episodes:*','overdose:*','documents:read','patient-requests:*','export:read','careplan:*','court-orders:read','agreements:read','supplies:read','supplies:receive','ai:draft'],
  // finance sees money, not people: export:read without export:identified means every export it can run
  // comes out keyed by client_code. Do not add 'export:identified' here — docs/HIPAA.md promises otherwise.
  // Its people counts are aggregate only: publication releases, and (reports:funder) the programme's own
  // submission runs of the funder, NDP and settlement reports, exact, by fund and for any range. It holds no
  // reports:internal or reports:exact, so no internal runs, and its dashboard stays masked. Money and hours
  // are exact everywhere, and on Budget and Time for any range or fund.
  finance:    ['clients:list-deidentified','budget:read','budget:write','budget:approve','budget:manage','time:read','time:all','time:approve','reports:read','reports:funder','export:read','users:read','documents:read','documents:write','county:view'],
  // readonly is for oversight (a county analyst, an auditor's dashboard): aggregate reports and the resource
  // directory, keyed by client code. It holds neither clients:read nor export:read, so it can identify nobody
  // and take nothing off the system. Its funder, NDP and settlement reports are publication releases only.
  // forms:read is the form library (templates, blank forms); a client's filled forms are client records and
  // need clients:read as well (server/routes/forms.js), which readonly does not hold.
  readonly:   ['clients:list-deidentified','resources:read','reports:read','users:read','forms:read','documents:read'],
};

const { isKnownPermission, grantProblem } = require('./permissions');

// The role's defaults, as a fresh array the caller may mutate.
function rolePerms(role) { return [...(PERMS[role] || [])]; }

// A user's effective permissions: role defaults plus grants, minus denies.
// Returns { allow, deny }. Deny always wins — including across wildcards and the
// write-implies-read rule — so hasPerm checks deny first. Memoized on the user object;
// resolveSession builds a fresh user object per request, so this is per-request only.
function effectivePerms(user) {
  if (!user) return { allow: [], deny: [] };
  if (user._effectivePerms) return user._effectivePerms;
  const allow = new Set(rolePerms(user.role));
  const deny = new Set();
  if (user.id) {
    try {
      const rows = db.all(`SELECT permission, mode FROM user_permission_overrides WHERE user_id=?`, user.id);
      const defaults = PERMS[user.role] || [];
      for (const r of rows) {
        if (!isKnownPermission(r.permission)) continue; // defensive: ignore hand-edited typos
        if (r.mode === 'deny') { allow.delete(r.permission); deny.add(r.permission); }
        // A grant the account's role may not hold (a privileged one after a demotion, clients:read on a
        // de-identified role: permissions.js grantProblem) is checked here, at every request, so a row that
        // was left behind, written before 1.15.4 or put in by hand cannot drift into power.
        else if (!grantProblem(user.role, defaults, r.permission)) { allow.add(r.permission); }
      }
    } catch (e) { /* table missing on databases that have not run migration 46 yet */ }
  }
  const out = { allow: [...allow].sort(), deny: [...deny].sort() };
  user._effectivePerms = out;
  return out;
}

// The role defaults widened in 1.16.0 (the owner's decision; CHANGELOG). A local-mode device that synced before
// then holds what the narrower defaults allowed, so sync compares against them (server/routes/sync.js,
// syncScopeKey). `asBefore1_16(user)` is the user as the 1.15 defaults saw them: the same overrides, without the
// widened defaults unless an administrator granted one explicitly.
const WIDENED_1_16 = { navigator: ['clients:all', 'notes:clinical:read'], clinician: ['clients:all', 'budget:read'] };
function asBefore1_16(user) {
  const eff = effectivePerms(user);
  const widened = WIDENED_1_16[user.role] || [];
  if (!widened.length) return user;
  let granted = [];
  try { granted = db.all(`SELECT permission FROM user_permission_overrides WHERE user_id=? AND mode='grant'`, user.id).map(r => r.permission); } catch { /* before migration 46 */ }
  const drop = widened.filter(p => !granted.includes(p));
  return { id: user.id, role: user.role, _effectivePerms: { allow: eff.allow.filter(p => !drop.includes(p)), deny: eff.deny } };
}

function hasPerm(user, perm) {
  if (!user) return false;
  const { allow, deny } = effectivePerms(user);
  if (deny.includes(perm)) return false;
  const ns = perm.split(':')[0];
  if (deny.includes(`${ns}:*`)) return false;
  if (perm.endsWith(':read') && deny.includes(perm.slice(0, -5) + ':write')) return false;
  if (allow.includes(perm)) return true;
  if (allow.includes(`${ns}:*`)) return true;
  if (perm.endsWith(':read') && allow.includes(perm.slice(0, -5) + ':write')) return true;
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

// May this user run a report that is not a publication release? `caseloadScoped` says whether the report
// counts only the user's caseload (the funder report and the NDP log do; the settlement report does not).
// Without reports:internal, only a role with clients:read whose run counts nobody it cannot open: its own
// caseload, or everyone when caseloads are not restricted.
function reportRunAllowed(user, { caseloadScoped = false } = {}) {
  if (hasPerm(user, 'reports:internal')) return true;
  return hasPerm(user, 'clients:read') && (caseloadScoped || !caseloadRestricted(user));
}
// May this user run the programme's own submission of the funder report, the NDP log or the settlement
// report (purpose=submission, exact counts, by fund, any range) without client-level access? reports:funder.
function submissionRunAllowed(user) { return hasPerm(user, 'reports:funder'); }

// Caseload scoping: whoever may open client records (clients:read) sees only the clients assigned to them,
// unless they hold clients:all (or the setting is off). clients:all alone decides it: holding
// clients:list-deidentified is no exemption (security review of 1.15.3, M1: a navigator granted it, or finance
// granted clients:read, used to see every client's record). So denying clients:all puts anyone back on their
// caseload, everywhere this is asked: REST lists and records, exports, sync pull, the dashboard and search.
// The one account that is not held to a caseload without clients:all is a de-identified one: it cannot open a
// record at all (no clients:read: canAccessClient refuses it every one) and lists clients by code only, through
// its own read path (clients:list-deidentified; test/deidentified-roles.test.js), which it is never granted a
// way around (permissions.js grantProblem: no clients:read, clients:write or export:identified, and no
// clients:list-deidentified for a role that opens records). Anyone else without clients:read (a navigator
// denied it) stays caseload-scoped, as before.
function caseloadRestricted(user) {
  if (hasPerm(user, 'clients:all')) return false;
  if (!hasPerm(user, 'clients:read') && hasPerm(user, 'clients:list-deidentified')) return false;
  return db.getSetting('caseload_restriction', '1') === '1';
}
// An assignment is over when its last day has passed, or the moment somebody ended it outright.
// The date alone is not enough: a supervisor taking a worker off a case means now, not at midnight.
// Parenthesised as a whole: callers drop it into WHERE clauses that may already contain an OR.
const ACTIVE_ASSIGNMENT = `((end_date IS NULL OR end_date >= date('now')) AND (ended_at IS NULL OR ended_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
const activeAssignment = (prefix = '') => ACTIVE_ASSIGNMENT.replace(/\b(end_date|ended_at)\b/g, `${prefix}$1`);

// A role without clients:read (finance, readonly: clients:list-deidentified) is not caseload-scoped because
// it never sees who a client is — so it may open no client's record. caseloadRestricted() is false for it,
// which used to make this answer "yes" for every client (readonly read any client's identified forms). The
// one exception is opt-in: `deidentified: true` from a route whose answer is keyed by client code only
// (crud.js: an expenditure or time entry that names a client, which finance approves; withClientName gives a
// role without clients:read the code, never the name). test/deidentified-roles.test.js sweeps every GET
// route as each such role and fails on any identifier in the answer.
function canAccessClient(user, clientId, { deidentified = false } = {}) {
  if (!hasPerm(user, 'clients:read')) return deidentified && hasPerm(user, 'clients:list-deidentified');
  if (!caseloadRestricted(user)) return true;
  const r = db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND ${activeAssignment()}`, clientId, user.id);
  return !!r;
}
function assertClientAccess(ctx, clientId, opts) {
  if (!canAccessClient(ctx.user, clientId, opts)) {
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
function createSession(user, ctx, { mfaPending = false, mfaSource = null, reauthMethod = 'password', passkeyId = null, syncClient = false } = {}) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + policy().absoluteHours * 3600 * 1000);
  // Creating a session is the moment its user proved who they are (a password, a passkey, or the identity provider).
  // reauth_method says which: "Require fingerprint or authenticator for signing" counts only a passkey or a code.
  // passkey_id: the passkey that opened it, so removing that passkey ends it (server/passkeys.js remove).
  // sync_client: a device's sync sign-in, for which a passkey is not a second factor (requireAuth, mfaDeadline).
  db.run(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_pending,ip,user_agent,mfa_source,reauth_at,reauth_method,passkey_id,sync_client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sha256(token), user.id, now.toISOString(), now.toISOString(), expires.toISOString(), mfaPending ? 1 : 0, ctx.ip, (ctx.headers['user-agent'] || '').slice(0, 200), mfaSource, now.toISOString(), reauthMethod, passkeyId, syncClient ? 1 : 0);
  return token;
}
// ---- recent re-authentication (the electronic-signature step) ----
// A signature is the signer's deliberate act, attested each time; proving identity again for every note is
// what made signing take eleven steps. A session that proved who is using it within signReauthMinutes
// (sign-in, second factor, or the password or code given for the last signature) needs only the
// confirmation; after that, the password again — or the authenticator code for an account with two-step
// verification on.
// A completed single sign-on re-authentication (routes/oidc.js finishReauth), by session, for key custody
// (verifySigner's `fresh`): good for SSO_PROOF_MS and for one use. Kept in memory: SUDS is one process per
// database (server/instance-lock.js), and a restart only means confirming with the provider again. The
// session's reauth_at cannot tell this apart from a sign-in, which sets it too.
const SSO_PROOF_MS = 5 * 60_000;
const ssoProofs = new Map();
function noteSsoProof(sessionId) {
  const now = Date.now();
  for (const [k, at] of ssoProofs) if (now - at > SSO_PROOF_MS) ssoProofs.delete(k);
  ssoProofs.set(sessionId, now);
}
function ssoProofFresh(ctx) { const at = ctx.session && ssoProofs.get(ctx.session.id); return !!at && Date.now() - at <= SSO_PROOF_MS; }
function takeSsoProof(ctx) { const ok = ssoProofFresh(ctx); if (ctx.session) ssoProofs.delete(ctx.session.id); return ok; }
function markReauth(ctx, method = 'password') { if (ctx.session) { const at = db.now(); db.run(`UPDATE sessions SET reauth_at=?, reauth_method=? WHERE id=?`, at, method, ctx.session.id); ctx.session.reauth_at = at; ctx.session.reauth_method = method; } }
// The methods that count as a fingerprint or an authenticator code (policy().signStrongRequired).
const STRONG_METHODS = ['passkey', 'totp'];
function reauthStatus(ctx) {
  const minutes = policy().signReauthMinutes;
  const at = ctx.session && ctx.session.reauth_at ? Date.parse(ctx.session.reauth_at) : NaN;
  const until = Number.isFinite(at) && minutes > 0 ? at + minutes * 60000 : 0;
  // How the signer proves it again: the authenticator code with two-step verification on; single sign-on
  // (an identity-provider round-trip, server/routes/oidc.js) for an account linked to the provider that has
  // no SUDS password of its own (SCIM-provisioned, or never given one); otherwise the password. `sso`: the
  // round-trip is offered at all (as an alternative, for a linked account that also has a password).
  const u = ctx.user ? db.one(`SELECT mfa_enabled, password_hash, oidc_subject FROM users WHERE id=?`, ctx.user.id) : null;
  const sso = !!(u && u.oidc_subject && config.oidc && config.oidc.enabled);
  const method = u && u.mfa_enabled ? 'totp' : sso && !hasLocalPassword(u.password_hash) ? 'sso' : 'password';
  // passkey: "Confirm with fingerprint" is offered as an equal alternative (the user has a passkey and the programme
  // allows it). strong_required: the password alone is not enough (policy().signStrongRequired); then the quick
  // window counts only when a fingerprint or code opened it (recent_method).
  const pol = policy();
  const passkey = pol.passkeySigning && passkeyCount(ctx.user && ctx.user.id) > 0;
  const recentMethod = ctx.session ? ctx.session.reauth_method || null : null;
  const recent = until > Date.now() && (!pol.signStrongRequired || STRONG_METHODS.includes(recentMethod));
  return { recent, until: until ? new Date(until).toISOString() : null, window_minutes: minutes, method, sso, sso_fresh: sso && ssoProofFresh(ctx),
    passkey, strong_required: pol.signStrongRequired, recent_method: recentMethod, totp: !!(u && u.mfa_enabled) };
}
/** Whether a password hash is a real one (an SSO-provisioned account's is a marker nobody can match). */
function hasLocalPassword(hash) { return /^scrypt\$/.test(String(hash || '')); }
/**
 * Establish who is signing: the password (or, with two-step verification on, the authenticator code) given
 * with this request, or a recent re-authentication plus an explicit confirmation. Returns how, for the audit
 * entry: 'password', 'totp' or 'recent_auth'. `action` names the failed-attempt audit entry; `purpose` finishes
 * the messages ("Enter your password to ..."): signing a note, or downloading the key backup. `fresh`: no
 * recent-authentication window at all (the key backup); 'sso' is then returned for a single sign-on round-trip.
 */
async function verifySigner(ctx, body, { action = 'note.sign.failed', purpose = 'sign', fresh = false, bind = null } = {}) {
  const password = typeof body.password === 'string' && body.password ? body.password : null;
  const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : null;
  const passkey = body.passkey && typeof body.passkey === 'object' ? body.passkey : null;
  const pol = policy();
  const u = db.one(`SELECT id, password_hash, mfa_enabled, mfa_secret_enc, failed_attempts, locked_until FROM users WHERE id=?`, ctx.user.id);
  // A signature is a password / authenticator check like the sign-in, with the sign-in's protections: a
  // locked account cannot sign by any route (including the quick confirmation), and every failure below
  // counts toward the same lockout and rate limits and ends the quick-signing window — whoever is guessing
  // at an unlocked workstation must not keep it open.
  if (isLocked(u)) {
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'locked' } });
    throw new HttpError(423, 'Account locked after too many failed attempts. Try again later or contact an administrator.');
  }
  const failed = (details, message) => {
    clearReauth(ctx);
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details });
    throw forbidden(message);
  };
  // "Confirm with fingerprint": a passkey assertion over a challenge bound to exactly what is being signed (`bind`:
  // the purpose, the record and its content hash; server/passkeys.js). Equal to the password or the code, and like
  // them it opens the quick-signing window. The evidence is kept (signature_evidence) and its id left on ctx for the
  // route's audit entry.
  if (passkey) {
    if (!bind) throw badRequest('A fingerprint confirmation is not accepted here');
    // One proof at a time: a password or code sent with a fingerprint would go unchecked, and whatever is given must verify.
    if (password || code) throw badRequest('Confirm with your fingerprint, or with your password or code, not both at once');
    ctx.signatureEvidence = require('./passkeys').confirm(ctx, passkey, bind, { action });
    markReauth(ctx, 'passkey'); return 'passkey';
  }
  // The programme requires a fingerprint or an authenticator code for signatures and approvals: the password alone
  // is refused (not a failed attempt: nothing was guessed).
  const strongHow = (st) => (st.passkey && st.totp ? 'Confirm with your fingerprint or enter the code from your authenticator app' : st.passkey ? 'Confirm with your fingerprint' : st.totp ? 'Enter the code from your authenticator app' : 'Set up fingerprint sign-in or two-step verification under My profile, then try again');
  const checkPassword = async () => {
    const limit = config.loginRateLimit;
    const app = require('./app');
    if (app.rateLimited(`login:${ctx.ip}`, limit)) throw new HttpError(429, 'Too many attempts. Try again later.');
    if (!(await verifyPasswordAsync(password, u.password_hash))) {
      app.rateLimit(`login:${ctx.ip}`, limit, 15 * 60_000);
      const locked = recordPasswordFailure(u);
      failed(locked ? { reason: 'locked after failures' } : undefined, locked ? 'Password verification failed. The account is now locked after too many failed attempts.' : 'Password verification failed');
    }
  };
  // A code that is given must verify, whatever else comes with it: a password with a made-up code is not a password
  // and a code (security review of the fingerprint work, finding 1). With both given, both are checked; the code is
  // what counts (a fingerprint or a code is what "Require fingerprint or authenticator for signing" asks for).
  if (code) {
    if (!u.mfa_enabled || !u.mfa_secret_enc) {
      audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { method: 'totp', reason: 'no authenticator set up' } });
      throw badRequest(pol.signStrongRequired ? `Two-step verification is not set up for your account, and your programme requires your fingerprint or an authenticator code to ${purpose}. ${strongHow(reauthStatus(ctx))}.` : 'Two-step verification is not set up for your account; give your password instead');
    }
    if (password) await checkPassword();
    if (!require('./app').rateLimit(`mfa:${ctx.user.id}`, 10, 10 * 60_000)) throw new HttpError(429, 'Too many attempts');
    const r = useTotp(u.id, u.mfa_secret_enc, code);
    if (r !== 'ok') {
      const locked = recordPasswordFailure(u);
      if (r === 'replay') failed({ method: 'totp', reason: 'replay', ...(locked ? { locked: true } : {}) }, 'That code has already been used. Wait for the next code from your authenticator app.');
      failed({ method: 'totp', ...(locked ? { reason: 'locked after failures' } : {}) }, locked ? 'That code is not right. The account is now locked after too many failed attempts.' : 'That code is not right. Enter the current code from your authenticator app.');
    }
    clearFailures(u.id);
    markReauth(ctx, 'totp'); return 'totp';
  }
  if (password) {
    if (pol.signStrongRequired) {
      const st = reauthStatus(ctx);
      audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'password alone not accepted' } });
      throw new HttpError(403, `Your programme requires your fingerprint or an authenticator code to ${purpose}; your password alone is not enough. ${strongHow(st)}.`, { reauthRequired: true, strongRequired: true, method: st.method, passkey: st.passkey, totp: st.totp });
    }
    await checkPassword();
    clearFailures(u.id);
    markReauth(ctx, 'password'); return 'password';
  }
  const st = reauthStatus(ctx);
  // Key custody (fresh: the key backup) has no window: the password or code with this very request, or, for an
  // account linked to single sign-on, an identity-provider round-trip completed in the last few minutes and not
  // yet used (takeSsoProof, one download each). A sign-in, a signature a few minutes ago or the previous
  // download does not count (security review of 1.13.0, design weakness 6).
  if (fresh) {
    if ((body.confirm === true || body.confirm === 1) && st.sso && takeSsoProof(ctx)) return 'sso';
    const how = st.method === 'totp' ? `Enter the code from your authenticator app to ${purpose}` : st.method === 'sso' ? `Confirm with single sign-on to ${purpose}` : `Enter your password to ${purpose}`;
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'fresh proof required' } });
    throw new HttpError(403, `${how}. It is asked for every time, however recently you confirmed it is you.`, { reauthRequired: true, fresh: true, method: st.method, sso: st.sso });
  }
  // validate() stores booleans as 1/0 (SQLite); either spelling is the confirmation.
  if (body.confirm !== true && body.confirm !== 1) throw badRequest(st.recent ? `Confirm the attestation to ${purpose}` : st.method === 'totp' ? `Enter the code from your authenticator app to ${purpose}` : st.method === 'sso' ? `Confirm with single sign-on, then ${purpose}` : `Your password is required to ${purpose}`);
  if (!st.recent) {
    if (pol.signStrongRequired) throw new HttpError(403, `Your programme requires your fingerprint or an authenticator code to ${purpose}. ${strongHow(st)}.`, { reauthRequired: true, strongRequired: true, method: st.method, sso: st.sso, passkey: st.passkey, totp: st.totp });
    const how = { totp: `Enter the code from your authenticator app to ${purpose}.`, sso: `Confirm with single sign-on to ${purpose}.`, password: `Enter your password to ${purpose}.` }[st.method];
    throw new HttpError(403, `It has been a while since you last confirmed it is you. ${how}${st.passkey ? ' Or confirm with your fingerprint.' : ''}`, { reauthRequired: true, method: st.method, sso: st.sso, passkey: st.passkey });
  }
  return 'recent_auth';
}
/**
 * An approval (time, spending): it asked for no proof of identity before 1.19.0 and asks for none by default now.
 * Proof is taken when it is given — "Confirm with fingerprint" (a passkey assertion bound to exactly what is
 * approved), or the password or code, checked as for a signature — and required, as a fingerprint or an
 * authenticator code, when the programme turns on "Require fingerprint or authenticator for signing". Returns how
 * identity was established ('passkey', 'totp', 'password', 'recent_auth') or null when none was asked for or given.
 */
async function verifyApprover(ctx, body, { action, purpose, bind }) {
  const given = (body.passkey && typeof body.passkey === 'object') || (typeof body.password === 'string' && body.password) || (typeof body.code === 'string' && body.code.trim());
  if (!given && !policy().signStrongRequired) return null;
  if (!given && body.confirm !== true && body.confirm !== 1) {
    // Required and not given: say how (a fingerprint or a code), so the approval dialog can ask for it.
    const st = reauthStatus(ctx);
    throw new HttpError(403, `Your programme requires your fingerprint or an authenticator code to ${purpose}.`, { reauthRequired: true, strongRequired: true, method: st.method, passkey: st.passkey, totp: st.totp, recent: st.recent });
  }
  return verifySigner(ctx, body, { action, purpose, bind });
}
const LOCKED_MESSAGE = 'Account locked after too many failed attempts. Try again later or contact an administrator.';
/**
 * The password of the person already signed in, given again to change it or to turn two-step verification
 * off. It gets the sign-in's protections, as a signature's password does (verifySigner): the per-address
 * limit, the account's failure count and lockout, and an audit entry (`action`) for every failure. Before
 * 1.14.0 these routes took unlimited guesses from inside a session (security review of 1.13.0, finding 5).
 * Throws on failure; the caller clears the failure count once everything it asks for has been given.
 */
async function confirmPassword(ctx, password, { action, message = 'Password is incorrect' }) {
  const u = db.one(`SELECT id, password_hash, failed_attempts, locked_until FROM users WHERE id=?`, ctx.user.id);
  if (isLocked(u)) {
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'locked' } });
    throw new HttpError(423, LOCKED_MESSAGE);
  }
  const app = require('./app'); const limit = config.loginRateLimit;
  if (app.rateLimited(`login:${ctx.ip}`, limit)) {
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'rate limited' } });
    throw new HttpError(429, 'Too many attempts. Try again later.');
  }
  if (await verifyPasswordAsync(password, u.password_hash)) return;
  app.rateLimit(`login:${ctx.ip}`, limit, 15 * 60_000);
  const locked = recordPasswordFailure(u);
  clearReauth(ctx);
  audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'wrong password', ...(locked ? { locked: true } : {}) } });
  throw locked ? new HttpError(423, `${message}. ${LOCKED_MESSAGE.replace('Account locked', 'The account is now locked')}`) : unauthorized(message);
}
/** The same for a current authenticator code (the per-account code limit, the failure count, the lockout, the audit). */
function confirmCode(ctx, code, { action }) {
  const u = db.one(`SELECT id, mfa_enabled, mfa_secret_enc, failed_attempts, locked_until FROM users WHERE id=?`, ctx.user.id);
  if (isLocked(u)) {
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'locked' } });
    throw new HttpError(423, LOCKED_MESSAGE);
  }
  if (!u.mfa_enabled || !u.mfa_secret_enc) throw badRequest('Two-step verification is not set up for your account');
  if (!require('./app').rateLimit(`mfa:${u.id}`, 10, 10 * 60_000)) {
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: 'rate limited', method: 'totp' } });
    throw new HttpError(429, 'Too many attempts');
  }
  const r = useTotp(u.id, u.mfa_secret_enc, String(code || '').trim());
  if (r === 'ok') return;
  const locked = recordPasswordFailure(u);
  clearReauth(ctx);
  audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { reason: r === 'replay' ? 'replayed code' : 'wrong code', method: 'totp', ...(locked ? { locked: true } : {}) } });
  if (locked) throw new HttpError(423, 'That code is not right. The account is now locked after too many failed attempts.');
  throw forbidden(r === 'replay' ? 'That code has already been used. Wait for the next code from your authenticator app.' : 'That code is not right. Enter the current code from your authenticator app.');
}
function clearReauth(ctx) { if (ctx.session) { db.run(`UPDATE sessions SET reauth_at=NULL WHERE id=?`, ctx.session.id); ctx.session.reauth_at = null; } }
function isLocked(user) { return !!(user.locked_until && Date.parse(user.locked_until) > Date.now()); }
/** Count a wrong password or authenticator code (sign-in, second step, enrolment, signature) toward the account lockout. True if it now locks the account. */
function recordPasswordFailure(user) {
  const row = db.one(`SELECT failed_attempts FROM users WHERE id=?`, user.id);
  const attempts = ((row && row.failed_attempts) || 0) + 1;
  const lock = attempts >= config.lockout.maxAttempts ? new Date(Date.now() + config.lockout.minutes * 60000).toISOString() : null;
  db.run(`UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?`, lock ? 0 : attempts, lock, user.id);
  return !!lock;
}
function clearFailures(userId) { db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, userId); }
/**
 * Check an authenticator code for this account and use it up: each code is accepted once, and never one
 * from a time-step at or before the last accepted (RFC 6238 section 5.2). The step is claimed in one UPDATE,
 * so two requests racing with the same code cannot both succeed. 'ok', 'wrong' or 'replay'.
 */
function useTotp(userId, secretEnc, code) {
  const step = totpStep(decrypt(secretEnc), code);
  if (step === null) return 'wrong';
  const r = db.run(`UPDATE users SET totp_last_step=? WHERE id=? AND (totp_last_step IS NULL OR totp_last_step < ?)`, step, userId, step);
  return r && r.changes ? 'ok' : 'replay';
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
    // A session whose second factor the identity provider asserted (and the administrator trusts) has had
    // one: the SUDS enrolment deadline is about SUDS's own authenticator and does not apply to it.
    // The page that lets someone change their password (or enrol a second factor) still needs the reference
    // data and preferences the app shell loads first; refusing those too meant a brand-new account (or an
    // expired password) was bounced straight back to the sign-in form, forever. Reads of those two — no PHI
    // — and nothing else, get through.
    const shellOnly = ctx.method === 'GET' && (ctx.path === '/api/meta/constants' || ctx.path === '/api/me/prefs');
    // A passkey sign-in (mfa_source 'passkey') was two factors in one: the device held the key and verified the person.
    // A device's sync session (sync_client) signed in with the password and cannot give a fingerprint: for it a passkey
    // is not the account's two-step verification, and the deadline is the one it had before passkeys (mfaDeadline).
    const sync = !!ctx.session?.sync_client;
    const due = ctx.session?.mfa_source === 'idp' || ctx.session?.mfa_source === 'passkey' ? null : mfaDeadline(ctx.user, { passkeyCounts: !sync });
    if (due && Date.now() > Date.parse(due) && !shellOnly) {
      // Someone whose passkey counts in the browser is told why the device is different, and what would work there.
      if (sync && mfaDeadline(ctx.user) === null) throw new HttpError(403, DEVICE_NEEDS_AUTHENTICATOR, { deviceNeedsAuthenticator: true, mfaSetupDeadline: due });
      throw new HttpError(403, 'Two-step verification must be set up for your role before you can continue', { mfaSetupRequired: true, mfaSetupDeadline: due });
    }
    if (ctx.user.must_change_password && !shellOnly) throw new HttpError(403, 'Password change required', { passwordChangeRequired: true });
    const age = ctx.user.password_changed_at ? (Date.now() - Date.parse(ctx.user.password_changed_at)) / 86400000 : Infinity;
    const maxAge = policy().passwordMaxAgeDays; if (age > maxAge && !shellOnly) throw new HttpError(403, `Password is older than ${maxAge} days and must be changed`, { passwordChangeRequired: true });
  }
}

/**
 * When this user must have two-step verification in place, or null if it is not required of them (or is
 * already set up). Measured from the account's creation.
 */
// `passkeyCounts`: false for a device's sync sign-in, which cannot use a passkey: the deadline is then the one the
// account had before passkeys (its authenticator app is the only second factor a device can give).
function mfaDeadline(user, { passkeyCounts = true } = {}) {
  if (!user || user.mfa_enabled) return null;
  if (!policy().mfaRequiredRoles.includes(user.role)) return null;
  // A passkey with user verification (the fingerprint, or the device's screen lock) is multi-factor on its own
  // (NIST SP 800-63B: a multi-factor cryptographic authenticator, AAL2; docs/FINGERPRINT.md): an account that has
  // one has set up two-step verification, as long as fingerprint sign-in is allowed here.
  if (passkeyCounts && policy().passkeySignin && passkeyCount(user.id) > 0) return null;
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
  if (isLocked(user)) {
    audit.log({ user, action: 'auth.login.locked', ip: ctx.ip, success: false });
    if (pendingWipe) wipeRequired(false);
    throw new HttpError(423, 'Account locked. Try again later or contact an administrator.');
  }
  if (!(await verifyPasswordAsync(password || '', user.password_hash))) {
    fail(recordPasswordFailure(user) ? 'locked after failures' : 'bad password');
  }
  if (pendingWipe) wipeRequired(true);
  // Checked only once the password is right, so the answer says nothing about accounts to someone guessing.
  const pol = policy();
  const emergency = pol.ssoRequired && pol.ssoEmergencyAccounts.includes(String(user.username).toLowerCase());
  if (pol.ssoRequired && !emergency) {
    audit.log({ user, action: 'auth.login.sso_required', ip: ctx.ip, success: false });
    throw new HttpError(403, 'This organisation requires single sign-on. Use the county sign-in button instead of a password.', { ssoRequired: true });
  }
  // With two-step verification on, the password is only half the sign-in: the count of failed attempts is
  // cleared by the second factor (verifyMfa), so a password-holding attacker cannot reset the lockout by
  // signing in again between guesses at the code.
  db.run(`UPDATE users SET failed_attempts=CASE WHEN mfa_enabled=1 THEN failed_attempts ELSE 0 END, locked_until=NULL, last_login_at=? WHERE id=?`, db.now(), user.id);
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
  // The second step is the authenticator code, or the fingerprint: with two-step verification on, either; for a role
  // that requires it, an account whose only second factor is a passkey finishes signing in with it (a password alone
  // is one factor, and the passkey is what counts as that account's enrolment in mfaDeadline).
  // Not for a device's sync sign-in (X-Sync-Client): a device sends the password and, at most, the authenticator code
  // (local/sync.js), and a passkey is refused there (server/passkeys.js loginFinish). For it, everything is as it was
  // before passkeys: the code when the account has an authenticator app; otherwise the enrolment deadline, after which
  // the session is stopped (requireAuth) and the device told to add an authenticator app (DEVICE_NEEDS_AUTHENTICATOR).
  const syncClient = !!ctx.headers['x-sync-client'];
  const passkeyStep = passkeyStepOwed(user, { syncClient });
  const mfaPending = !!user.mfa_enabled || (mfaRequiredForRole && passkeyStep);
  const token = createSession(user, ctx, { mfaPending, syncClient });
  // A password sign-in while SSO is required is the break-glass path: said so in the audit trail and the log.
  if (emergency) console.warn(`[suds] emergency (break-glass) password sign-in by ${user.username} while single sign-on is required`);
  audit.log({ user, action: mfaPending ? 'auth.login.mfa_pending' : 'auth.login', ip: ctx.ip, details: emergency ? { emergency_account: true } : undefined });
  const deadline = mfaDeadline(user, { passkeyCounts: !syncClient });
  return { token, user: publicUser(user), mfaPending, mfaMethods: mfaPending ? mfaMethods(user, { syncClient }) : undefined, mfaSetupRequired: mfaRequiredForRole && !user.mfa_enabled && !passkeyStep, mfaSetupDeadline: deadline };
}
/**
 * Whether a sign-in that proved only one factor (a password, or single sign-on whose provider did not assert
 * multi-factor) owes the fingerprint as its second step because the account's passkey is what counts as its
 * enrolment (mfaDeadline): passkey sign-in allowed, the account has a usable passkey, and it is not a device's sync
 * sign-in (which cannot give one). The caller adds the role check (mfaRequiredRoles).
 */
function passkeyStepOwed(user, { syncClient = false } = {}) {
  return !syncClient && policy().passkeySignin && passkeyCount(user.id) > 0;
}
/** The ways this account may finish the second step of signing in: 'totp', 'passkey' (never on a device's sync sign-in). */
function mfaMethods(user, { syncClient = false } = {}) {
  const out = [];
  if (user.mfa_enabled) out.push('totp');
  if (!syncClient && policy().passkeySignin && passkeyCount(user.id) > 0) out.push('passkey');
  return out;
}
// What a device is told when its owner's only second factor is a passkey, past the enrolment deadline of a role that
// requires two-step verification: a device cannot use a passkey (docs/FINGERPRINT.md).
const DEVICE_NEEDS_AUTHENTICATOR = 'Fingerprint sign-in does not work for syncing a device, and your role requires two-step verification. Add an authenticator app under My profile to sync this device, then sync again.';

function verifyMfa(ctx, code) {
  if (!ctx.session) throw unauthorized();
  const user = db.one(`SELECT * FROM users WHERE id=?`, ctx.user.id);
  // A wrong code is a failed factor like a wrong password: it counts toward the same account lockout, and a
  // locked account cannot finish signing in with the right code either (the lockout is the account's, not
  // the password step's).
  if (isLocked(user)) {
    audit.log({ user, action: 'auth.mfa.failed', ip: ctx.ip, success: false, details: { reason: 'locked' } });
    throw new HttpError(423, 'Account locked after too many failed attempts. Try again later or contact an administrator.');
  }
  const r = user.mfa_secret_enc ? useTotp(user.id, user.mfa_secret_enc, code) : 'wrong';
  if (r !== 'ok') {
    const locked = recordPasswordFailure(user);
    audit.log({ user, action: 'auth.mfa.failed', ip: ctx.ip, success: false, details: r === 'replay' ? { reason: 'replay', ...(locked ? { locked: true } : {}) } : locked ? { reason: 'locked after failures' } : undefined });
    throw unauthorized(r === 'replay' ? 'That code has already been used. Wait for the next code from your authenticator app.' : 'Invalid verification code');
  }
  clearFailures(user.id);
  db.run(`UPDATE sessions SET mfa_pending=0, reauth_at=?, reauth_method='totp' WHERE id=?`, db.now(), ctx.session.id);
  audit.log({ user, action: 'auth.login', ip: ctx.ip, details: { mfa: true } });
  return publicUser(user);
}

function publicUser(u) {
  const eff = effectivePerms(u);
  return { id: u.id, username: u.username, display_name: u.display_name, email: u.email, title: u.title, role: u.role,
    mfa_enabled: !!u.mfa_enabled, must_change_password: !!u.must_change_password, permissions: eff.allow,
    denied_permissions: eff.deny,
    mfa_required: policy().mfaRequiredRoles.includes(u.role), mfa_setup_deadline: mfaDeadline(u), caseload_restricted: caseloadRestricted(u),
    // How many passkeys (fingerprint sign-in, docs/FINGERPRINT.md) the account has; 0 on a device. passkey_mfa: whether
    // they count as its two-step verification, which they do only while fingerprint sign-in is allowed (mfaDeadline).
    passkeys: passkeyCount(u.id), passkey_mfa: policy().passkeySignin && passkeyCount(u.id) > 0 };
}

function passwordPolicy(pw) {
  const errors = [];
  if (typeof pw !== 'string' || pw.length < config.password.minLength) errors.push(`at least ${config.password.minLength} characters`);
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) errors.push('upper and lower case letters');
  if (!/[0-9]/.test(pw)) errors.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push('a symbol');
  return errors;
}

module.exports = { auditUsername, policy, PERMS, WIDENED_1_16, asBefore1_16, hasPerm, rolePerms, effectivePerms, activeAssignment, requirePerm, requireAuth, mfaDeadline, canAccessClient, assertClientAccess, caseloadFilter, caseloadRestricted, reportRunAllowed, submissionRunAllowed,
  createSession, passkeyStepOwed, markReauth, noteSsoProof, takeSsoProof, reauthStatus, verifySigner, verifyApprover, passkeyCount, mfaMethods, hasLocalPassword, clearReauth, confirmPassword, confirmCode, useTotp, isLocked, recordPasswordFailure, clearFailures, cookieHeader, revokeSession, revokeAllForUser, resolveSession, login, verifyMfa, publicUser, passwordPolicy, COOKIE };
