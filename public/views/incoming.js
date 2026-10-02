// Incoming referrals (built for 1.24.0): the intake queue of people referred TO the programme by a hospital, a jail,
// a detox, probation or a court, another provider, themselves or their family (server/incoming-referrals.js).
//   #/incoming            the queue, with filters by status, assignee and urgency, and a search by surname
//   #/incoming/<id>       one referral: its details, the attempts to reach the person, and the actions
// Accepting links the referral to a client: one of the possible matches the duplicate check finds (only records the
// worker may open), one found with the client search, or a new client made from the referral's details (the usual
// New client form, with its own duplicate check). Nothing is ever sent back to the referrer: that would be a
// disclosure (docs/USER_GUIDE.md "Incoming referrals").
import { h, route, get, post, put, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, filterBar, pagedList, emptyState, kv, confirmDialog } from '../app.js';

export const SOURCE_LABELS = { er_hospital: 'Emergency department or hospital', jail_reentry: 'Jail or re-entry', detox: 'Detox or withdrawal management', justice: 'Probation, parole or court', other_provider: 'Another provider or agency', self: 'Self-referral', family_friend: 'Family or friend', other: 'Other' };
const VIA_LABELS = { phone: 'Phone call', fax: 'Fax', email: 'Email', walk_in: 'Walk-in', ereferral: 'eReferral' };
const URGENCY_LABELS = { routine: 'Routine', soon: 'Soon (within a few days)', urgent: 'Urgent (today)' };
const STATUS_LABELS = { new: 'New', contacting: 'Contacting', accepted: 'Accepted', declined: 'Declined', unable_to_reach: 'Unable to reach', referred_elsewhere: 'Referred elsewhere' };
const METHOD_LABELS = { phone: 'Phone call', text: 'Text message', email: 'Email', in_person: 'In person', letter: 'Letter', other: 'Other' };
const OUTCOME_LABELS = { reached: 'Reached them', left_message: 'Left a message', no_answer: 'No answer', wrong_number: 'Wrong number', other: 'Other' };
const opts = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }));
const statusKind = (s) => ({ new: 'warn', contacting: 'info', accepted: 'ok' }[s] || '');
const urgencyBadge = (u) => (u === 'urgent' ? badge('Urgent', 'danger') : u === 'soon' ? badge('Soon', 'warn') : badge('Routine'));
/** "2.5 hours", "3 days": time to first contact, in words. */
export function hoursText(hrs) {
  if (hrs === null || hrs === undefined) return '—';
  if (hrs < 1) return 'under an hour';
  if (hrs < 48) return `${Math.round(hrs * 10) / 10} hour${hrs === 1 ? '' : 's'}`;
  return `${Math.round(hrs / 24)} days`;
}
/** The queue's numbers are worked here only on a database that keeps the queue (not a device that syncs with an office). */
export const queueHere = () => !state.local || !!window.SUDS_STATIC_HOST;

/** Record a new incoming referral, or change an open one's details. */
export function openIncomingForm(values = null, { onDone } = {}) {
  const isNew = !values;
  const staff = state.users.filter(u => u.is_active !== 0 && !['finance', 'readonly'].includes(u.role));
  const f = form([
    { type: 'section', label: 'Who was referred' },
    { name: 'first_name', label: 'First name' },
    { name: 'last_name', label: 'Last name', help: 'A name, or a phone number below, so somebody can reach them.' },
    { name: 'dob', label: 'Date of birth', type: 'date', max: fmt.today() },
    { name: 'phone', label: 'Their phone', type: 'tel' },
    { type: 'section', label: 'The referral' },
    { name: 'source_type', label: 'Referred by', type: 'select', required: true, options: opts(SOURCE_LABELS) },
    { name: 'referring_org', label: 'Referring organization', help: 'The hospital, jail, court or agency, if any.' },
    { name: 'received_via', label: 'How it arrived', type: 'select', required: true, options: opts(VIA_LABELS) },
    { name: 'received_at', label: 'Received', type: 'datetime', required: true, value: new Date().toISOString() },
    { name: 'urgency', label: 'Urgency', type: 'select', noBlank: true, options: opts(URGENCY_LABELS), value: 'routine' },
    { name: 'assigned_to', label: 'Assigned to', type: 'select', options: staff.map(u => ({ value: u.id, label: u.display_name })), placeholder: 'Nobody yet' },
    { name: 'reason', label: 'Reason and needs', type: 'textarea', span: true, rows: 3 },
    { type: 'section', label: 'Who made the referral', collapsible: true, heading: true, key: 'referrer', open: !!(values && (values.referrer_name || values.referrer_phone || values.referrer_email)) },
    { name: 'referrer_name', label: 'Their name' },
    { name: 'referrer_phone', label: 'Their phone', type: 'tel' },
    { name: 'referrer_email', label: 'Their email', type: 'email' },
    { type: 'section', end: true },
    { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 2 },
  ], { values: values || {}, submitText: isNew ? 'Save referral' : 'Save changes', onCancel: () => m.close(), draftKey: isNew ? 'incoming:new' : `incoming:${values.id}`, onSubmit: async (d) => {
    for (const k of Object.keys(d)) if (d[k] === null && isNew) delete d[k];
    const r = isNew ? await post('/api/incoming-referrals', d) : await put(`/api/incoming-referrals/${values.id}`, d);
    toast(isNew ? 'Referral recorded' : 'Referral updated', 'ok'); m.close();
    onDone ? onDone(r.id || values.id) : nav(`incoming/${r.id || values.id}`);
  } });
  const m = modal(isNew ? 'Incoming referral' : 'Edit incoming referral', h('div', { 'data-incoming-form': '1' },
    h('p', { class: 'small muted' }, 'Someone referred to this program by a hospital, jail, detox, probation, another provider, themselves or their family. Recording it shares nothing with anyone.'), f), { wide: true });
}

