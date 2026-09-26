'use strict';
// One publication release per period (server/publication-release.js), audited as one constraint system
// (server/sdc.js), and attacked with everything its three reports publish by an attacker that shares no code
// with it (test/fixtures/release-attacker.js). docs/HIPAA.md "Small cells in aggregate reports".
//
// The protection rule the attacker checks: a "<T" count, or an unprinted or withheld count of people that is
// truly 1..T-1, must still be able to be 1 and T-1 given everything published; a "suppressed" count of people
// must still range over at least ceil(T/2) values.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { attack, makeSolver } = require('./fixtures/release-attacker');

let admin, sup;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('prsup', 'supervisor');
  sup = H.client(); await sup.login('prsup', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

// The API tests run first: the pure ones below hold the event loop for seconds, and a kept-alive connection
// idle that long can be closed under a request.
// ---- through the API: the three reports serve one audited release ----
const AUG = 'from=2026-08-01&to=2026-08-31';
const EXACT = '&purpose=submission&counts=exact';
async function seedAugust() {
  const fund = (await admin.post('/api/budget/funds', { name: 'Settlement', source_type: 'opioid_settlement', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 1000 })).data.id;
  for (let i = 0; i < 20; i++) {
    const c = await admin.post('/api/clients', { first_name: `Aug${i}`, last_name: 'Release', gender: i < 10 ? 'male' : 'female', confirm_duplicate: true });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const day = i === 19 ? '2026-08-31T18:00:00.000Z' : '2026-08-10T18:00:00.000Z';
    assert.equal((await admin.post('/api/interventions', { client_id: c.data.id, type: 'outreach', occurred_at: day, funding_source_id: fund })).status, 201);
  }
  return fund;
}
// The second quarter of 2024: April 18 overdoses of which 5 reversed, May 11 of which 11 reversed; 3 fatal.
const Q = 'from=2024-04-01&to=2024-06-30';
async function seedQuarter() {
  const post = async (b) => assert.equal((await admin.post('/api/overdose-events', b)).status, 201);
  for (let i = 0; i < 18; i++) {
    const reversed = i < 5; const fatal = !reversed && i < 8;
    await post({ occurred_at: `2024-04-${String(2 + i).padStart(2, '0')}T12:00:00Z`, kind: reversed ? 'reversal' : fatal ? 'fatal' : 'overdose', naloxone_used: reversed, naloxone_doses: reversed ? 1 : 0, administered_by: i < 3 ? 'staff' : 'bystander', survived: !fatal });
  }
  for (let i = 0; i < 11; i++) await post({ occurred_at: `2024-05-${String(2 + i).padStart(2, '0')}T12:00:00Z`, kind: 'reversal', naloxone_used: true, naloxone_doses: 2, administered_by: i < 4 ? 'staff' : 'bystander', survived: true });
}
async function releaseOf(q) {
  const [funder, ndp, settlement] = await Promise.all(['/api/reports/funder', '/api/reports/naloxone-ndp', '/api/reports/opioid-settlement'].map(p => sup.get(`${p}?${q}`).then(x => x.data)));
  const [tf, ts] = await Promise.all(['/api/reports/funder', '/api/reports/opioid-settlement'].map(p => sup.get(`${p}?${q}${EXACT}`).then(x => x.data)));
  return { pub: { funder, ndp, settlement }, truth: { funder: tf, settlement: ts } };
}

test('API: the August release (reviewer e2e1) and the overdose quarter survive the attacker, all three reports together', async () => {
  await seedAugust(); await seedQuarter();
  for (const q of [AUG, Q]) {
    const { pub, truth } = await releaseOf(q);
    for (const d of Object.values(pub)) assert.equal(d.suppression.purpose, 'publication', q);
    assert.deepEqual(attack(pub, truth, 11), [], `${q}: ${JSON.stringify({ served: pub.funder.unduplicated.served, gender: pub.funder.demographics.by_gender, funds: pub.funder.by_funding_source.map(f => [f.name, f.clients_served, f.services]), settlement: pub.settlement.services_by_use, od: pub.funder.overdose })}`);
    // One release: the same id on all three, and the NDP reversals are the funder report's.
    assert.ok(pub.funder.release.id && pub.funder.release.id === pub.ndp.release.id && pub.ndp.release.id === pub.settlement.release.id, JSON.stringify([pub.funder.release, pub.ndp.release]));
    assert.deepEqual(pub.ndp.rows.filter(x => x.entry === 'reversal').map(x => [x.date, x.reversals]), pub.funder.overdose.by_month.filter(x => truth.funder.overdose.by_month.find(m => m.month === x.month).reversals > 0).map(x => [x.month, x.reversals]));
    assert.deepEqual(pub.ndp.totals.reversals, pub.funder.overdose.reversals);
  }
});

test('API: determinism - asking again, or for the export, serves the identical release', async () => {
  const first = await releaseOf(AUG);
  const again = await releaseOf(AUG);
  for (const k of ['funder', 'ndp', 'settlement']) assert.equal(again.pub[k].release.id, first.pub[k].release.id, k);
  const strip = (d) => JSON.parse(JSON.stringify(d, (key, v) => (key === 'generated_at' ? undefined : v)));
  assert.deepEqual(strip(again.pub.funder), strip(first.pub.funder));
  assert.deepEqual(again.pub.settlement.services_by_use, first.pub.settlement.services_by_use);
  // The files print the same cells.
  const csv = String((await sup.get(`/api/reports/funder/export?${AUG}&format=csv`)).data);
  assert.match(csv, /publication/i);
  for (const x of first.pub.funder.demographics.by_gender) assert.ok(csv.includes(`Gender,${x.k},${x.n}`), `${x.k} ${x.n}`);
  const sx = await sup.raw(`/api/reports/opioid-settlement/export?${AUG}&format=xlsx`);
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await sx.arrayBuffer()));
  const services = wb.find(s => s.name === 'Services');
  for (const x of first.pub.settlement.services_by_use) assert.ok(services.rows.some(row => row.map(String).includes(String(x.people))), `${x.people} in ${JSON.stringify(services.rows)}`);
});

