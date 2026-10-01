import { h, post, state, toast, can } from './app.js';

// Street outreach's waiting list (1.23.0; docs/USER_GUIDE.md "Street outreach", docs/security/DATA-INVENTORY.md).
//
// On the office app a phone that loses signal could not save a street-outreach contact at all: the form kept it
// until there was signal again. A contact that NAMES NOBODY now waits on the phone instead, and is sent when the
// phone is back online (the browser's online event, the first answer from the office after a failure, the header
// drawn after signing in again) or when the worker presses Send now. Each item is sent with the Idempotency-Key the
// screen first tried it with, so however often it is sent, and however late, the office makes one contact of it and
// takes its supplies off the stock once (server/crud.js keyedId).
//
// What waits, and why only that (an owner decision, conservative default): the office app keeps no PHI in browser
// storage, phones are shared, and a record that identifies a client of a SUD programme is a 42 CFR Part 2 record.
// So only a contact with no client, no participant code and no notes waits; it holds the kind of contact, a coarse
// place (Street, Shelter…), the time, the supplies handed out and the supply site, and the worker's account id so
// that it is sent only as them. That is not about anyone, so it is not encrypted with a session key (a key that
// went with the session would lose the contact the worker was promised would be sent at the next sign-in). A
// contact with a participant code or notes is not kept: the screen says so, and offers to keep it without them.
// The office refuses anything else from this list (X-Suds-Queued, server/routes/interventions.js checkQueued).
// Not used on a device's offline copy or on SUDS on this device: there the device itself saves the contact.
//
// Stored in IndexedDB `suds-outreach-queue` (store `contacts`, keyed by the Idempotency-Key). Signing out leaves a
// worker's waiting contacts for their next sign-in; another account signing in on the same phone neither sees nor
// sends them. Discard removes one for good.

const DB_NAME = 'suds-outreach-queue';
const STORE = 'contacts';
const CHANGED = 'suds:outreach-queue';
// Never kept: anything that could identify a person (and anything that would move money or make a to-do).
export const NOT_KEPT = ['client_id', 'summary', 'participant_code', 'note', 'follow_up_due', 'cost', 'funding_source_id', 'budget_line_id'];
/** Whether a contact's payload names or describes someone, so it cannot wait on the phone. */
export const identifies = (p) => NOT_KEPT.some(k => p[k] !== undefined && p[k] !== null && p[k] !== '');

let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      let r;
      try { r = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'key' }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    }).catch((e) => { dbp = null; throw e; });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode); const s = t.objectStore(STORE);
    let out; const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('aborted'));
  });
}
const changed = () => { try { window.dispatchEvent(new CustomEvent(CHANGED)); } catch { /* ignore */ } };
export const onChange = (fn) => { window.addEventListener(CHANGED, fn); return () => window.removeEventListener(CHANGED, fn); };

/** Whether this browser can keep a contact at all (a private window may refuse IndexedDB). */
export async function available() { try { await open(); return true; } catch { return false; } }

/** Keep a contact to send later. `what`: the screen's own words for what was given ("2 Naloxone kits"). */
export async function keep({ key, payload, what, typeLabel }) {
  if (!state.user || state.local) throw new Error('not on the office app');
  if (identifies(payload)) throw new Error('A contact with a participant code or notes is not kept on this phone.');
  await tx('readwrite', (s) => s.put({ key, user_id: state.user.id, payload, what: what || '', type_label: typeLabel || '', queued_at: new Date().toISOString(), error: null }));
  changed();
}
/** This account's waiting contacts, oldest first. */
export async function waiting() {
  if (!state.user || state.local) return [];
  let all = [];
  try { all = (await tx('readonly', (s) => s.getAll())) || []; } catch { return []; }
  return all.filter(x => x.user_id === state.user.id).sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
}
export async function discard(key) { await tx('readwrite', (s) => s.delete(key)); changed(); }

let flushing = null;
/**
 * Send this account's waiting contacts. `all`: also the ones the office refused before (Send now); otherwise those
 * are left for the worker to look at. Stops at the first sign of no signal or an ended session. Returns
 * { sent, failed, left }.
 */
export function flush({ all = false } = {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0, failed = 0;
    for (const item of await waiting()) {
      if (item.error && !all) continue;
      try {
        await post('/api/interventions', item.payload, { idempotencyKey: item.key, headers: { 'X-Suds-Queued': '1' }, quiet: true });
        await tx('readwrite', (s) => s.delete(item.key)); sent++;
      } catch (e) {
        if (e && (e.offline || e.status === 401 || e.status === 403 || e.status >= 500 || e.status === 429)) break;
        failed++;
        await tx('readwrite', (s) => s.put({ ...item, error: (e && e.message) || 'The office did not accept it.', failed_at: new Date().toISOString() }));
      }
    }
    const left = (await waiting()).length;
    changed();
    if (sent) toast(`${sent} waiting contact${sent === 1 ? '' : 's'} sent to the office${left ? `; ${left} still waiting` : ''}.`, 'ok');
    if (failed) toast(`${failed} waiting contact${failed === 1 ? ' was' : 's were'} not accepted by the office: see Street outreach.`, 'error');
    return { sent, failed, left };
  })().finally(() => { flushing = null; });
  return flushing;
}

let lastAuto = 0;
/** Send what is waiting, unprompted, at most every 20 seconds (the header asks on every page). */
export function autoFlush() {
  if (state.local || !state.user || state.offline || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  if (Date.now() - lastAuto < 20000) return;
  lastAuto = Date.now();
  waiting().then((w) => { if (w.some(x => !x.error)) flush(); }, () => {});
}
window.addEventListener('online', () => { lastAuto = 0; autoFlush(); });

/**
 * The header's "N contacts waiting to send" (office app only), shown only while there are some. It opens Street
 * outreach, where the list is, with Send now and Discard. Drawing it also sends what is waiting when there is signal.
 */
export function queueChip() {
  if (state.local || window.SUDS_STATIC_HOST || !state.user || !can('interventions:write')) return null;
  const a = h('a', { class: 'btn ghost sm sync-chip pending queue-chip', href: '#/outreach', 'data-queue-chip': '0', hidden: true });
  const paint = async () => {
    if (!a.isConnected && a.dataset.drawn) { off(); return; }
    a.dataset.drawn = '1';
    const w = await waiting(); const n = w.length;
    a.hidden = !n; a.dataset.queueChip = String(n);
    a.replaceChildren(h('span', { 'aria-hidden': 'true' }, '⏳ '), h('span', { class: 'sync-long' }, `${n} contact${n === 1 ? '' : 's'} waiting to send`),
      h('span', { class: 'sync-short', 'aria-hidden': 'true' }, String(n)),
      h('span', { class: 'sr-only' }, ` — ${n} street outreach contact${n === 1 ? '' : 's'} kept on this phone until there is signal. Open Street outreach to see ${n === 1 ? 'it' : 'them'}`));
  };
  const off = onChange(paint);
  paint().then(() => autoFlush(), () => {});
  return a;
}
