// Clinical documentation on a client's page (CalAIM): the problem list, the care coordination plan, ASAM
// six-dimension assessments and outcome measures (PHQ-9, GAD-7, AUDIT-C, DAST-10, wellbeing), and the card
// that sums them up on the Overview. The instrument wording, scoring bands, ASAM dimension names and Z codes
// come from the server (GET /api/meta/constants, built from server/clinical.js), so the score shown while
// the form is filled in is the one the server saves.
import { h, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, confirmDialog, kv, emptyState, clear } from '../app.js';

const C = () => state.constants || {};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const PROBLEM_STATUS_KIND = { active: 'warn', resolved: 'ok', inactive: '' };
const GOAL_STATUS_KIND = { active: 'info', met: 'ok', partially_met: 'warn', not_met: 'danger', discontinued: '' };
const users = () => (state.users || []).filter(u => u.is_active !== 0);
const userName = (id) => (state.users || []).find(u => u.id === id)?.display_name || '';

/** Bars scaled to the instrument's own range, so a PHQ-9 of 5 looks small even when it is the only score. */
function trend(series, max) {
  const top = Math.max(1, max || 0, ...series.map(x => x.score));
  return h('div', { class: 'spark', 'data-trend': '1', role: 'img', 'aria-label': `Scores over time: ${series.map(x => x.score).join(', ')}`, style: { height: '32px', maxWidth: '160px' } },
    series.map(x => h('div', { style: { height: `${(x.score / top) * 100}%` }, title: `${fmt.date(x.at)}: ${x.score}` })));
}

// ---------------------------------------------------------------- Overview card
/** The Overview's summary: safety alert, active problems, care plan reviews, latest ASAM, outcome trends. */
export async function overviewCard(clientId, { refresh } = {}) {
  if (!can('careplan:read') && !can('assessments:read')) return null;
  let s;
  try { s = await get(`/api/clients/${clientId}/clinical-summary`); } catch { return null; }
  const parts = [];
  if (s.safety_alert) parts.push(h('div', { class: 'banner danger', role: 'alert', 'data-safety-alert': '1' },
    `PHQ-9 on ${fmt.date(s.safety_alert.at)}: question 9 (thoughts of self-harm) was answered above "Not at all". Assess risk and review the safety plan with the client.`));
  if (s.problems) parts.push(h('div', { 'data-overview-problems': '1' }, h('h4', {}, `Active problems (${s.problems.length})`),
    s.problems.length ? h('ul', { style: { margin: '0 0 .5rem', paddingLeft: '1.1rem' } }, s.problems.slice(0, 8).map(p => h('li', {}, p.problem, p.icd10_code ? h('span', { class: 'muted small' }, ` · ${p.icd10_code}`) : null, p.z_codes.length ? h('span', { class: 'muted small' }, ` · ${p.z_codes.join(', ')}`) : null)))
      : h('p', { class: 'small muted' }, 'None recorded. ', h('a', { href: `#/client/${clientId}/problems` }, 'Add to the problem list')),
    s.problems.length > 8 ? h('a', { class: 'small', href: `#/client/${clientId}/problems` }, `All ${s.problems.length} problems`) : null));
  if (s.care_plan) parts.push(h('div', { 'data-overview-careplan': '1' }, h('h4', {}, 'Care plan'),
    h('p', { class: 'small' }, h('a', { href: `#/client/${clientId}/careplan` }, `${s.care_plan.active_goals} active goal${s.care_plan.active_goals === 1 ? '' : 's'}`),
      s.care_plan.next_review ? ` · next review ${fmt.date(s.care_plan.next_review)}` : ''),
    s.care_plan.overdue_reviews.length ? h('p', { class: 'small', style: { color: 'var(--danger)', fontWeight: 600 }, 'data-review-overdue': String(s.care_plan.overdue_reviews.length) },
      `Review overdue: ${s.care_plan.overdue_reviews.map(g => `"${g.goal.slice(0, 60)}" (due ${fmt.date(g.review_date)})`).join('; ')}`) : null));
  if (s.asam !== undefined) parts.push(h('div', { 'data-overview-asam': s.asam ? s.asam.id : '' }, h('h4', {}, 'Latest ASAM assessment'),
    s.asam ? h('div', { class: 'small' }, h('div', {}, `${fmt.date(s.asam.assessed_at)}${s.asam.assessed_by_name ? ' · ' + s.asam.assessed_by_name : ''}`),
      h('div', { class: 'row', style: { gap: '.25rem', flexWrap: 'wrap' } }, s.asam.ratings.map((r, i) => badge(`D${i + 1}: ${r}`, r >= 3 ? 'danger' : r === 2 ? 'warn' : 'ok'))),
      h('div', {}, `Recommended ${s.asam.recommended_loc || '—'} · referred ${s.asam.actual_loc || '—'}`, s.asam.discrepancy_reason ? ` (${fmt.label(s.asam.discrepancy_reason)})` : ''))
      : h('p', { class: 'small muted' }, 'None yet. ', h('a', { href: `#/client/${clientId}/assessments` }, 'Complete one'))));
  if (s.outcomes) parts.push(h('div', { 'data-overview-outcomes': '1' }, h('h4', {}, 'Outcome measures'),
    s.outcomes.length ? table([
      { label: 'Measure', key: 'name' },
      { label: 'Latest', render: o => h('span', { 'data-latest-score': o.instrument }, `${o.latest.total_score} · ${o.latest.band || ''}`) },
      { label: 'Since first', render: o => o.series.length > 1 ? changeText(o) : '—' },
      { label: 'Trend', render: o => trend(o.series, o.max) },
    ], s.outcomes) : h('p', { class: 'small muted' }, 'None yet. ', h('a', { href: `#/client/${clientId}/assessments` }, 'Give a screening'))));
  if (!parts.length) return null;
  return h('div', { class: 'card', style: { gridColumn: '1 / -1' }, 'data-clinical-card': '1' }, h('h3', {}, 'Clinical picture'), h('div', { class: 'grid cols-2' }, parts));
}
function changeText(o) {
  const d = o.latest.total_score - o.baseline.total_score;
  if (!d) return 'no change';
  const better = o.better === 'higher' ? d > 0 : d < 0;
  return h('span', { style: { color: better ? 'var(--ok, #0a7)' : 'var(--danger)' } }, `${d > 0 ? '+' : ''}${d} (${better ? 'better' : 'worse'})`);
}

