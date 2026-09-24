'use strict';
// The caseload questions the Home page counts and the client list answers ("high-risk", "not contacted in
// 30 days", "consent expiring", by substance, by MAT status), written once. The client list used to fetch
// its first 200 rows and filter those in the browser, so a dashboard tile of 915 high-risk clients opened a
// list of 101. Every predicate here is SQL over plaintext operational columns (risk_level,
// primary_substance, mat_status, dates) or over other tables by client_id — never over an _enc column —
// so it runs inside the same caseload-scoped WHERE clause as the rest of the list, and pages correctly.
//
// Each function returns { sql, params } for a client row aliased `c`. The dashboard query in
// server/routes/reports.js computes the same numbers; test/client-list-filters.test.js asserts that the
// tile counts and the filtered list totals agree, so a change to one without the other fails loudly.

const DAY = 86400000;

/** 'high' means high or critical (the Home tile's "High-risk clients"); any other level is exact. */
function risk(level) {
  if (level === 'high') return { sql: `c.risk_level IN ('high','critical')`, params: [] };
  return { sql: 'c.risk_level=?', params: [level] };
}

/** No visit or service, and no call that reached them, since `since` (default: 30 days ago). */
function noContactSince(since = new Date(Date.now() - 30 * DAY).toISOString()) {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM interventions i WHERE i.client_id=c.id AND i.occurred_at >= ?) AND NOT EXISTS (SELECT 1 FROM calls ca WHERE ca.client_id=c.id AND ca.outcome IN ('reached','replied') AND ca.started_at >= ?)`,
    params: [since, since],
  };
}

/** A blank value is counted as 'unknown' on the dashboard, so 'unknown' finds the blanks too. */
function substance(value) { return { sql: `COALESCE(c.primary_substance,'unknown')=?`, params: [value] }; }
function mat(value) { return { sql: `COALESCE(c.mat_status,'unknown')=?`, params: [value] }; }

/** The window the dashboard's "consents expiring soon" uses: today (program time zone) to 30 days out. */
function consentWindow() {
  const today = require('./routes/budget').localDate();
  return { from: today, to: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10) };
}
/** Has a consent that is still in force and runs out within the window. */
function consentExpiring({ from, to } = consentWindow()) {
  return { sql: `EXISTS (SELECT 1 FROM consents co WHERE co.client_id=c.id AND co.revoked_at IS NULL AND co.expires_at BETWEEN ? AND ?)`, params: [from, to] };
}

/** Has an open patient-rights request (access, amendment, restriction, accounting). */
function openPatientRequest() { return { sql: `EXISTS (SELECT 1 FROM patient_requests p WHERE p.client_id=c.id AND p.status='open')`, params: [] }; }

module.exports = { risk, noContactSince, substance, mat, consentWindow, consentExpiring, openPatientRequest };
