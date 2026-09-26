// Privacy & Part 2: the programme-level 42 CFR Part 2 controls in one place — whether this is a Part 2
// programme, the §2.22 patient notice (its text, and the active clients with no record of receiving it), the
// §2.4 complaint log, the privacy incident / breach register with its 60-day notification clock, and the
// register of QSOAs and research / audit approvals the non-consent disclosure bases rest on.
// Everything here is enforced and audited by the server (server/routes/part2.js, compliance.js);
// docs/compliance/PART2.md maps each rule to it. SUDS provides the controls; the programme's policies and
// counsel decide how they are used.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, stat, tabStrip, confirmDialog, clientPicker } from '../app.js';
import { AGREEMENT_KIND_LABELS } from './part2.js';

const CHANNELS = ['in_person', 'phone', 'mail', 'email', 'web', 'other'];
const COMPLAINANTS = ['client', 'representative', 'staff', 'anonymous', 'other'];
const STATUSES = ['open', 'investigating', 'resolved', 'closed'];
const DET = { pending: 'Not yet determined', breach: 'Breach — notices owed', not_breach: 'Not a breach (low probability of compromise)' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function printNotice(n) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the notice', 'error'); return; }
  w.document.open(); w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notice of privacy practices</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111;white-space:pre-wrap;line-height:1.45}</style></head><body>${esc(n.rendered)}\n\nVersion ${esc(n.version)}</body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}