// ---- the solver ----
test('the exact integer solver agrees with brute force on random small systems', () => {
  const SDC = require('../server/sdc');
  const r = rng(7);
  for (let run = 0; run < 300; run++) {
    const n = 2 + Math.floor(r() * 3);
    const lb = Array.from({ length: n }, () => Math.floor(r() * 3)); const ub = lb.map(l => (r() < 0.2 ? Infinity : l + Math.floor(r() * 6)));
    const rows = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ a: Array.from({ length: n }, () => [-1, 0, 1, 1, 2][Math.floor(r() * 5)]), op: ['<=', '>=', '='][Math.floor(r() * 3)], b: Math.floor(r() * 9) - 2 }));
    const c = Array.from({ length: n }, () => [-1, 0, 1][Math.floor(r() * 3)]);
    // Brute force over a box (an unbounded variable is capped at 40, and a maximum that reaches the cap is unbounded).
    const CAP = 40; const hi = ub.map(u => Math.min(u, CAP));
    let best = -Infinity; let known = null; const values = new Set(); let capped = false;
    const x = lb.slice();
    const rec = (j) => {
      if (j === n) {
        if (!rows.every(row => { const s = row.a.reduce((a, v, i) => a + v * x[i], 0); return row.op === '<=' ? s <= row.b : row.op === '>=' ? s >= row.b : s === row.b; })) return;
        const v = c.reduce((a, cv, i) => a + cv * x[i], 0); values.add(v);
        if (v > best) { best = v; }
        if (!known) known = x.slice();
        if (x.some((xi, i) => ub[i] === Infinity && xi === CAP)) capped = true;
        return;
      }
      for (let v = lb[j]; v <= hi[j]; v++) { x[j] = v; rec(j + 1); }
    };
    rec(0);
    if (!known) continue; // the engine is only ever asked about systems the truth satisfies
    const got = SDC.intMax({ n, rows, lb, ub }, c, known).value;
    if (got === Infinity) assert.ok(capped || c.some((cv, i) => cv > 0 && ub[i] === Infinity), `run ${run}: unbounded but brute force found ${best}`);
    else assert.equal(got, best, `run ${run}: ${JSON.stringify({ rows, lb, ub, c })}`);
    for (const v of [best, best - 1, best - 2]) {
      if (got === Infinity) break;
      assert.equal(SDC.intFeasible({ n, rows, lb, ub }, c, v).feasible, values.has(v), `run ${run}: can the objective be ${v}?`);
    }
  }
});

