// SUPRT-A: SAMHSA's client-level record for a State Opioid Response grant (server/suprt.js,
// docs/compliance/SUPRT.md). A client's assessments and what is due (the client record's SUPRT-A tab), the
// follow-ups due on the To-dos page, and the program page: completion rates, the file for entry into SPARS
// (a disclosure) and the grant and site IDs. Shown only while the SUPRT-A module is on (server/programme.js).
import { h, route, get, post, put, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, stat, kv, moduleOn, loadingFor } from '../app.js';
import { withRestrictionCheck } from './part2.js';
import { fetchDownload, downloadedMessage } from './reports.js';

let itemsCache = null;
async function items() { if (!itemsCache) itemsCache = await get('/api/suprt/items'); return itemsCache; }
const typeLabel = (t) => ({ baseline: 'Baseline', reassessment: 'Reassessment', annual: 'Annual assessment', closeout: 'Closeout' }[t] || t);
const STATUS = { open: ['Due now', 'warn'], missed: ['Window closed', 'danger'], upcoming: ['Upcoming', ''], done: ['Done', 'ok'], not_required: ['Not required (closed out)', ''] };
function dueBadge(e) {
  if (e.status === 'open' && e.overdue) return badge('Overdue', 'danger');
  const [text, kind] = STATUS[e.status] || [e.status, ''];
  return badge(text, kind);
}
const windowText = (e) => (e.type === 'baseline' ? `first SOR-funded service ${fmt.date(e.opens)}; due by ${fmt.date(e.closes)}` : e.type === 'closeout' ? `services ended ${fmt.date(e.opens)}; due by ${fmt.date(e.closes)}` : `window ${fmt.date(e.opens)} – ${fmt.date(e.closes)}`);

/**
 * The assessment form: each SUPRT-A section a group of fields, the answers SUDS already holds pre-filled
 * (and said to be), the rest asked. One column on a phone; every control labelled.
 */
async function openAssessment(clientId, { row = null, type = 'baseline', clientDisplay = '', onDone } = {}) {
  const def = await items();
  const date = row ? row.assessment_date : fmt.today();
  const pre = row ? { answers: row.answers, derived: row.derived_keys } : await get(`/api/clients/${clientId}/suprt/prefill?type=${type}&date=${date}`);
  const t = row ? row.assessment_type : type;
  const answers = { ...pre.answers };
  const derived = new Set(pre.derived || []);
  const sectionOf = (k) => def.sections.find(s => s.key === k);
  const fields = [
    { name: 'assessment_date', label: 'Date of assessment', type: 'date', required: true, value: date, max: fmt.today(), help: 'The day the answers were collected.' },
  ];
  let section = null;
  for (const it of def.items.filter(i => i.at.includes(t) && !i.readonly)) {
    if (it.section !== section) { section = it.section; fields.push({ type: 'section', label: sectionOf(section).label, heading: true, collapsible: true, open: true }); }
    const from = derived.has(it.key) ? 'Pre-filled from the client record; change it if it is not right.' : it.source === 'asked' ? 'Ask the client, or check the record.' : null;
    const help = [it.help, from].filter(Boolean).join(' ');
    const f = { name: `answers.${it.key}`, label: it.label, value: answers[it.key] ?? '', help: help || null, span: it.type === 'text' };
    if (it.type === 'choice') Object.assign(f, { type: 'select', options: it.options.map(o => ({ value: o.value, label: it.key === 'B_primary_substance' ? fmt.label(o.value, 'SUBSTANCES') : o.label })) });
    else if (it.type === 'date') Object.assign(f, { type: 'date' });
    else Object.assign(f, { type: 'text', maxLen: 500 });
    fields.push(f);
  }
  fields.push({ type: 'section', label: 'Finish', heading: false });
  fields.push({ name: 'status', label: 'Status', type: 'select', noBlank: true, value: row ? row.status : 'complete', options: [{ value: 'complete', label: 'Complete — every required answer given' }, { value: 'draft', label: 'Draft — finish later' }] });
  const fixed = [['Assessment', typeLabel(t)], ['Client ID', answers.A_client_id || '—'], ['Grant ID', answers.A_grant_id || def.grant_id || 'Not set'], ['Site ID', answers.A_site_id || def.site_id || 'Not set']];
  // No grant ID: every record is carried with it into SPARS, so say so plainly and where it is set (1.16.0).
  const noGrant = !(answers.A_grant_id || def.grant_id);
  const grantPrompt = noGrant ? h('div', { class: 'banner warn small', role: 'note', 'data-suprt-no-grant': '1' },
    h('b', {}, 'The SOR grant ID is not set. '), 'SPARS takes no record without it. ',
    can('settings:manage') ? h('a', { href: '#/suprt?focus=settings', 'data-suprt-grant-link': '1', onClick: () => m.close() }, 'Set the grant ID on the SUPRT-A page') : 'Ask an administrator to set it under Settings on the SUPRT-A page.',
    ' You can still record this assessment: the ID is added to it when the file for SPARS is made.') : null;
  const f = form(fields, { submitText: row ? 'Save changes' : `Save ${typeLabel(t).toLowerCase()}`, onCancel: () => m.close(), onSubmit: async (v) => {
    const a = {};
    for (const [k, val] of Object.entries(v)) if (k.startsWith('answers.') && val !== '' && val !== null && val !== undefined) a[k.slice(8)] = val;
    const body = { assessment_date: v.assessment_date, status: v.status, answers: a };
    if (row) await put(`/api/suprt/${row.id}`, body); else await post(`/api/clients/${clientId}/suprt`, { ...body, assessment_type: t });
    m.close(); toast(`${typeLabel(t)} saved`, 'ok'); if (onDone) onDone();
  } });
  const m = modal(`SUPRT-A ${typeLabel(t).toLowerCase()}${clientDisplay ? ` — ${clientDisplay}` : ''}`, h('div', { 'data-suprt-form': t },
    h('p', { class: 'small muted' }, 'SUPRT-A is completed by staff from the client\'s record. Answers SUDS already holds are filled in for you; the rest are asked. SAMHSA\'s client questionnaire (SUPRT-C) is completed on SAMHSA\'s own form: record here whether it was.'),
    grantPrompt, kv(fixed), f), { wide: true });
}

