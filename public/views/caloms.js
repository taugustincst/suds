// State reporting (CalOMS Tx) and the county EHR hand-off.
//
// CalOMS Tx: when the programme reports it (Settings, below), the admission and discharge dialogs on a
// client's Episodes tab carry the CalOMS questions, each episode shows which CalOMS records it has and
// needs, and this page lists every edit-check problem by client code and field, previews the file, and
// produces the submission for DHCS (the disclosure; the file downloaded is the one accounted). The county EHR hand-off is the billing boundary: SUDS does not bill, it hands encounters over.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, navAndRender, emptyState, confirmDialog, downloadCsv, stat, kv, moduleOn, loadingFor } from '../app.js';
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
    else if (f.type === 'int' && f.alt) {
      // A number, or one of the dictionary's 999xx special answers: the select fills the number box, and
      // typing a number clears the select. The stored value is always the code that is in the number box.
      const altLabels = cfg.spec.alt_labels || {};
      const isAlt = f.alt.map(String).includes(String(v ?? ''));
      const altOpts = f.alt.map(code => ({ value: String(code), label: `${altLabels[code] || 'Special answer'} (${code})` }));
      out.push({ ...base, type: 'number', min: f.min, max: Math.max(f.max, ...f.alt.map(Number)), step: 1, value: isAlt ? '' : (v ?? ''),
        help: [`Enter ${f.min}–${f.max}`, f.help].filter(Boolean).join('; ') + ', or choose a special answer below.' });
      out.push({ name: `${P}${f.key}__alt`, label: `${f.label} — special answer`, type: 'select', value: isAlt ? v : '', options: altOpts });
    }
    else if (f.type === 'int') out.push({ ...base, type: 'number', min: f.min, max: f.max, step: 1 });
    else if (f.type === 'date') out.push({ ...base, type: 'date' });
    else out.push({ ...base, maxLen: 5, placeholder: f.type === 'zip' ? '5 digits, 00000, XXXXX or ZZZZZ' : '' });
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
    if (key.endsWith('__alt')) continue; // the 999xx special-answer select: its value was copied into the number box
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
/** "3 clients", "1 client". */
const n = (count, word) => `${fmt.num(count)} ${word}${Number(count) === 1 ? '' : 's'}`;
/** A server message's ISO dates ("opened 2026-05-02") as the rest of the page shows dates ("May 2, 2026"). */
const localDates = (msg) => String(msg || '').replace(/\b(\d{4}-\d{2}-\d{2})(T[\d:.]+Z?)?\b/g, (m0, d) => fmt.date(d));
/** The upload's log detail ("2026-09-29 BATCH-42"): the day uploaded, and the DHCS reference if one was given. */
const uploadDetail = (s) => { const m = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(String(s || '')); return m ? `Uploaded on ${fmt.date(m[1])}${m[2] ? ` · DHCS reference ${m[2]}` : ''}` : String(s || ''); };
const sevBadge = (s) => badge(s === 'fatal' ? 'Fatal' : 'Warning', s === 'fatal' ? 'danger' : 'warn');