test('the attacker\'s own solver agrees with brute force', () => {
  const r = rng(11);
  for (let run = 0; run < 200; run++) {
    const n = 2 + Math.floor(r() * 3); const lo = Array.from({ length: n }, () => Math.floor(r() * 3)); const hi = lo.map(l => l + Math.floor(r() * 6));
    const cons = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ terms: Array.from({ length: n }, (_, i) => [i, [-1, 0, 1, 1][Math.floor(r() * 4)]]).filter(([, c]) => c), op: ['<=', '>=', '='][Math.floor(r() * 3)], rhs: Math.floor(r() * 9) - 2 }));
    const sols = []; const x = lo.slice();
    const rec = (j) => { if (j === n) { if (cons.every(k => { const s = k.terms.reduce((a, [i, c]) => a + c * x[i], 0); return k.op === '<=' ? s <= k.rhs : k.op === '>=' ? s >= k.rhs : s === k.rhs; })) sols.push(x.slice()); return; } for (let v = lo[j]; v <= hi[j]; v++) { x[j] = v; rec(j + 1); } };
    rec(0);
    let s;
    try { s = makeSolver(lo, hi, cons); } catch { assert.equal(sols.length, 0, `run ${run}`); continue; }
    for (let i = 0; i < n; i++) for (let v = lo[i]; v <= hi[i]; v++) assert.equal(s.can(i, v), sols.some(z => z[i] === v), `run ${run} x${i}=${v}`);
  }
});

// ---- the release, as a pure function of its figures ----
const PARTS = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'];
const count = (people, f) => { const m = new Map(); for (const p of people) for (const k of [].concat(f(p))) m.set(k, (m.get(k) || 0) + 1); return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => (b.n - a.n) || String(a.k).localeCompare(String(b.k))); };
/**
 * A programme's figures, computed from its records the way the reports count them. people: [{ gender, ...,
 * visits: { fundId|null: services } }]; anon: { fundId|null: services with no client }; events: [{ month,
 * reversed, fatal, community, by }]; discharges: [reason]; funds: [{ id, use (null: not settlement), active }].
 */