/** The client record's SUPRT-A tab. */
export async function suprtTab(clientId, { refresh, clientDisplay } = {}) {
  const d = await get(`/api/clients/${clientId}/suprt`);
  const on = moduleOn('suprt') && can('clients:write');
  const cy = d.cycle;
  const next = cy.baseline && !cy.closeout ? ['reassessment', 'annual', 'closeout'] : ['baseline'];
  const add = on ? h('div', { class: 'row', role: 'group', 'aria-label': 'Record a SUPRT-A assessment' }, next.map(t => h('button', { class: `btn ${t === (cy.due.find(e => e.status === 'open') || {}).type || (t === 'baseline' && !cy.baseline) ? 'primary' : ''}`, 'data-suprt-add': t, onClick: () => openAssessment(clientId, { type: t, clientDisplay, onDone: refresh }) }, `+ ${typeLabel(t)}`))) : null;
  const dueRows = cy.due.filter(e => e.status !== 'done');
  return h('div', { class: 'grid cols-2', 'data-suprt-tab': '1' },
    h('section', { class: 'card', 'data-suprt-due': String(dueRows.length) }, h('div', { class: 'card-head' }, h('h2', {}, 'What is due'), add),
      cy.baseline ? h('p', { class: 'small muted' }, `Baseline ${fmt.date(cy.baseline)}${cy.closeout ? `; closed out ${fmt.date(cy.closeout)}` : ''}. Reassessment and annual assessments are due in a window from 30 days before to 30 days after each anniversary.`)
        // A baseline already owed (the client has had a SOR-funded service) is said to be due now, as the table says.
        : cy.due.some(e => e.type === 'baseline' && e.status !== 'done') ? h('p', { class: 'small muted', 'data-suprt-baseline-owed': '1' }, 'No baseline yet, and one is due now: the client has received a service charged to a SOR grant.')
          : h('p', { class: 'small muted' }, 'No baseline yet. A baseline becomes due once the client receives a service charged to a SOR grant.'),
      dueRows.length ? table([
        { label: 'Assessment', render: e => typeLabel(e.type) + (e.type === 'annual' ? ` ${e.occurrence}` : '') },
        { label: 'Due', render: e => fmt.date(e.due) },
        { label: 'Window', render: e => windowText(e) },
        { label: 'Status', render: e => dueBadge(e) },
      ], dueRows) : h('p', { class: 'muted' }, cy.baseline ? 'Nothing due now.' : 'Nothing due.')),
    h('section', { class: 'card' }, h('h2', {}, 'Assessments recorded'),
      table([
        { label: 'Assessment', render: x => typeLabel(x.assessment_type) },
        { label: 'Date', render: x => fmt.date(x.assessment_date) },
        { label: 'Status', render: x => (x.status === 'complete' ? badge('Complete', 'ok') : badge(`Draft${x.missing.length ? ` — ${x.missing.length} to answer` : ''}`, 'warn')) },
        { label: 'SPARS file', render: x => (x.exported_at ? `Exported ${fmt.date(x.exported_at)}` : '—') },
      ], d.rows, { empty: 'None recorded yet.', onRow: on ? (x) => openAssessment(clientId, { row: x, clientDisplay, onDone: refresh }) : null })));
}