/** The 999xx special-answer selects fill their number box; typing a number clears the select. */
function wireCalomsAlt(f) {
  if (!f || !f.inputs) return;
  for (const [name, input] of Object.entries(f.inputs)) {
    if (!name.endsWith('__alt')) continue;
    const num = f.inputs[name.slice(0, -5)];
    if (!num || !input.addEventListener) continue;
    input.addEventListener('change', () => { if (input.value) num.value = input.value; });
    num.addEventListener('input', () => { if (num.value !== input.value) input.value = ''; });
  }
}

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
      m.close(); toast(r.warnings && r.warnings.length ? `Saved, with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : 'CalOMS record saved', 'ok');
      box.close(); calomsEpisodeDialog(episode, { onChange }); if (onChange) onChange();
    } });
    wireCalomsAlt(f);
    const m = modal(`CalOMS ${RECORD_LABEL[type].toLowerCase()} — episode from ${fmt.date(episode.opened_at)}`, f, { wide: true });
  };
  const rows = d.records;
  const body = h('div', { 'data-caloms-episode': episode.id },
    h('p', { class: 'small muted' }, 'The CalOMS Tx records this episode reports to the state. A record with a fatal error is held back from the extract until it is fixed.'),
    rows.length ? table([
      { label: 'Record', render: r => RECORD_LABEL[r.record_type] },
      { label: 'Date', render: r => fmt.date(r.record_date) },
      { label: 'Provider', key: 'provider_id' },
      { label: 'Problems', render: r => r.issues.length ? h('ul', { class: 'small', style: { margin: 0, paddingLeft: '1rem' } }, r.issues.map(i => h('li', {}, sevBadge(i.severity), ' ', localDates(i.message)))) : badge('Ready', 'ok') },
      { label: 'Sent', render: r => (r.extracted_at ? fmt.date(r.extracted_at) : '—') },
      { label: '', render: r => can('episodes:write') && (r.record_type !== 'discharge' || episode.status === 'closed') ? h('button', { class: 'btn sm', 'data-caloms-edit': r.record_type, onClick: (e) => { e.stopPropagation(); editRecord(r.record_type, r); } }, 'Edit') : null },
    ], rows, { rowLabel: r => `${RECORD_LABEL[r.record_type]} ${r.record_date}` }) : emptyState('No CalOMS records yet', can('episodes:write') ? 'Complete the admission record below (Still needed).' : 'A supervisor, clinician or anyone who may edit episodes completes the admission record.'),
    d.expected.length ? h('div', { class: 'mt' }, h('h3', {}, 'Still needed'), h('ul', {}, d.expected.map(x => h('li', {}, localDates(x.message), ' ',
      can('episodes:write') && x.record_type !== 'discharge' ? h('button', { class: 'btn sm primary', 'data-caloms-add': x.record_type, onClick: () => editRecord(x.record_type, null, x.record_type === 'annual_update' ? fmt.today() : null) }, x.record_type === 'admission' ? 'Complete admission record' : 'Record annual update') : null,
      x.record_type === 'discharge' ? h('span', { class: 'small muted' }, '(recorded with the discharge: reopen and discharge again, or ask a supervisor)') : null)))) : null,
    can('episodes:write') && rows.some(r => r.record_type === 'admission') ? h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', 'data-caloms-add': 'annual_update', onClick: () => editRecord('annual_update') }, '+ Annual update')) : null);
  const box = modal(`CalOMS Tx — episode from ${fmt.date(episode.opened_at)}`, body, { wide: true });
  return box;
}

// ---- CalOMS provider IDs: one row of fields per provider (r10 M6) ----
// It was one textarea line per provider, "ID, name | legal name | NPI": a comma and pipes mixed, a line typed with
// one more "|" put the legal name in the NPI's place, and the error named "providers.0.npi". Now each part has its
// own field, and a problem names the provider and what was typed.
const PROVIDER_ID_RE = /^[0-9A-Za-z]{4,10}$/;
/** The NPI check digit (Luhn over 80840 + the first nine digits), as server/caloms.js validNpi. */
export function validNpi(v) {
  if (!/^\d{10}$/.test(String(v || ''))) return false;
  const digits = `80840${String(v).slice(0, 9)}`.split('').map(Number);
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) { let d = digits[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return (10 - (sum % 10)) % 10 === Number(String(v)[9]);
}
function providerEditor(initial) {
  const rows = h('div', { class: 'caloms-prov-rows' });
  const err = h('div', { class: 'err', role: 'alert', 'data-caloms-providers-error': '1' });
  let n = 0;
  const renumber = () => [...rows.children].forEach((r, i) => {
    r.querySelector('legend').textContent = `Provider ${i + 1}`;
    const rm = r.querySelector('[data-prov-remove]'); rm.setAttribute('aria-label', `Remove this provider (provider ${i + 1})`);
  });
  const addRow = (p = {}, focus = false) => {
    const k = n++;
    const input = (key, label, attrs = {}) => {
      const id = `cal-prov-${k}-${key}`;
      const i = h('input', { type: 'text', id, value: p[key] || '', 'data-prov': key, autocomplete: 'off', spellcheck: 'false', ...attrs });
      return h('div', { class: 'field' }, h('label', { for: id }, label), i);
    };
    const row = h('fieldset', { class: 'caloms-prov', 'data-caloms-provider-row': '1' }, h('legend', {}, 'Provider'),
      h('div', { class: 'grid cols-2' },
        input('id', 'Provider ID *', { maxLength: 10, 'aria-required': 'true' }), input('name', 'Site or program name', { maxLength: 80 }),
        input('legal_name', 'Legal name of the provider organization', { maxLength: 120 }), input('npi', 'NPI (10 digits)', { maxLength: 10, inputMode: 'numeric' })),
      h('div', { class: 'err small', 'data-prov-error': '1' }),
      h('button', { type: 'button', class: 'btn sm ghost', 'data-prov-remove': '1', onClick: () => { row.remove(); renumber(); addBtn.focus(); } }, 'Remove this provider'));
    rows.append(row); renumber();
    if (focus) row.querySelector('input').focus();
  };
  const addBtn = h('button', { type: 'button', class: 'btn sm', 'data-prov-add': '1', onClick: () => addRow({}, true) }, '+ Add a provider');
  for (const p of initial) addRow(p);
  if (!initial.length) addRow();
  const el = h('div', { class: 'span', 'data-caloms-providers': '1' },
    h('h3', { class: 'eyebrow' }, 'CalOMS provider IDs'),
    h('p', { class: 'small muted' }, 'The provider ID DHCS assigned to each reporting site or program (4 to 10 letters or digits). A county server reporting for several provider organizations adds each one\'s legal name and NPI.'),
    rows, addBtn, err);
  const clear = () => { err.textContent = ''; el.querySelectorAll('[data-prov-error]').forEach(x => { x.textContent = ''; }); el.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid')); };
  /** Show problems: [{ row (0-based) | null, key, message }]; focuses the first field named. */
  const show = (problems) => {
    clear();
    const all = [...rows.children]; let first = null;
    for (const p of problems) {
      const r = p.row === null || p.row === undefined ? null : all[p.row];
      const box = r ? r.querySelector('[data-prov-error]') : err;
      box.textContent = box.textContent ? `${box.textContent} ${p.message}` : p.message;
      const i = r && p.key ? r.querySelector(`[data-prov="${p.key}"]`) : null;
      if (i) { i.setAttribute('aria-invalid', 'true'); if (!first) first = i; }
    }
    err.textContent = err.textContent || `${problems.length === 1 ? 'One provider needs' : 'Some providers need'} changing before the settings can be saved: ${problems.map(p => p.message).join(' ')}`;
    (first || addBtn).focus();
  };
  /** The providers typed, and what is wrong with them (in words that name the provider and what was typed). */
  const read = () => {
    const out = []; const problems = []; const seen = new Map();
    [...rows.children].forEach((r, i) => {
      const v = (k) => r.querySelector(`[data-prov="${k}"]`).value.trim();
      const p = { id: v('id'), name: v('name'), legal_name: v('legal_name'), npi: v('npi').replace(/[\s-]/g, '') };
      if (!p.id && !p.name && !p.legal_name && !p.npi) return;
      const who = `Provider ${i + 1}`;
      if (!p.id) problems.push({ row: i, key: 'id', message: `${who}: enter the provider ID DHCS assigned.` });
      else if (!PROVIDER_ID_RE.test(p.id)) problems.push({ row: i, key: 'id', message: `${who}: "${p.id}" is not a CalOMS provider ID, which is 4 to 10 letters or digits.` });
      else if (seen.has(p.id.toUpperCase())) problems.push({ row: i, key: 'id', message: `${who}: ${p.id} is already listed as provider ${seen.get(p.id.toUpperCase()) + 1}.` });
      else seen.set(p.id.toUpperCase(), i);
      if (p.npi && !validNpi(p.npi)) problems.push({ row: i, key: 'npi', message: /^\d{10}$/.test(p.npi) ? `${who}: ${p.npi} is not a valid NPI (its check digit does not match). Check the number on the NPI registry.` : `${who}: "${p.npi}" is not an NPI, which is 10 digits.` });
      out.push({ id: p.id, name: p.name, ...(p.legal_name ? { legal_name: p.legal_name } : {}), ...(p.npi ? { npi: p.npi } : {}) });
    });
    return { providers: out, problems };
  };
  /** A refusal from the server (field keys such as providers.0.npi), in the same words. */
  const serverProblems = (fields) => Object.entries(fields || {}).map(([k, msg]) => {
    const m = /^providers\.(\d+)\.(\w+)$/.exec(k);
    if (!m) return { row: null, key: null, message: k === 'providers' ? `${String(msg).charAt(0).toUpperCase()}${String(msg).slice(1)}.` : String(msg) };
    return { row: Number(m[1]), key: m[2], message: `Provider ${Number(m[1]) + 1}: the ${m[2] === 'npi' ? 'NPI' : m[2] === 'id' ? 'provider ID' : m[2].replace(/_/g, ' ')} ${msg}.` };
  });
  return { el, read, show, clear, serverProblems };
}

// ---- the page ----
loadingFor('caloms', () => 'Checking the CalOMS records for the period…');
route('caloms', async (r) => {
  const today = fmt.today();
  const from = r.query.get('from') || `${today.slice(0, 7)}-01`; const to = r.query.get('to') || today;
  const cfg = await calomsConfig({ fresh: true });
  const seesEpisodes = can('episodes:read') || can('episodes:write');
  const v = seesEpisodes ? await get(`/api/caloms/validation?from=${from}&to=${to}`) : null;
  const subs = can('export:identified') ? await get('/api/caloms/submissions', { quiet: true }).catch(() => null) : null;
  // The errors to fix, each assigned to the record's owner (1.17.0): a front-line worker sees their own first.
  const mineFirst = !can('export:identified');
  const showAll = r.query.get('work') === 'all' || (!mineFirst && r.query.get('work') !== 'mine');
  const work = seesEpisodes && cfg && cfg.enabled ? await get(`/api/caloms/worklist?from=${from}&to=${to}${showAll ? '' : '&mine=1'}`, { quiet: true }).catch(() => null) : null;
  const fromI = h('input', { type: 'date', value: from, 'aria-label': 'From' }), toI = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  // navAndRender: after producing or preparing a file the address is unchanged, and the page must still be redrawn.
  const go = (f, t) => navAndRender(`caloms?from=${f}&to=${t}`);

  const settingsCard = () => {
    if (!can('settings:manage')) return null;
    const f = form([
      { name: 'enabled', label: 'This program reports CalOMS Tx (adds the CalOMS questions to admission and discharge)', type: 'checkbox', span: true, value: cfg.enabled },
      { name: 'start_date', label: 'CalOMS records expected for episodes opened on or after', type: 'date', value: cfg.start_date || '' },
      { type: 'section', label: 'Monthly run' },
      { name: 'schedule', label: 'Check the month before and prepare its file', type: 'select', noBlank: true, value: (cfg.schedule && cfg.schedule.frequency) || 'off', options: [{ value: 'off', label: 'Off — produce files by hand' }, { value: 'monthly', label: 'Every month' }],
        help: 'Prepares the file; it is not sent or accounted until someone produces it here. SUDS never sends anything to DHCS: a person uploads the file.' },
      { name: 'schedule_day', label: 'On this day of the month', type: 'number', min: 1, max: 28, step: 1, value: (cfg.schedule && cfg.schedule.day) || 5 },
      { name: 'split_by_provider', label: 'One file per provider ID (a county server reporting for several providers)', type: 'checkbox', span: true, value: !!(cfg.schedule && cfg.schedule.split_by_provider) },
    ], { submitText: 'Save CalOMS settings', onSubmit: async (d) => {
      const { providers, problems } = provEd.read();
      if (!problems.length && d.enabled && !providers.length) problems.push({ row: 0, key: 'id', message: 'Add at least one CalOMS provider ID before turning CalOMS reporting on.' });
      if (problems.length) { provEd.show(problems); return; }
      provEd.clear();
      try { await put('/api/caloms/settings', { enabled: !!d.enabled, providers, start_date: d.start_date || null, schedule: d.schedule, schedule_day: d.schedule_day ? Number(d.schedule_day) : undefined, split_by_provider: !!d.split_by_provider }); }
      catch (e) {
        // A provider the server refused is shown on its own row; anything else goes to the form's own message.
        const fields = (e.data && e.data.fields) || {};
        const mine = Object.fromEntries(Object.entries(fields).filter(([k]) => /^providers(\.|$)/.test(k)));
        if (Object.keys(mine).length) { provEd.show(provEd.serverProblems(mine)); if (Object.keys(mine).length === Object.keys(fields).length) return; e.data = { ...e.data, fields: Object.fromEntries(Object.entries(fields).filter(([k]) => !(k in mine))) }; }
        throw e;
      }
      toast('CalOMS settings saved', 'ok'); cached = null; go(from, to);
    } });
    const provEd = providerEditor(cfg.providers || []);
    f.querySelector('[data-field="start_date"]').before(provEd.el);
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
        { label: 'Problem', render: x => localDates(x.message) },
      ], v.rows, { rowLabel: x => `${x.severity} ${x.client_code} ${x.field_label}` }) : emptyState('No problems found', 'Every CalOMS record in this period passes the edit checks, and every episode has the records it needs.'));
  };

  const worklistCard = () => {
    if (!work) return null;
    const clientCell = (x) => (can('clients:read') ? h('a', { href: `#/client/${x.client_id}/episodes` }, x.client_code) : h('span', { class: 'mono' }, x.client_code));
    const toggle = h('div', { class: 'row' }, h('a', { class: `btn sm${showAll ? '' : ' primary'}`, href: `#/caloms?from=${from}&to=${to}&work=mine`, 'aria-current': showAll ? null : 'true' }, 'Mine'), h('a', { class: `btn sm${showAll ? ' primary' : ''}`, href: `#/caloms?from=${from}&to=${to}&work=all`, 'aria-current': showAll ? 'true' : null }, 'Everyone\'s'));
    return h('div', { class: 'card mb', 'data-caloms-worklist': showAll ? 'all' : 'mine' },
      h('div', { class: 'card-head' }, h('h2', {}, 'To fix before the next submission'), toggle),
      h('p', { class: 'small muted' }, 'Each problem goes to whoever last saved the record — or, for a record still missing, the client\'s primary worker. Fix it on the client\'s Episodes tab; it drops off this list when the record passes.'),
      work.rows.length ? table([
        { label: 'Severity', render: x => sevBadge(x.severity) }, { label: 'Client', render: clientCell },
        { label: 'Record', render: x => RECORD_LABEL[x.record_type] || x.record_type }, { label: 'Date', render: x => fmt.date(x.record_date) },
        { label: 'Field', key: 'field_label' }, { label: 'Problem', render: x => localDates(x.message) },
        showAll ? { label: 'For', render: x => x.owner_name || h('span', { class: 'muted' }, 'Unassigned') } : null,
      ].filter(Boolean), work.rows, { rowLabel: x => `${x.severity} ${x.client_code} ${x.field_label}` }) : emptyState(showAll ? 'Nothing to fix' : 'Nothing for you to fix', 'Every CalOMS record in this period you are responsible for passes the edit checks.'));
  };

  // The preview checks the file; producing the submission is the disclosure, and the file downloaded is the
  // one that was accounted (server/routes/caloms.js). Earlier submissions can be downloaded again while kept.
  const downloadSubmission = async (sub) => {
    try { await fetchDownload(`/api/caloms/submissions/${sub.id}/file`); toast(`Submission file downloaded (SHA-256 ${sub.sha256.slice(0, 12)}…). Send it to DHCS unchanged.`, 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const STATUS = { prepared: ['Prepared — not sent', 'warn'], produced: ['Produced', 'ok'], discarded: ['Discarded', 'info'] };
  const produce = async (x) => {
    const held = Number((x.counts || {}).held_back) || 0;
    if (!await confirmDialog('Produce this file for DHCS', `Produce the prepared CalOMS Tx file for ${fmt.date(x.period_from)} – ${fmt.date(x.period_to)}${x.provider_id ? ` (provider ${x.provider_id})` : ''}. ${x.clients === 1 ? 'Its 1 client gets an entry in their' : `Each of its ${x.clients} clients gets an entry in their`} accounting of disclosures and its records are marked as sent. ${held ? `${n(held, 'record')} with fatal errors ${held === 1 ? 'was' : 'were'} held back and ${held === 1 ? 'is' : 'are'} not in this file: fix ${held === 1 ? 'it' : 'them'} and prepare a new file. ` : ''}Then upload the file that downloads to DHCS unchanged.`, { okText: 'Produce file' })) return;
    try { const res = await post(`/api/caloms/submissions/${x.id}/produce`, {}); toast(`Produced: ${n(res.clients_disclosed, 'client')} accounted for.`, 'ok'); await downloadSubmission({ ...x, sha256: res.sha256 }); go(from, to); }
    catch (e) { toast(e.message, 'error'); }
  };
  const discard = async (x) => { if (!await confirmDialog('Discard this prepared file', 'It was never sent. The records stay as they are; prepare a new file when they are ready.', { danger: true, okText: 'Discard' })) return; await post(`/api/caloms/submissions/${x.id}/discard`, {}); toast('Discarded', 'ok'); go(from, to); };
  const recordUpload = (x) => {
    const f = form([
      { name: 'uploaded_on', label: 'Uploaded to DHCS on', type: 'date', required: true, value: fmt.today() },
      { name: 'dhcs_reference', label: 'Confirmation or batch number from the DHCS portal (optional)', maxLen: 60 },
    ], { submitText: 'Record upload', onCancel: () => m.close(), onSubmit: async (d) => { await post(`/api/caloms/submissions/${x.id}/uploaded`, d); toast('Upload recorded', 'ok'); m.close(); go(from, to); } });
    const m = modal('Record the upload to DHCS', h('div', {}, h('p', { class: 'small muted' }, 'SUDS does not upload anything to DHCS. Record here that you uploaded this file, so the submission log shows it.'), f));
  };
  const showLog = async (x) => {
    const d = await get(`/api/caloms/submissions/${x.id}/events`);
    const ACTION = { prepared: 'Prepared', produced: 'Produced (accounted)', downloaded: 'Downloaded', uploaded: 'Recorded as uploaded to DHCS', discarded: 'Discarded' };
    modal(`Submission log — ${x.file_name}`, h('div', { 'data-caloms-log': x.id }, h('p', { class: 'small mono' }, `SHA-256 ${d.sha256}`),
      table([{ label: 'When', render: e => fmt.dt(e.created_at) }, { label: 'What', render: e => ACTION[e.action] || e.action }, { label: 'Who', key: 'who' }, { label: 'Detail', render: e => (e.action === 'uploaded' ? uploadDetail(e.detail) : '') }], d.rows, { rowLabel: e => `${e.action} ${e.created_at}` })), { wide: true });
  };
  const provs = (cfg && cfg.providers) || [];
  const extractCard = () => {
    if (!can('export:identified')) return null;
    const rows = (subs && subs.rows) || [];
    const provSel = provs.length > 1 ? h('select', { 'aria-label': 'Provider for the submission file', 'data-caloms-provider': '1' }, [h('option', { value: '' }, 'Every provider, one file'), ...provs.map(p => h('option', { value: p.id }, `${p.id}${p.name ? ` — ${p.name}` : ''}`))]) : null;
    return h('div', { class: 'card mb', 'data-caloms-extract': '1' }, h('h2', {}, 'Submission to DHCS'),
      h('p', { class: 'small' }, 'A zip of CSV files — admissions, discharges, annual updates and the monthly provider activity report (with "no activity" months) — for the period above. Records with fatal errors are held back.'),
      h('ol', { class: 'small' },
        h('li', {}, h('b', {}, 'Preview'), ' to check the file. A preview has PREVIEW / NOT FOR SUBMISSION where names go and no dates of birth, so it cannot be submitted; nobody\'s accounting of disclosures changes.'),
        h('li', {}, h('b', {}, 'Produce the submission file'), ' when the records are ready. This is the disclosure: each client in it gets a "State reporting (CalOMS)" entry in their accounting of disclosures, its records are marked as sent, and the file downloads.'),
        h('li', {}, 'Send that file to DHCS unchanged. It is kept here, identified by its SHA-256, for ', String((subs && subs.keep_days) || 90), ' days, so it can be downloaded again.')),
      h('p', { class: 'small muted' }, 'The code values were verified against the DHCS CalOMS Tx data dictionary (File Version 3.0, October 2024). The column names and file layout are SUDS\u2019s own: see the README in the zip and docs/compliance/CALOMS.md before the first submission.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', disabled: !cfg.enabled, 'data-caloms-download': '1', onClick: () => downloadCsv(`/api/caloms/extract?from=${from}&to=${to}`) }, 'Download preview (not for submission)'),
        h('button', { class: 'btn primary', disabled: !cfg.enabled, 'data-caloms-submitted': '1', onClick: async () => {
          if (!await confirmDialog('Produce the submission file for DHCS', `Produce the CalOMS Tx submission for ${fmt.date(from)} – ${fmt.date(to)}. It includes client names and dates of birth. Each client in it gets an entry in their accounting of disclosures (a disclosure required by law) and its records are marked as sent. ${v && v.summary.blocked ? `${n(v.summary.blocked, 'record')} with fatal errors will be held back: ${v.summary.blocked === 1 ? 'it is' : 'they are'} not in the file. ` : ''}Send the file that downloads to DHCS unchanged.`, { okText: 'Produce submission file' })) return;
          try {
            const r = await post('/api/caloms/submissions', { from, to, provider_id: provSel && provSel.value ? provSel.value : undefined });
            toast(`Submission produced: ${n(r.clients_disclosed, 'client')} accounted for as disclosed to DHCS.`, 'ok');
            await downloadSubmission(r);
            go(from, to);
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Produce submission file'),
        provSel,
        h('button', { class: 'btn ghost', disabled: !cfg.enabled, 'data-caloms-run': '1', onClick: async () => {
          try { const res = await post('/api/caloms/schedule/run', { from, to }); toast(res.prepared.length ? `Checked: ${n(res.fatal, 'fatal error')}. ${n(res.prepared.length, 'file')} prepared — produce ${res.prepared.length === 1 ? 'it' : 'each'} below to send it.` : `Checked: ${n(res.fatal, 'fatal error')}. Nothing ready to prepare.`, res.prepared.length ? 'ok' : 'error'); go(from, to); }
          catch (e) { toast(e.message, 'error'); }
        } }, 'Check and prepare (not sent)')),
      cfg.enabled ? null : h('p', { class: 'small muted' }, 'CalOMS reporting is off for this program.'),
      h('p', { class: 'small muted', 'data-caloms-no-dhcs': '1' }, 'SUDS does not send anything to DHCS and holds no DHCS credentials: a person uploads the produced file through the county\'s DHCS channel and records the upload here.'),
      cfg.schedule && cfg.schedule.frequency === 'monthly' ? h('p', { class: 'small', 'data-caloms-schedule': '1' }, `Monthly run: on day ${cfg.schedule.day}, for the month before${cfg.schedule.split_by_provider ? ', one file per provider' : ''}.${cfg.schedule.last ? ` Last run ${fmt.dt(cfg.schedule.last.ran_at)} for ${fmt.date(cfg.schedule.last.from)} – ${fmt.date(cfg.schedule.last.to)}: ${n(cfg.schedule.last.fatal, 'fatal error')}, ${n(cfg.schedule.last.prepared.length, 'file')} prepared.` : ''}`) : null,
      rows.length ? h('div', { 'data-caloms-submissions': '1' }, h('h3', {}, 'Submissions'), table([
        { label: 'Period', render: x => h('div', {}, `${fmt.date(x.period_from)} – ${fmt.date(x.period_to)}`, x.provider_id ? h('div', { class: 'small muted' }, `Provider ${x.provider_id}`) : null) },
        { label: 'Status', render: x => h('div', { 'data-caloms-status-of': x.id }, badge(...(STATUS[x.status] || [x.status, 'info'])), x.origin === 'scheduled' ? h('div', { class: 'small muted' }, 'Monthly run') : null,
          x.uploaded_at ? h('div', { class: 'small' }, `Uploaded ${fmt.date(x.uploaded_at)}${x.uploaded_by_name ? ` by ${x.uploaded_by_name}` : ''}${x.dhcs_reference ? ` · ${x.dhcs_reference}` : ''}`) : null) },
        { label: 'Made', render: x => `${fmt.date(x.created_at)}${x.status === 'produced' ? ` by ${x.created_by_name}` : ''}` },
        { label: 'Clients', key: 'clients' },
        { label: 'SHA-256', render: x => h('span', { class: 'mono', title: x.sha256 }, `${x.sha256.slice(0, 12)}…`) },
        { label: '', render: x => { const when = `${fmt.date(x.period_from)} – ${fmt.date(x.period_to)}`; return h('div', { class: 'row' },
          x.status === 'prepared' && x.file_available ? h('button', { class: 'btn sm primary', 'data-caloms-produce': x.id, 'aria-label': `Produce the prepared file for ${when}`, onClick: () => produce(x) }, 'Produce') : null,
          x.status === 'prepared' ? h('button', { class: 'btn sm ghost', 'data-caloms-discard': x.id, 'aria-label': `Discard the prepared file for ${when}`, onClick: () => discard(x) }, 'Discard') : null,
          x.status === 'produced' ? (x.file_available ? h('button', { class: 'btn sm', 'data-caloms-submission-download': x.id, 'aria-label': `Download the submission for ${when}`, onClick: () => downloadSubmission(x) }, 'Download') : h('span', { class: 'muted small' }, 'No longer kept')) : null,
          x.status === 'produced' && !x.uploaded_at ? h('button', { class: 'btn sm', 'data-caloms-uploaded': x.id, 'aria-label': `Record the upload of the submission for ${when}`, onClick: () => recordUpload(x) }, 'Record upload') : null,
          h('button', { class: 'btn sm ghost', 'data-caloms-log-open': x.id, 'aria-label': `Submission log for ${when}`, onClick: () => showLog(x) }, 'Log')); } },
      ], rows, { rowLabel: x => `Submission ${x.period_from} to ${x.period_to}` })) : null);
  };

  const handoffCard = () => {
    const intro = h('p', { class: 'small', 'data-not-a-claim': '1' }, h('b', {}, 'SUDS does not submit Drug Medi-Cal claims'), ' (no 837 or Short-Doyle/Medi-Cal files). Where a service must be billed, the county EHR (SmartCare or its equivalent) is where the claim is made. This file hands the encounters over for entry there: one row per client, per service day, per kind of service and worker, with minutes, place, modality and funding source.');
    if (!can('export:identified')) return h('div', { class: 'card mb', 'data-handoff': '1' }, h('h2', {}, 'County EHR hand-off'), intro, h('p', { class: 'small muted' }, 'A supervisor or administrator produces this file.'));
    const summary = h('div', { class: 'small muted', 'data-handoff-summary': '1' }, 'Checking the period…');
    // Checked against the recipient and purpose in the form: a consent covers only the recipient it names, for the purpose it states.
    const check = (recipient, purpose) => get(`/api/handoff/summary?from=${from}&to=${to}&recipient=${encodeURIComponent(recipient || '')}&purpose=${encodeURIComponent(purpose || '')}`).then(s => {
      summary.textContent = `${n(s.rows, 'encounter row')} for ${n(s.clients, 'client')}, ${fmt.mins(s.minutes)} in total.${s.without_consent.length ? ` No consent that can authorise the hand-off to ${recipient || 'this recipient'} for this purpose (a 42 CFR Part 2 consent naming it and given for that purpose, such as the single treatment, payment and operations consent) on file for: ${s.without_consent.join(', ')} — with the consent basis they are left out.` : ''}${s.restricted ? ` ${n(s.restricted, 'client')} ${s.restricted === 1 ? 'has' : 'have'} an agreed restriction: you will be asked to confirm the file respects it.` : ''}`;
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
    const recheck = () => check(f.inputs.recipient.value, f.inputs.purpose.value);
    recheck();
    f.inputs.recipient.addEventListener('change', recheck); f.inputs.purpose.addEventListener('change', recheck);
    return h('div', { class: 'card mb', 'data-handoff': '1' }, h('h2', {}, 'County EHR hand-off (encounters for billing)'), intro, summary, f);
  };

  // Each half of this page is a module of the programme profile (server/programme.js); one switched off is
  // left out, and says where it is switched on.
  const calOn = moduleOn('caloms'), hoOn = moduleOn('handoff');
  const offNote = (what) => h('p', { class: 'small muted', 'data-module-off': what }, `${what === 'caloms' ? 'CalOMS Tx state reporting' : 'The county EHR hand-off'} is switched off for this program.${can('settings:manage') ? ' Switch it on in Settings › Program › Modules.' : ' An administrator can switch it on in Settings › Program.'}`);
  if (!calOn) return h('div', {}, pageHead('State reporting'), offNote('caloms'), hoOn ? handoffCard() : offNote('handoff'));
  return h('div', {},
    pageHead('State reporting'),
    h('div', { class: `banner ${cfg && cfg.enabled ? '' : 'warn'}`, 'data-caloms-status': cfg && cfg.enabled ? 'on' : 'off' }, cfg && cfg.enabled
      ? `CalOMS Tx reporting is on (provider ${cfg.providers.map(p => p.id).join(', ')}). The admission and discharge dialogs ask the CalOMS questions.`
      : 'CalOMS Tx reporting is off for this program. Funder reports are not a substitute for CalOMS: a treatment program that must report turns it on under Settings below.'),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('button', { class: 'btn', onClick: () => go(fromI.value, toI.value) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { const d = new Date(); d.setDate(0); const last = fmt.isoLocal(d).slice(0, 10); go(`${last.slice(0, 7)}-01`, last); } }, 'Last month')),
    h('h2', {}, `CalOMS Tx · ${fmt.date(from)} – ${fmt.date(to)}`),
    worklistCard(), validationCard(), extractCard(), hoOn ? handoffCard() : offNote('handoff'), settingsCard(),
    cfg ? h('p', { class: 'small muted' }, `Layout: ${cfg.spec.version}.`) : null);
});