function figuresOf({ people, anon = {}, events = [], discharges = [], funds }) {
  const perFund = new Map();
  for (const f of [...funds.map(x => x.id), null]) {
    const services = people.reduce((a, p) => a + (p.visits[f] || 0), 0) + (anon[f] || 0);
    const clients = people.filter(p => p.visits[f]).length;
    if (services) perFund.set(f, { services, clients_served: clients });
  }
  const months = [...new Set(events.map(e => e.month))].sort();
  const raw = {
    unduplicated: { served: people.length, new_admissions: 0, with_a_referral: people.filter(p => p.referred).length, admitted_after_referral: people.filter(p => p.admitted).length, on_mat: people.filter(p => p.mat).length },
    demographics: { by_gender: count(people, p => p.gender), by_language: count(people, p => p.language), by_housing: count(people, p => p.housing), by_insurance: count(people, p => p.insurance), by_ethnicity: count(people, p => p.ethnicity), by_race_code: count(people, p => (p.race.length ? p.race : ['unknown'])) },
    episodes: { admissions: 0, discharges: discharges.length, open_at_end: 0, by_discharge_reason: count(discharges.map(k => ({ k })), x => x.k), median_length_of_stay_days: null },
    overdose: { events: events.length, reversals: events.filter(e => e.reversed).length, fatal: events.filter(e => e.fatal).length, community_reported: events.filter(e => e.community).length, naloxone_doses: 0,
      by_month: months.map(m => ({ month: m, n: events.filter(e => e.month === m).length, reversals: events.filter(e => e.month === m && e.reversed).length, reversal_doses: events.filter(e => e.month === m && e.reversed).length })),
      by_administered_by: count(events.filter(e => e.reversed), e => e.by) },
    naloxone_distribution: { kits: 0, strips: 0, community_kits: 0 },
    by_funding_source: [...funds.filter(f => f.active).map(f => ({ id: f.id, name: f.id, ...(perFund.get(f.id) || { services: 0, clients_served: 0 }) })), { id: null, name: 'No funding source', ...(perFund.get(null) || { services: 0, clients_served: 0 }) }]
      .map(f => ({ ...f, approved_minutes: 0, unapproved_minutes: 0 })),
    attribution: { unattributed_services: perFund.get(null)?.services || 0, unattributed_clients: perFund.get(null)?.clients_served || 0, approved_minutes: 0, unapproved_minutes: 0 },
  };
  const uses = [...new Set(funds.filter(f => f.use).map(f => f.use))].sort();
  const services_by_use = uses.map(u => {
    const ids = funds.filter(f => f.use === u).map(f => f.id);
    return { use_code: u, services: ids.reduce((a, id) => a + (perFund.get(id)?.services || 0), 0), people: people.filter(p => ids.some(id => p.visits[id])).length, naloxone_kits: 0 };
  }).filter(x => x.services > 0);
  const settlement = { services_by_use, fundKeys: funds.filter(f => f.use).map(f => ({ id: f.id, key: f.use, active: f.active })) };
  const inactiveFunds = Object.fromEntries(funds.filter(f => !f.active).map(f => [f.id, { people: perFund.get(f.id)?.clients_served || 0, services: perFund.get(f.id)?.services || 0 }]));
  return { inputs: { funder: raw, perFund, settlement }, inactiveFunds, funds };
}
/** Protect a programme's figures and put them the way the three reports publish them. */
function publish(prog, T) {
  const PR = require('../server/publication-release');
  const p = PR.protectFigures(prog.inputs, T, { strict: true });
  const { funder: raw, settlement } = prog.inputs;
  const pub = {
    funder: p.funder,
    settlement: { funds: prog.funds.filter(f => f.use).map(f => ({ id: f.id, settlement_use: f.use })), services_by_use: settlement.services_by_use.map((x, i) => ({ ...x, people: p.uses[i].people, services: p.uses[i].services })) },
    ndp: { rows: raw.overdose.by_month.map((m, i) => ({ date: m.month, entry: 'reversal', reversals: p.ndp.by_month[i], truth: m.reversals })).filter(x => x.truth > 0), totals: { reversals: p.ndp.reversals } },
  };
  const truth = { funder: raw, settlement: { services_by_use: settlement.services_by_use }, inactiveFunds: prog.inactiveFunds };
  return { p, pub, truth };
}
/** Whatever a report prints is true: a number is the count, "<T" a count of 1..T-1, "suppressed" at least T. */
function honest(shown, truth, T, people = true) {
  if (typeof shown === 'number') return shown === truth;
  if (shown === `<${T}`) return truth > 0 && truth < T;
  if (shown === 'suppressed') return !people || truth >= T;
  return shown === 'withheld';
}
const noPeople = (over = {}) => ({ people: [], funds: [], ...over });