// ---------------------------------------------------------------- Problem list
function zCodeBox(selected = []) {
  const known = new Set((C().Z_CODES || []).map(z => z.code));
  const other = selected.filter(c => !known.has(c));
  const box = h('details', { class: 'section span', open: selected.length ? true : undefined, 'data-zcodes': '1' },
    h('summary', {}, 'Social determinants (Z codes)', h('span', { class: 'muted small' }, ' — optional')),
    h('div', { class: 'form-grid' }, (C().Z_CODES || []).map(z => h('label', { class: 'check small' }, h('input', { type: 'checkbox', value: z.code, checked: selected.includes(z.code) }), ` ${z.code} ${z.label}`)),
      h('div', { class: 'field span' }, h('label', {}, 'Other Z55–Z65 codes (comma separated)'), h('input', { type: 'text', 'data-z-other': '1', value: other.join(', ') }))));
  box.read = () => [...box.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value)
    .concat(box.querySelector('[data-z-other]').value.split(',').map(x => x.trim()).filter(Boolean));
  return box;
}

export function openProblemForm(clientId, p, { onDone } = {}) {
  const K = C();
  const z = zCodeBox(p?.z_codes || []);
  const f = form([
    { name: 'problem', label: 'Problem or need', type: 'textarea', rows: 2, span: true, required: true, help: 'In plain words, as the client and team understand it.' },
    { name: 'icd10_code', label: 'ICD-10-CM code', placeholder: 'e.g. F11.20', help: 'Optional. Checked for format only.' },
    { name: 'icd10_description', label: 'Code description', placeholder: 'e.g. Opioid dependence, uncomplicated' },
    { name: 'status', label: 'Status', type: 'select', options: K.PROBLEM_STATUSES || ['active', 'resolved', 'inactive'], noBlank: true, value: p?.status || 'active' },
    { name: 'source', label: 'Identified through', type: 'select', options: (K.PROBLEM_SOURCES || []).map(v => ({ value: v, label: fmt.label(v) })), noBlank: true, value: p?.source || 'self_report' },
    { name: 'onset_date', label: 'Onset / identified on', type: 'date' },
    { name: 'resolved_date', label: 'Resolved on', type: 'date', help: 'Filled in with today when the status is set to resolved.' },
  ], { values: p || {}, submitText: p ? 'Save changes' : 'Add problem', extra: z, onCancel: () => m.close(), onSubmit: async (d) => {
    const body = { ...d, z_codes: z.read() };
    if (p) { await put(`/api/problems/${p.id}`, { ...body, if_updated_at: p.updated_at }); toast('Problem updated', 'ok'); }
    else { await post(`/api/clients/${clientId}/problems`, body); toast('Added to the problem list', 'ok'); }
    m.close(); onDone && onDone();
  } });
  const m = modal(p ? 'Edit problem' : 'Add to the problem list', f, { wide: true });
}

