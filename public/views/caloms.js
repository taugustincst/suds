// State reporting (CalOMS Tx) and the county EHR hand-off.
//
// CalOMS Tx: when the programme reports it (Settings, below), the admission and discharge dialogs on a
// client's Episodes tab carry the CalOMS questions, each episode shows which CalOMS records it has and
// needs, and this page lists every edit-check problem by client code and field, then produces the extract
// for DHCS. The county EHR hand-off is the billing boundary: SUDS does not bill, it hands encounters over.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog, downloadCsv, stat, kv } from '../app.js';
import { withRestrictionCheck } from './part2.js';
import { fetchDownload, downloadedMessage } from './reports.js';

let cached = null;
/** The CalOMS switch, provider IDs and layout (GET /api/caloms/config), fetched once per page load. */
export async function calomsConfig({ fresh = false } = {}) {
  if (!cached || fresh) cached = await get('/api/caloms/config', { quiet: true }).catch(() => null);
  return cached;
}

const P = 'caloms_';
/**
 * The CalOMS questions for one record type, as form() fields named caloms_<key>. A multi-answer question
 * (race, disability) is one checkbox per answer, named caloms_<key>__<code>. `values` are stored answers.
 */
export function calomsFields(cfg, type, { values = {}, provider = null, standardHint = false } = {}) {
  const out = [];
  const provs = cfg.providers || [];
  if (provs.length > 1) out.push({ name: `${P}provider_id`, label: 'CalOMS provider ID', type: 'select', required: true, noBlank: true, value: provider || provs[0].id, options: provs.map(p => ({ value: p.id, label: p.name ? `${p.id} — ${p.name}` : p.id })) });
  let group = null;
  for (const f of cfg.spec.fields.filter(x => x.in.includes(type))) {
    if (f.group !== group) {
      group = f.group;
      out.push({ type: 'section', label: `CalOMS: ${group}`, collapsible: true, open: true, hint: group === 'Past 30 days' && standardHint ? 'required unless the discharge status is administrative (4, 6, 7, 8)' : null });
    }
    const v = values[f.key];
    const required = f.req === 'always' || (f.req === 'standard' && type !== 'discharge');
    if (f.multi) {
      // One checkbox per answer, in a section of its own; the group carries on in a section after it.
      out.push({ type: 'section', label: `CalOMS: ${f.label}${required ? ' *' : ''}`, collapsible: true, open: true, hint: 'tick all that apply' });
      for (const c of cfg.spec.sets[f.set]) out.push({ name: `${P}${f.key}__${c.code}`, label: c.label, type: 'checkbox', value: Array.isArray(v) && v.includes(c.code) });
      out.push({ type: 'section', label: `CalOMS: ${group} (continued)`, collapsible: true, open: true });
      continue;
    }
    const base = { name: `${P}${f.key}`, label: f.label, required, help: f.help || null, value: v ?? '' };
    if (f.set) out.push({ ...base, type: 'select', placeholder: 'Choose…', options: cfg.spec.sets[f.set].map(c => ({ value: c.code, label: `${c.label} (${c.code})` })) });
    else if (f.type === 'int') out.push({ ...base, type: 'number', min: f.min, max: f.max, step: 1 });
    else if (f.type === 'date') out.push({ ...base, type: 'date' });
    else out.push({ ...base, maxLen: 5, placeholder: f.type === 'zip' ? '5 digits' : '' });
  }
  return out;
}

/** Split form() data into the ordinary fields and the CalOMS part ({ provider_id, answers }). */
export function splitCaloms(cfg, type, data) {
  const plain = {}; const answers = {}; let provider_id = null;
  const multi = new Map(cfg.spec.fields.filter(f => f.multi).map(f => [f.key, []]));
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith(P)) { plain[k] = v; continue; }
    const key = k.slice(P.length);
    if (key === 'provider_id') { provider_id = v; continue; }
    const m = /^(.+)__(.+)$/.exec(key);
    if (m && multi.has(m[1])) { if (v) multi.get(m[1]).push(m[2]); continue; }
    if (v !== null && v !== '' && v !== undefined) answers[key] = v;
  }
  for (const f of cfg.spec.fields.filter(x => x.multi && x.in.includes(type))) { const list = multi.get(f.key); if (list.length) answers[f.key] = list; }
  return { plain, caloms: { provider_id, answers } };
}

