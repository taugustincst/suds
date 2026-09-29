'use strict';
// The AI copilot's estimated cost (docs/AI-COPILOT.md, "Cost"): the administrator enters what the programme pays
// per million input and output tokens (from its provider's price sheet or contract), and Settings → AI copilot shows
// this month's tokens at those prices. It is an estimate, not a bill: every input token is priced at the input rate
// (cached input is billed differently by the provider), and the provider's invoice is what counts.
//
// An optional monthly spending limit in dollars stops drafts once this month's estimate reaches it, beside the limit
// on the number of drafts (server/ai-copilot.js status()). It is checked before each draft against what is already
// recorded, so drafts in progress at that moment can take the month a little past it.
//
// Stored in the settings table like the copilot's other settings (ai_price_input_per_mtok, ai_price_output_per_mtok,
// ai_monthly_cost_cap): numbers as text, absent when not set. Office server only, never synchronised.
const db = require('./db');

const KEYS = { price_input: 'ai_price_input_per_mtok', price_output: 'ai_price_output_per_mtok', monthly_cost_cap: 'ai_monthly_cost_cap' };
const MAX_PRICE = 10000; // dollars per million tokens
const MAX_COST_CAP = 10000000; // dollars a month

const num = (key) => { const v = db.getSetting(key, null); if (v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
/** { price_input, price_output, monthly_cost_cap }: dollars per million tokens, and dollars a month; null when not set. */
function pricing() { return Object.fromEntries(Object.entries(KEYS).map(([k, key]) => [k, num(key)])); }
const priced = (p = pricing()) => p.price_input !== null && p.price_output !== null;

/** Estimated dollars for these token counts at these prices, or null without both prices. */
function estimate({ input_tokens = 0, output_tokens = 0 } = {}, p = pricing()) {
  if (!priced(p)) return null;
  return (Number(input_tokens) * p.price_input + Number(output_tokens) * p.price_output) / 1e6;
}

/** Whether this month's estimate has reached the dollar limit (false when there is no limit, or no prices). */
function capReached(usage, p = pricing()) {
  if (p.monthly_cost_cap === null || !priced(p)) return false;
  return estimate(usage, p) >= p.monthly_cost_cap;
}

/** Save the settings in `v` (validated numbers, or null to clear) that are present. Returns the names changed. */
function save(v) {
  const changed = [];
  for (const [k, key] of Object.entries(KEYS)) {
    if (v[k] === undefined) continue;
    if (v[k] === null) db.run(`DELETE FROM settings WHERE key=?`, key); else db.setSetting(key, String(v[k]));
    changed.push(k);
  }
  return changed;
}

module.exports = { KEYS, MAX_PRICE, MAX_COST_CAP, pricing, priced, estimate, capReached, save };
