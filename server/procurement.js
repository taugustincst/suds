'use strict';
// "Security & procurement" (public/procurement.html, built for 1.24.0): the page an organization evaluating SUDS
// reaches from the sign-in page with no account. The facts only the maintainer can state (who to contact, the legal
// entity that signs a BAA/QSOA, the pricing stance, the support SLA) are never invented by SUDS: on an office server
// an administrator enters them under Settings → Program → Security & procurement page (these settings keys); on SUDS
// on this device the owner edits public/procurement.json. Blank, the page says "Not yet published by the maintainer".
//
// GET /api/procurement answers without a session, so it carries exactly these six values and nothing else: no
// program contact, no organization name, no version, no configuration.
const db = require('./db');

// Field of the public answer → its settings key.
const FIELDS = {
  legal_entity: 'procurement_legal_entity',
  contact_name: 'procurement_contact_name',
  contact_email: 'procurement_contact_email',
  contact_url: 'procurement_contact_url',
  pricing: 'procurement_pricing',
  sla: 'procurement_sla',
};
const SETTING_KEYS = Object.values(FIELDS);
// The longer texts (a pricing stance, an SLA summary) may run to a few paragraphs; the rest are one line.
const MAX_LEN = { procurement_pricing: 2000, procurement_sla: 2000 };
const maxLen = (k) => MAX_LEN[k] || 200;

/** The public answer: each field's text, or null where the administrator has published nothing. */
function publicInfo() {
  const out = {};
  for (const [field, key] of Object.entries(FIELDS)) { const v = db.getSetting(key, null); out[field] = v && String(v).trim() ? String(v) : null; }
  return out;
}

/** A value for one of the keys, checked; throws badRequest. '' clears it. Returns the value to store. */
function validate(key, v) {
  const { badRequest } = require('./http');
  v = String(v).replace(/\r\n/g, '\n').trim();
  if (v === '') return '';
  if (v.length > maxLen(key)) throw badRequest(`${key} must be at most ${maxLen(key)} characters`);
  // One-line fields carry no line breaks or control characters; the two texts keep their paragraphs.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) || (!MAX_LEN[key] && /\n/.test(v))) throw badRequest(`${key} must be plain text`);
  if (key === 'procurement_contact_email' && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) throw badRequest('procurement_contact_email must be an email address');
  if (key === 'procurement_contact_url') {
    let u; try { u = new URL(v); } catch { throw badRequest('procurement_contact_url must be a web address starting with https://'); }
    if (u.protocol !== 'https:' || u.username || u.password) throw badRequest('procurement_contact_url must be a web address starting with https://');
    v = u.href;
  }
  return v;
}

module.exports = { FIELDS, SETTING_KEYS, MAX_LEN, maxLen, publicInfo, validate };
