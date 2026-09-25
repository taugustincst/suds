'use strict';
// Shared pieces of the read-only FHIR R4 API (server/routes/fhir.js): content types, OperationOutcome,
// security labels, the base URL, and search-parameter parsing. No database access here, so server/app.js
// can use sendError for any /fhir/ failure without pulling the rest of the FHIR code into the local kernel.
const config = require('../config');

const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const FHIR_NDJSON = 'application/fhir+ndjson';
const FHIR_VERSION = '4.0.1';

// SUDS's own code systems and identifier namespaces. urn:suds: rather than a web address, because every
// county runs its own server and there is no one SUDS domain to publish them under.
const SYS = {
  clientCode: 'urn:suds:client-code',
  medicaid: 'urn:suds:medicaid-id',
  interventionType: 'urn:suds:codesystem:intervention-type',
  callPurpose: 'urn:suds:codesystem:contact',
  consentType: 'urn:suds:codesystem:consent-type',
  resourceCategory: 'urn:suds:codesystem:resource-category',
  serviceTag: 'urn:suds:codesystem:service-tag',
  observation: 'urn:suds:codesystem:observation',
  noteFormat: 'urn:suds:codesystem:note-format',
  episode: 'urn:suds:codesystem:episode',
  confidentiality: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  actReason: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
};

// Every resource that identifies a client carries these: Restricted confidentiality, the 42 CFR Part 2
// policy, and the refrain "no redisclosure without consent directive" (HL7 Data Segmentation for Privacy).
const PART2_SECURITY = [
  { system: SYS.confidentiality, code: 'R', display: 'restricted' },
  { system: SYS.actCode, code: '42CFRPart2', display: '42 CFR Part2' },
  // NORDSCLCD, not NORDSLCD: the latter is retired in HL7 Terminology (the HL7 validator flags it).
  { system: SYS.actCode, code: 'NORDSCLCD', display: 'no redisclosure without consent directive' },
];

class FhirError extends Error {
  constructor(status, message, { code = 'processing', headers = {} } = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

function outcome(issues) {
  return { resourceType: 'OperationOutcome', issue: issues.map(i => ({ severity: i.severity || 'error', code: i.code || 'processing', diagnostics: i.diagnostics, ...(i.details ? { details: i.details } : {}) })) };
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': FHIR_JSON, 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const CODE_FOR_STATUS = { 400: 'invalid', 401: 'login', 403: 'forbidden', 404: 'not-found', 405: 'not-supported', 406: 'not-supported', 410: 'not-found', 413: 'too-costly', 429: 'throttled', 500: 'exception', 501: 'not-supported', 507: 'exception' };
/** Answer a failed /fhir/ request with an OperationOutcome (used by the FHIR routes and by server/app.js). */
function sendError(res, status, message, { code, headers = {} } = {}) {
  if (res.headersSent) { res.destroy(); return; }
  if (status === 401) headers = { 'WWW-Authenticate': 'Bearer realm="SUDS FHIR"', ...headers };
  send(res, status, outcome([{ severity: status >= 500 ? 'fatal' : 'error', code: code || CODE_FOR_STATUS[status] || 'processing', diagnostics: message }]), headers);
}

/** The absolute base of this FHIR server as the caller reached it (used for fullUrl, links and manifests). */
function baseUrl(ctx) {
  const clean = (s) => String(s || '').split(',')[0].trim().replace(/[^A-Za-z0-9.:\-[\]]/g, '');
  let proto = ctx.req?.socket?.encrypted ? 'https' : 'http';
  let host = clean(ctx.headers.host) || 'localhost';
  if (config.trustProxy) {
    const p = clean(ctx.headers['x-forwarded-proto']); if (p === 'https' || p === 'http') proto = p;
    const hh = clean(ctx.headers['x-forwarded-host']); if (hh) host = hh;
  }
  return `${proto}://${host}/fhir/R4`;
}

// ---- search parameters ----
const PREFIXES = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb'];
const DATE_RE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;
/**
 * A FHIR date search value ("ge2026-01-01", "2026-03", "lt2026-04-01T12:00:00Z") as SQL over an ISO text
 * column. A partial date means its whole range: date=2026-03 is every instant in March.
 */
function dateClause(col, raw) {
  let v = String(raw || '').trim(); let prefix = 'eq';
  if (PREFIXES.includes(v.slice(0, 2)) && /^\d/.test(v.slice(2))) { prefix = v.slice(0, 2); v = v.slice(2); }
  if (!DATE_RE.test(v)) throw new FhirError(400, `"${raw}" is not a FHIR date`, { code: 'invalid' });
  // Normalise to UTC ISO where a time was given; plain dates compare as text against ISO strings.
  let lo = v, hi;
  if (v.includes('T')) {
    const t = Date.parse(v.length === 16 ? v + ':00Z' : /Z|[+-]\d{2}:\d{2}$/.test(v) ? v : v + 'Z');
    if (Number.isNaN(t)) throw new FhirError(400, `"${raw}" is not a FHIR date`, { code: 'invalid' });
    lo = new Date(t).toISOString(); hi = new Date(t + 1000).toISOString();
  } else if (v.length === 4) hi = `${Number(v) + 1}`;
  else if (v.length === 7) { const [y, m] = v.split('-').map(Number); hi = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
  else { const d = new Date(v + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); hi = d.toISOString().slice(0, 10); }
  switch (prefix) {
    case 'eq': return { sql: `(${col} >= ? AND ${col} < ?)`, params: [lo, hi] };
    case 'ne': return { sql: `(${col} < ? OR ${col} >= ?)`, params: [lo, hi] };
    case 'gt': case 'sa': return { sql: `${col} >= ?`, params: [hi] };
    case 'ge': return { sql: `${col} >= ?`, params: [lo] };
    case 'lt': case 'eb': return { sql: `${col} < ?`, params: [lo] };
    case 'le': return { sql: `${col} < ?`, params: [hi] };
  }
  throw new FhirError(400, `Unsupported date prefix in "${raw}"`, { code: 'invalid' });
}

/** A reference search value: "Patient/abc", "abc", or an absolute URL ending in Patient/abc. */
function refId(raw, type) {
  const v = String(raw || '').trim();
  const m = v.match(new RegExp(`(?:^|/)${type}/([A-Za-z0-9\\-.]{1,64})$`));
  if (m) return m[1];
  if (/^[A-Za-z0-9\-.]{1,64}$/.test(v)) return v;
  throw new FhirError(400, `"${raw}" is not a ${type} reference`, { code: 'invalid' });
}

module.exports = { FHIR_JSON, FHIR_NDJSON, FHIR_VERSION, SYS, PART2_SECURITY, FhirError, outcome, send, sendError, baseUrl, dateClause, refId };