route('compliance', async (r) => {
  const tabs = [
    (can('complaints:read') || can('incidents:read') || can('settings:manage')) ? ['overview', 'Overview'] : null,
    ['notice', 'Patient notice'],
    can('consents:read') ? ['notices', 'Notice not given'] : null,
    can('complaints:read') ? ['complaints', 'Complaints'] : null,
    can('incidents:read') ? ['incidents', 'Incidents & breaches'] : null,
    can('agreements:read') ? ['agreements', 'Agreements'] : null,
  ].filter(Boolean);
  const tab = tabs.some(([k]) => k === r.query.get('tab')) ? r.query.get('tab') : tabs[0][0];
  const refresh = () => nav(`compliance?tab=${tab}&_=${Date.now()}`);
  const body = h('div', { 'data-compliance-tab': tab });
  const T = {
    async overview() {
      const [s, cfg] = await Promise.all([get('/api/part2/summary'), get('/api/part2/settings')]);
      const settingsCard = can('settings:manage') ? h('div', { class: 'card mt' }, h('h2', {}, 'Programme settings'),
        form([
          { name: 'part2_program', label: 'This is a 42 CFR Part 2 programme (label records, attach the §2.32 notice, refuse general releases)', type: 'checkbox', value: cfg.part2_program, span: true },
          { name: 'part2_off_reason', label: 'Reason for switching Part 2 off (required to switch it off)', type: 'textarea', rows: 2, span: true,
            help: 'At least 20 characters — usually counsel\'s determination that this is not a federally assisted Part 2 program. Switching it off is audited, shown to administrators on Home, and opens a draft incident for review.' },
          { name: 'mass_export_threshold', label: 'Open a draft incident when one identified export names this many clients', type: 'number', min: 1, step: 1, value: cfg.mass_export_threshold },
        ], { submitText: 'Save', onSubmit: async (v) => {
          const r = await put('/api/part2/settings', v);
          toast(r.incident ? 'Saved. Part 2 is off: a draft incident was opened for review.' : 'Saved', 'ok'); refresh();
        } })) : null;
      return h('div', {},
        h('p', { class: 'small muted' }, 'SUDS enforces the controls; your programme\'s policies, training and counsel decide how they are used. See docs/compliance/PART2.md for the rule-by-rule matrix.'),
        h('div', { class: 'grid cols-4' },
          stat('Part 2 programme', s.part2_program ? 'Yes' : 'No', s.part2_program ? 'ok' : 'warn'),
          stat('Active clients with no notice', s.clients_missing_notice, s.clients_missing_notice ? 'warn' : '', can('consents:read') ? 'compliance?tab=notices' : null),
          stat('Active consents on the pre-2024 form', s.consents_legacy_active, s.consents_legacy_active ? 'warn' : ''),
          stat('Court orders in force', s.court_orders_active),
          stat('Disclosures, last 90 days', s.disclosures_90d),
          stat('SUD counseling notes', s.counseling_notes),
          stat('Open complaints', s.complaints_open, s.complaints_open ? 'warn' : '', can('complaints:read') ? 'compliance?tab=complaints' : null),
          stat('Open incidents', s.incidents_open, s.incidents_open ? 'danger' : '', can('incidents:read') ? 'compliance?tab=incidents' : null)),
        settingsCard);
    },
    async notice() {
      const n = await get('/api/part2/notice');
      const editor = can('settings:manage') ? h('details', { class: 'card mt', 'data-notice-editor': '1' }, h('summary', {}, 'Edit the notice'),
        h('p', { class: 'small muted' }, 'Every save is a new version; each client\'s record says which version they were given. {org}, {contact} and {effective} are filled in when the notice is shown. Have county counsel approve the wording.'),
        form([
          { name: 'notice_text', label: 'Notice text', type: 'textarea', rows: 18, span: true, value: n.text, required: true },
          { name: 'notice_effective_date', label: 'Effective date', type: 'date', value: n.effective_date || '' },
        ], { submitText: 'Save new version', onSubmit: async (v) => { await put('/api/part2/settings', v); toast('Notice saved as a new version', 'ok'); refresh(); } }),
        n.is_default ? null : h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('Restore the built-in notice', 'Replace your wording with the built-in starting text? This is a new version.', { okText: 'Restore' })) { await put('/api/part2/settings', { reset_notice: true }); refresh(); } } }, 'Restore the built-in wording')) : null;
      return h('div', {},
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Notice of privacy practices (42 CFR §2.22)'), h('div', { class: 'row' }, badge(`Version ${n.version}`, 'info'), n.is_default ? badge('Built-in starting text', 'warn') : null, h('button', { class: 'btn sm', 'data-print-notice': '1', onClick: () => printNotice(n) }, 'Print'))),
          h('p', { class: 'small muted' }, 'Give every client this notice when they start, and record it on their Consents tab (+ Notice given).'),
          h('pre', { class: 'note', 'data-notice-rendered': '1', style: { whiteSpace: 'pre-wrap' } }, n.rendered)),
        editor);
    },
    async notices() {
      const d = await get('/api/part2/notices/missing');
      return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Active clients with no Part 2 notice on record'), badge(String(d.total), d.total ? 'warn' : 'ok')),
        h('p', { class: 'small muted' }, 'Open the client, give them the notice, and record it on their Consents tab.'),
        table([{ label: 'Client', render: x => h('a', { href: `#/client/${x.id}/consents` }, x.display_name || x.client_code) }, { label: 'Code', key: 'client_code' }, { label: 'Intake', render: x => fmt.date(x.intake_date) }], d.rows,
          { empty: 'Every active client on your caseload has been given the notice.', onRow: x => nav(`client/${x.id}/consents`) }));
    },
    async complaints() {
      const year = fmt.today().slice(0, 4);
      const [list, rep] = await Promise.all([get('/api/complaints?status=all&limit=500'), get(`/api/complaints/report?from=${year}-01-01&to=${fmt.today()}`)]);
      const edit = (x) => {
        const f = form([
          ...(x ? [] : [{ name: 'client_id', label: 'Client (leave empty for an anonymous complaint or a non-client)', type: 'client' }]),
          { name: 'received_at', label: 'Received', type: 'date', required: true, value: x?.received_at || fmt.today() },
          { name: 'channel', label: 'How it came in', type: 'select', options: CHANNELS, noBlank: true, value: x?.channel || 'in_person' },
          { name: 'complainant', label: 'From', type: 'select', options: COMPLAINANTS, noBlank: true, value: x?.complainant || 'client' },
          { name: 'summary', label: 'What the complaint is about', type: 'textarea', required: true, span: true, rows: 3, value: x?.summary || '', help: 'Stored encrypted.' },
          { name: 'hhs_referral_given', label: 'Told they may also complain to the HHS Secretary (Office for Civil Rights)', type: 'checkbox', span: true, value: x?.hhs_referral_given },
          ...(x ? [
            { name: 'status', label: 'Status', type: 'select', options: STATUSES, noBlank: true, value: x.status },
            { name: 'resolution', label: 'How it was resolved', type: 'textarea', span: true, rows: 3, value: x.resolution || '', help: 'Required before it is resolved or closed. Stored encrypted.' },
            { name: 'retaliation_reviewed', label: 'Checked that no adverse action followed the complaint (§2.4: no retaliation)', type: 'checkbox', span: true, value: x.retaliation_reviewed },
          ] : []),
        ], { submitText: x ? 'Save' : 'Record complaint', onCancel: () => m.close(), onSubmit: async (v) => {
          if (x) await put(`/api/complaints/${x.id}`, { ...v, if_updated_at: x.updated_at }); else await post('/api/complaints', v);
          toast('Saved', 'ok'); m.close(); refresh();
        } });
        const m = modal(x ? 'Complaint' : 'Record a privacy complaint', f, { wide: true });
      };
      return h('div', {},
        h('div', { class: 'grid cols-4 mb' }, stat(`Complaints in ${year}`, rep.total), stat('Still open', rep.open, rep.open ? 'warn' : ''), stat('Told about HHS', rep.hhs_referral_given), stat('Median days to resolve', rep.median_days_to_resolve ?? '—')),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Complaint log (42 CFR §2.4)'), can('complaints:write') ? h('button', { class: 'btn sm primary', 'data-add-complaint': '1', onClick: () => edit(null) }, '+ Complaint') : null),
          h('p', { class: 'small muted' }, 'Anyone may complain to the programme and to the HHS Secretary about a privacy violation, and may not be retaliated against for it. A complaint is closed with its resolution, never deleted.'),
          table([{ label: 'Received', render: x => fmt.date(x.received_at) }, { label: 'From', render: x => fmt.label(x.complainant) }, { label: 'Client', render: x => x.client_code || '—' }, { label: 'Channel', render: x => fmt.label(x.channel) },
            { label: 'Summary', render: x => String(x.summary || '').slice(0, 120) }, { label: 'Status', render: x => badge(fmt.label(x.status), ['open', 'investigating'].includes(x.status) ? 'warn' : 'ok') }, { label: 'HHS told', render: x => (x.hhs_referral_given ? '✓' : '') }],
          list.rows, { empty: 'No complaints recorded.', onRow: can('complaints:write') ? edit : null })));
    },
    async agreements() {
      const d = await get('/api/disclosure-agreements');
      const kinds = Object.entries(d.kinds || AGREEMENT_KIND_LABELS).map(([value, label]) => ({ value, label: fmt.label(label) }));
      const add = () => {
        const f = form([
          { name: 'kind', label: 'Kind', type: 'select', options: kinds, required: true, noBlank: true, value: 'qsoa' },
          { name: 'organisation', label: 'Organization (the recipient of disclosures under it)', required: true, span: true },
          { name: 'aliases', label: 'Other names it goes by (one per line)', type: 'textarea', rows: 2, span: true },
          { name: 'services', label: 'Services (a QSOA) or study / audit title', span: true },
          { name: 'approving_body', label: 'IRB, privacy board or approving body (research and audit)', span: true },
          { name: 'reference', label: 'Protocol or approval number' },
          { name: 'agreement_date', label: 'Signed / approved on', type: 'date', required: true, value: fmt.today() },
          { name: 'expires_at', label: 'Expires on', type: 'date' },
          { name: 'document_ref', label: 'Where the signed agreement or approval is kept', span: true },
        ], { submitText: 'Register', onCancel: () => m.close(), onSubmit: async (v) => { await post('/api/disclosure-agreements', v); toast('Registered', 'ok'); m.close(); refresh(); } });
        const m = modal('Register an agreement or approval', h('div', {}, h('p', { class: 'small muted' }, 'A QSOA (§2.11) is a written agreement with an organization that provides a service to this program and is bound by Part 2. Research (§2.52) needs an IRB or privacy board approval; an audit or evaluation (§2.53), the oversight body\'s. Disclosures on those bases may only go to the organization named here.'), f), { wide: true });
      };
      const end = async (a) => { const reason = await confirmDialog('End this agreement', `Record that the ${fmt.label(a.label)} with ${a.organisation} has ended. Nothing more can be disclosed under it.`, { danger: true, okText: 'End agreement', requireReason: true }); if (!reason) return; await post(`/api/disclosure-agreements/${a.id}/end`, { reason }); toast('Agreement ended', 'ok'); refresh(); };
      return h('div', { class: 'card', 'data-agreements': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'QSOAs and research / audit approvals'), d.editable ? h('button', { class: 'btn sm primary', 'data-add-agreement': '1', onClick: add }, '+ Agreement') : null),
        h('p', { class: 'small muted' }, 'A disclosure under a qualified service organization agreement, for research, or for an audit or evaluation rests on one of these: the recipient must be the organization it is with (or one of its other names). Research and audit disclosures are recorded by a supervisor or administrator.'),
        table([{ label: 'Kind', render: a => AGREEMENT_KIND_LABELS[a.kind] || fmt.label(a.kind) }, { label: 'Organization', key: 'organisation' }, { label: 'Services / study', key: 'services' }, { label: 'Approved by', render: a => a.approving_body || '—' },
          { label: 'Signed', render: a => fmt.date(a.agreement_date) }, { label: 'Expires', render: a => a.expires_at ? fmt.date(a.expires_at) : '—' },
          { label: 'Status', render: a => a.active ? badge('In force', 'ok') : h('span', {}, badge('Cannot be relied on', 'danger'), h('div', { class: 'small muted' }, a.problems.join('; '))) },
          { label: '', render: a => d.editable && a.status === 'active' ? h('button', { class: 'btn sm ghost', onClick: () => end(a) }, 'End') : null }],
        d.rows, { empty: 'No agreements registered. Until one is, nothing can be disclosed on a QSOA, research or audit basis.' }));
    },
    async incidents() {
      const d = await get('/api/incidents?status=all');
      const due = (i) => { const o = i.obligations; if (i.status === 'closed') return badge('Closed', 'ok'); if (!o.attention) return badge('Nothing owed', 'ok');
        return h('span', { 'data-incident-due': i.id }, badge(o.overdue ? 'Overdue' : `${o.days_left} days left`, o.overdue ? 'danger' : o.warn ? 'danger' : 'warn'), h('div', { class: 'small muted' }, `Deadline ${fmt.date(o.deadline)}`)); };
      const add = () => {
        const f = form([
          { name: 'title', label: 'Short title (no client names)', required: true, span: true }, { name: 'discovered_at', label: 'Discovered on', type: 'date', required: true, value: fmt.today(), help: 'The 60-day clock runs from the day the breach was known, or would have been known with reasonable diligence.' },
          { name: 'occurred_at', label: 'Happened on (if known)', type: 'date' }, { name: 'affected_count', label: 'People affected (estimate)', type: 'number', min: 0, step: 1 },
          { name: 'description', label: 'What happened', type: 'textarea', span: true, rows: 3, help: 'Stored encrypted.' },
        ], { submitText: 'Open incident', onCancel: () => m.close(), onSubmit: async (v) => { const res = await post('/api/incidents', v); m.close(); openIncident(res.id, refresh); } });
        const m = modal('Record a privacy or security incident', f);
      };
      return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Incident & breach register'), can('incidents:write') ? h('button', { class: 'btn sm primary', 'data-add-incident': '1', onClick: add }, '+ Incident') : null),
        h('p', { class: 'small muted' }, `The 2024 Part 2 rule applies HIPAA breach notification to Part 2 records: a breach is presumed unless a four-factor risk assessment shows a low probability of compromise, and notices are due within ${d.thresholds.notice_days} days of discovery — to each person, to HHS (at once for ${d.thresholds.hhs_immediate_at} or more; otherwise in the annual log), and to the media for more than ${d.thresholds.media_over} in one state. Security events (a failed audit-chain check, a flagged emergency access, a very large identified export) open a draft here automatically.`),
        d.rows.length ? table([{ label: 'Discovered', render: i => fmt.date(i.discovered_at) }, { label: 'Title', key: 'title' }, { label: 'Source', render: i => fmt.label(i.source) }, { label: 'People', render: i => i.affected_count }, { label: 'Determination', render: i => DET[i.determination] || i.determination }, { label: 'Clock', render: due }],
          d.rows, { onRow: i => openIncident(i.id, refresh) }) : emptyState('No incidents recorded', 'Record anything that may have exposed client information: a lost phone, a misdirected fax, an email to the wrong person, a stolen laptop.'));
    },
  };
  body.append(await T[tab]());
  return h('div', {}, pageHead('Privacy & Part 2'), tabStrip(tabs, tab, (k) => nav(`compliance?tab=${k}`)), body);
});