function logAttempt(row, refresh) {
  const f = form([
    { name: 'attempted_at', label: 'When', type: 'datetime', required: true, value: new Date().toISOString() },
    { name: 'method', label: 'How', type: 'select', required: true, options: opts(METHOD_LABELS), value: 'phone' },
    { name: 'outcome', label: 'What happened', type: 'select', required: true, options: opts(OUTCOME_LABELS) },
    { name: 'notes', label: 'Note', type: 'textarea', span: true, rows: 2 },
  ], { submitText: 'Save attempt', onCancel: () => m.close(), onSubmit: async (d) => {
    await post(`/api/incoming-referrals/${row.id}/attempts`, d);
    toast('Attempt logged', 'ok'); m.close(); refresh();
  } });
  const m = modal('Log an attempt to reach them', f);
}

function closeReferral(row, refresh) {
  const f = form([
    { name: 'status', label: 'Outcome', type: 'select', required: true, options: [{ value: 'declined', label: 'Declined' }, { value: 'unable_to_reach', label: 'Unable to reach' }, { value: 'referred_elsewhere', label: 'Referred elsewhere' }] },
    { name: 'reason', label: 'Why, or where to', type: 'textarea', span: true, rows: 3, help: 'Required for a decline (why) and a referral elsewhere (where to). Kept in SUDS; nothing is sent to the referrer.' },
  ], { submitText: 'Close referral', onCancel: () => m.close(), onSubmit: async (d) => {
    await post(`/api/incoming-referrals/${row.id}/close`, d);
    toast('Referral closed', 'ok'); m.close(); refresh();
  } });
  const m = modal('Close without a client', f);
}

