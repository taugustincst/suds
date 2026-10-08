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
 * Parse a typed date into "YYYY-MM-DD", or null. Accepts "10/5/2026", "10-05-2026", "2026-10-05",
 * "10.5.26", and "20261005". Month/day order is US (month first). A two-digit year slides: up to next
 * year's is this century, anything later the last ("7/9/81" is a date of birth in 1981, not 2081, which
 * was refused as in the future; in 2026, "27" is 2027 and "28" is 1928). `now` is for the unit tests.
 * Exported for the unit tests.
 */
export function parseDate(s, now = new Date()) {
  const t = String(s || '').trim();
  if (!t) return null;
  let y, mth, d;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { y = +m[1]; mth = +m[2]; d = +m[3]; }
  else {
    m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
    if (m) {
      mth = +m[1]; d = +m[2]; y = +m[3];
      if (m[3].length === 2) { const year = now.getFullYear(); const century = year - (year % 100); y += y <= (year % 100) + 1 ? century : century - 100; }
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
