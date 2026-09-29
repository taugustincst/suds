'use strict';
// What test/sync-rules.test.js expects for each table and case: { push, rest }. First recorded against 1.13.0 by
// running it with SUDS_CHARACTERISE=1, before server/rules/ existed. An entry that changed since then says what
// it was ("was:") and why: each is a place where sync push and the REST routes disagreed, now decided one way
// (docs/architecture/README.md, "Where REST and sync disagreed").
module.exports = {
  resources: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: category not a category": { push: "rejected: has a value the office does not accept (category: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: name too long": { push: "flagged: was accepted, but its name is longer than the office allows (200 characters); the office will review it", rest: 400 },
    // was: push "rejected: is missing a required field", rest 400 -- still refused; the reason now names the field
    "invalid: name missing": { push: "rejected: is missing a required field (name)", rest: 400 },
    "role without permission (clin)": { push: "rejected: your role cannot write resources", rest: 403 },
    "tombstone": { push: "kept", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  policy_documents: {
    "valid": { push: "applied", rest: null },
    // was: push "rejected: has a value the office does not accept", rest null -- still refused; the reason now names the field
    "invalid: category not a category": { push: "rejected: has a value the office does not accept (category: not one of the values it accepts)", rest: null },
    // was: push "applied", rest null -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: title too long": { push: "flagged: was accepted, but its title is longer than the office allows (200 characters); the office will review it", rest: null },
    "role without permission (nav)": { push: "rejected: your role cannot write policy_documents", rest: null },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  funding_sources: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: period ends before it starts": { push: "rejected: has a value the office does not accept (its period ends before it starts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: source type unknown": { push: "rejected: has a value the office does not accept (source_type: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: negative total": { push: "rejected: has a value the office does not accept (total_amount: min 0)", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write funding_sources", rest: 403 },
    "tombstone": { push: "deleted", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  budget_lines: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: category unknown": { push: "rejected: has a value the office does not accept (category: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: more than the fund holds": { push: "rejected: has a value the office does not accept (it allocates more than its fund or parent line holds)", rest: 400 },
    "invalid: its own parent": { push: "rejected: would create a cycle in its allocation hierarchy", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write budget_lines", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  clients: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: status unknown": { push: "rejected: has a value the office does not accept (status: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: date of birth in the future": { push: "flagged: was accepted, but its dob does not look right (dob cannot be in the future); the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: email not an address": { push: "flagged: was accepted, but its email does not look right (email is not a valid email address); the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: first name too long": { push: "flagged: was accepted, but its first name is longer than the office allows (100 characters); the office will review it", rest: 400 },
    "invalid: sets a legal hold without the permission": { push: "applied", rest: 201 },
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  assignments: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: role unknown": { push: "rejected: has a value the office does not accept (role_on_case: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: a deactivated worker": { push: "rejected: has a value the office does not accept (a worker the office has deactivated)", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write assignments", rest: 403 },
    "tombstone": { push: "deleted", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: null },
  },
  episodes: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: a second open episode": { push: "flagged: was accepted, but the client already had an open episode at the office; a supervisor should close one of the two", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: closed before it opened": { push: "rejected: has a value the office does not accept (it closes before it was opened)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload and push applies; REST's 400 is the second open episode that push has just opened. A navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 400 },
    "another worker's record on a shared client": { push: "applied", rest: null },
    // was: push "deleted", rest null -- no REST route deletes this record; a device tombstone is ignored like the legal record's
    "another worker's record on a shared client: tombstone": { push: "kept", rest: null },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    // was: push "deleted", rest null -- no REST route deletes this record; a device tombstone is ignored like the legal record's
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: null },
  },
  interventions: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: type not on the list": { push: "flagged: was accepted, but its type is not one of the choices the office offers now; the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: a client is required for this service": { push: "rejected: is missing a required field (a client: only outreach and community naloxone distribution can be recorded without one)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: duration over a day": { push: "rejected: has a value the office does not accept (duration_minutes: max 1440)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: stage of change unknown": { push: "rejected: has a value the office does not accept (stage_of_change: not one of the values it accepts)", rest: 400 },
    // was: (not recorded in 1.13.0) -- new case (1.13.0 would have applied it: push checked the permission, not the cost); REST refuses this; so does push now
    "invalid: a cost with no budget line": { push: "rejected: is missing a required field (a budget line for its cost)", rest: 400 },
    // was: (not recorded in 1.13.0) -- new case (1.13.0 would have applied it); REST refuses this; so does push now
    "invalid: a cost on a line of another fund": { push: "rejected: has a value the office does not accept (its budget line belongs to another fund)", rest: 400 },
    "invalid: attributed to another worker": { push: "rejected: attributed to another user, which your role cannot do", rest: 201 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "another worker's record with no client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record with no client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  overdose_events: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: kind unknown": { push: "rejected: has a value the office does not accept (kind: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: doses negative": { push: "rejected: has a value the office does not accept (naloxone_doses: min 0)", rest: 400 },
    // was: push "applied", rest 201 -- REST refuses this; so does push now
    "invalid: reported by another worker": { push: "rejected: attributed to another user, which your role cannot do", rest: 201 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "another worker's record with no client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record with no client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  calls: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: direction unknown": { push: "rejected: has a value the office does not accept (direction: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: a text outcome on a phone call": { push: "flagged: was accepted, but its outcome is not one the office offers for a phone call; the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: contact name too long": { push: "flagged: was accepted, but its contact name is longer than the office allows (120 characters); the office will review it", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "another worker's record with no client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record with no client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  time_entries: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: no minutes": { push: "rejected: has a value the office does not accept (minutes: min 1)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: charged to a fund outside its period": { push: "flagged: was accepted, but its work date is outside the period of the fund it is charged to, or in the future; the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: category not on the list": { push: "flagged: was accepted, but its category is not one of the choices the office offers now; the office will review it", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "another worker's record with no client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record with no client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (ro)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  consents: {
    "valid": { push: "applied", rest: 201 },
    "invalid: type unknown": { push: "rejected: has a value the office does not accept (consent type \"pinky_swear\")", rest: 400 },
    "invalid: a Part 2 consent missing its elements": { push: "rejected: is missing a required field: a 42 CFR Part 2 consent must record what information is covered (scope); an expiration date or event; evidence it was signed (a document reference, a witness, or \"signed on paper\"); the 2024 elements (it was signed on or after 2026-02-16, when the 2024 rule's element list became mandatory)", rest: 400 },
    // was: push "applied", rest 400 -- the recipient limit is 2,000 characters since 1.14.0 (a TPO consent lists its partner agencies); the case sends 2,001
    "invalid: recipient too long": { push: "flagged: was accepted, but its recipient is longer than the office allows (2000 characters); the office will review it", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    "another worker's record on a shared client": { push: "rejected: immutable", rest: null },
    "another worker's record on a shared client: tombstone": { push: "kept", rest: null },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "rejected: immutable", rest: null },
  },
  court_orders: {
    "valid": { push: "applied", rest: 201 },
    "invalid: order type unknown": { push: "rejected: has a value the office does not accept (order type \"parking\")", rest: 400 },
    "invalid: expires before it was issued": { push: "rejected: has a value the office does not accept (the order expires before it was issued)", rest: 400 },
    "invalid: no court": { push: "rejected: is missing a required field: a court order must record the court", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write court_orders", rest: 403 },
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    // was: push "conflict", rest null -- no REST route edits this record; a device cannot either (it was only saved by the office copy being newer)
    "an older device edit": { push: "rejected: immutable", rest: null },
  },
  part2_notices: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: method unknown": { push: "rejected: has a value the office does not accept (method: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: given in the future": { push: "flagged: was accepted, but it is dated in the future; the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: acknowledged and refused": { push: "rejected: has a value the office does not accept (it is both acknowledged and refused)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest null -- no REST route edits this record; a device cannot either
    "another worker's record on a shared client": { push: "rejected: immutable", rest: null },
    "another worker's record on a shared client: tombstone": { push: "kept", rest: null },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    // was: push "conflict", rest null -- no REST route edits this record; a device cannot either (it was only saved by the office copy being newer)
    "an older device edit": { push: "rejected: immutable", rest: null },
  },
  referrals: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: urgency unknown": { push: "rejected: has a value the office does not accept (urgency: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: cites another client's consent": { push: "rejected: has a value the office does not accept (the consent it cites is another client's)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: status not on the list": { push: "flagged: was accepted, but its status is not one of the choices the office offers now; the office will review it", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  tasks: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: priority unknown": { push: "rejected: has a value the office does not accept (priority: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: title too long": { push: "flagged: was accepted, but its title is longer than the office allows (200 characters); the office will review it", rest: 400 },
    // was: push "rejected: is missing a required field", rest 400 -- still refused; the reason now names the field
    "invalid: no title": { push: "rejected: is missing a required field (title)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "another worker's record with no client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record with no client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  expenditures: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: category unknown": { push: "rejected: has a value the office does not accept (category: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: an inactive fund": { push: "flagged: was accepted, but the fund it is charged to is closed or unknown at the office; the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: nothing spent": { push: "rejected: has a value the office does not accept (amount: min 0.01)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "another worker's record with no client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record with no client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (clin)": { push: "rejected: your role cannot write expenditures", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  notes: {
    "valid": { push: "applied", rest: 201 },
    "invalid: a clinical note from a navigator": { push: "rejected: clinical notes not permitted for this role", rest: 403 },
    // was: push "applied", rest 400 -- REST refuses this; push flags it rather than throw away work done offline under the lists and limits the device had
    "invalid: format not on the list": { push: "flagged: was accepted, but its format is not one of the choices the office offers now; the office will review it", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: a counseling note that is not clinical": { push: "rejected: has a value the office does not accept (only a clinical note can be a SUD counseling note)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    "another worker's record on a shared client: tombstone": { push: "kept", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "kept", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  patient_requests: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: kind unknown": { push: "rejected: has a value the office does not accept (kind: not one of the values it accepts)", rest: 400 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: status unknown": { push: "rejected: has a value the office does not accept (status: not one of the values it accepts)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    // was: push "applied", rest 403 -- REST's edit rule (the record's worker, or a manager) now applies to a device's edit
    "another worker's record on a shared client": { push: "rejected: not permitted", rest: 403 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  problems: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: status unknown": { push: "rejected: has a value the office does not accept (status: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: not an ICD-10 code": { push: "rejected: has a value the office does not accept (its ICD-10 code)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    "another worker's record on a shared client": { push: "applied", rest: 200 },
    // was: push "deleted", rest null -- no REST route deletes this record; a device tombstone is ignored like the legal record's
    "another worker's record on a shared client: tombstone": { push: "kept", rest: null },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    // was: push "applied", rest 403 -- REST refuses new work while the module is off; a device that recorded it while the module was on keeps it, flagged
    "module switched off": { push: "flagged: was accepted, but Care plan & problem list is switched off at the office; an administrator can switch it on in Settings › Program › Modules", rest: 403 },
    // was: push "deleted", rest null -- no REST route deletes this record; a device tombstone is ignored like the legal record's
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  care_plan_goals: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: status unknown": { push: "rejected: has a value the office does not accept (status: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: a problem on another client's list": { push: "rejected: has a value the office does not accept (the problem it addresses is not on this client's list)", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    "another worker's record on a shared client": { push: "applied", rest: 200 },
    // was: push "deleted", rest 403 -- REST's DELETE rule (the record's worker, or a manager) now applies to a device's tombstone
    "another worker's record on a shared client: tombstone": { push: "rejected: not permitted", rest: 403 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    // was: push "applied", rest 403 -- REST refuses new work while the module is off; a device that recorded it while the module was on keeps it, flagged
    "module switched off": { push: "flagged: was accepted, but Care plan & problem list is switched off at the office; an administrator can switch it on in Settings › Program › Modules", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  asam_assessments: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: a rating out of range": { push: "rejected: has a value the office does not accept (d1_rating: max 4)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: a level of care unknown": { push: "rejected: has a value the office does not accept (recommended_loc: not one of the values it accepts)", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write asam_assessments", rest: 403 },
    // was: push "applied", rest 403 -- REST refuses new work while the module is off; a device that recorded it while the module was on keeps it, flagged
    "module switched off": { push: "flagged: was accepted, but Assessments is switched off at the office; an administrator can switch it on in Settings › Program › Modules", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  outcome_measures: {
    "valid": { push: "applied", rest: 201 },
    "invalid: answers that do not score": { push: "rejected: has a value the office does not accept (the answers do not score)", rest: 400 },
    "invalid: an instrument that is switched off": { push: "rejected: has a value the office does not accept (DAST-10 is not enabled on the office server; an administrator can turn it on under Settings → Screening instruments)", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write outcome_measures", rest: 403 },
    // was: push "applied", rest 403 -- REST refuses new work while the module is off; a device that recorded it while the module was on keeps it, flagged
    "module switched off": { push: "flagged: was accepted, but Assessments is switched off at the office; an administrator can switch it on in Settings › Program › Modules", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  form_templates: {
    "valid": { push: "applied", rest: 201 },
    // was: push "applied", rest 400 -- REST refuses this; so does push now
    "invalid: category unknown": { push: "rejected: has a value the office does not accept (category: not one of the values it accepts)", rest: 400 },
    "role without permission (nav)": { push: "rejected: your role cannot write form_templates", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  client_forms: {
    "valid": { push: "applied", rest: 201 },
    // was: push "rejected: has a value the office does not accept", rest 400 -- still refused; the reason now names the field
    "invalid: status unknown": { push: "rejected: has a value the office does not accept (status: not one of the values it accepts)", rest: 400 },
    // was: push "applied", rest 400 -- REST refuses this; push lets the field work land and tells the device and the audit trail
    "invalid: completed with a required field empty": { push: "flagged: was accepted as completed, but it is missing required answers (1); the office will review it", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    "another worker's record on a shared client": { push: "applied", rest: 200 },
    "another worker's record on a shared client: tombstone": { push: "deleted", rest: 200 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 409 },
  },
  suprt_assessments: {
    // A table new in 1.14.0 (SUPRT-A), recorded when its rules were declared: push flags what depends on the office (the module, the date, completeness, the order of a cycle) and refuses answers the instrument does not ask.
    "valid": { push: "applied", rest: 201 },
    "invalid: type unknown": { push: "rejected: has a value the office does not accept (assessment_type: not one of the values it accepts)", rest: 400 },
    "invalid: dated in the future": { push: "flagged: was accepted, but it is dated in the future; the office will review it", rest: 400 },
    "invalid: an answer the instrument does not ask": { push: "rejected: has a value the office does not accept (answers: no_such_item)", rest: 400 },
    "invalid: complete with required answers missing": { push: "flagged: was accepted as complete, but it is missing required answers (2); the office will review it", rest: 400 },
    // was: push "rejected: not on caseload", rest 403 -- 1.16.0: a navigator holds clients:all, so nav2's client is not off their caseload; a navigator denied clients:all is refused as before (test/role-expansion.test.js)
    "client off the caseload": { push: "applied", rest: 201 },
    "another worker's record on a shared client": { push: "applied", rest: 200 },
    "another worker's record on a shared client: tombstone": { push: "deleted", rest: 200 },
    "role without permission (fin)": { push: "http 403", rest: 403 },
    "module switched off": { push: "flagged: was accepted, but SUPRT-A (SOR client-level reporting) is switched off at the office; an administrator can switch it on in Settings › Program › Modules", rest: 403 },
    "tombstone": { push: "deleted", rest: 200 },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: 200 },
  },
  supply_ledger: {
    // A table new in 1.14.0 (supplies), recorded when its rules were declared: REST receives stock by POST /api/supplies/receipts; a visit's draw-down is the office's; an item or site retired at the office is flagged.
    "valid": { push: "applied", rest: 201 },
    "invalid: a visit's draw-down": { push: "rejected: drawn down at the office from the visit it belongs to", rest: null },
    "invalid: a negative delivery": { push: "rejected: has a value the office does not accept (stock received or moved in cannot be negative)", rest: 400 },
    "invalid: an item the office has retired": { push: "flagged: was accepted, but Retired kit is no longer offered at the office; the office will review it", rest: 400 },
    "invalid: a fund on a delivery that was not a purchase": { push: "rejected: has a value the office does not accept (a funding source is recorded for a purchase only)", rest: 400 },
    "tombstone": { push: "kept", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "rejected: immutable", rest: null },
  },
  imports: {
    "valid": { push: "applied", rest: null },
    "invalid: source unknown": { push: "applied", rest: null },
    "role without permission (fin)": { push: "http 403", rest: null },
    "tombstone": { push: "deleted", rest: null },
    "device clock two hours fast": { push: "applied (office time)", rest: null },
    "an older device edit": { push: "conflict", rest: null },
  },
};
