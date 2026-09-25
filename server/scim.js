'use strict';
// SCIM 2.0 user provisioning (RFC 7643 / RFC 7644) — just enough for a county identity provider (Entra ID,
// Okta) to create, update and deactivate SUDS accounts: the User resource, GET/POST/PUT/PATCH/DELETE on
// /scim/v2/Users, `filter=userName eq "…"` (and externalId), and active=false as deactivation. No Groups
// endpoint: group membership arrives as the user's `roles` or `groups` values and is mapped to a SUDS role
// through the scim_group_roles setting ("County-SUD-Navigators=navigator; County-SUD-Admins=admin"), the
// most privileged match winning; an unmapped user gets scim_default_role (readonly unless set).
//
// What SCIM may not do: sign anyone in (a provisioned account has no password; it signs in through OIDC,
// server/routes/oidc.js, which links it on first sign-in), touch an emergency (break-glass) account, or
// delete an account outright — the audit trail refers to it, so DELETE deactivates, like active=false.
// Every change is audited under the token's name. The HTTP side is server/routes/scim.js.
const db = require('./db');
const audit = require('./audit');
const { uuid } = require('./crypto');

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
// Most privileged first: when a person is in several mapped groups, the first role here that any of them
// maps to is the one they get.
const ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'];
// A provisioned account has no usable password: verifyPassword refuses anything that is not an scrypt hash.
const NO_PASSWORD = '!scim-provisioned-no-password';

class ScimError extends Error {
  constructor(status, detail, scimType) { super(detail); this.status = status; this.scimType = scimType; }
}
const errorBody = (status, detail, scimType) => ({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });

/** "Group=role; Other Group=role" (or one per line) → the same, validated and tidied. Throws on a bad role. */
function parseGroupRoles(text) {
  const out = [];
  for (const part of String(text || '').split(/[;\n]+/)) {
    const t = part.trim(); if (!t) continue;
    const i = t.lastIndexOf('=');
    if (i <= 0) throw Object.assign(new Error(`"${t}" is not Group=role`), { status: 400 });
    const group = t.slice(0, i).trim(); const role = t.slice(i + 1).trim().toLowerCase();
    if (!ROLES.includes(role)) throw Object.assign(new Error(`"${role}" is not a SUDS role (${ROLES.join(', ')})`), { status: 400 });
    if (group.length > 200) throw Object.assign(new Error('A group name is too long'), { status: 400 });
    out.push([group, role]);
  }
  return out;
}
function normaliseGroupRoles(text) {
  try { return parseGroupRoles(text).map(([g, r]) => `${g}=${r}`).join('; '); }
  catch (e) { const { badRequest } = require('./http'); throw badRequest(`scim_group_roles: ${e.message}`); }
}
function mappedRole(names) {
  let map = []; try { map = parseGroupRoles(db.getSetting('scim_group_roles', '')); } catch {}
  const lower = new Set(names.filter(Boolean).map((n) => String(n).toLowerCase()));
  const hits = map.filter(([g]) => lower.has(g.toLowerCase())).map(([, r]) => r);
  return ROLES.find((r) => hits.includes(r)) || null;
}
function defaultRole() { const r = db.getSetting('scim_default_role', 'readonly'); return ROLES.includes(r) ? r : 'readonly'; }
function emergencyAccounts() { return String(db.getSetting('sso_emergency_accounts', '') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); }

function toResource(u, base = '') {
  return {
    schemas: [USER_SCHEMA], id: u.id, ...(u.scim_external_id ? { externalId: u.scim_external_id } : {}),
    userName: u.username, displayName: u.display_name, name: { formatted: u.display_name },
    ...(u.title ? { title: u.title } : {}),
    emails: u.email ? [{ value: u.email, type: 'work', primary: true }] : [],
    active: !!u.is_active, roles: [{ value: u.role, primary: true }],
    meta: { resourceType: 'User', created: u.created_at, lastModified: u.updated_at, location: `${base}/scim/v2/Users/${u.id}` },
  };
}