async function showHistory(p) {
  const { rows } = await get(`/api/problems/${p.id}/history`);
  const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  modal(`History: ${p.problem.slice(0, 60)}`, h('div', { 'data-problem-history': p.id }, table([
    { label: 'When', render: x => fmt.dt(x.created_at) }, { label: 'Who', key: 'changed_by_name' }, { label: 'What', render: x => fmt.label(x.action) },
    { label: 'Changes', render: x => h('ul', { class: 'small', style: { margin: 0, paddingLeft: '1.1rem' } }, Object.entries(x.changes).map(([k, c]) => h('li', {}, h('b', {}, fmt.label(k)), `: ${show(c.from)} → ${show(c.to)}`))) },
  ], rows, { empty: 'No history.' })), { wide: true });
}

export async function problemsTab(clientId, { refresh } = {}) {
  const { rows } = await get(`/api/clients/${clientId}/problems?status=all`);
  const writable = can('careplan:write');
  return h('div', { class: 'card', 'data-problems': '1' },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, 'Problem list'), h('div', { class: 'small muted' }, 'The client\'s current problems and needs (CalAIM). Keep it current: resolve what no longer applies rather than deleting it — every change is kept in the history. Notes can say which problems they address.')),
      writable ? h('button', { class: 'btn sm primary', 'data-add-problem': '1', onClick: () => openProblemForm(clientId, null, { onDone: refresh }) }, '+ Problem') : null),
    rows.length ? table([
      { label: 'Problem / need', render: p => h('div', { 'data-problem-row': p.id }, p.problem, p.icd10_code ? h('div', { class: 'small muted' }, `${p.icd10_code}${p.icd10_description ? ' — ' + p.icd10_description : ''}`) : null, p.z_codes.length ? h('div', { class: 'small muted' }, p.z_codes.join(', ')) : null) },
      { label: 'Status', render: p => badge(fmt.label(p.status), PROBLEM_STATUS_KIND[p.status]) },
      { label: 'Onset', render: p => fmt.date(p.onset_date) }, { label: 'Resolved', render: p => fmt.date(p.resolved_date) },
      { label: 'Source', render: p => fmt.label(p.source) }, { label: 'Notes', key: 'notes', num: true }, { label: 'Goals', key: 'goals', num: true },
      { label: 'Last change', render: p => h('span', { class: 'small' }, `${fmt.date(p.updated_at)}${p.updated_by_name ? ' · ' + p.updated_by_name : ''}`) },
      { label: '', render: p => h('div', { class: 'row nowrap' },
        writable ? h('button', { class: 'btn sm ghost', 'data-edit-problem': p.id, onClick: () => openProblemForm(clientId, p, { onDone: refresh }) }, 'Edit') : null,
        writable && p.status === 'active' ? h('button', { class: 'btn sm ghost', 'data-resolve-problem': p.id, onClick: async () => { await put(`/api/problems/${p.id}`, { status: 'resolved', if_updated_at: p.updated_at }); toast('Marked resolved', 'ok'); refresh && refresh(); } }, 'Resolve') : null,
        h('button', { class: 'btn sm ghost', 'data-problem-history-btn': p.id, onClick: () => showHistory(p) }, 'History')) },
    ], rows) : emptyState('No problems recorded', 'Add what the client is working on — health, substance use, housing, legal, income. An optional ICD-10-CM code and social determinant (Z) codes can be attached.'));
}

