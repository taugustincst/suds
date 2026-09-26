'use strict';
// The rules for a problem's history: the audit of how a problem-list entry changed, written with each change.
// A device may add its entries, never rewrite them.
const { define } = require('./core');

module.exports = define({ table: 'problem_history', immutable: true, tombstone: 'never' });
