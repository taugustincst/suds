// Typed time/date parsing for the keyboard-first time and date boxes (1.24.3).
// Pure: no DOM, no imports, so it can be unit-tested from node. The bodies here are
// identical to the ones in public/app.js, which imports and re-exports them.

/**
 * Parse a typed time of day into 24-hour "HH:MM", or null when it is not a time. Accepts "14:30",
 * "2:30", "1430", "930", "2:30p", "2:30 pm", "14.30", "2pm", "2 p", "9" — whatever a person or a phone
 * keypad produces. An hour alone is on the hour. Without am/pm it is read on the 24-hour clock, as "930" is
 * (09:30): "9" is 09:00 and "14" is 14:00; "9p" or "9 pm" is 21:00.
 */
export function parseTime(s) {
  const t = String(s || '').trim().toLowerCase().replace(/[\s.]/g, '');
  if (!t) return null;
  let core = t, ampm = null;
  const m = core.match(/^(.*?)(am|pm|a|p)$/);
  if (m) { core = m[1]; ampm = m[2][0] === 'a' ? 'am' : 'pm'; }
  core = core.replace(/[:-]/g, '');
  if (!/^\d{1,4}$/.test(core)) return null;
  let hh, mm;
  if (core.length <= 2) { hh = Number(core); mm = 0; }
  else if (core.length === 3) { hh = Number(core[0]); mm = Number(core.slice(1)); }
  else { hh = Number(core.slice(0, 2)); mm = Number(core.slice(2)); }
  if (mm > 59) return null;
  if (ampm) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (hh > 23) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * The full year of a two-digit year `yy` typed in `year`. Which century depends on the field (F2): for a date
 * that can only be in the past (`past`: a date of birth) it is the latest year not after this one ("7/9/81" is
 * 1981; in 2026, "27" is 1927); for any other date, such as a consent's expiry or a due date, it is within 20
 * years ahead and 80 behind (in 2026, "28" is 2028, "46" 2046 and "47" 1947), so a typed expiry is not 1928.
 * server/dataimport.js reads a spreadsheet's two-digit years by the same rule.
 */
export function fullYear(yy, year, past = false) {
  let y = year - (year % 100) + yy;
  if (past) { if (y > year) y -= 100; } else if (y > year + 20) y -= 100; else if (y <= year - 80) y += 100;
  return y;
}

/**
 * Parse a typed date into "YYYY-MM-DD", or null. Accepts "10/5/2026", "10-05-2026", "2026-10-05",
 * "10.5.26", "20261005", and a month and day alone, "10/8". Month/day order is US (month first). A two-digit
 * year is read by fullYear(), into the past for a field that is never in the future (`{ past: true }`). A
 * month and day alone is this year's (FL3); for a past-only field, last year's when this year's is still to
 * come, and for a field that looks ahead (`{ future: true }`: a due or follow-up date) next year's when this
 * year's has gone. `now` is for the unit tests. Exported for the unit tests.
 */
export function parseDate(s, now = new Date(), { past = false, future = false } = {}) {
  const t = String(s || '').trim();
  if (!t) return null;
  let y, mth, d;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { y = +m[1]; mth = +m[2]; d = +m[3]; }
  else if ((m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})$/))) {
    mth = +m[1]; d = +m[2]; y = now.getFullYear();
    const typed = mth * 100 + d; const today = (now.getMonth() + 1) * 100 + now.getDate();
    if (past && typed > today) y -= 1; else if (future && typed < today) y += 1;
  }
  else {
    m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
    if (m) {
      mth = +m[1]; d = +m[2]; y = +m[3];
      if (m[3].length === 2) y = fullYear(y, now.getFullYear(), past);
    }
    else { m = t.match(/^(\d{4})(\d{2})(\d{2})$/); if (!m) return null; y = +m[1]; mth = +m[2]; d = +m[3]; }
  }
  if (mth < 1 || mth > 12 || d < 1 || d > 31) return null;
  // Impossible dates (Feb 30) fail the round-trip through the Date constructor.
  const dt = new Date(y, mth - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mth - 1 || dt.getDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(mth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const fmtMDY = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${+m[2]}/${+m[3]}/${m[1]}` : (iso || ''); };