// ---------------------------------------------------------------- Care plan
function openGoalForm(clientId, g, problems, { onDone } = {}) {
  const f = form([
    { name: 'goal', label: 'Goal, in the client\'s words', type: 'textarea', rows: 3, span: true, required: true, placeholder: 'e.g. "I want my own place by winter."' },
    { name: 'problem_id', label: 'Problem it addresses', type: 'select', options: problems.map(p => ({ value: p.id, label: p.problem.slice(0, 80) })), placeholder: '— none —' },
    { name: 'status', label: 'Status', type: 'select', options: C().GOAL_STATUSES || ['active'], noBlank: true, value: g?.status || 'active' },
    { name: 'target_date', label: 'Target date', type: 'date' },
    { name: 'review_date', label: 'Review with the client by', type: 'date', help: 'Shown as overdue on the client\'s Overview once it passes.' },
  ], { values: g || {}, submitText: g ? 'Save goal' : 'Add goal', onCancel: () => m.close(), onSubmit: async (d) => {
    if (g) await put(`/api/goals/${g.id}`, { ...d, if_updated_at: g.updated_at }); else await post(`/api/clients/${clientId}/goals`, d);
    toast(g ? 'Goal saved' : 'Goal added', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(g ? 'Edit goal' : 'New care plan goal', f, { wide: true });
}
function openStepForm(goal, s, { onDone } = {}) {
  const f = form([
    { name: 'step', label: 'Step or intervention', type: 'textarea', rows: 2, span: true, required: true },
    { name: 'owner_role', label: 'Who does it', type: 'select', options: C().STEP_OWNERS || ['staff'], noBlank: true, value: s?.owner_role || 'staff' },
    { name: 'owner_user_id', label: 'Staff member', type: 'user', help: 'For a staff step: whose list the to-do goes on (you, if blank).' },
    { name: 'target_date', label: 'Target date', type: 'date' },
    s ? { name: 'status', label: 'Status', type: 'select', options: C().STEP_STATUSES || ['open'], noBlank: true, value: s.status } : null,
    !s && can('tasks:write') ? { name: 'create_task', label: 'Also add it to the to-do list', type: 'checkbox', span: true } : null,
  ].filter(Boolean), { values: s || {}, submitText: s ? 'Save step' : 'Add step', onCancel: () => m.close(), onSubmit: async (d) => {
    if (s) await put(`/api/steps/${s.id}`, { ...d, if_updated_at: s.updated_at }); else { const r = await post(`/api/goals/${goal.id}/steps`, d); if (r.task_id) toast('Step added, and put on the to-do list', 'ok'); }
    if (s || !d.create_task) toast(s ? 'Step saved' : 'Step added', 'ok');
    m.close(); onDone && onDone();
  } });
  const m = modal(s ? 'Edit step' : 'Add a step', f, { wide: true });
}

function printCarePlan(clientDisplay, problems, goals) {
  const probs = problems.filter(p => p.status === 'active').map(p => `<tr><td>${esc(p.problem)}</td><td>${esc([p.icd10_code, ...p.z_codes].filter(Boolean).join(', '))}</td><td>${esc(fmt.date(p.onset_date))}</td><td>${esc(fmt.label(p.source))}</td></tr>`).join('');
  const gl = goals.map(g => `<h3>${esc(g.goal)}</h3><p>${g.problem ? `Addresses: ${esc(g.problem)} · ` : ''}Status: ${esc(fmt.label(g.status))}${g.target_date ? ` · Target ${esc(fmt.date(g.target_date))}` : ''}${g.review_date ? ` · Review by ${esc(fmt.date(g.review_date))}` : ''}${g.reviewed_at ? ` · Last reviewed ${esc(fmt.date(g.reviewed_at))}` : ''}</p>
<table><tr><th>Step</th><th>Who</th><th>By</th><th>Status</th></tr>${g.steps.map(s => `<tr><td>${esc(s.step)}</td><td>${esc(fmt.label(s.owner_role))}${s.owner_name ? ' — ' + esc(s.owner_name) : ''}</td><td>${esc(fmt.date(s.target_date))}</td><td>${esc(fmt.label(s.status))}</td></tr>`).join('') || '<tr><td colspan="4">No steps yet.</td></tr>'}</table>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Care plan — ${esc(clientDisplay)}</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%;font-size:.85rem;margin-bottom:1rem}th,td{border:1px solid #999;padding:.3rem .5rem;text-align:left;vertical-align:top}h1{font-size:1.3rem}h2{font-size:1.1rem;margin-top:1.5rem}h3{font-size:1rem;margin-bottom:.2rem}p{font-size:.85rem}.sig{margin-top:2.5rem;display:flex;gap:3rem}.sig div{border-top:1px solid #111;padding-top:.2rem;min-width:14rem;font-size:.8rem}</style></head><body>
<h1>Care coordination plan — ${esc(clientDisplay)}</h1>
<p>Printed ${esc(fmt.dt(new Date().toISOString()))} by ${esc(state.user?.display_name || '')}. Contains information protected by federal confidentiality rules (42 CFR Part 2); redisclosure is prohibited without the client's written consent.</p>
<h2>Active problems</h2><table><tr><th>Problem / need</th><th>Codes</th><th>Onset</th><th>Source</th></tr>${probs || '<tr><td colspan="4">None recorded.</td></tr>'}</table>
<h2>Goals and steps</h2>${gl || '<p>No goals yet.</p>'}
<div class="sig"><div>Client</div><div>Staff</div><div>Date</div></div></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the care plan', 'error'); return; }
  w.document.open(); w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}

export async function carePlanTab(clientId, { refresh, clientDisplay } = {}) {
  const [{ goals }, { rows: problems }] = await Promise.all([get(`/api/clients/${clientId}/care-plan`), get(`/api/clients/${clientId}/problems?status=all`)]);
  const writable = can('careplan:write');
  const active = problems.filter(p => p.status === 'active');
  const goalCard = (g) => h('div', { class: 'card mt', 'data-goal': g.id },
    h('div', { class: 'card-head' }, h('div', {},
      h('h4', { style: { margin: 0 } }, `“${g.goal}”`),
      h('div', { class: 'small muted' }, g.problem ? `Addresses: ${g.problem}` : 'Not tied to a problem', g.target_date ? ` · target ${fmt.date(g.target_date)}` : '', g.reviewed_at ? ` · last reviewed ${fmt.date(g.reviewed_at)}` : ''),
      h('div', { class: 'row', style: { gap: '.3rem', marginTop: '.25rem' } }, badge(fmt.label(g.status), GOAL_STATUS_KIND[g.status]),
        g.review_date ? (g.review_overdue ? badge(`Review overdue (${fmt.date(g.review_date)})`, 'danger') : badge(`Review by ${fmt.date(g.review_date)}`, 'info')) : null)),
      writable ? h('div', { class: 'row nowrap' },
        h('button', { class: 'btn sm', 'data-add-step': g.id, onClick: () => openStepForm(g, null, { onDone: refresh }) }, '+ Step'),
        g.status === 'active' ? h('button', { class: 'btn sm ghost', 'data-review-goal': g.id, onClick: async () => {
          const f = form([{ name: 'review_date', label: 'Next review by', type: 'date', required: true, value: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) }], { submitText: 'Record review', onCancel: () => m.close(), onSubmit: async (d) => { await put(`/api/goals/${g.id}`, { reviewed: true, review_date: d.review_date }); toast('Review recorded', 'ok'); m.close(); refresh && refresh(); } });
          const m = modal('Reviewed with the client today', f);
        } }, 'Reviewed') : null,
        h('button', { class: 'btn sm ghost', 'data-edit-goal': g.id, onClick: () => openGoalForm(clientId, g, active.concat(problems.filter(p => p.id === g.problem_id && p.status !== 'active')), { onDone: refresh }) }, 'Edit'),
        (g.created_by === state.user.id || can('clients:all')) ? h('button', { class: 'btn sm ghost danger', onClick: async () => { if (await confirmDialog('Delete this goal?', 'For a goal entered in error. A goal the client has moved on from should be marked Discontinued instead, so the plan keeps its history.', { danger: true, okText: 'Delete' })) { await del(`/api/goals/${g.id}`); toast('Goal deleted', 'ok'); refresh && refresh(); } } }, 'Delete') : null) : null),
    g.steps.length ? table([
      { label: 'Step', render: s => h('span', { 'data-step': s.id }, s.step) },
      { label: 'Who', render: s => `${fmt.label(s.owner_role)}${s.owner_name ? ' — ' + s.owner_name : ''}` },
      { label: 'By', render: s => h('span', { style: s.overdue ? { color: 'var(--danger)', fontWeight: 600 } : {} }, fmt.date(s.target_date)) },
      { label: 'Status', render: s => h('span', {}, badge(fmt.label(s.status), s.status === 'done' ? 'ok' : s.status === 'cancelled' ? '' : 'info'), s.task_id ? h('span', { class: 'small muted' }, ' · on to-do list') : null) },
      { label: '', render: s => writable ? h('div', { class: 'row nowrap' },
        s.status === 'open' ? h('button', { class: 'btn sm', 'data-step-done': s.id, onClick: async () => { await put(`/api/steps/${s.id}`, { status: 'done' }); toast('Step done', 'ok'); refresh && refresh(); } }, 'Done') : null,
        h('button', { class: 'btn sm ghost', onClick: () => openStepForm(g, s, { onDone: refresh }) }, 'Edit')) : null },
    ], g.steps) : h('p', { class: 'small muted' }, 'No steps yet.'));
  return h('div', { 'data-careplan': '1' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' },
      h('div', {}, h('h3', {}, 'Care coordination plan'), h('div', { class: 'small muted' }, 'Goals in the client\'s own words, tied to the problem list, with the steps toward each one, who does them and by when. Set a review date and go over the plan with the client when it comes due.')),
      h('div', { class: 'row nowrap' },
        h('button', { class: 'btn sm', 'data-print-careplan': '1', onClick: () => printCarePlan(clientDisplay || '', problems, goals) }, 'Print'),
        writable ? h('button', { class: 'btn sm primary', 'data-add-goal': '1', onClick: () => openGoalForm(clientId, null, active, { onDone: refresh }) }, '+ Goal') : null)),
      !goals.length ? emptyState('No goals yet', active.length ? 'Start with what the client most wants to change, in their words.' : 'Goals usually follow from the problem list — add problems first, then a goal for the ones the client wants to work on.') : null),
    goals.map(goalCard));
}

// ---------------------------------------------------------------- ASAM
function openAsamForm(clientId, a, { onDone } = {}) {
  const K = C(); const dims = K.ASAM_DIMENSIONS || [];
  const ratings = (K.ASAM_RATINGS || []).map(r => ({ value: String(r.value), label: r.label }));
  const fields = [{ name: 'assessed_at', label: 'Date of assessment', type: 'date', required: true, value: a?.assessed_at || fmt.today() }];
  for (const d of dims) {
    fields.push({ type: 'section', label: d.label });
    fields.push({ name: `${d.key}_rating`, label: 'Risk rating', type: 'select', options: ratings, required: true, value: a ? String(a[`${d.key}_rating`]) : '' });
    fields.push({ name: `note_${d.key}`, label: 'What supports this rating', type: 'textarea', rows: 2, value: a?.dimension_notes?.[d.key] || '' });
  }
  fields.push({ type: 'section', label: 'Level of care' },
    { name: 'recommended_loc', label: 'Recommended level of care', type: 'select', options: K.ASAM || [] },
    { name: 'actual_loc', label: 'Level referred to', type: 'select', options: K.ASAM || [] },
    { name: 'discrepancy_reason', label: 'If they differ, why', type: 'select', options: (K.ASAM_DISCREPANCY_REASONS || []).map(v => ({ value: v, label: fmt.label(v) })), help: 'Required when the level referred to differs from the level recommended.' },
    { name: 'discrepancy_notes', label: 'Discrepancy notes', type: 'textarea', rows: 2 },
    { name: 'summary', label: 'Summary', type: 'textarea', rows: 3, span: true });
  const values = a ? { ...a } : {};
  const f = form(fields, { values, submitText: a ? 'Save assessment' : 'Save assessment', onCancel: () => m.close(), onSubmit: async (d) => {
    const body = { assessed_at: d.assessed_at, recommended_loc: d.recommended_loc, actual_loc: d.actual_loc, discrepancy_reason: d.discrepancy_reason, discrepancy_notes: d.discrepancy_notes, summary: d.summary, dimension_notes: {} };
    for (const dm of dims) { body[`${dm.key}_rating`] = d[`${dm.key}_rating`] === null ? null : Number(d[`${dm.key}_rating`]); if (d[`note_${dm.key}`]) body.dimension_notes[dm.key] = d[`note_${dm.key}`]; }
    if (a) await put(`/api/asam/${a.id}`, { ...body, if_updated_at: a.updated_at });
    else { const r = await post(`/api/clients/${clientId}/asam`, body); if (r.client_asam_level) toast(`Assessment saved. The client's level of care is now ${r.client_asam_level}.`, 'ok'); }
    if (a) toast('Assessment saved', 'ok');
    m.close(); onDone && onDone();
  } });
  const m = modal(a ? 'Edit ASAM assessment' : 'ASAM multidimensional assessment', h('div', {},
    h('p', { class: 'small muted' }, 'Rate the risk in each of the six ASAM dimensions from 0 (none) to 4 (severe) and note what supports it. Use your programme\'s ASAM Criteria materials for the rating definitions; SUDS records the ratings and the level of care decision.'), f), { wide: true });
}
function asamDetail(a, { onDone } = {}) {
  const dims = C().ASAM_DIMENSIONS || [];
  const mayEdit = can('assessments:write') && (a.assessed_by === state.user.id || can('clients:all'));
  const m = modal(`ASAM assessment — ${fmt.date(a.assessed_at)}`, h('div', {},
    kv([['Assessed by', a.assessed_by_name], ['Recommended level', a.recommended_loc], ['Referred to', a.actual_loc], ['Discrepancy', a.discrepancy ? `${fmt.label(a.discrepancy_reason)}${a.discrepancy_notes ? ' — ' + a.discrepancy_notes : ''}` : 'None'], ['Summary', a.summary]]),
    table([{ label: 'Dimension', key: 'label' }, { label: 'Rating', render: d => String(a[`${d.key}_rating`]) }, { label: 'Notes', render: d => a.dimension_notes?.[d.key] || '—' }], dims),
    mayEdit ? h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: () => { m.close(); openAsamForm(a.client_id, a, { onDone }); } }, 'Edit'),
      h('button', { class: 'btn danger', onClick: async () => { if (await confirmDialog('Delete this assessment?', 'Only for an assessment entered in error.', { danger: true, okText: 'Delete' })) { await del(`/api/asam/${a.id}`); m.close(); toast('Deleted', 'ok'); onDone && onDone(); } } }, 'Delete')) : null), { wide: true });
}