test('reviewer reproduction: the overdose months, reversals at most the events of their month', () => {
  // Found against 1.12.1: [events, reversals] per month, reversals by who gave the naloxone, fatal events.
  const cases = [
    { months: [[18, 5], [11, 11]], by: [7, 9], fatal: 3 }, // r1 >= 11 and n1 = 11 forced r1 = 11, so r0 = 5
    { months: [[18, 1], [18, 11]], by: [11, 1], fatal: 24 }, // fatal 24 of 36 left one reversal
    { months: [[1, 1], [18, 17]], by: [5, 13], fatal: 1 },
    { months: [[15, 14], [3, 3]], by: [16, 1], fatal: 1 },
  ];
  for (const c of cases) {
    const events = [];
    c.months.forEach(([n, rv], m) => { for (let i = 0; i < n; i++) events.push({ month: `2026-0${m + 1}`, reversed: i < rv }); });
    let f = c.fatal; for (const e of events) if (!e.reversed && f > 0) { e.fatal = true; f--; }
    let b = 0; for (const e of events) if (e.reversed) { e.by = b < c.by[0] ? 'staff' : 'bystander'; b++; }
    const { pub, truth } = publish(figuresOf(noPeople({ events })), 11);
    assert.deepEqual(attack(pub, truth, 11), [], `${JSON.stringify(c)} published as ${JSON.stringify(pub.funder.overdose)}`);
  }
});

test('reviewer reproduction: the funder report and the settlement report of one release', () => {
  // 20 people, 10 men and 10 women, all served under one settlement fund. 1.12.1 hid the total and both
  // genders in the funder report, and printed 20 people for the fund's use in the settlement report.
  const people = Array.from({ length: 20 }, (_, i) => ({ gender: i < 10 ? 'male' : 'female', language: 'en', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: { S: 1 } }));
  const prog = figuresOf({ people, funds: [{ id: 'S', use: 'uncategorised', active: true }] });
  const { pub, truth } = publish(prog, 11);
  assert.deepEqual(attack(pub, truth, 11), [], JSON.stringify({ served: pub.funder.unduplicated.served, gender: pub.funder.demographics.by_gender, settlement: pub.settlement.services_by_use }));
  // A fund's services bound its people (everyone served was served at least once), and the settlement
  // report prints its use's services, the sum of its funds': fund A served two people twice, fund B (same
  // use) twenty people, those two among them. A's services are the use's minus B's: 2.
  const two = figuresOf({ people: Array.from({ length: 50 }, (_, i) => ({ gender: 'm', language: 'en', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: i < 2 ? { A: 1, B: 1 } : i < 20 ? { B: 1 } : { C: 1 } })),
    funds: [{ id: 'A', use: 'u1', active: true }, { id: 'B', use: 'u1', active: true }, { id: 'C', use: null, active: true }] });
  const t2 = publish(two, 11);
  assert.deepEqual(attack(t2.pub, t2.truth, 11), [], JSON.stringify({ funds: t2.pub.funder.by_funding_source, settlement: t2.pub.settlement.services_by_use }));
  assert.equal(t2.pub.funder.by_funding_source.find(f => f.id === 'A').clients_served, '<11');
  // And the cross-report cases found by random search (cross.js): a fund, a use, and the total they share.
  const r = rng(5);
  for (let run = 0; run < 60; run++) {
    const n = 1 + Math.floor(r() * 30);
    const ppl = Array.from({ length: n }, () => ({ gender: r() < 0.5 ? 'm' : 'f', language: r() < 0.8 ? 'en' : 'es', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: r() < 0.7 ? { S: 1 + Math.floor(r() * 2) } : { C: 1 } }));
    const pr = figuresOf({ people: ppl, funds: [{ id: 'S', use: 'u1', active: true }, { id: 'C', use: null, active: true }] });
    const x = publish(pr, 11);
    assert.deepEqual(attack(x.pub, x.truth, 11), [], `run ${run}`);
  }
});