/** Accept: link to a client the worker may open, or make a new one from the referral's details. */
async function acceptReferral(row, may, refresh) {
  const link = async (clientId) => {
    try { await post(`/api/incoming-referrals/${row.id}/accept`, { client_id: clientId }); toast('Referral accepted and linked to the client', 'ok'); refresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  let matches = [];
  if (may.link) { try { matches = (await get(`/api/incoming-referrals/${row.id}/matches`)).matches; } catch (e) { matches = []; } }
  const body = h('div', { 'data-accept-dialog': '1' });
  if (may.link) {
    body.append(h('h3', {}, 'Already a client?'),
      matches.length ? h('ul', { class: 'tight', 'data-accept-matches': String(matches.length) }, matches.map(x => h('li', {},
        h('b', {}, x.display_name || x.client_code), ' ', h('span', { class: 'muted small' }, x.client_code, x.dob ? ` · born ${fmt.date(x.dob)}` : ''),
        h('div', { class: 'small muted' }, `Matched on ${x.reasons.join(' and ')}.`),
        h('button', { class: 'btn sm primary', type: 'button', 'data-link-client': x.id, onClick: () => { m.close(); link(x.id); } }, `Link to ${x.client_code}`))))
        : h('p', { class: 'small muted', 'data-accept-matches': '0' }, 'No existing record you can open matches their name, date of birth or phone.'));
    const f = form([{ name: 'client_id', label: 'Find the client', type: 'client', required: true }], { submitText: 'Link to this client', onCancel: () => m.close(), onSubmit: async (d) => { m.close(); await link(d.client_id); } });
    body.append(f);
  }
  if (may.create_client) {
    body.append(h('h3', {}, 'A new client'), h('p', { class: 'small muted' }, 'Opens New client — full intake with what the referral says. Its own duplicate check runs as you save.'),
      h('button', { class: 'btn primary', type: 'button', 'data-accept-new': '1', onClick: async () => {
        m.close();
        const { openClientForm } = await import('./clients.js');
        const prefill = { first_name: row.first_name || '', last_name: row.last_name || '', dob: row.dob || '', phone: row.phone || '',
          referral_source: [SOURCE_LABELS[row.source_type], row.referring_org].filter(Boolean).join(' — ').slice(0, 120), referral_date: String(row.received_at || '').slice(0, 10), status: 'active', intake_date: fmt.today() };
        openClientForm(null, (clientId) => link(clientId), { full: true, prefill });
      } }, 'Create a new client from this referral'));
  }
  const m = modal('Accept this referral', body, { wide: true });
}

async function detail(id) {
  const { row, attempts, may } = await get(`/api/incoming-referrals/${id}`);
  const refresh = () => nav(`incoming/${id}?_=${Date.now()}`);
  const actions = [];
  if (may.write && row.open) {
    actions.push(h('button', { class: 'btn primary', 'data-log-attempt': '1', onClick: () => logAttempt(row, refresh) }, 'Log an attempt'));
    if (may.link || may.create_client) actions.push(h('button', { class: 'btn', 'data-accept': '1', onClick: () => acceptReferral(row, may, refresh) }, 'Accept'));
    actions.push(h('button', { class: 'btn', 'data-close-referral': '1', onClick: () => closeReferral(row, refresh) }, 'Close without a client'));
    if (row.assigned_to !== state.user.id) actions.push(h('button', { class: 'btn', 'data-assign-me': '1', onClick: async () => { await put(`/api/incoming-referrals/${id}`, { assigned_to: state.user.id }); toast('Assigned to you', 'ok'); refresh(); } }, 'Assign to me'));
    actions.push(h('button', { class: 'btn', 'data-edit-referral': '1', onClick: () => openIncomingForm(row, { onDone: refresh }) }, 'Edit'));
  }
  if (may.write && !row.open && row.status !== 'accepted') actions.push(h('button', { class: 'btn', 'data-reopen': '1', onClick: async () => {
    if (!await confirmDialog('Reopen this referral?', 'It goes back on the queue to be worked.', { okText: 'Reopen' })) return;
    await post(`/api/incoming-referrals/${id}/reopen`, {}); toast('Referral reopened', 'ok'); refresh();
  } }, 'Reopen'));
  const closedLine = row.status === 'accepted'
    ? h('p', { 'data-accepted-client': row.client_id }, `Accepted ${fmt.dt(row.closed_at)} by ${row.closed_by_name || '—'}, as ${row.accepted_as === 'new' ? 'a new' : 'an existing'} client: `, h('a', { href: `#/client/${row.client_id}` }, `open ${row.client_code || 'the client'}`), '.')
    : !row.open ? h('p', {}, `${STATUS_LABELS[row.status]} ${fmt.dt(row.closed_at)} by ${row.closed_by_name || '—'}${row.outcome_reason ? `: ${row.outcome_reason}` : '.'}`) : null;
  return h('div', { 'data-incoming-detail': row.id },
    pageHead('Incoming referral', ...actions),
    h('p', {}, h('a', { href: '#/incoming' }, '← Back to the queue')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, row.display_name), h('div', { class: 'row' }, badge(STATUS_LABELS[row.status], statusKind(row.status)), urgencyBadge(row.urgency))),
      closedLine,
      kv([
        ['Referred by', [SOURCE_LABELS[row.source_type], row.referring_org].filter(Boolean).join(' — ')],
        ['Received', `${fmt.dt(row.received_at)} · ${VIA_LABELS[row.received_via] || row.received_via}`],
        ['Reason and needs', row.reason],
        ['Date of birth', row.dob ? fmt.date(row.dob) : null],
        ['Phone', row.phone],
        ['Assigned to', row.assignee_name || 'Nobody yet'],
        ['Time to first contact', h('span', { 'data-first-contact': row.first_contact_at ? '1' : '0' }, row.first_contact_at ? `${hoursText(row.hours_to_first_contact)} (first attempt ${fmt.dt(row.first_contact_at)})` : 'Nobody has tried to reach them yet')],
        ['Referrer', [row.referrer_name, row.referrer_phone, row.referrer_email].filter(Boolean).join(' · ') || null],
        ['Notes', row.notes],
        ['Recorded by', `${row.created_by_name || '—'}, ${fmt.dt(row.created_at)}`],
      ]),
      h('p', { class: 'small muted' }, 'Receiving a referral is not a disclosure. SUDS does not tell the referrer what happened: answering them about this person needs the person\'s consent, recorded on their Consents tab.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Attempts to reach them'), badge(String(attempts.length))),
      attempts.length ? table([
        { label: 'When', render: a => fmt.dt(a.attempted_at) },
        { label: 'How', render: a => METHOD_LABELS[a.method] || a.method },
        { label: 'What happened', render: a => OUTCOME_LABELS[a.outcome] || a.outcome },
        { label: 'Note', render: a => a.notes || '—' },
        { label: 'By', render: a => a.user_name || '—' },
      ], attempts) : emptyState('No attempts yet', 'Log each call, text or visit, and what happened. The first one sets the time to first contact.')));
}