// ---------------------------------------------------------------- Outcome measures
/** Score in the browser, the same way server/clinical.js does, for the live total shown on the form. */
function previewScore(ins, answers, variant) {
  if (answers.some(v => v === null || v === '' || v === undefined)) return null;
  const total = answers.reduce((s, v) => s + Number(v), 0);
  if (ins.bands) return { total, band: (ins.bands.find(([lo, hi]) => total >= lo && total <= hi) || [])[2] || '' };
  const cut = ins.variants ? (ins.variants.find(x => x.value === variant) || ins.variants.find(x => x.value === 'unspecified')).positiveAt : ins.positiveAt;
  return { total, band: total >= cut ? 'Positive screen' : 'Negative screen' };
}

export function openOutcomeForm(clientId, code, { onDone, clientDisplay } = {}) {
  const ins = (C().INSTRUMENTS || {})[code]; if (!ins) return;
  const fields = [{ name: 'administered_at', label: 'Date given', type: 'date', required: true, value: fmt.today() }];
  if (ins.variants) fields.push({ name: 'variant', label: 'Scoring cut-off', type: 'select', options: ins.variants.map(v => ({ value: v.value, label: v.label })), value: 'unspecified', noBlank: true });
  fields.push({ type: 'section', label: ins.stem });
  ins.items.forEach((it, i) => fields.push({ name: `q${i}`, label: `${ins.items.length > 1 ? `${i + 1}. ` : ''}${it.text}`, type: 'select', span: true, required: true, options: it.options.map(o => ({ value: String(o.value), label: `${o.label}${ins.items.length > 1 && it.options.length <= 5 ? ` (${o.value})` : ''}` })) }));
  fields.push({ name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: true });
  const scoreLine = h('div', { class: 'banner', role: 'status', 'aria-live': 'polite', 'data-outcome-preview': '1' }, 'Answer every question to see the score.');
  const f = form(fields, { submitText: 'Save', extra: scoreLine, onCancel: () => m.close(), onSubmit: async (d) => {
    const responses = ins.items.map((_, i) => Number(d[`q${i}`]));
    const r = await post(`/api/clients/${clientId}/outcomes`, { instrument: code, administered_at: d.administered_at, responses, variant: d.variant || undefined, notes: d.notes });
    m.close();
    toast(`${ins.name} saved: ${r.total} — ${r.band}`, 'ok');
    if (r.safety_alert) safetyAlert(clientId, r.safety_alert, { onDone, clientDisplay });
    else onDone && onDone();
  } });
  const update = () => {
    const answers = ins.items.map((_, i) => f.inputs[`q${i}`].value);
    const s = previewScore(ins, answers, f.inputs.variant?.value);
    scoreLine.textContent = s ? `Score: ${s.total} of ${ins.max} — ${s.band}` : 'Answer every question to see the score.';
    const item9 = ins.safetyItem !== undefined && Number(f.inputs[`q${ins.safetyItem}`].value) > 0;
    scoreLine.className = item9 ? 'banner danger' : 'banner';
    if (item9) scoreLine.append(h('div', {}, 'Question 9 is above "Not at all": saving will raise a safety alert.'));
  };
  f.addEventListener('change', update);
  const m = modal(`${ins.name} — ${ins.title}`, h('div', { 'data-outcome-form': code }, f, h('p', { class: 'small muted' }, ins.credit)), { wide: true });
}

