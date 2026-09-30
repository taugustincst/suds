'use strict';
// Reporting periods for the county view, the Send to the county card and the county connection (docs/COUNTY-VIEW.md):
// calendar quarters, California fiscal years (July 1 to June 30; "FY 2025-26" starts 2025-07-01, and its Q1 is July
// to September) and their quarters, months, calendar years. Pure functions on YYYY-MM-DD strings, so a day is never a
// time zone's day before.
//
// The one copy: the server requires this file (server/county-connect.js: the periods a county expects), and the
// browser imports public/county-periods.js, an ES module generated from it by scripts/gen-county-periods.js (run by
// `npm run build:local`; test/county-periods.test.js fails if the two differ). So a period is named the same on the
// county's pages, the programme's card and in what the county connection tells a programme. Edit this file, not that.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m 1-12
const ym = (s) => [Number(s.slice(0, 4)), Number(s.slice(5, 7))];

/** Calendar quarter q (1-4) of year y. */
function calendarQuarter(y, q) { const m = (q - 1) * 3 + 1; return { from: `${y}-${pad(m)}-01`, to: lastDay(y, m + 2) }; }
/** The last calendar quarter that has ended before `today`. */
function lastCompleteQuarter(today) {
  const [y, m] = ym(today); let q = Math.floor((m - 1) / 3); let yy = y; // q: the current quarter, 0-based
  if (q === 0) { q = 4; yy = y - 1; }
  return calendarQuarter(yy, q);
}
/** The `n` calendar quarters that have ended before `today`, newest first. */
function completeQuarters(today, n = 8) {
  const out = []; let { from } = lastCompleteQuarter(today);
  for (let i = 0; i < n; i++) {
    const [y, m] = ym(from); const q = Math.floor((m - 1) / 3) + 1;
    out.push({ ...calendarQuarter(y, q), y, q });
    from = q === 1 ? calendarQuarter(y - 1, 4).from : calendarQuarter(y, q - 1).from;
  }
  return out;
}
/** The `n` calendar months that have ended before `today`, newest first. */
function completeMonths(today, n = 12) {
  const out = []; let [y, m] = ym(today);
  for (let i = 0; i < n; i++) { m--; if (m < 1) { m = 12; y--; } out.push({ from: `${y}-${pad(m)}-01`, to: lastDay(y, m), y, m }); }
  return out;
}
/** The start year of the California fiscal year a day falls in (July 2026 is in FY 2026-27, start year 2026). */
const fiscalYearOf = (day) => { const [y, m] = ym(day); return m >= 7 ? y : y - 1; };
const fyLabel = (sy) => `FY ${sy}-${pad((sy + 1) % 100)}`;
const fiscalYear = (sy) => ({ from: `${sy}-07-01`, to: `${sy + 1}-06-30` });
/** Quarter n (1-4) of the fiscal year starting in July of `sy`: Q1 Jul–Sep, Q2 Oct–Dec, Q3 Jan–Mar, Q4 Apr–Jun. */
const fiscalQuarter = (sy, n) => (n <= 2 ? calendarQuarter(sy, n + 2) : calendarQuarter(sy + 1, n - 2));
/** "Apr – Jun 2026", "Jul 2025 – Jun 2026", "Apr 1 – 15, 2026" for a period that is not whole months. */
function monthsLabel(from, to) {
  const [fy, fm] = ym(from); const [ty, tm] = ym(to);
  const whole = from.slice(8) === '01' && to === lastDay(ty, tm);
  if (!whole) return `${MON[fm - 1]} ${Number(from.slice(8))}${fy !== ty ? `, ${fy}` : ''} – ${fm === tm && fy === ty ? '' : `${MON[tm - 1]} `}${Number(to.slice(8))}, ${ty}`;
  if (fy === ty && fm === tm) return `${MON[fm - 1]} ${fy}`;
  return fy === ty ? `${MON[fm - 1]} – ${MON[tm - 1]} ${ty}` : `${MON[fm - 1]} ${fy} – ${MON[tm - 1]} ${ty}`;
}
/**
 * What a period is, in words, when it is one of the standard ones: "calendar Q2 2026 · FY 2025-26 Q4", "FY 2025-26",
 * "calendar year 2025"; or null (not a whole quarter, fiscal year or calendar year).
 */
