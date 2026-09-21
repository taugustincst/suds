import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, stat, bars, downloadCsv, loadRefData } from '../app.js';

export function openExpenditureForm(values, { clientId, clientDisplay, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  let lineSel;
  const f = form([
    { name: 'funding_source_id', label: 'Funding source', type: 'fund', required: true }, { name: 'budget_line_id', label: 'Budget line', type: 'select', options: [] },
    { name: 'spent_at', label: 'Date', type: 'date', required: true, value: values?.spent_at || fmt.today() }, { name: 'amount', label: 'Amount ($)', type: 'number', min: 0.01, step: 0.01, required: true },
    { name: 'category', label: 'Category', type: 'select', options: C.BUDGET_CATEGORIES, required: true }, { name: 'client_id', label: 'Client (for client assistance)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    { name: 'vendor', label: 'Vendor / payee' }, { name: 'receipt_ref', label: 'Receipt / invoice #' }, { name: 'description', label: 'Description', type: 'textarea', span: true, rows: 2 },
  ], { values: values || {}, submitText: isNew ? 'Submit expenditure' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    // Overspending a line is not blocked (the allocation may simply be out of date), but it must not be
    // frictionless either: say by how much, before the money is committed rather than after.
    const fund = state.funds.find(x => x.id === d.funding_source_id); const line = fund && d.budget_line_id ? flattenLines(fund.lines).find(x => x.id === d.budget_line_id) : null;
    const prior = !isNew && values.budget_line_id === d.budget_line_id ? Number(values.amount) : 0;
    if (line && Number(d.amount) - prior > line.available) {
      const over = Number(d.amount) - prior - line.available;
      if (!await confirmDialog('This overspends the budget line', `${line.label || fmt.label(line.category)} has ${fmt.money(line.available)} available${line.children && line.children.length ? ' after its sub-allocations' : ''}; this would go ${fmt.money(over)} over. Record it anyway?`, { danger: true, okText: 'Record anyway' })) return;
    }
    if (isNew) await post('/api/budget/expenditures', d); else await put(`/api/budget/expenditures/${values.id}`, d); toast('Expenditure saved (pending approval)', 'ok'); m.close(); onDone && onDone(); } });
  lineSel = f.inputs.budget_line_id;
  const fundSel = f.inputs.funding_source_id;
  // Flattened so a sub-allocation nested under a larger one is still a pickable line, not hidden inside its
  // parent — indented to show where it sits. "available" is what can still be spent directly against that
  // line: its allocation less what it has handed down to sub-allocations and less its own spend.
  const fillLines = () => { const fund = state.funds.find(x => x.id === fundSel.value); lineSel.replaceChildren(h('option', { value: '' }, '— none —'), ...flattenLines(fund ? fund.lines : []).map(l => h('option', { value: l.id, selected: l.id === values?.budget_line_id }, `${'— '.repeat(l._depth)}${l.label || fmt.label(l.category)} (${fmt.money(l.available)} available)`))); };
  fundSel.addEventListener('change', () => { fillLines(); const fund = state.funds.find(x => x.id === fundSel.value); if (fund && !f.inputs.category.value && fund.lines[0]) f.inputs.category.value = fund.lines[0].category; });
  lineSel.addEventListener('change', () => { const fund = state.funds.find(x => x.id === fundSel.value); const l = fund && flattenLines(fund.lines).find(x => x.id === lineSel.value); if (l) f.inputs.category.value = l.category; });
  fillLines();
  const m = modal(isNew ? 'Record expenditure' : 'Edit expenditure', f, { wide: true });
}
export function expenditureTable(rows, { showClient = true, onChange } = {}) {
  // Approving is one click but confirmed; rejecting asks for the reason the submitter will see. Neither has
  // an undo, and county money deserves at least the same care as deleting a to-do gets.
  const approve = async (r, status) => {
    let note;
    if (status === 'rejected') { note = await confirmDialog('Reject this expenditure', `Reject ${fmt.money(r.amount)}${r.vendor ? ` to ${r.vendor}` : ''} submitted by ${r.worker}? They will see your reason.`, { danger: true, okText: 'Reject', requireReason: true }); if (!note) return; }
    else if (status === 'approved') { if (!await confirmDialog('Approve this expenditure', `Approve ${fmt.money(r.amount)}${r.vendor ? ` to ${r.vendor}` : ''} against ${r.fund}?`, { okText: 'Approve' })) return; }
    await post(`/api/budget/expenditures/${r.id}/approve`, { status, note }); toast(`Marked ${status}`, 'ok'); onChange && onChange();
  };
  return table([
    { label: 'Date', render: r => fmt.date(r.spent_at) }, { label: 'Fund', render: r => h('div', {}, r.fund, r.line_label || r.line_category ? h('div', { class: 'small muted' }, r.line_label || fmt.label(r.line_category)) : null) }, { label: 'Category', render: r => fmt.label(r.category) },
    showClient ? { label: 'Client', render: r => r.client_id ? h('a', { href: `#/client/${r.client_id}` }, r.client_code) : '—' } : null, { label: 'Amount', render: r => fmt.money(r.amount), num: true },
    { label: 'Vendor / description', render: r => h('span', { class: 'small' }, r.vendor ? h('b', {}, r.vendor, ' ') : null, r.description || '', r.receipt_ref ? h('span', { class: 'muted' }, ` #${r.receipt_ref}`) : null) },
    { label: 'Status', render: r => [badge(fmt.label(r.status), statusKind(r.status)), r.approver ? h('div', { class: 'small muted' }, r.approver) : null, r.approval_note ? h('div', { class: 'small', title: 'Reviewer\'s note' }, `“${r.approval_note}”`) : null] }, { label: 'By', key: 'worker' },
    { label: '', render: r => h('div', { class: 'row nowrap' }, r.status === 'pending' && can('budget:approve') && r.user_id !== state.user.id ? [h('button', { class: 'btn sm primary', onClick: () => approve(r, 'approved') }, 'Approve'), h('button', { class: 'btn sm', onClick: () => approve(r, 'rejected') }, 'Reject')] : null,
      // Separation of duties, said out loud: the buttons are missing on purpose, not broken.
      r.status === 'pending' && can('budget:approve') && r.user_id === state.user.id ? h('span', { class: 'small muted', 'data-self-review': '1' }, 'Waiting for someone else to review') : null, r.status === 'approved' && can('budget:approve') ? h('button', { class: 'btn sm', onClick: () => approve(r, 'reimbursed') }, 'Reimbursed') : null,
      r.status === 'pending' && (r.user_id === state.user.id || can('budget:approve')) ? [h('button', { class: 'btn sm', onClick: () => openExpenditureForm(r, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this expenditure', onClick: async () => { if (await confirmDialog('Delete', 'Delete this pending expenditure?', { danger: true, okText: 'Delete' })) { await del(`/api/budget/expenditures/${r.id}`); onChange && onChange(); } } }, '✕')] : null) },
  ].filter(Boolean), rows, { empty: 'No expenditures.' });
}
function openFundForm(values, onDone) {
  const C = state.constants; const isNew = !values;
  const f = form([{ name: 'name', label: 'Fund / grant name', required: true, span: true }, { name: 'source_type', label: 'Source type', type: 'select', options: C.FUNDING_TYPES, required: true }, { name: 'grant_number', label: 'Grant / award #' },
    { name: 'fiscal_year_start', label: 'Period start', type: 'date', required: true }, { name: 'fiscal_year_end', label: 'Period end', type: 'date', required: true }, { name: 'total_amount', label: 'Total award ($)', type: 'number', min: 0, step: 0.01, required: true },
    { name: 'restrictions', label: 'Allowable uses / restrictions', type: 'textarea', span: true, rows: 2 }, { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 2 }, { name: 'is_active', label: 'Active', type: 'checkbox', value: values ? values.is_active : true }],
    { values: values || {}, submitText: isNew ? 'Create fund' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => { if (isNew) await post('/api/budget/funds', d); else await put(`/api/budget/funds/${values.id}`, d); toast('Fund saved', 'ok'); m.close(); await loadRefData(); onDone(); } });
  const m = modal(isNew ? 'New funding source' : 'Edit funding source', f, { wide: true });
}
// Every line in this fund, flattened out of the nested tree with its depth, in tree order (parent right
// before its children) — used both to indent the overview table and to build the "parent allocation" picker.
export function flattenLines(lines, depth = 0, out = []) {
  for (const l of lines) { out.push({ ...l, _depth: depth }); flattenLines(l.children || [], depth + 1, out); }
  return out;
}
// Everything under `id` (not id itself) — a line cannot be nested inside its own sub-allocation, so these
// are excluded from the parent picker when editing rather than relying only on the server's cycle check.
function descendantIds(lines, id) {
  const out = new Set();
  const walk = (ls, inside) => { for (const l of ls) { const nowInside = inside || l.id === id; if (nowInside && l.id !== id) out.add(l.id); walk(l.children || [], nowInside); } };
  walk(lines, false);
  return out;
}
function openLineForm(fund, values, onDone, { parentId } = {}) {
  const C = state.constants; const isNew = !values;
  const excluded = values ? descendantIds(fund.lines, values.id) : new Set();
  if (values) excluded.add(values.id);
  const parentOptions = flattenLines(fund.lines, 0, []).filter(l => !excluded.has(l.id)).map(l => ({ value: l.id, label: `${'— '.repeat(l._depth)}${l.label || fmt.label(l.category)}` }));
  const f = form([
    { name: 'category', label: 'Category', type: 'select', options: C.BUDGET_CATEGORIES, required: true }, { name: 'label', label: 'Label' },
    { name: 'allocated_amount', label: 'Allocated ($)', type: 'number', min: 0, step: 0.01, required: true },
    { name: 'parent_id', label: 'Part of a larger allocation?', type: 'select', options: parentOptions, placeholder: '— top-level, directly under the fund —', value: values?.parent_id || parentId || '' },
    { name: 'notes', label: 'Notes', span: true },
  ], { values: values || {}, submitText: 'Save', onCancel: () => m.close(), onSubmit: async (d) => { if (isNew) await post(`/api/budget/funds/${fund.id}/lines`, d); else await put(`/api/budget/lines/${values.id}`, d); m.close(); await loadRefData(); onDone(); } });
  const m = modal(`${fund.name} — budget line`, f);
}
route('budget', async (r) => {
  const tab = r.query.get('tab') || 'overview';
  const [sum, exp] = await Promise.all([get('/api/budget/summary'), get(`/api/budget/expenditures?limit=300${r.query.get('status') ? '&status=' + r.query.get('status') : ''}`)]);
  const refresh = async () => { await loadRefData(); nav(`budget?tab=${tab}&_=${Date.now()}`); };
  const t = sum.totals;
  const pct = (a, b) => b ? Math.min(100, (a / b) * 100) : 0;
  const fundCard = (f) => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, f.name), h('div', { class: 'small muted' }, `${fmt.label(f.source_type)}${f.grant_number ? ' · ' + f.grant_number : ''} · ${fmt.date(f.fiscal_year_start)} – ${fmt.date(f.fiscal_year_end)}`)), can('budget:manage') ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onClick: () => openLineForm(f, null, refresh) }, '+ Line'), h('button', { class: 'btn sm', onClick: () => openFundForm(f, refresh) }, 'Edit')) : null),
    h('div', { class: 'grid cols-4 mb' }, stat('Award', fmt.money(f.total_amount)), stat('Spent', fmt.money(f.spent), f.pct_spent > 90 ? 'danger' : '', 'budget?tab=expenditures&status=approved'), stat('Pending', fmt.money(f.pending), f.pending ? 'warn' : '', 'budget?tab=expenditures&status=pending'), stat('Remaining', fmt.money(f.remaining), f.remaining < 0 ? 'danger' : 'ok')),
    h('div', { class: 'row between small muted' }, h('span', {}, `${f.pct_spent.toFixed(0)}% spent`), h('span', {}, `${f.pct_elapsed.toFixed(0)}% of period elapsed`)),
    h('div', { class: 'progress mb' }, h('div', { class: f.pct_spent > f.pct_elapsed + 15 ? 'danger' : f.pct_spent > f.pct_elapsed + 5 ? 'warn' : '', style: { width: `${pct(f.spent, f.total_amount)}%` } })),
    f.staff_minutes ? h('div', { class: 'small muted mb' }, `Staff time charged: ${fmt.mins(f.staff_minutes)} logged, ${fmt.mins(f.staff_minutes_approved || 0)} approved${f.staff_cost ? ` (≈ ${fmt.money(f.staff_cost)} at loaded rates, all logged time)` : ''}. The funder report counts approved time only.`) : null,
    // Allocated is always the line's own envelope — a sub-allocation is carved out of its parent's, never
    // stacked on top, so this never sums up the tree. Spent/Pending/Remaining use the subtree total: a
    // parent is usually just a container nobody spends directly against, so its own direct figures would
    // read as "$0 spent" even with thousands committed under it. A leaf's subtree is identical to its own.
    f.lines.length ? table([
      { label: 'Line', render: l => h('div', { style: { paddingLeft: `${l._depth * 18}px` } }, l.label || fmt.label(l.category), l.children.length ? h('div', { class: 'small', style: l.child_allocated > l.allocated_amount ? { color: 'var(--danger)' } : { color: 'var(--muted)' } }, l.child_allocated > l.allocated_amount ? `Sub-allocated ${fmt.money(l.child_allocated - l.allocated_amount)} over its own allocation` : `Sub-allocated: ${fmt.money(l.child_allocated)} of ${fmt.money(l.allocated_amount)}`) : null) },
      { label: 'Category', render: l => fmt.label(l.category) }, { label: 'Allocated', render: l => fmt.money(l.allocated_amount), num: true }, { label: 'Spent', render: l => fmt.money(l.subtree_spent), num: true }, { label: 'Pending', render: l => fmt.money(l.subtree_pending), num: true }, { label: 'Remaining', render: l => h('div', {}, h('span', { style: l.subtree_remaining < 0 ? { color: 'var(--danger)' } : {} }, fmt.money(l.subtree_remaining)), l.children.length ? h('div', { class: 'small', style: l.available < 0 ? { color: 'var(--danger)' } : { color: 'var(--muted)' } }, `${fmt.money(l.available)} available here`) : null), num: true },
      { label: '%', render: l => h('div', { class: 'progress', style: { width: '80px' } }, h('div', { class: pct(l.subtree_spent, l.allocated_amount) > 90 ? 'danger' : '', style: { width: `${pct(l.subtree_spent, l.allocated_amount)}%` } })) },
      { label: '', render: l => can('budget:manage') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openLineForm(f, null, refresh, { parentId: l.id }) }, '+ Sub'), h('button', { class: 'btn sm', onClick: () => openLineForm(f, l, refresh) }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this budget line', onClick: async () => { if (await confirmDialog('Delete line', l.children.length ? 'Delete this budget line and its sub-allocations? Expenditures keep their fund.' : 'Delete this budget line? Expenditures keep their fund.', { danger: true, okText: 'Delete' })) { await del(`/api/budget/lines/${l.id}`); refresh(); } } }, '✕')) : null },
    ], flattenLines(f.lines)) : h('div', { class: 'muted small' }, 'No budget lines yet.'),
    // Over-allocating (lines totaling more than the award) is deliberately not blocked -- a fund's total_amount
    // is itself just the recorded award and may be amended later -- but it must not read the same as an
    // ordinary, harmless remainder, or a report built from these lines can overstate what is actually covered.
    f.unallocated ? h('div', { class: 'small mt', style: f.unallocated < 0 ? { color: 'var(--danger)' } : { color: 'var(--muted)' } }, f.unallocated < 0 ? `Over-allocated by ${fmt.money(-f.unallocated)}` : `Unallocated: ${fmt.money(f.unallocated)}`) : null);
  return h('div', {},
    pageHead('Funding & spending', can('budget:write') ? h('button', { class: 'btn primary', onClick: () => openExpenditureForm(null, { onDone: refresh }) }, '+ Record expenditure') : null, can('budget:manage') ? h('button', { class: 'btn', onClick: () => openFundForm(null, refresh) }, '+ Funding source') : null, h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/expenditures?from=2000-01-01&format=xlsx') }, 'Export to Excel')),
    h('div', { class: 'grid cols-4 mb' }, stat('Total budget', fmt.money(t.budget), '', 'budget?tab=overview'), stat('Spent (approved)', fmt.money(t.spent), '', 'budget?tab=expenditures&status=approved'), stat('Pending approval', fmt.money(t.pending), t.pending ? 'warn' : '', 'budget?tab=expenditures&status=pending'), stat('Remaining', fmt.money(t.remaining), t.remaining < 0 ? 'danger' : 'ok', 'budget?tab=analysis')),
    h('div', { class: 'tabs' }, [['overview', 'Funds'], ['expenditures', `Expenditures`], ['analysis', 'Analysis']].map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onClick: () => nav(`budget?tab=${k}`) }, l))),
    tab === 'overview' ? (sum.funds.length ? h('div', { class: 'grid' }, sum.funds.map(fundCard)) : h('div', { class: 'empty' }, 'No funding sources yet. Add your opioid settlement, SOR, or county allocations.')) : null,
    tab === 'expenditures' ? h('div', {}, h('div', { class: 'filters' }, ['', 'pending', 'approved', 'rejected', 'reimbursed'].map(s => h('button', { class: `btn sm ${(r.query.get('status') || '') === s ? 'primary' : ''}`, onClick: () => nav(`budget?tab=expenditures${s ? '&status=' + s : ''}`) }, s ? fmt.label(s) : 'All'))), expenditureTable(exp.rows, { onChange: refresh })) : null,
    tab === 'analysis' ? h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h3', {}, 'Spend by category'), bars(sum.by_category, { valueKey: 'amount', labelKey: 'category', format: fmt.money })), h('div', { class: 'card' }, h('h3', {}, 'Spend by month'), bars(sum.by_month, { valueKey: 'amount', labelKey: 'month', format: fmt.money })), h('div', { class: 'card' }, h('h3', {}, 'Client assistance'), stat('Clients assisted', sum.per_client.clients), h('div', { class: 'mt' }, stat('Avg per client', fmt.money(sum.per_client.clients ? sum.per_client.amount / sum.per_client.clients : 0))))) : null);
});
