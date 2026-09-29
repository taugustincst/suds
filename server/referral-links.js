'use strict';
// Secure referral links (1.17.0): a referral to an organisation that does not use SUDS, sent as a one-time
// link the recipient opens in a browser without an account, served by the office server. Threat model and
// operating rules: docs/security/REFERRAL-LINKS.md.
//
// Two kinds:
//   packet          names the client. Only with a live Part 2 consent that names the recipient: the disclosure
//                   gate (server/disclosure.js requireBasis, basis 'consent' only) runs when the link is made
//                   and again when it is opened, and the disclosure is accounted when the recipient first opens
//                   it — that is when the information leaves — under the worker who made the link. The packet
//                   is minimal (name, the reason for the referral, urgency; phone and date of birth only when
//                   the worker ticks them) and is a snapshot, encrypted (packet_enc). It needs an access code
//                   given to the recipient separately (by phone), and is claimed by the first browser that opens
//                   it: another browser holding the same link (a forwarded email) is refused, and that refusal
//                   is audited as a possible forward.
//   contact_notice  names nobody: "a programme would like to talk to you about a referral; quote reference R-…".
//                   The only thing that can go without a consent. No free text (a worker's words could name the
//                   person), no accounting (nothing identifying is disclosed), no access code.
//
// Tokens are 256-bit random, carried in the URL's fragment (never sent to a server, never in a log or a
// Referer), posted in a request body, and stored only as SHA-256 hashes; the access code and the claim secret
// likewise. A link expires (24 hours to 7 days), can be revoked, and locks after MAX_FAILED wrong codes. Every
// open, refusal and acknowledgement is audited without PHI. Office server only (not in LOCAL_ROUTE_MODULES).
const db = require('./db');
const audit = require('./audit');
const disclosure = require('./disclosure');
const { encrypt, decrypt, uuid, randomToken, sha256 } = require('./crypto');
const { badRequest, notFound, forbidden, HttpError } = require('./http');

const KINDS = ['packet', 'contact_notice'];
const TTL_HOURS = [24, 72, 168];
const DEFAULT_TTL_HOURS = 72;
const MAX_FAILED = 5;
const ACK_STATUSES = ['received', 'accepted', 'scheduled', 'declined', 'unable_to_reach'];
// One message for every link that cannot be opened — unknown, expired, revoked or locked — so the answer is
// not an oracle for which tokens exist.
const NOT_VALID = 'This link is not valid. It may have expired or been withdrawn. Contact the program that sent it.';

// Referral statuses after which the referral is over: a link made for it is not opened any more.
const CLOSED_REFERRAL = ['declined_by_client', 'declined_by_provider', 'no_show', 'completed', 'closed'];
// The programme setting "Secure referral links" (off unless an administrator turns it on: docs/security/REFERRAL-LINKS.md).
const SETTING = 'referral_links_enabled';
const enabled = () => db.getSetting(SETTING, '0') === '1';

const hashToken = (t) => sha256(`referral-link:${t}`);
const hashCode = (id, code) => sha256(`referral-link-code:${id}:${String(code || '').replace(/\D/g, '')}`);
const hashClaim = (id, claim) => sha256(`referral-link-claim:${id}:${claim}`);
/** Six digits, read out over the phone. With MAX_FAILED tries a guess succeeds 5 times in a million. */
function newCode() { const n = require('node:crypto').randomInt(0, 1000000); return String(n).padStart(6, '0'); }
/** A short reference both sides can quote on the phone; random, so it says nothing about the client. */
function newReference() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = require('node:crypto').randomBytes(6); return 'R-' + [...b].map(x => A[x % A.length]).join(''); }
const dec = (v) => { if (!v) return null; try { return decrypt(v); } catch { return null; } };

function resourceOf(resourceId) { return db.one(`SELECT id, name, organization FROM resources WHERE id=?`, resourceId); }
function resourceNames(r) { return r ? [r.name, r.organization].filter(Boolean) : []; }