// ---- random programmes, every report of the release attacked together ----
function randomProgramme(r) {
  const pick = (xs, w) => { let u = r() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { u -= w[i]; if (u < 0) return xs[i]; } return xs[xs.length - 1]; };
  const T = 3 + Math.floor(r() * 3);
  const skew = [1 + r() * 8, 1, r()];
  const funds = [{ id: 'A', use: 'u1', active: true }, { id: 'B', use: r() < 0.5 ? 'u1' : 'u2', active: true }, { id: 'C', use: null, active: true }];
  if (r() < 0.4) funds.push({ id: 'D', use: 'u2', active: false });
  const n = 1 + Math.floor(r() * 12);
  const people = Array.from({ length: n }, () => {
    const race = ['w', 'b', 'a'].filter(() => r() < 0.4);
    const visits = {};
    for (const [f, pr] of [['A', 0.6], ['B', 0.3], ['C', 0.3], ['D', 0.2], [null, 0.15]]) if (r() < pr && funds.some(x => x.id === f || f === null)) visits[f] = 1 + Math.floor(r() * 3);
    return { gender: pick(['m', 'f', 'x'], skew), language: pick(['en', 'es'], [skew[0], 1]), housing: pick(['s', 'h', 'u'], [1, 1, r()]), insurance: pick(['a', 'b'], [skew[0], 1]),
      ethnicity: pick(['h', 'n', 'u'], skew), race, visits, mat: r() < 0.6, referred: r() < 0.5, admitted: r() < 0.3 };
  });
  const anon = r() < 0.3 ? { A: 1 + Math.floor(r() * 3) } : {};
  const nm = 1 + Math.floor(r() * 3);
  const events = Array.from({ length: Math.floor(r() * 16) }, () => {
    const reversed = r() < 0.5; const fatal = !reversed && r() < 0.35;
    return { month: `2025-0${1 + Math.floor(r() * nm)}`, reversed, fatal, community: r() < 0.3, by: pick(['staff', 'bystander', 'ems'], [skew[0], 1, r()]) };
  });
  const discharges = Array.from({ length: Math.floor(r() * 12) }, () => pick(['completed', 'moved', 'lost'], skew));
  return { T, prog: figuresOf({ people, anon, events, discharges, funds }) };
}

test('property: nothing any report of a release publishes lets an attacker narrow a hidden count beyond the rule', () => {
  const r = rng(Number(process.env.PR_SEED) || 20260926);
  const runs = Number(process.env.PR_RUNS) || 250;
  let hidden = 0; let withheld = 0;
  for (let run = 0; run < runs; run++) {
    const { T, prog } = randomProgramme(r);
    const { p, pub, truth } = publish(prog, T);
    // Every published symbol is true.
    const m = p.model;
    m.vars.forEach((v, i) => { if (v.published) assert.ok(honest(p.status[i] === 'vis' ? v.value : p.status[i] === 'pri' ? `<${T}` : p.status[i] === 'sec' ? 'suppressed' : 'withheld', v.value, T, v.people), `run ${run}: ${v.id}`); });
    const leaks = attack(pub, truth, T);
    assert.deepEqual(leaks, [], `run ${run}, T=${T}: ${JSON.stringify(prog.inputs.funder.unduplicated)} ${JSON.stringify(prog.inputs.funder.overdose.by_month)}`);
    hidden += p.status.filter(s => s === 'pri' || s === 'sec').length; withheld += p.withheld_tables.length;
  }
  // The runs exercised the audit (something was hidden, and something withheld, somewhere).
  assert.ok(hidden > runs, `hidden ${hidden}`); assert.ok(withheld > 0, `withheld ${withheld}`);
});

test('determinism: the same figures give the same release, cell for cell', () => {
  const PR = require('../server/publication-release');
  const r = rng(99);
  for (let run = 0; run < 20; run++) {
    const { T, prog } = randomProgramme(r);
    const copy = { funder: JSON.parse(JSON.stringify(prog.inputs.funder)), perFund: new Map(prog.inputs.perFund), settlement: JSON.parse(JSON.stringify(prog.inputs.settlement)) };
    const a = PR.protectFigures(prog.inputs, T); const b = PR.protectFigures(copy, T);
    assert.deepEqual(a.funder, b.funder); assert.deepEqual(a.uses, b.uses); assert.deepEqual(a.ndp, b.ndp); assert.equal(a.id, b.id);
  }
});