const bool = (v) => (typeof v === 'boolean' ? v : typeof v === 'string' && /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : undefined);
const USERNAME_RE = /^[\w.@+'-]{1,120}$/;

/**
 * The attributes SUDS keeps, read from a SCIM User (a POST or PUT body, or a PATCH's value object).
 * Attributes SUDS does not keep (phone numbers, addresses, the enterprise extension) are ignored, as RFC 7644
 * allows a service provider to.
 */
function attrsFrom(body, { partial = false } = {}) {
  const a = {};
  if (!body || typeof body !== 'object') throw new ScimError(400, 'The request body must be a SCIM User', 'invalidSyntax');
  if (body.userName !== undefined) {
    if (typeof body.userName !== 'string' || !USERNAME_RE.test(body.userName.trim())) throw new ScimError(400, 'userName must be 1-120 letters, digits or . _ @ + \' -', 'invalidValue');
    a.username = body.userName.trim();
  } else if (!partial) throw new ScimError(400, 'userName is required', 'invalidValue');
  const n = body.name && typeof body.name === 'object' ? body.name : {};
  const display = [body.displayName, n.formatted, [n.givenName, n.familyName].filter(Boolean).join(' ')].find((x) => typeof x === 'string' && x.trim());
  if (display) a.display_name = display.trim().slice(0, 120);
  else if (!partial) a.display_name = a.username;
  if (body.title !== undefined) a.title = body.title === null ? null : String(body.title).slice(0, 120);
  if (body.emails !== undefined) {
    const list = Array.isArray(body.emails) ? body.emails : [];
    const e = list.find((x) => x && x.primary) || list.find((x) => x && x.type === 'work') || list[0];
    a.email = e && e.value ? String(e.value).slice(0, 200) : null;
  }
  if (body.externalId !== undefined) a.scim_external_id = body.externalId === null || body.externalId === '' ? null : String(body.externalId).slice(0, 200);
  if (body.active !== undefined) { const b = bool(body.active); if (b === undefined) throw new ScimError(400, 'active must be true or false', 'invalidValue'); a.active = b; }
  const names = [];
  for (const k of ['roles', 'groups']) if (Array.isArray(body[k])) for (const x of body[k]) if (x) names.push(typeof x === 'string' ? x : x.display, typeof x === 'string' ? null : x.value);
  if (names.length) { const r = mappedRole(names); if (r) a.role = r; }
  return a;
}

/** PATCH Operations → the same attribute set. Entra sends "Replace"/"Add" with a path; Okta a value object. */
function attrsFromPatch(body) {
  if (!body || !Array.isArray(body.Operations)) throw new ScimError(400, 'A PATCH needs Operations', 'invalidSyntax');
  const merged = {};
  for (const op of body.Operations) {
    const kind = String(op && op.op || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw new ScimError(400, `Unsupported PATCH op "${op && op.op}"`, 'invalidSyntax');
    const p = op.path ? String(op.path).trim() : '';
    if (!p) {
      if (kind === 'remove') throw new ScimError(400, 'remove needs a path', 'noTarget');
      Object.assign(merged, attrsFrom(op.value, { partial: true }));
      continue;
    }
    const key = p.toLowerCase();
    const v = kind === 'remove' ? null : op.value;
    const one = (attr) => Object.assign(merged, attrsFrom({ [attr]: v }, { partial: true }));
    if (key === 'active') { if (kind === 'remove') continue; one('active'); }
    else if (key === 'username') { if (kind !== 'remove') one('userName'); }
    else if (key === 'displayname' || key === 'name.formatted') { if (kind !== 'remove' && v) merged.display_name = String(v).trim().slice(0, 120); }
    else if (key === 'title') one('title');
    else if (key === 'externalid') one('externalId');
    else if (key === 'emails' || key.startsWith('emails[')) merged.email = kind === 'remove' ? null : (Array.isArray(v) ? attrsFrom({ emails: v }, { partial: true }).email : v && typeof v === 'object' ? String(v.value || '') || null : v ? String(v).slice(0, 200) : null);
    else if (key === 'roles' || key === 'groups') { if (kind !== 'remove') Object.assign(merged, attrsFrom({ [key]: Array.isArray(v) ? v : [v] }, { partial: true })); }
    // Anything else (phone numbers, name.givenName on its own, the enterprise extension) is not kept.
  }
  return merged;
}

/** { filter } → a WHERE clause, for the two filters identity providers use to find an existing account. */
function parseFilter(filter) {
  if (!filter) return null;
  const m = String(filter).trim().match(/^(userName|externalId|id)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
  if (!m) throw new ScimError(400, 'Only userName eq "…", externalId eq "…" and id eq "…" filters are supported', 'invalidFilter');
  const value = m[2].replace(/\\(.)/g, '$1');
  const col = { username: 'username', externalid: 'scim_external_id', id: 'id' }[m[1].toLowerCase()];
  return { sql: col === 'username' ? 'username = ? COLLATE NOCASE' : `${col} = ?`, value };
}

const LISTED = `access_status NOT IN ('pending','declined')`;
function list({ filter, startIndex = 1, count = 100 } = {}, base = '') {
  const f = parseFilter(filter);
  const where = f ? `${LISTED} AND ${f.sql}` : LISTED;
  const params = f ? [f.value] : [];
  const total = db.one(`SELECT COUNT(*) n FROM users WHERE ${where}`, ...params).n;
  const start = Math.max(1, Number(startIndex) || 1); const n = Math.min(200, Math.max(0, Number.isFinite(Number(count)) ? Number(count) : 100));
  const rows = n ? db.all(`SELECT * FROM users WHERE ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`, ...params, n, start - 1) : [];
  return { schemas: [LIST_SCHEMA], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map((u) => toResource(u, base)) };
}

function find(id) {
  const u = db.one(`SELECT * FROM users WHERE id=? AND ${LISTED}`, id);
  if (!u) throw new ScimError(404, `User ${id} not found`);
  return u;
}
function guard(u) {
  if (emergencyAccounts().includes(String(u.username).toLowerCase())) throw new ScimError(403, `${u.username} is an emergency (break-glass) account and is managed in SUDS, not by provisioning`, 'mutability');
}

/** Disable an account and everything that keeps it signed in: sessions now, devices on their next sync (wiped). */
function cutOff(userId) {
  require('./auth').revokeAllForUser(userId);
  return db.run(`UPDATE devices SET revoked_at=COALESCE(revoked_at, ?), wipe_requested_at=COALESCE(wipe_requested_at, ?) WHERE user_id=?`, db.now(), db.now(), userId).changes;
}

function create(body, actor, base) {
  const a = attrsFrom(body);
  if (db.one(`SELECT 1 FROM users WHERE username=? COLLATE NOCASE`, a.username)) throw new ScimError(409, `A user named ${a.username} already exists`, 'uniqueness');
  if (a.scim_external_id && db.one(`SELECT 1 FROM users WHERE scim_external_id=?`, a.scim_external_id)) throw new ScimError(409, 'A user with this externalId already exists', 'uniqueness');
  const id = uuid(); const now = db.now();
  const active = a.active !== false;
  const role = a.role || defaultRole();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,email,title,role,is_active,must_change_password,password_changed_at,scim_external_id,idp_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
    id, a.username, NO_PASSWORD, a.display_name, a.email || null, a.title || null, role, active ? 1 : 0, now, a.scim_external_id || null, active ? now : null, now, now);
  audit.log({ user: actor, action: 'scim.user.create', entity: 'user', entityId: id, details: { username: a.username, role, active, role_from: a.role ? 'group mapping' : 'default' } });
  return toResource(find(id), base);
}

/** Apply attributes to an existing user (PUT replaces what it names; PATCH what its operations name). */
function apply(id, a, actor, base, action) {
  const u = find(id); guard(u);
  if (a.username && a.username.toLowerCase() !== String(u.username).toLowerCase() && db.one(`SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id<>?`, a.username, id)) throw new ScimError(409, `A user named ${a.username} already exists`, 'uniqueness');
  if (a.scim_external_id && db.one(`SELECT 1 FROM users WHERE scim_external_id=? AND id<>?`, a.scim_external_id, id)) throw new ScimError(409, 'Another user has this externalId', 'uniqueness');
  const sets = []; const vals = []; const changed = [];
  const col = (c, v) => { if (v !== undefined && v !== u[c]) { sets.push(`${c}=?`); vals.push(v); changed.push(c); } };
  col('username', a.username); col('display_name', a.display_name); col('email', a.email); col('title', a.title); col('scim_external_id', a.scim_external_id); col('role', a.role);
  let deactivated = false; let reactivated = false;
  if (a.active === false && u.is_active) { sets.push('is_active=0'); changed.push('active'); deactivated = true; }
  if (a.active === true && !u.is_active) { sets.push(`is_active=1`, `access_status='active'`); changed.push('active'); reactivated = true; }
  // The provider still vouches for an active account whenever it updates it (server/deprovision.js).
  if (a.active !== false && (u.is_active || reactivated)) { sets.push('idp_seen_at=?'); vals.push(db.now()); }
  sets.push('updated_at=?'); vals.push(db.now());
  db.transaction(() => {
    db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...vals, id);
    if (deactivated) cutOff(id);
  });
  if (changed.length) audit.log({ user: actor, action: deactivated ? 'scim.user.deactivate' : action, entity: 'user', entityId: id, details: { username: a.username || u.username, changed, ...(a.role && a.role !== u.role ? { role: { from: u.role, to: a.role } } : {}), ...(reactivated ? { reactivated: true } : {}) } });
  return toResource(find(id), base);
}
function replace(id, body, actor, base) { return apply(id, attrsFrom(body), actor, base, 'scim.user.update'); }
function patch(id, body, actor, base) { return apply(id, attrsFromPatch(body), actor, base, 'scim.user.update'); }
function deactivate(id, actor) {
  const u = find(id); guard(u);
  if (u.is_active) {
    db.transaction(() => { db.run(`UPDATE users SET is_active=0, updated_at=? WHERE id=?`, db.now(), id); cutOff(id); });
    audit.log({ user: actor, action: 'scim.user.deactivate', entity: 'user', entityId: id, details: { username: u.username, via: 'DELETE' } });
  }
}

const serviceProviderConfig = () => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'docs/security/IDENTITY.md',
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A SCIM token created under Settings → Security status → Provisioning (SCIM)', primary: true }],
});

module.exports = { USER_SCHEMA, LIST_SCHEMA, ERROR_SCHEMA, PATCH_SCHEMA, ScimError, errorBody, parseGroupRoles, normaliseGroupRoles, mappedRole, toResource, attrsFrom, attrsFromPatch, parseFilter, list, find, create, replace, patch, deactivate, cutOff, serviceProviderConfig, NO_PASSWORD };