/** The invitation shown on every link: where an organisation learns about receiving referrals through SUDS. */
function invite() {
  const url = db.getSetting('referral_invite_url', null);
  return { url: url && /^https:\/\//i.test(url) ? url : null, contact: db.getSetting('program_contact', null) || null, programme: db.getSetting('org_name', null) || 'The referring program' };
}

/** What the office shows for a link (never its token, code or packet). */
function present(l) {
  const now = new Date().toISOString();
  const status = l.revoked_at ? 'revoked' : l.failed_attempts >= MAX_FAILED ? 'locked' : l.expires_at < now && !l.opened_at ? 'expired' : l.ack_status ? 'acknowledged' : l.opened_at ? 'opened' : l.expires_at < now ? 'expired' : 'sent';
  return { id: l.id, referral_id: l.referral_id, client_id: l.client_id, resource_id: l.resource_id, kind: l.kind, reference: l.reference, expires_at: l.expires_at, status,
    opened_at: l.opened_at, open_count: l.open_count, failed_attempts: l.failed_attempts, ack_status: l.ack_status, ack_at: l.ack_at, ack_by: dec(l.ack_by_enc), ack_note: dec(l.ack_note_enc),
    revoked_at: l.revoked_at, created_at: l.created_at, created_by_name: l.created_by_name || null, accounted: !!l.disclosure_id };
}

function listFor(referralId) {
  return db.all(`SELECT l.*, u.display_name AS created_by_name FROM referral_links l JOIN users u ON u.id=l.created_by WHERE l.referral_id=? ORDER BY l.created_at DESC`, referralId).map(present);
}

/**
 * Make a link for a referral. `v`: kind, consent_id, message, include_phone, include_dob, expires_hours,
 * restriction_reviewed. A packet passes the disclosure gate now (and again at open). Returns the token and
 * code once; only their hashes are kept.
 */
function create({ referral, user, ip, v }) {
  const kind = v.kind;
  if (!enabled()) throw new HttpError(409, 'Secure referral links are switched off for this program. An administrator can switch them on in Privacy & Part 2 once counsel has reviewed them.', { referral_links_off: true });
  if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  const hours = v.expires_hours === undefined || v.expires_hours === null ? DEFAULT_TTL_HOURS : Number(v.expires_hours);
  if (!TTL_HOURS.includes(hours)) throw badRequest(`A link lasts ${TTL_HOURS.join(', ')} hours (7 days at most)`);
  const res = resourceOf(referral.resource_id);
  if (!res) throw badRequest('The referral\'s provider is not in the directory');
  const id = uuid(); const token = randomToken(32); const reference = newReference();
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  let code = null; let packet = null; let consentId = null;
  if (kind === 'packet') {
    // The client's consent must name this provider (or its organisation), carry the §2.31 elements and be live.
    // Only consent: a medical emergency or a court order is not something to send as a link to be opened later.
    const basis = disclosure.requireBasis(referral.client_id, { basis: 'consent', consent_id: v.consent_id || referral.consent_id, recipient: resourceNames(res), allowed: ['consent'],
      restriction_reviewed: v.restriction_reviewed, user });
    consentId = basis.consent.id;
    const c = db.one(`SELECT first_name_enc, last_name_enc, preferred_name_enc, dob_enc, phone_enc FROM clients WHERE id=?`, referral.client_id);
    const message = String(v.message || '').trim().slice(0, 1000);
    packet = {
      client: { name: [dec(c.first_name_enc), dec(c.last_name_enc)].filter(Boolean).join(' '), preferred_name: dec(c.preferred_name_enc) || undefined,
        dob: v.include_dob ? dec(c.dob_enc) || undefined : undefined, phone: v.include_phone ? dec(c.phone_enc) || undefined : undefined },
      reason: message || null, urgency: referral.urgency || 'routine', referred_at: referral.referred_at,
      referred_by: user.display_name || user.username, recipient: res.name,
    };
    code = newCode();
    // The recipient as the directory named it now, kept with the packet: the consent is checked against these
    // names again at open, and the accounting names this recipient, whatever the entry is called by then
    // (security review of 1.17.0, L2). Not shown to the recipient.
    packet = { packet, recipient_names: resourceNames(res) };
  }
  db.run(`INSERT INTO referral_links(id,referral_id,client_id,resource_id,kind,token_hash,code_hash,consent_id,packet_enc,reference,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, referral.id, referral.client_id, referral.resource_id, kind, hashToken(token), code ? hashCode(id, code) : null, consentId, packet ? encrypt(JSON.stringify(packet)) : null, reference, expires, user.id);
  audit.log({ user, action: 'referral_link.create', entity: 'referral_link', entityId: id, clientId: referral.client_id, ip,
    details: { kind, referral_id: referral.id, consent_id: consentId || undefined, expires_hours: hours, phone: kind === 'packet' ? !!v.include_phone : undefined, dob: kind === 'packet' ? !!v.include_dob : undefined } });
  return { id, kind, reference, expires_at: expires, token, code, path: `/referral-link.html#${token}` };
}

function revoke({ link, user, ip }) {
  if (link.revoked_at) return present(link);
  db.run(`UPDATE referral_links SET revoked_at=?, revoked_by=?, updated_at=? WHERE id=?`, db.now(), user.id, db.now(), link.id);
  audit.log({ user, action: 'referral_link.revoke', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, details: { kind: link.kind, opened: !!link.opened_at } });
  return present(db.one(`SELECT * FROM referral_links WHERE id=?`, link.id));
}

/**
 * Refusals of anonymous callers, in the audit log without letting anyone who can reach the office grow it without
 * limit (security review of 1.17.0, L3): per link (or, for tokens that match no link, for all of them together)
 * the first REFUSALS_LOGGED_PER_HOUR in an hour are written one by one, then one entry saying the rest are being
 * counted, and when the hour is over one summary with the count and the addresses they came from (the busiest
 * twenty). The summary is written by the next refusal after the hour, or by flushRefusals when the server stops.
 */
const REFUSALS_LOGGED_PER_HOUR = 10;
const REFUSAL_WINDOW_MS = 3600_000;
const refusals = new Map(); // key -> { start, logged, extra, byIp: Map, action, linkId, clientId }
function summarise(key, w) {
  if (!w.extra) return;
  const addresses = [...w.byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([ip, n]) => ({ ip, n }));
  audit.log({ user: null, action: w.action, entity: 'referral_link', entityId: w.linkId, clientId: w.clientId, ip: null, success: false,
    details: { reason: key === 'unknown' ? 'unknown_summary' : 'refused_summary', count: w.extra, window_start: new Date(w.start).toISOString(), window_end: new Date(Math.min(Date.now(), w.start + REFUSAL_WINDOW_MS)).toISOString(), addresses } });
}
function flushRefusals() { for (const [key, w] of refusals) summarise(key, w); refusals.clear(); }
function logRefusal({ action, link, ip, reason }) {
  const key = link ? link.id : 'unknown';
  const now = Date.now();
  let w = refusals.get(key);
  if (w && now - w.start >= REFUSAL_WINDOW_MS) { summarise(key, w); refusals.delete(key); w = null; }
  if (!w) { w = { start: now, logged: 0, extra: 0, byIp: new Map(), action, linkId: link ? link.id : null, clientId: link ? link.client_id : null }; refusals.set(key, w); }
  if (w.logged < REFUSALS_LOGGED_PER_HOUR) {
    w.logged++;
    audit.log({ user: null, action, entity: 'referral_link', entityId: w.linkId, clientId: w.clientId, ip, success: false, details: { reason } });
    if (w.logged === REFUSALS_LOGGED_PER_HOUR) audit.log({ user: null, action, entity: 'referral_link', entityId: w.linkId, clientId: w.clientId, ip, success: false, details: { reason: 'counting', note: 'further refusals this hour are counted and summarised, not written one by one' } });
    return;
  }
  w.extra++; w.byIp.set(ip || '?', (w.byIp.get(ip || '?') || 0) + 1);
  if (refusals.size > 5000) flushRefusals();
}

/** A link a recipient may still use, or a 404 with the one message. Audits the refusal (reason code only). */
function usable(token, ip, action) {
  const t = String(token || '');
  const link = /^[A-Za-z0-9_-]{40,64}$/.test(t) ? db.one(`SELECT * FROM referral_links WHERE token_hash=?`, hashToken(t)) : null;
  const refuse = (reason) => { logRefusal({ action, link, ip, reason }); throw notFound(NOT_VALID); };
  // Switched off: every link stops working at once (the setting is also the way to stop them all).
  if (!enabled()) refuse(link ? 'switched_off' : 'unknown');
  if (!link) refuse('unknown');
  if (link.revoked_at) refuse('revoked');
  if (link.failed_attempts >= MAX_FAILED) refuse('locked');
  // An unopened link expires; an opened one stays readable to the browser that claimed it until it expires too.
  if (link.expires_at < new Date().toISOString()) refuse('expired');
  return link;
}

/** What was stored with a packet: the packet itself and the recipient's names when the link was made. */
function stored(link) {
  if (!link.packet_enc) return { packet: null, names: null };
  const s = JSON.parse(decrypt(link.packet_enc));
  return s && s.packet ? { packet: s.packet, names: Array.isArray(s.recipient_names) ? s.recipient_names : null } : { packet: s, names: null };
}
function header(link) {
  const res = resourceOf(link.resource_id) || {};
  const snap = link.kind === 'packet' ? stored(link).names : null;
  return { kind: link.kind, reference: link.reference, expires_at: link.expires_at, recipient: (snap && snap[0]) || res.name || null, programme: invite().programme, contact: invite().contact,
    invite: invite(), ack_status: link.ack_status, ack_statuses: link.kind === 'packet' ? ACK_STATUSES : ['received', 'unable_to_reach'] };
}

/**
 * The consent this packet rests on, checked again now: a consent revoked or expired since the link was made,
 * a restriction agreed since, or a consent that no longer names the provider withholds the packet.
 */
function stillCovered(link, creator) {
  // The record is still there and still this person's, and the referral is still open (security review of
  // 1.17.0, L2): a removed or merged record, or a referral since closed or declined, is not disclosed.
  const client = db.one(`SELECT deleted_at, merged_into FROM clients WHERE id=?`, link.client_id);
  if (!client || client.deleted_at || client.merged_into) return { ok: false, reason: 'client_removed' };
  const referral = db.one(`SELECT status FROM referrals WHERE id=?`, link.referral_id);
  if (!referral || CLOSED_REFERRAL.includes(referral.status)) return { ok: false, reason: 'referral_closed' };
  // The recipient as named when the link was made (a link from before the snapshot: the directory entry now).
  const snap = stored(link).names;
  const live = resourceOf(link.resource_id);
  const res = snap && snap.length ? { name: snap[0], names: snap } : live && { name: live.name, names: resourceNames(live) };
  if (!res) return { ok: false, reason: 'recipient_not_covered' };
  const restrictedSince = db.one(`SELECT 1 FROM patient_requests WHERE client_id=? AND kind='restriction' AND status='fulfilled' AND updated_at > ?`, link.client_id, link.created_at);
  if (restrictedSince) return { ok: false, reason: 'restriction' };
  try {
    const basis = disclosure.requireBasis(link.client_id, { basis: 'consent', consent_id: link.consent_id, recipient: res.names, allowed: ['consent'], restriction_reviewed: true, user: creator });
    return { ok: true, basis, res };
  } catch (e) { return { ok: false, reason: e && e.extra && e.extra.recipientNotCovered ? 'recipient_not_covered' : 'consent_not_valid' }; }
}

/**
 * The recipient opens the link. `code` the first time (a packet), `claim` afterwards. Returns what the page
 * shows; a first successful open of a packet returns a claim secret the page keeps for this browser session.
 */
function open({ token, code, claim, ip }) {
  const link = usable(token, ip, 'referral_link.open');
  const base = header(link);
  const bump = (extra = {}) => db.run(`UPDATE referral_links SET open_count=open_count+1, opened_at=COALESCE(opened_at, ?), updated_at=? ${extra.sql || ''} WHERE id=?`, db.now(), db.now(), ...(extra.params || []), link.id);
  if (link.kind === 'contact_notice') {
    bump();
    audit.log({ user: null, action: 'referral_link.open', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, details: { kind: link.kind, first: !link.opened_at } });
    return { ...base };
  }
  // A packet: claimed by the first browser that proves the code; any other is refused (a forwarded link).
  if (link.claim_hash) {
    if (!claim || hashClaim(link.id, claim) !== link.claim_hash) {
      audit.log({ user: null, action: 'referral_link.open', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, success: false, details: { reason: 'claimed_elsewhere' } });
      throw new HttpError(409, 'This referral has already been opened on another device or browser. If that was not you, contact the program that sent it: they can withdraw it and send a new one.', { claimed: true });
    }
  } else {
    if (!code) return { ...base, code_required: true };
    if (hashCode(link.id, code) !== link.code_hash) {
      db.run(`UPDATE referral_links SET failed_attempts=failed_attempts+1, updated_at=? WHERE id=?`, db.now(), link.id);
      const left = MAX_FAILED - (link.failed_attempts + 1);
      audit.log({ user: null, action: 'referral_link.open', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, success: false, details: { reason: 'wrong_code', attempts: link.failed_attempts + 1 } });
      if (left <= 0) throw notFound(NOT_VALID);
      throw new HttpError(401, `That access code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left before the link is locked.`, { code_required: true, tries_left: left });
    }
  }
  const creator = db.one(`SELECT * FROM users WHERE id=?`, link.created_by);
  const cover = stillCovered(link, creator);
  if (!cover.ok) {
    // The consent no longer covers it: the packet is withheld and the page shows the contact notice instead.
    bump();
    audit.log({ user: null, action: 'referral_link.open', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, success: false, details: { reason: cover.reason, withheld: true } });
    return { ...base, withheld: true };
  }
  const packet = stored(link).packet;
  let newClaim = null;
  db.transaction(() => {
    if (!link.claim_hash) {
      newClaim = randomToken(32);
      // First open: the information leaves now, so it is accounted now, as the worker's disclosure.
      const parts = ['name', packet.client.preferred_name ? 'preferred name' : null, packet.client.dob ? 'date of birth' : null, packet.client.phone ? 'phone' : null, packet.reason ? 'reason for referral' : null, 'urgency'].filter(Boolean);
      const did = disclosure.record({ clientId: link.client_id, consentId: cover.basis.consent.id, recipient: cover.res.name, purpose: 'Referral for services',
        what: `Secure referral link ${link.reference}: ${parts.join(', ')}`, method: 'secure referral link', basis: 'consent', source: 'referral_link', sourceRef: link.id, user: creator, ip });
      bump({ sql: ', claim_hash=?, disclosure_id=?', params: [hashClaim(link.id, newClaim), did] });
    } else bump();
  });
  audit.log({ user: null, action: 'referral_link.open', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, details: { kind: link.kind, first: !link.claim_hash } });
  return { ...base, packet, notice: disclosure.notice().text, claim: newClaim || undefined };
}

/** The recipient says what happened. Closes the loop: the worker who made the link gets a to-do to confirm it. */
function acknowledge({ token, claim, status, by, note, ip }) {
  const link = usable(token, ip, 'referral_link.ack');
  if (!(link.kind === 'packet' ? ACK_STATUSES : ['received', 'unable_to_reach']).includes(status)) throw badRequest('Choose what happened');
  if (link.kind === 'packet' && (!link.claim_hash || !claim || hashClaim(link.id, claim) !== link.claim_hash)) {
    audit.log({ user: null, action: 'referral_link.ack', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, success: false, details: { reason: 'not_claimed' } });
    throw forbidden('Open the referral with its access code first.');
  }
  if (link.kind === 'contact_notice' && !link.opened_at) throw forbidden('Open the link first.');
  const who = String(by || '').trim().slice(0, 120); const text = link.kind === 'packet' ? String(note || '').trim().slice(0, 1000) : '';
  if (!who) throw badRequest('Say who is acknowledging (your name and organisation)', { fields: { by: 'required' } });
  const res = resourceOf(link.resource_id) || { name: 'the provider' };
  db.transaction(() => {
    db.run(`UPDATE referral_links SET ack_status=?, ack_at=?, ack_by_enc=?, ack_note_enc=?, updated_at=? WHERE id=?`, status, db.now(), encrypt(who), text ? encrypt(text) : null, db.now(), link.id);
    const label = { received: 'received it', accepted: 'accepted the client', scheduled: 'scheduled the client', declined: 'declined', unable_to_reach: 'could not reach the client' }[status];
    const title = encrypt(`${res.name} ${label} (secure referral link ${link.reference}) — confirm and record the outcome`);
    const priority = status === 'declined' || status === 'unable_to_reach' ? 'high' : 'normal';
    // One to-do per link, saying what the recipient said last: a recipient answering again (or anyone holding a
    // forwarded notice link) updates it rather than filling the worker's list (security review of 1.17.0, L3).
    const mark = `(secure referral link ${link.reference})`;
    const open = db.all(`SELECT id, title_enc FROM tasks WHERE referral_id=? AND assigned_to=? AND created_by=? AND status IN ('open','in_progress')`, link.referral_id, link.created_by, link.created_by)
      .find(t => (dec(t.title_enc) || '').includes(mark));
    if (open) db.run(`UPDATE tasks SET title_enc=?, priority=?, due_at=?, updated_at=? WHERE id=?`, title, priority, new Date().toISOString().slice(0, 10), db.now(), open.id);
    else db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,priority,referral_id) VALUES(?,?,?,?,?,?,?,?)`, uuid(), link.client_id, link.created_by, link.created_by,
      title, new Date().toISOString().slice(0, 10), priority, link.referral_id);
  });
  audit.log({ user: null, action: 'referral_link.ack', entity: 'referral_link', entityId: link.id, clientId: link.client_id, ip, details: { status, kind: link.kind } });
  return { ok: true, ack_status: status };
}

module.exports = { SETTING, enabled, CLOSED_REFERRAL, REFUSALS_LOGGED_PER_HOUR, flushRefusals, KINDS, TTL_HOURS, DEFAULT_TTL_HOURS, MAX_FAILED, ACK_STATUSES, NOT_VALID, create, revoke, open, acknowledge, listFor, present, invite, hashToken };