async function openIncident(id, onDone) {
  const { row: i } = await get(`/api/incidents/${id}`);
  const o = i.obligations; const w = can('incidents:write');
  const ob = (label, x) => x.required ? h('li', {}, `${label}: due ${fmt.date(x.due)} — `, x.done ? badge(`done ${fmt.date(x.done_at)}`, 'ok') : badge(x.overdue ? 'overdue' : 'owed', x.overdue ? 'danger' : 'warn')) : h('li', { class: 'muted' }, `${label}: not required${i.determination === 'pending' ? ' (yet)' : ''}`);
  const f = w ? form([
    { type: 'section', label: 'What happened' },
    { name: 'title', label: 'Title', span: true, value: i.title }, { name: 'discovered_at', label: 'Discovered on', type: 'date', value: i.discovered_at }, { name: 'occurred_at', label: 'Happened on', type: 'date', value: i.occurred_at || '' },
    { name: 'description', label: 'Description', type: 'textarea', span: true, rows: 3, value: i.description || '' },
    { name: 'affected_count', label: 'People affected', type: 'number', min: 0, step: 1, value: i.affected_count }, { name: 'max_in_one_state', label: 'Most in any one state', type: 'number', min: 0, step: 1, value: i.max_in_one_state },
    { name: 'part2_records', label: 'Involves 42 CFR Part 2 records', type: 'checkbox', value: i.part2_records },
    { type: 'section', label: 'Risk assessment (45 CFR §164.402(2))' },
    { name: 'risk_nature', label: '1. Nature and extent of the information (identifiers, likelihood of re-identification)', type: 'textarea', span: true, rows: 2, value: i.risk_nature || '' },
    { name: 'risk_recipient', label: '2. The unauthorised person who used it or received it', type: 'textarea', span: true, rows: 2, value: i.risk_recipient || '' },
    { name: 'risk_acquired', label: '3. Whether it was actually acquired or viewed', type: 'textarea', span: true, rows: 2, value: i.risk_acquired || '' },
    { name: 'risk_mitigation', label: '4. How far the risk has been mitigated', type: 'textarea', span: true, rows: 2, value: i.risk_mitigation || '' },
    { type: 'section', label: 'Determination and notices' },
    { name: 'determination', label: 'Determination', type: 'select', options: Object.entries(DET).map(([value, label]) => ({ value, label })), noBlank: true, value: i.determination },
    { name: 'determination_reason', label: 'Reason for the determination', type: 'textarea', span: true, rows: 2, value: i.determination_reason || '', help: 'At least 20 characters. "Not a breach" also needs all four factors above.' },
    { name: 'law_enforcement_delay_until', label: 'Law enforcement asked to delay notice until', type: 'date', value: i.law_enforcement_delay_until || '' },
    { name: 'individuals_notified_at', label: 'Individuals notified on', type: 'date', value: i.individuals_notified_at || '' }, { name: 'hhs_notified_at', label: 'HHS notified on', type: 'date', value: i.hhs_notified_at || '' }, { name: 'media_notified_at', label: 'Media notified on', type: 'date', value: i.media_notified_at || '' },
    { name: 'status', label: 'Status', type: 'select', options: ['open', 'closed'], noBlank: true, value: i.status },
  ], { submitText: 'Save', onCancel: () => m.close(), onSubmit: async (v) => { await put(`/api/incidents/${i.id}`, v); toast('Saved', 'ok'); m.close(); onDone && onDone(); } }) : null;
  const picker = w ? clientPicker('incident_client', '', { placeholder: 'Find an affected client…' }) : null;
  const clients = h('div', { class: 'card tight mt', 'data-incident-clients': '1' }, h('h3', {}, `Affected clients on record (${i.clients.length})`),
    // A client whose record retention has purged is still listed, by the code kept when they were linked.
    table([{ label: 'Client', render: x => x.client_id ? h('a', { href: `#/client/${x.client_id}` }, x.client_code) : h('span', {}, x.client_code || '—', h('div', { class: 'small muted' }, `Record purged ${fmt.date(x.client_purged_at)}`)) }, { label: 'Notified', render: x => x.notified_at ? fmt.date(x.notified_at) : '—' },
      { label: '', render: x => w && x.client_id ? h('div', { class: 'row nowrap' }, !x.notified_at ? h('button', { class: 'btn sm', onClick: async () => { await put(`/api/incidents/${i.id}/clients/${x.client_id}`, { notified_at: fmt.today() }); m.close(); openIncident(id, onDone); } }, 'Notified today') : null,
        h('button', { class: 'btn sm ghost', onClick: async () => { await del(`/api/incidents/${i.id}/clients/${x.client_id}`); m.close(); openIncident(id, onDone); } }, 'Remove')) : null }], i.clients, { empty: 'None linked.' }),
    w ? h('div', { class: 'row mt' }, picker, h('button', { class: 'btn sm', onClick: async () => { if (!picker.value) { toast('Choose a client first', 'error'); return; } await post(`/api/incidents/${i.id}/clients`, { client_ids: [picker.value] }); m.close(); openIncident(id, onDone); } }, 'Link client')) : null);
  const m = modal(i.title, h('div', { 'data-incident': i.id },
    h('div', { class: 'banner small' }, h('b', {}, `Notification deadline: ${fmt.date(o.deadline)}`), ` (${o.days_left >= 0 ? `${o.days_left} days left` : `${-o.days_left} days late`}). `, `Source: ${fmt.label(i.source)}.`),
    h('ul', { class: 'small', 'data-obligations': '1' }, ob('Individuals', o.individuals), ob(`HHS (${o.hhs_route === 'contemporaneous' ? 'within 60 days' : 'annual log'})`, o.hhs), ob('Media', o.media)),
    f || h('pre', { class: 'note' }, i.description || ''), clients), { wide: true });
}