route('incoming', async (r) => {
  if (!queueHere()) return h('div', {}, pageHead('Incoming referrals'), h('p', { class: 'banner info' }, 'Incoming referrals are kept at the office. Open the office SUDS to record or work one.'));
  if (r.id) return detail(r.id);
  const status = r.query.get('status') || 'open'; const assigned = r.query.get('assigned_to') || ''; const urgency = r.query.get('urgency') || ''; const q = r.query.get('q') || '';
  const params = { status, assigned_to: assigned, urgency, q };
  const qs = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const go = (o) => nav('incoming?' + Object.entries({ ...params, ...o }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'));
  const [data, sum] = await Promise.all([get(`/api/incoming-referrals?limit=100&${qs}`), get('/api/incoming-referrals/summary')]);
  const select = (name, label, value, options) => h('div', { class: 'field' }, h('label', {}, label), h('select', { name, onChange: (e) => go({ [name]: e.target.value }) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
  const staff = state.users.filter(u => u.is_active !== 0 && !['finance', 'readonly'].includes(u.role));
  const search = h('input', { type: 'search', name: 'q', id: 'incoming-search', value: q, placeholder: 'Surname or organization' });
  const on = (status !== 'open') + !!assigned + !!urgency + !!q;
  const fc = sum.first_contact;
  return h('div', { 'data-incoming-queue': '1' },
    pageHead('Incoming referrals', can('intake:write') ? h('button', { class: 'btn primary', 'data-new-incoming': '1', onClick: () => openIncomingForm(null) }, '+ Incoming referral') : null),
    h('p', { class: 'muted' }, 'People referred to this program who are not clients yet: try to reach them, then accept them as a client or close the referral. Everyone who works intake sees the whole queue.'),
    h('div', { class: 'row small', 'data-incoming-summary': '1' },
      h('span', {}, `${sum.new} new · ${sum.contacting} contacting · ${sum.unassigned} unassigned`),
      h('span', { class: 'muted', 'data-first-contact-median': fc.median_hours === null ? '' : String(fc.median_hours) }, fc.contacted ? `Time to first contact, last ${fc.days} days: median ${hoursText(fc.median_hours)} (${fc.contacted} of ${fc.received} referrals tried; ${fc.within_24h} within 24 hours)` : `No referral in the last ${fc.days} days has had an attempt to reach the person yet.`)),
    filterBar(on,
      select('status', 'Status', status, [['open', 'Open (new and contacting)'], ['new', 'New'], ['contacting', 'Contacting'], ['closed', 'Closed'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['unable_to_reach', 'Unable to reach'], ['referred_elsewhere', 'Referred elsewhere'], ['all', 'All']]),
      select('assigned_to', 'Assigned to', assigned, [['', 'Anyone'], ['me', 'Me'], ['none', 'Nobody yet'], ...staff.map(u => [u.id, u.display_name])]),
      select('urgency', 'Urgency', urgency, [['', 'Any'], ['urgent', 'Urgent'], ['soon', 'Soon'], ['routine', 'Routine']]),
      h('div', { class: 'field' }, h('label', { for: 'incoming-search' }, 'Search'), h('form', { class: 'row', onSubmit: (e) => { e.preventDefault(); go({ q: search.value.trim() }); } }, search, h('button', { class: 'btn sm', type: 'submit' }, 'Search')))),
    pagedList({ first: data, url: `/api/incoming-referrals?${qs}`, limit: 100, summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} referral${total === 1 ? '' : 's'}`),
      render: (rows) => (rows.length ? table([
        { label: 'Person', render: x => x.display_name },
        { label: 'Urgency', render: x => urgencyBadge(x.urgency) },
        { label: 'Referred by', render: x => h('div', {}, SOURCE_LABELS[x.source_type] || x.source_type, x.referring_org ? h('div', { class: 'small muted' }, x.referring_org) : null) },
        { label: 'Received', render: x => fmt.dt(x.received_at) },
        { label: 'Status', render: x => badge(STATUS_LABELS[x.status] || x.status, statusKind(x.status)) },
        { label: 'Attempts', num: true, render: x => String(x.attempts_count) },
        { label: 'Assigned to', render: x => x.assignee_name || '—' },
      ], rows, { onRow: (x) => nav(`incoming/${x.id}`) }) : emptyState('No referrals here', status === 'open' ? 'Nobody is waiting. A referral from a hospital, jail, detox, court or anyone else goes in with + Incoming referral.' : 'None match these filters.')) }));
});
