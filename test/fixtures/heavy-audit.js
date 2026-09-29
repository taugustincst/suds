'use strict';
// A publication release whose audit is real work: the benchmark's 2,000-client year
// (release-small-programme.json) with its overdose figures scaled by k, exactly (no jitter), as the first
// programme of each scale in test/thorough/refusal-band.test.js. At k = 0.2 (39 events) it publishes after
// about 30 million units of work (1.17.0; the unscaled year takes about 0.25 million), a few hundred
// milliseconds of one core: heavy enough that auditing it on the main thread visibly holds the event loop.
const base = require('./release-small-programme.json');

function scaledYear(k) {
  const f = JSON.parse(JSON.stringify(base)); const od = f.inputs.funder.overdose;
  for (const m of od.by_month) {
    m.n = Math.max(0, Math.round(m.n * k));
    m.reversals = Math.min(m.n, Math.max(0, Math.round(m.reversals * k)));
    m.reversal_doses = m.reversals ? Math.max(m.reversals, Math.round(m.reversal_doses * k)) : 0;
  }
  od.events = od.by_month.reduce((a, x) => a + x.n, 0);
  const R = od.by_month.reduce((a, x) => a + x.reversals, 0); od.reversals = R;
  const by = od.by_administered_by; const tot = by.reduce((a, x) => a + x.n, 0); let s = 0;
  by.forEach((x, i) => { x.n = i < by.length - 1 ? Math.round((x.n * R) / tot) : R - s; s += x.n; });
  od.fatal = Math.min(od.events, Math.round(od.fatal * k)); od.community_reported = Math.min(od.events, Math.round(od.community_reported * k));
  od.naloxone_doses = Math.max(Math.round(od.naloxone_doses * k), od.by_month.reduce((a, x) => a + x.reversal_doses, 0));
  return { T: f.T, inputs: { ...f.inputs, perFund: new Map(f.inputs.perFund) } };
}

module.exports = { scaledYear };