function describe(from, to) {
  const [y, m] = ym(from);
  if (from.slice(5) === '01-01' && to === `${y}-12-31`) return `calendar year ${y}`;
  if (from.slice(5) === '07-01' && to === `${y + 1}-06-30`) return fyLabel(y);
  if ((m - 1) % 3 === 0 && from.slice(8) === '01') {
    const q = Math.floor((m - 1) / 3) + 1; const cq = calendarQuarter(y, q);
    if (cq.to === to) { const sy = fiscalYearOf(from); const fq = q >= 3 ? q - 2 : q + 2; return `calendar Q${q} ${y} · ${fyLabel(sy)} Q${fq}`; }
  }
  return null;
}
/** Is the period a whole calendar (or fiscal) quarter? */
const isQuarter = (from, to) => { const d = describe(from, to); return !!d && d.startsWith('calendar Q'); };

/**
 * The county view's presets (U12): the last quarter; the fiscal year so far and the last whole one with their
 * quarters that have ended; the last calendar year; the year to date. [{ key, label, from, to }]
 */
function presets(today) {
  const out = []; const lq = lastCompleteQuarter(today);
  out.push({ key: 'lq', label: `Last quarter (${monthsLabel(lq.from, lq.to)})`, ...lq });
  const cur = fiscalYearOf(today);
  for (const sy of [cur, cur - 1]) {
    const fy = fiscalYear(sy);
    if (fy.to < today) out.push({ key: `fy${sy}`, label: `${fyLabel(sy)} (${monthsLabel(fy.from, fy.to)})`, ...fy });
    else if (fy.from < today) { const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10); out.push({ key: `fy${sy}td`, label: `${fyLabel(sy)} to date`, from: fy.from, to: yesterday < fy.from ? fy.from : yesterday }); }
    for (let n = 1; n <= 4; n++) { const q = fiscalQuarter(sy, n); if (q.to < today) out.push({ key: `fy${sy}q${n}`, label: `${fyLabel(sy)} Q${n} (${monthsLabel(q.from, q.to)})`, ...q }); }
  }
  const y = Number(today.slice(0, 4));
  out.push({ key: `cy${y - 1}`, label: `Calendar year ${y - 1}`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` });
  out.push({ key: 'ytd', label: `Year to date (${y})`, from: `${y}-01-01`, to: today });
  return out;
}
/**
 * The periods the Send to the county card offers (U3): the calendar quarters that have ended (newest first, the
 * default the first), each said as its fiscal quarter too; the fiscal years and calendar year that have ended.
 */
function submissionPeriods(today) {
  const out = completeQuarters(today, 8).map((q, i) => ({ key: `q${q.y}${q.q}`, label: `${monthsLabel(q.from, q.to)} (${describe(q.from, q.to)})`, from: q.from, to: q.to, default: i === 0 }));
  const cur = fiscalYearOf(today);
  for (const sy of [cur - 1, cur - 2]) { const fy = fiscalYear(sy); if (fy.to < today) out.push({ key: `fy${sy}`, label: `${fyLabel(sy)}, the whole fiscal year (${monthsLabel(fy.from, fy.to)})`, ...fy }); }
  const y = Number(today.slice(0, 4));
  out.push({ key: `cy${y - 1}`, label: `Calendar year ${y - 1}`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` });
  return out;
}

module.exports = { calendarQuarter, lastCompleteQuarter, completeQuarters, completeMonths, fiscalYearOf, fyLabel, fiscalYear, fiscalQuarter, monthsLabel, describe, isQuarter, presets, submissionPeriods };