function safetyAlert(clientId, alert, { onDone, clientDisplay } = {}) {
  const box = h('div', { 'data-safety-alert-dialog': '1' },
    h('div', { class: 'banner danger', role: 'alert' }, alert.message || 'Safety alert.'),
    alert.task_id ? h('p', { class: 'small' }, 'An urgent to-do has been put on your list for today.') : null,
    h('div', { class: 'btn-row' },
      alert.safety_plan ? h('button', { class: 'btn primary', 'data-open-safety-plan': alert.safety_plan.id, onClick: async () => { m.close(); (await import('./notes.js')).openNote(alert.safety_plan.id, { onChange: onDone }); } }, `Open the safety plan (${fmt.date(alert.safety_plan.occurred_at)})`)
        : (can('notes:admin:write') || can('notes:clinical:write')) ? h('button', { class: 'btn primary', 'data-write-safety-plan': '1', onClick: async () => { m.close(); (await import('./notes.js')).openNoteForm(null, { clientId, clientDisplay, onDone, prefill: { format: 'safety_plan', title: 'Safety plan' } }); } }, 'Write a safety plan now') : null,
      h('button', { class: 'btn', onClick: () => { m.close(); onDone && onDone(); } }, 'Close')));
  const m = modal('Safety alert', box);
}