/** Starting answers from what the client record already says (substance, level of care, veteran). */
export function calomsDefaults(cfg, client) {
  if (!client) return {};
  const m = cfg.from_suds || {}; const out = {};
  if (client.primary_substance && m.substance[client.primary_substance]) out.primary_drug = m.substance[client.primary_substance];
  if (client.asam_level && m.asam_level[client.asam_level]) out.service_type = m.asam_level[client.asam_level];
  if (client.veteran === 1 || client.veteran === 0) out.veteran = m.veteran[client.veteran];
  if (client.zip && /^\d{5}$/.test(client.zip)) out.zip_code = client.zip;
  return out;
}

const RECORD_LABEL = { admission: 'Admission', discharge: 'Discharge', annual_update: 'Annual update' };
const sevBadge = (s) => badge(s === 'fatal' ? 'Fatal' : 'Warning', s === 'fatal' ? 'danger' : 'warn');

/** One episode's CalOMS records: what it has, what is wrong with each, and what it still needs. */
export async function calomsEpisodeDialog(episode, { onChange } = {}) {
  const cfg = await calomsConfig();
  const d = await get(`/api/episodes/${episode.id}/caloms`);
  const editRecord = (type, rec = null, date = null) => {
    const fields = [
      type === 'annual_update' ? { name: 'record_date', label: 'Annual update date', type: 'date', required: true, value: rec ? rec.record_date : (date || fmt.today()) } : null,
      ...calomsFields(cfg, type, { values: rec ? rec.answers : {}, provider: rec ? rec.provider_id : null, standardHint: type === 'discharge' }),
    ].filter(Boolean);
    const f = form(fields, { submitText: rec ? 'Save CalOMS record' : `Save CalOMS ${RECORD_LABEL[type].toLowerCase()}`, onCancel: () => m.close(), onSubmit: async (data) => {
      const { plain, caloms } = splitCaloms(cfg, type, data);
      const body = { record_type: type, provider_id: caloms.provider_id, record_date: plain.record_date || undefined, answers: caloms.answers };
      const r = rec ? await put(`/api/caloms/records/${rec.id}`, body) : await post(`/api/episodes/${episode.id}/caloms`, body);
      m.close(); toast(r.warnings && r.warnings.length ? `Saved, with ${r.warnings.length} warning(s)` : 'CalOMS record saved', 'ok');
      box.close(); calomsEpisodeDialog(episode, { onChange }); if (onChange) onChange();
    } });
    const m = modal(`CalOMS ${RECORD_LABEL[type].toLowerCase()} — episode from ${fmt.date(episode.opened_at)}`, f, { wide: true });
  };
  const rows = d.records;
  const body = h('div', { 'data-caloms-episode': episode.id },
    h('p', { class: 'small muted' }, 'The CalOMS Tx records this episode reports to the state. A record with a fatal error is held back from the extract until it is fixed.'),
    rows.length ? table([
      { label: 'Record', render: r => RECORD_LABEL[r.record_type] },
      { label: 'Date', render: r => fmt.date(r.record_date) },
      { label: 'Provider', key: 'provider_id' },
      { label: 'Problems', render: r => r.issues.length ? h('ul', { class: 'small', style: { margin: 0, paddingLeft: '1rem' } }, r.issues.map(i => h('li', {}, sevBadge(i.severity), ' ', i.message))) : badge('Ready', 'ok') },
      { label: 'Sent', render: r => (r.extracted_at ? fmt.date(r.extracted_at) : '—') },
      { label: '', render: r => can('episodes:write') && (r.record_type !== 'discharge' || episode.status === 'closed') ? h('button', { class: 'btn sm', 'data-caloms-edit': r.record_type, onClick: (e) => { e.stopPropagation(); editRecord(r.record_type, r); } }, 'Edit') : null },
    ], rows, { rowLabel: r => `${RECORD_LABEL[r.record_type]} ${r.record_date}` }) : emptyState('No CalOMS records yet', 'Complete the admission record below.'),
    d.expected.length ? h('div', { class: 'mt' }, h('h3', {}, 'Still needed'), h('ul', {}, d.expected.map(x => h('li', {}, x.message, ' ',
      can('episodes:write') && x.record_type !== 'discharge' ? h('button', { class: 'btn sm primary', 'data-caloms-add': x.record_type, onClick: () => editRecord(x.record_type, null, x.record_type === 'annual_update' ? fmt.today() : null) }, x.record_type === 'admission' ? 'Complete admission record' : 'Record annual update') : null,
      x.record_type === 'discharge' ? h('span', { class: 'small muted' }, '(recorded with the discharge: reopen and discharge again, or ask a supervisor)') : null)))) : null,
    can('episodes:write') && rows.some(r => r.record_type === 'admission') ? h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', 'data-caloms-add': 'annual_update', onClick: () => editRecord('annual_update') }, '+ Annual update')) : null);
  const box = modal(`CalOMS Tx — episode from ${fmt.date(episode.opened_at)}`, body, { wide: true });
  return box;
}

// ---- the page ----
route('caloms', async (r) => {
  const today = fmt.today();
  const from = r.query.get('from') || `${today.slice(0, 7)}-01`; const to = r.query.get('to') || today;
  const cfg = await calomsConfig({ fresh: true });
  const seesEpisodes = can('episodes:read') || can('episodes:write');
  const v = seesEpisodes ? await get(`/api/caloms/validation?from=${from}&to=${to}`) : null;
  const fromI = h('input', { type: 'date', value: from, 'aria-label': 'From' }), toI = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  const go = (f, t) => nav(`caloms?from=${f}&to=${t}`);

  const settingsCard = () => {
    if (!can('settings:manage')) return null;
    const f = form([
      { name: 'enabled', label: 'This program reports CalOMS Tx (adds the CalOMS questions to admission and discharge)', type: 'checkbox', span: true, value: cfg.enabled },
      { name: 'providers', label: 'CalOMS provider IDs, one per line: ID, name', type: 'textarea', rows: 3, span: true, value: cfg.providers.map(p => p.name ? `${p.id}, ${p.name}` : p.id).join('\n'), help: 'The provider ID DHCS assigned to each reporting site or program (4 to 10 letters or digits).' },
      { name: 'start_date', label: 'CalOMS records expected for episodes opened on or after', type: 'date', value: cfg.start_date || '' },
    ], { submitText: 'Save CalOMS settings', onSubmit: async (d) => {
      const providers = String(d.providers || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const [id, ...rest] = l.split(','); return { id: id.trim(), name: rest.join(',').trim() }; });
      await put('/api/caloms/settings', { enabled: !!d.enabled, providers, start_date: d.start_date || null });
      toast('CalOMS settings saved', 'ok'); cached = null; go(from, to);
    } });
    return h('div', { class: 'card', 'data-caloms-settings': '1' }, h('h2', {}, 'Settings'), h('p', { class: 'small muted' }, 'Off by default: a prevention, outreach or navigation program that does not report CalOMS is never asked these questions.'), f);
  };

  const validationCard = () => {
    if (!v) return null;
    const s = v.summary;
    const clientCell = (x) => (can('clients:read') ? h('a', { href: `#/client/${x.client_id}/episodes` }, x.client_code) : h('span', { class: 'mono' }, x.client_code));
    return h('div', { class: 'card mb', 'data-caloms-validation': '1' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Validation report'), h('button', { class: 'btn sm', onClick: () => downloadCsv(`/api/caloms/validation?from=${from}&to=${to}&format=csv`) }, 'Download CSV')),
      h('p', { class: 'small muted' }, 'Every CalOMS record dated in the period, checked against the edit rules, and every episode checked for the records it should have. A record with a fatal error is held back from the extract.'),
      h('div', { class: 'grid cols-4 mb' }, stat('Records in period', s.records), stat('Ready to submit', s.ready), stat('Fatal errors', s.fatal, s.fatal ? 'danger' : ''), stat('Warnings', s.warnings, s.warnings ? 'warn' : '')),
      v.rows.length ? table([
        { label: 'Severity', render: x => sevBadge(x.severity) },
        { label: 'Client', render: clientCell },
        { label: 'Record', render: x => RECORD_LABEL[x.record_type] || x.record_type },
        { label: 'Date', render: x => fmt.date(x.record_date) },
        { label: 'Field', key: 'field_label' },
        { label: 'Problem', key: 'message' },
      ], v.rows, { rowLabel: x => `${x.severity} ${x.client_code} ${x.field_label}` }) : emptyState('No problems found', 'Every CalOMS record in this period passes the edit checks, and every episode has the records it needs.'));
  };

  const extractCard = () => {
    if (!can('export:identified')) return null;
    return h('div', { class: 'card mb', 'data-caloms-extract': '1' }, h('h2', {}, 'Extract for DHCS'),
      h('p', { class: 'small' }, 'A zip of CSV files — admissions, discharges, annual updates and the monthly provider activity report (with "no activity" months) — for the period above. Records with fatal errors are held back. Downloading it is a test / preview: it is audited, but it is not a disclosure until the file goes to DHCS. When you have submitted it, choose "Mark as submitted": each client in it then gets a "State reporting (CalOMS)" entry in their accounting of disclosures, and its records are marked as sent.'),
      h('p', { class: 'small muted' }, 'The layout has not been verified against the current DHCS CalOMS Tx data dictionary; see the README in the zip and docs/compliance/CALOMS.md before the first submission.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', disabled: !cfg.enabled, 'data-caloms-download': '1', onClick: async () => {
          if (!await confirmDialog('CalOMS Tx extract (test / preview)', `This file identifies clients. Downloading it is recorded in the audit log; nobody's accounting of disclosures changes until you mark the extract as submitted. ${v && v.summary.blocked ? `${v.summary.blocked} record(s) with fatal errors will be held back.` : ''} Continue?`, { okText: 'Download extract' })) return;
          downloadCsv(`/api/caloms/extract?from=${from}&to=${to}`);
        } }, 'Download extract (test / preview)'),
        h('button', { class: 'btn primary', disabled: !cfg.enabled, 'data-caloms-submitted': '1', onClick: async () => {
          if (!await confirmDialog('Mark as submitted to DHCS', `Record that the CalOMS Tx extract for ${fmt.date(from)} – ${fmt.date(to)} was submitted to DHCS. Each client in it gets an entry in their accounting of disclosures (a disclosure required by law), and its records are marked as sent. Do this once the file has actually been submitted.`, { okText: 'Mark as submitted' })) return;
          try { const r = await post('/api/caloms/submissions', { from, to }); toast(`Recorded: ${r.clients_disclosed} client(s) accounted for as submitted to DHCS.`, 'ok'); }
          catch (e) { toast(e.message, 'error'); }
        } }, 'Mark as submitted')),
      cfg.enabled ? null : h('p', { class: 'small muted' }, 'CalOMS reporting is off for this program.'));
  };

  const handoffCard = () => {
    const intro = h('p', { class: 'small', 'data-not-a-claim': '1' }, h('b', {}, 'SUDS does not submit Drug Medi-Cal claims'), ' (no 837 or Short-Doyle/Medi-Cal files). Where a service must be billed, the county EHR (SmartCare or its equivalent) is where the claim is made. This file hands the encounters over for entry there: one row per client, per service day, per kind of service and worker, with minutes, place, modality and funding source.');
    if (!can('export:identified')) return h('div', { class: 'card mb', 'data-handoff': '1' }, h('h2', {}, 'County EHR hand-off'), intro, h('p', { class: 'small muted' }, 'A supervisor or administrator produces this file.'));
    const summary = h('div', { class: 'small muted', 'data-handoff-summary': '1' }, 'Checking the period…');
    // Checked against the recipient in the form: a consent covers only the recipient it names.
    const check = (recipient) => get(`/api/handoff/summary?from=${from}&to=${to}&recipient=${encodeURIComponent(recipient || '')}`).then(s => {
      summary.textContent = `${s.rows} encounter row(s) for ${s.clients} client(s), ${fmt.mins(s.minutes)} in total.${s.without_consent.length ? ` No consent that can authorise the hand-off to ${recipient || 'this recipient'} (a 42 CFR Part 2 consent naming it, such as the single treatment, payment and operations consent) on file for: ${s.without_consent.join(', ')} — with the consent basis they are left out.` : ''}${s.restricted ? ` ${s.restricted} client(s) have an agreed restriction: you will be asked to confirm the file respects it.` : ''}`;
    }).catch(e => { summary.textContent = e.message; });
    const f = form([
      { name: 'recipient', label: 'Recipient', required: true, value: 'County EHR / billing unit', span: true },
      { name: 'purpose', label: 'Purpose', required: true, value: 'Encounter entry in the county EHR for billing and claims', span: true },
      { name: 'basis', label: 'Lawful basis', type: 'select', noBlank: true, value: 'consent', options: [{ value: 'consent', label: 'Each client\'s consent naming the recipient (clients without one are left out)' }, { value: 'qsoa', label: 'Qualified service organization agreement with the recipient, on file (whole file)' }, { value: 'internal', label: 'Internal — the county EHR is this program\'s own (whole file)' }] },
      { name: 'format', label: 'Format', type: 'select', noBlank: true, value: 'csv', options: [{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel' }] },
    ], { submitText: 'Download hand-off file', onSubmit: async (d) => {
      if (!await confirmDialog('County EHR hand-off', 'This file includes client names, dates of birth and Medi-Cal IDs. Each client in it gets an entry in their accounting of disclosures. Continue?', { okText: 'Download' })) return;
      const q = new URLSearchParams({ from, to, recipient: d.recipient, purpose: d.purpose, basis: d.basis, format: d.format });
      // Fetched rather than followed as a link, so a refusal (an agreed restriction to confirm, no
      // agreement on file) is shown as a message instead of being saved as a file.
      const done = await withRestrictionCheck((extra) => fetchDownload(`/api/handoff/export?${q}${extra.restriction_reviewed ? '&restriction_reviewed=1' : ''}`));
      toast(downloadedMessage(done, 'Hand-off file downloaded. It carries the 42 CFR Part 2 notice.'), 'ok');
    } });
    check(f.inputs.recipient.value);
    f.inputs.recipient.addEventListener('change', () => check(f.inputs.recipient.value));
    return h('div', { class: 'card mb', 'data-handoff': '1' }, h('h2', {}, 'County EHR hand-off (encounters for billing)'), intro, summary, f);
  };

  return h('div', {},
    pageHead('State reporting'),
    h('div', { class: `banner ${cfg && cfg.enabled ? '' : 'warn'}`, 'data-caloms-status': cfg && cfg.enabled ? 'on' : 'off' }, cfg && cfg.enabled
      ? `CalOMS Tx reporting is on (provider ${cfg.providers.map(p => p.id).join(', ')}). The admission and discharge dialogs ask the CalOMS questions.`
      : 'CalOMS Tx reporting is off for this program. Funder reports are not a substitute for CalOMS: a treatment program that must report turns it on under Settings below.'),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('button', { class: 'btn', onClick: () => go(fromI.value, toI.value) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { const d = new Date(); d.setDate(0); const last = fmt.isoLocal(d).slice(0, 10); go(`${last.slice(0, 7)}-01`, last); } }, 'Last month')),
    h('h2', {}, `CalOMS Tx · ${fmt.date(from)} – ${fmt.date(to)}`),
    validationCard(), extractCard(), handoffCard(), settingsCard(),
    cfg ? h('p', { class: 'small muted' }, `Layout: ${cfg.spec.version}.`) : null);
});