/** The follow-ups due, for the To-dos page: the worker's caseload, or a supervisor's team. */
export async function suprtDueCard() {
  if (!moduleOn('suprt') || !can('clients:read')) return null;
  let d; try { d = await get('/api/suprt/due'); } catch { return null; }
  if (!d.rows.length) return null;
  return h('section', { class: 'card mb', 'data-suprt-due-card': String(d.rows.length) },
    h('div', { class: 'card-head' }, h('h2', {}, `SUPRT-A follow-ups due (${d.rows.length})`), h('a', { class: 'btn sm', href: '#/suprt' }, 'SUPRT-A page')),
    d.overdue ? h('p', { class: 'small', 'data-suprt-overdue': String(d.overdue) }, h('strong', {}, `${d.overdue} overdue. `), 'A reassessment or annual assessment can be collected until its window closes, 30 days after the anniversary.') : null,
    table([
      { label: 'Client', render: x => h('a', { href: `#/client/${x.client_id}/suprt` }, `${x.name || x.client_code} (${x.client_code})`) },
      { label: 'Assessment', render: x => typeLabel(x.type) },
      { label: 'Due', render: x => fmt.date(x.due) },
      { label: 'Status', render: x => dueBadge(x) },
      can('clients:all') ? { label: 'Worker', render: x => x.workers.join(', ') || 'Unassigned' } : null,
    ].filter(Boolean), d.rows, { compact: { primary: x => `${x.name || x.client_code}: ${typeLabel(x.type)}`, secondary: x => `Due ${fmt.date(x.due)}${x.overdue ? ' — overdue' : ''}` } }));
}

/** The SPARS entry file: a disclosure, so it asks to whom, why and on what basis, like the identified export. */
function openExport(from, to, def) {
  const f = form([
    { name: 'set', label: 'Which records', type: 'select', noBlank: true, options: [{ value: 'main', label: 'Baselines, reassessments and annual assessments' }, { value: 'closeout', label: 'Closeouts (SPARS takes them last, in a file of their own)' }] },
    { name: 'recipient', label: 'Who receives this file', required: true, value: def.default_recipient, span: true, help: 'Each client\'s Part 2 consent must name this recipient, or they are left out.' },
    { name: 'purpose', label: 'Purpose of the disclosure', required: true, value: def.default_purpose, span: true },
    { name: 'basis', label: 'Lawful basis', type: 'select', noBlank: true, span: true, options: [{ value: 'consent', label: 'Each client\'s Part 2 consent naming this recipient (clients without one are left out)' }, { value: 'audit_evaluation', label: 'Audit or program evaluation (42 CFR §2.53): the approval on file with the recipient' }] },
  ], { submitText: 'Make the file (audited, accounted)', onCancel: () => m.close(), onSubmit: async (v) => {
    const url = `/api/suprt/export?from=${from}&to=${to}&set=${v.set}&recipient=${encodeURIComponent(v.recipient)}&purpose=${encodeURIComponent(v.purpose)}&basis=${encodeURIComponent(v.basis)}`;
    const done = await withRestrictionCheck((extra) => fetchDownload(url + (extra.restriction_reviewed ? '&restriction_reviewed=1' : '')));
    m.close(); toast(downloadedMessage(done, 'Saved. Enter it in SPARS, checking each field against the current SUPRT handbook and codebook.'), 'ok');
  } });
  const m = modal('File for entry into SPARS', h('div', { 'data-suprt-export-form': '1' },
    h('div', { class: 'banner warn small' }, 'This file names clients (client ID, date of birth, diagnoses). It is a disclosure: it is recorded in the audit log and in the accounting of disclosures of every client in it.'),
    h('p', { class: 'small' }, def.export_note), f));
}

