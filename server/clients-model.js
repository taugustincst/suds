'use strict';
const db = require('./db');
const { encrypt, decrypt, blindIndex, uuid } = require('./crypto');

// goals and flags are clinical narrative about a named person: encrypted like every other PHI field.
const ENC_FIELDS = ['first_name', 'last_name', 'preferred_name', 'dob', 'phone', 'alt_phone', 'email', 'address', 'medicaid_id', 'emergency_contact', 'goals', 'flags'];
const PLAIN_FIELDS = ['city', 'zip', 'gender', 'pronouns', 'race_ethnicity', 'preferred_language', 'veteran', 'housing_status', 'insurance', 'status', 'intake_date',
  'discharge_date', 'discharge_reason', 'referral_source', 'primary_substance', 'secondary_substances', 'route_of_use', 'asam_level', 'mat_status', 'mat_medication',
  'overdose_history', 'last_overdose_date', 'naloxone_provided', 'naloxone_last_date', 'risk_level', 'justice_involved', 'pregnant_or_parenting', 'co_occurring_mh',
  'race_codes', 'contact_preferences', 'ok_to_text', 'ok_to_voicemail'];

function decryptRow(row, { deidentify = false } = {}) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_enc')) {
      const plain = k.slice(0, -4);
      if (deidentify) continue;
      out[plain] = v ? decrypt(v) : null;
    } else if (k.endsWith('_idx')) continue;
    else out[k] = v;
  }
  if (deidentify) { out.display_name = row.client_code; }
  else out.display_name = `${out.last_name || ''}, ${out.first_name || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
  return out;
}

function encryptFields(v) {
  const cols = {}; 
  for (const f of ENC_FIELDS) if (v[f] !== undefined) cols[`${f}_enc`] = v[f] === null ? null : encrypt(v[f]);
  if (v.last_name !== undefined) cols.last_name_idx = blindIndex(v.last_name);
  if (v.first_name !== undefined || v.last_name !== undefined) cols.full_name_idx = undefined; // computed by caller with full row
  if (v.last_name !== undefined) { cols.name_prefix_idx = namePrefixIndex(v.last_name); cols.name_phonetic_idx = namePhoneticIndex(v.last_name); }
  if (v.dob !== undefined) cols.dob_idx = blindIndex(v.dob);
  if (v.phone !== undefined) cols.phone_idx = blindIndex(String(v.phone || '').replace(/\D/g, ''));
  return cols;
}

// Soundex (the classic 1918 algorithm): "Nguyen" and "Nguyan" share a code, so a misspelling still finds
// the person. Used only as a blind-index input, never stored or displayed in the clear.
function soundex(name) {
  const s = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const code = (c) => ({ B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 }[c] || 0);
  let out = s[0]; let prev = code(s[0]);
  for (const ch of s.slice(1)) {
    const c = code(ch);
    if (c && c !== prev) out += c;
    if (ch !== 'H' && ch !== 'W') prev = c; // H and W do not break a run of the same code
    if (out.length === 4) break;
  }
  return (out + '000').slice(0, 4);
}

const normaliseName = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
/** HMAC of the first three letters of a surname — lets "Ngu" find "Nguyen" without storing either. */
function namePrefixIndex(lastName) { const n = normaliseName(lastName); return n.length >= 2 ? blindIndex('pfx:' + n.slice(0, 3)) : null; }
/** HMAC of a surname's Soundex code — lets a misspelling still find the person. */
function namePhoneticIndex(lastName) { const c = soundex(normaliseName(lastName)); return c ? blindIndex('snd:' + c) : null; }

function nextClientCode() {
  const year = new Date().getFullYear();
  // Clients created on a device (local mode) get an M prefix so codes never collide with the office server's C codes.
  const prefix = `${require('./config').local ? 'M' : 'C'}${String(year).slice(2)}-`;
  const last = db.one(`SELECT client_code FROM clients WHERE client_code LIKE ? ORDER BY client_code DESC LIMIT 1`, prefix + '%');
  const n = last ? Number(last.client_code.slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

function summary(row, opts) {
  const d = decryptRow(row, opts);
  const keep = ['id', 'client_code', 'display_name', 'first_name', 'last_name', 'preferred_name', 'dob', 'phone', 'status', 'risk_level', 'primary_substance', 'mat_status', 'intake_date', 'city', 'flags', 'ok_to_text', 'ok_to_voicemail', 'updated_at'];
  const o = {}; for (const k of keep) if (d[k] !== undefined) o[k] = d[k];
  return o;
}

module.exports = { ENC_FIELDS, PLAIN_FIELDS, decryptRow, encryptFields, nextClientCode, summary, uuid, soundex, namePrefixIndex, namePhoneticIndex, normaliseName };
