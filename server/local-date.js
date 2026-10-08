'use strict';
// The programme's calendar: what date it is, and when a day begins, in the organisation's time zone. Every
// "today" on the server is today() — never new Date().toISOString().slice(0, 10), which is the UTC date and
// in California is tomorrow's from 5pm (4pm in winter): an intake that evening was dated tomorrow, and with
// CalOMS on its default admission date was then refused as "in the future" (evaluation of 1.25.0, E1).
// Moved here from server/routes/budget.js, which still exports these names.
// db and config are required when first asked, so any module (db.js's own dependencies included) may require this one.

/** True for a time zone name this runtime knows (IANA, e.g. "America/Los_Angeles"). */
function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try { formatter('en-US', { timeZone: tz }); return true; } catch { return false; }
}
// Building an Intl.DateTimeFormat costs tens of microseconds, and "today in the programme's time zone" is asked
// for many times a request (every visit saved, every report period, every list of what is due). The formatters
// are made once per zone and kept; a zone the runtime does not know still throws, and is not kept.
const formatters = new Map();
function formatter(locale, opts) {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) { f = new Intl.DateTimeFormat(locale, opts); if (formatters.size > 200) formatters.clear(); formatters.set(key, f); }
  return f;
}
/**
 * The organisation's time zone: the org_timezone setting (Settings → Program settings) when an
 * administrator has chosen one, else ORG_TIMEZONE / server.json (config.orgTimezone), else the machine's.
 * On SUDS on this device the setting is the browser's zone at set-up (local/kernel.js).
 */
function orgTimezone() {
  let v = null; try { v = require('./db').getSetting('org_timezone', null); } catch { /* no database open (a unit test) */ }
  return v && validTimezone(v) ? v : require('./config').orgTimezone;
}
/** The calendar date (YYYY-MM-DD) of an instant in the organisation's time zone (orgTimezone()). */
function localDate(when = new Date(), tz = orgTimezone()) {
  const d = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(d.getTime())) return null;
  try { return formatter('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}

/**
 * The instant (ISO, UTC) at which calendar day `date` (YYYY-MM-DD) begins in the organisation's time zone.
 * A report "for June 30" runs from local midnight to local midnight: with the day's bounds taken in UTC
 * instead, a 5:30pm visit on June 30th in Los Angeles (00:30 UTC on July 1st) fell out of the fiscal year.
 * DST-safe: the offset is measured at the answer, not at the guess.
 */
function localMidnight(date, tz = orgTimezone()) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(guess)) return null;
  const offset = (ms) => {
    try {
      const p = Object.fromEntries(formatter('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - (ms - (ms % 1000));
    } catch { return 0; }
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first)).toISOString();
}

/** Today's date (YYYY-MM-DD) in the organisation's time zone. */
const today = () => localDate();
/** The calendar date `n` days after `date` (YYYY-MM-DD); calendar arithmetic, so no time zone is involved. */
const addDays = (date, n) => new Date(Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/**
 * True for a real calendar date written YYYY-MM-DD. The pattern alone is not enough: V8's Date.parse reads
 * "2026-09-31" as October 1st and "1990-02-30" as March 2nd, so an impossible date was stored as typed (BO5).
 */
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
/**
 * The programme's date of a stored value: an instant (ISO, UTC) is read on the programme's calendar, so a call at 9pm
 * in Los Angeles is that day's, not the next (its UTC date); a bare YYYY-MM-DD is already a date and is kept.
 */
function dayOf(at) {
  if (at === null || at === undefined || at === '') return null;
  const s = String(at);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (localDate(s) || s.slice(0, 10));
}

module.exports = { today, localDate, localMidnight, orgTimezone, validTimezone, addDays, dayOf, isRealDate, formatter };
