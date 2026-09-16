'use strict';
const db = require('./db');
const { encrypt, decrypt, blindIndex, uuid } = require('./crypto');

const ENC_FIELDS = ['first_name', 'last_name', 'preferred_name', 'dob', 'phone', 'alt_phone', 'email', 'address', 'medicaid_id', 'emergency_contact'];
const PLAIN_FIELDS = ['city', 'zip', 'gender', 'pronouns', 'race_ethnicity', 'preferred_language', 'veteran', 'housing_status', 'insurance', 'status', 'intake_date',
  'discharge_date', 'discharge_reason', 'referral_source', 'primary_substance', 'secondary_substances', 'route_of_use', 'asam_level', 'mat_status', 'mat_medication',
  'overdose_history', 'last_overdose_date', 'naloxone_provided', 'naloxone_last_date', 'risk_level', 'justice_involved', 'pregnant_or_parenting', 'co_occurring_mh',
  'goals', 'flags', 'contact_preferences', 'ok_to_text', 'ok_to_voicemail'];

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
  if (v.dob !== undefined) cols.dob_idx = blindIndex(v.dob);
  if (v.phone !== undefined) cols.phone_idx = blindIndex(String(v.phone || '').replace(/\D/g, ''));
  return cols;
}

function nextClientCode() {
  const year = new Date().getFullYear();
  const prefix = `C${String(year).slice(2)}-`;
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

module.exports = { ENC_FIELDS, PLAIN_FIELDS, decryptRow, encryptFields, nextClientCode, summary, uuid };
