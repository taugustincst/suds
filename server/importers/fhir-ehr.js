'use strict';
// Patients and encounters from the host EHR, as FHIR R4 (1.17.0; docs/integration/EHR-PART2-LAYER.md).
//
// SUDS as the Part 2 layer beside an EHR (eClinicalWorks, Epic, SmartCare…) needs the people the EHR already
// knows and their visits, without anyone retyping them. Every certified EHR can export FHIR R4 — a Bundle, or the
// NDJSON files of a Bulk Data ($export) — so this reads Patient and Encounter resources and turns them into rows
// of the spreadsheet import (server/dataimport.js ENTITIES clients / interventions). They then go through exactly
// the same preview, validation, duplicate check, permissions and commit as a spreadsheet: nothing here writes.
//
// SUDS never connects to the EHR: an administrator exports the file there and uploads it here. An encounter names
// its patient by the EHR's id, which SUDS does not keep; it is matched to the SUDS client by the patient's name
// from the same file ("Last, First"), so import the patients first, from the same export.
const C = require('../constants');

const MAX_RESOURCES = 5000;

/** Resources from a Bundle, an array, one resource, or NDJSON text. */
function resourcesOf(input) {
  let v = input;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('{') && !t.includes('\n{')) { try { v = JSON.parse(t); } catch { throw new Error('The file is not valid JSON'); } }
    else if (t.startsWith('[')) { try { v = JSON.parse(t); } catch { throw new Error('The file is not valid JSON'); } }
    else v = t.split(/\r?\n/).filter(l => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`Line ${i + 1} is not valid JSON (NDJSON has one resource per line)`); } });
  }
  const out = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.resourceType === 'Bundle') { (x.entry || []).forEach(e => walk(e && e.resource)); return; }
    if (x.resourceType) out.push(x);
  };
  walk(v);
  if (out.length > MAX_RESOURCES) throw new Error(`At most ${MAX_RESOURCES} resources at a time; split the export`);
  return out;
}

const first = (a) => (Array.isArray(a) && a.length ? a[0] : null);
function officialName(p) {
  const names = Array.isArray(p.name) ? p.name : [];
  return names.find(n => n.use === 'official') || names.find(n => !n.use || n.use === 'usual') || names[0] || {};
}
function preferredName(p) {
  const n = (Array.isArray(p.name) ? p.name : []).find(x => x.use === 'nickname' || x.use === 'usual');
  const o = officialName(p);
  const g = n && first(n.given);
  return g && g !== first(o.given) ? g : '';
}
function telecom(p, system) {
  const t = (Array.isArray(p.telecom) ? p.telecom : []).filter(x => x.system === system && x.value);
  const pick = t.find(x => x.use === 'mobile') || t.find(x => x.use === 'home') || t[0];
  return pick ? String(pick.value) : '';
}
const GENDER = { female: 'female', male: 'male', other: 'other', unknown: '' };

/** A Patient as a row of the clients import (headers are the import's own field labels). */
function patientRow(p) {
  const n = officialName(p);
  const a = first(p.address) || {};
  const lang = first(p.communication);
  return {
    'First name': first(n.given) || '', 'Last name': n.family || '', 'Preferred name': preferredName(p), 'Date of birth': p.birthDate || '',
    Phone: telecom(p, 'phone'), Email: telecom(p, 'email'), Address: (a.line || []).join(', '), City: a.city || '', ZIP: a.postalCode || '',
    Gender: GENDER[p.gender] ?? '', Language: lang && lang.language ? (lang.language.text || (first(lang.language.coding) || {}).display || '') : '',
    Status: p.active === false ? 'inactive' : 'active',
  };
}

// What an encounter was, as the nearest SUDS visit type; anything else is "other", with the EHR's words kept in
// the summary. The import's own validation checks the result against the programme's list.
function visitType(e) {
  const text = [...(e.type || []).map(t => t.text || (first(t.coding) || {}).display || ''), (e.serviceType || {}).text || ''].join(' ').toLowerCase();
  const cls = (e.class && e.class.code) || '';
  if (cls === 'EMER' || /emergency/.test(text)) return 'hospital_or_ed_visit';
  const rules = [[/intake/, 'intake'], [/assess/, 'assessment'], [/screen|sbirt/, 'screening_sbirt'], [/case manag/, 'case_management'], [/care coord/, 'care_coordination'], [/peer/, 'peer_support'], [/crisis/, 'crisis_response'], [/discharge/, 'discharge_planning']];
  for (const [re, code] of rules) if (re.test(text) && C.INTERVENTION_TYPES.includes(code)) return code;
  return 'other';
}
function modality(e) {
  const cls = (e.class && e.class.code) || '';
  if (cls === 'VR') return 'video';
  const text = (e.type || []).map(t => t.text || '').join(' ').toLowerCase();
  if (/phone|telephone/.test(text)) return 'phone';
  return 'in_person';
}
function minutes(e) {
  if (e.length && Number.isFinite(Number(e.length.value))) { const v = Number(e.length.value); return String(Math.round(/^h/.test(e.length.unit || e.length.code || '') ? v * 60 : v)); }
  const s = Date.parse((e.period || {}).start || ''); const f = Date.parse((e.period || {}).end || '');
  return Number.isFinite(s) && Number.isFinite(f) && f > s ? String(Math.round((f - s) / 60000)) : '';
}

/** An Encounter as a row of the visits import; `patients` maps the EHR's Patient id to its row. */
function encounterRow(e, patients) {
  const ref = String((e.subject || e.patient || {}).reference || '');
  const pid = ref.replace(/^.*Patient\//, '');
  const p = patients.get(pid);
  const typeText = (e.type || []).map(t => t.text || (first(t.coding) || {}).display || '').filter(Boolean).join(', ');
  return {
    Client: p && p['Last name'] && p['First name'] ? `${p['Last name']}, ${p['First name']}` : '',
    Date: (e.period || {}).start || '', Type: visitType(e), Minutes: minutes(e), Modality: modality(e),
    Summary: `Imported from the EHR${typeText ? `: ${typeText}` : ''}${e.status ? ` (${e.status})` : ''}`,
    _missing_patient: !p,
  };
}

/**
 * The sheet the spreadsheet import previews, for one entity ('clients' from Patients, 'interventions' from
 * Encounters): { name, headers, rows, skipped } — skipped counts resources of other types and cancelled or
 * planned encounters (which did not happen).
 */
function toSheet(input, entity) {
  const all = resourcesOf(input);
  const patients = new Map(all.filter(r => r.resourceType === 'Patient').map(p => [String(p.id || ''), patientRow(p)]));
  if (entity === 'clients') {
    const rows = [...patients.values()];
    return { name: 'EHR patients', headers: Object.keys(rows[0] || patientRow({})), rows, skipped: all.length - rows.length };
  }
  if (entity === 'interventions') {
    const enc = all.filter(r => r.resourceType === 'Encounter' && !['planned', 'cancelled', 'entered-in-error'].includes(r.status));
    const rows = enc.map(e => encounterRow(e, patients));
    const missing = rows.filter(r => r._missing_patient).length;
    for (const r of rows) delete r._missing_patient;
    return { name: 'EHR encounters', headers: ['Client', 'Date', 'Type', 'Minutes', 'Modality', 'Summary'], rows, skipped: all.length - enc.length, missing_patient: missing };
  }
  throw new Error('entity must be clients or interventions');
}

module.exports = { resourcesOf, toSheet, patientRow, encounterRow, MAX_RESOURCES };