export async function assessmentsTab(clientId, { refresh, clientDisplay } = {}) {
  const [asam, out] = await Promise.all([get(`/api/clients/${clientId}/asam`), get(`/api/clients/${clientId}/outcomes`)]);
  const writable = can('assessments:write');
  const INS = C().INSTRUMENTS || {};
  const asamCard = h('div', { class: 'card', 'data-asam': '1' },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, 'ASAM assessments'), h('div', { class: 'small muted' }, 'Six-dimension risk ratings and the level of care decision. The latest is shown on the Overview and sets the client\'s level of care.')),
      writable ? h('button', { class: 'btn sm primary', 'data-add-asam': '1', onClick: () => openAsamForm(clientId, null, { onDone: refresh }) }, '+ ASAM assessment') : null),
    table([
      { label: 'Date', render: a => fmt.date(a.assessed_at) },
      ...[1, 2, 3, 4, 5, 6].map(n => ({ label: `D${n}`, render: a => h('span', { style: a.ratings[n - 1] >= 3 ? { color: 'var(--danger)', fontWeight: 600 } : {} }, String(a.ratings[n - 1])) })),
      { label: 'Recommended', render: a => a.recommended_loc || '—' }, { label: 'Referred', render: a => a.actual_loc || '—' },
      { label: 'Discrepancy', render: a => a.discrepancy ? fmt.label(a.discrepancy_reason) : '—' }, { label: 'By', key: 'assessed_by_name' },
    ], asam.rows, { onRow: (a) => asamDetail(a, { onDone: refresh }), empty: 'No ASAM assessments yet.' }));
  const series = out.series || {};
  const outcomesCard = h('div', { class: 'card mt', 'data-outcomes': '1' },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, 'Outcome measures'), h('div', { class: 'small muted' }, 'Standardized screenings, scored automatically. Give the same one again over time to see the trend.')),
      writable ? h('div', { class: 'row' }, Object.values(INS).map(i => h('button', { class: 'btn sm', 'data-add-outcome': i.code, onClick: () => openOutcomeForm(clientId, i.code, { onDone: refresh, clientDisplay }) }, `+ ${i.name}`))) : null),
    Object.keys(series).length ? h('div', { class: 'grid cols-4 mb' }, Object.entries(series).map(([code, s]) => h('div', { class: 'card stat', 'data-outcome-trend': code },
      h('div', { class: 'small muted' }, INS[code]?.name || code), h('div', { style: { fontWeight: 600 } }, `${s[s.length - 1].score} · ${s[s.length - 1].band || ''}`), trend(s, INS[code]?.max)))) : null,
    table([
      { label: 'Date', render: m => fmt.date(m.administered_at) }, { label: 'Measure', key: 'name' },
      { label: 'Score', render: m => h('span', { 'data-outcome-score': m.id }, `${m.total_score}`) }, { label: 'Result', render: m => h('span', {}, m.band || '—', m.safety_flag ? ' ' : '', m.safety_flag ? badge('Safety alert', 'danger') : null) },
      { label: 'By', key: 'administered_by_name' },
      { label: '', render: m => writable && (m.administered_by === state.user.id || can('clients:all')) ? h('button', { class: 'btn sm ghost danger', onClick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete this result?', 'Only for a questionnaire entered in error.', { danger: true, okText: 'Delete' })) { await del(`/api/outcomes/${m.id}`); toast('Deleted', 'ok'); refresh && refresh(); } } }, 'Delete') : null },
    ], out.rows, { empty: 'No outcome measures yet.', onRow: (m) => {
      const ins = INS[m.instrument];
      modal(`${m.name} — ${fmt.date(m.administered_at)}`, h('div', {}, kv([['Score', `${m.total_score} of ${ins?.max ?? '?'} — ${m.band || ''}`], ['Given by', m.administered_by_name], ['Notes', m.notes]]),
        ins ? table([{ label: 'Question', render: x => x.text }, { label: 'Answer', render: x => x.answer }], ins.items.map((it, i) => ({ text: it.text, answer: (it.options.find(o => o.value === m.responses[i]) || {}).label || '—' }))) : null), { wide: true });
    } }));
  return h('div', {}, asamCard, outcomesCard);
}

// ---------------------------------------------------------------- note form: problems addressed
/**
 * The "Problems this note addresses" checkboxes for the note form. Loads the client's active problems (and
 * any already linked); `read()` gives the ids ticked. Empty and silent for a role that cannot read the list.
 */
export function problemPicker(initial = []) {
  const box = h('fieldset', { class: 'span hidden', 'data-note-problems': '1' }, h('legend', {}, 'Problems this note addresses'));
  let chosen = new Set(initial);
  box.load = async (clientId) => {
    if (!clientId || !can('careplan:read')) { box.classList.add('hidden'); return; }
    let rows = [];
    try { rows = (await get(`/api/clients/${clientId}/problems?status=all`, { quiet: true })).rows; box.loaded = true; } catch { rows = []; box.loaded = false; }
    rows = rows.filter(p => p.status === 'active' || chosen.has(p.id));
    clear(box).append(h('legend', {}, 'Problems this note addresses'));
    if (!rows.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    for (const p of rows) box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p.id, checked: chosen.has(p.id), onChange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); } }), ` ${p.problem}`));
  };
  box.read = () => [...chosen];
  box.reset = () => { chosen = new Set(); };
  return box;
}