loadingFor('suprt', () => 'Counting SUPRT-A records due and done…');
route('suprt', async (r) => {
  if (!moduleOn('suprt')) return h('div', {}, pageHead('SUPRT-A'), emptyState('SUPRT-A is switched off', `SUPRT-A records are for programs with State Opioid Response (SOR) funding. ${can('settings:manage') ? 'Switch the module on in Settings › Program › Modules.' : 'An administrator can switch the module on in Settings › Program › Modules.'}`, can('settings:manage') ? h('a', { class: 'btn primary', 'data-empty-action': 'modules', href: '#/admin?tab=settings' }, 'Open Program settings') : null, { level: 2 }));
  const to = r.query.get('to') || fmt.today(); const from = r.query.get('from') || new Date(Date.parse(to) - 89 * 86400000).toISOString().slice(0, 10);
  const def = await items();
  // Arrived from an assessment's "Set the grant ID" link: the Settings card is where it is set.
  if (r.query.get('focus') === 'settings') setTimeout(() => { const card = document.getElementById('suprt-settings'); if (card) { card.scrollIntoView({ block: 'start' }); card.querySelector('input')?.focus(); } }, 0);
  const [c, due] = await Promise.all([can('clients:read') || can('reports:funder') ? get(`/api/suprt/completion?from=${from}&to=${to}`) : null, suprtDueCard()]);
  const fromI = h('input', { type: 'date', value: from, id: 'suprt-from' }); const toI = h('input', { type: 'date', value: to, id: 'suprt-to' });
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const settings = can('settings:manage') ? form([
    { name: 'suprt_grant_id', label: 'Grant ID', value: def.grant_id || '', help: 'Your SOR grant\'s ID, as SPARS knows it. Carried on every record.' },
    { name: 'suprt_site_id', label: 'Site ID', value: def.site_id || '', help: 'Your site\'s ID in SPARS.' },
    { name: 'suprt_reassessment_months', label: 'Reassessment due at', type: 'select', noBlank: true, value: def.reassessment_days === 90 ? '3' : '6', options: [{ value: '6', label: '6 months (180 days)' }, { value: '3', label: '3 months (90 days), if your SOR contract says so' }] },
  ], { submitText: 'Save SUPRT-A settings', onSubmit: async (v) => { await put('/api/admin/settings', v); itemsCache = null; toast('Saved', 'ok'); nav(`suprt?from=${from}&to=${to}&_=${Date.now()}`); } }) : null;
  return h('div', {},
    pageHead('SUPRT-A (SOR client-level reporting)'),
    h('p', { class: 'muted' }, 'SAMHSA\'s SUPRT-A record for clients served with State Opioid Response money: a baseline, a reassessment at 6 months (or 3), an annual assessment each year and a closeout, each in a window of 30 days either side. SUDS fills in what the client record already holds; the rest is asked. Nothing here is certified or accepted by SAMHSA or DHCS: check the file against the current SUPRT handbook and codebook before entering it in SPARS.'),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'suprt-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'suprt-to' }, 'To'), toI),
      h('button', { class: 'btn', onClick: () => nav(`suprt?from=${fromI.value}&to=${toI.value}`) }, 'Apply')),
    c ? h('section', { class: 'card mb', 'data-suprt-completion': String(c.total.rate ?? '') }, h('h2', {}, `Completion · ${fmt.date(c.from)} – ${fmt.date(c.to)}`),
      h('div', { class: 'grid cols-4 mb' }, stat('Completed within the window', pct(c.total.rate)), stat('Baselines recorded', c.baselines_recorded), stat('Baselines owed', c.baselines_owed, c.baselines_owed ? 'warn' : ''), stat('Missed', c.total.missed, c.total.missed ? 'danger' : '')),
      table([
        { label: 'Assessment', key: 'label' }, { label: 'Due in the period', key: 'due', num: true }, { label: 'Done in the window', key: 'done_in_window', num: true },
        { label: 'Done outside it', key: 'done_outside_window', num: true }, { label: 'Missed', key: 'missed', num: true }, { label: 'Still open', key: 'still_open', num: true }, { label: 'Rate', render: x => pct(x.rate), num: true },
      ], c.by_type), h('p', { class: 'small muted' }, c.note)) : null,
    due,
    can('export:identified') ? h('section', { class: 'card mb', 'data-suprt-export': '1' }, h('h2', {}, 'File for entry into SPARS'),
      h('p', { class: 'small muted' }, `Completed assessments dated ${fmt.date(from)} – ${fmt.date(to)}, one row each, in SUPRT-A section order. `, def.export_note),
      h('button', { class: 'btn danger', 'data-suprt-export-button': '1', onClick: () => openExport(from, to, def) }, 'Make the SPARS entry file (names clients, audited)')) : null,
    settings ? h('section', { class: 'card', id: 'suprt-settings', 'data-suprt-settings': '1' }, h('h2', {}, 'Settings'), settings) : null);
});
