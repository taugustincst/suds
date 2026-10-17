import { h, route, get, post, put, del, state, form, modal, toast, badge, fmt, can, pageHead, confirmDialog, nav, downloadCsv, emptyState, undoToast, table, tabStrip } from '../app.js';

const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read file')); r.readAsDataURL(file); });
const fileIcon = (t) => !t ? '📄' : t.includes('pdf') ? '📄' : t.includes('word') || t.includes('msword') ? '📝' : t.startsWith('image/') ? '🖼' : '📄';
const catKind = { policy: 'info', procedure: '', contract: 'warn' };
// PowerDMS (docs/integration/POWERDMS.md): a policy can be the county's PowerDMS document, read and signed there.
const rolesOf = (s) => (s ? String(s).split(',').filter(Boolean) : []);
const roleList = (s) => rolesOf(s).map(r => fmt.label(r)).join(', ');
const powerdmsLink = (url, label = 'Open in PowerDMS') => h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-powerdms-link': '' }, label, h('span', { class: 'sr-only' }, ' (opens in a new tab)'));

function openDocumentForm(values, onDone) {
  const C = state.constants; const isNew = !values;
  let file = null; let fileLabel = values?.filename || null;
  // .sr-only, not .hidden (display:none) — a programmatic .click() on a display:none file input is silently
  // ignored by a good few mobile browsers/WebViews.
  const fileInput = h('input', { type: 'file', tabindex: '-1', 'aria-hidden': 'true', class: 'sr-only', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/*', onChange: async () => {
    const f = fileInput.files[0]; if (!f) return;
    try { file = await readFile(f); fileLabel = f.name; fileNote.textContent = `Selected: ${f.name}`; } catch (e) { toast(e.message, 'error'); }
  } });
  const fileNote = h('div', { class: 'small muted' }, fileLabel ? `Current file: ${fileLabel}` : 'No file yet');
  // Who must sign it in PowerDMS: one box per role, kept outside form()'s own fields (it has no multi-choice field).
  const chosen = new Set(rolesOf(values && values.ack_roles));
  const roleBoxes = (C.STAFF_ROLES || []).map(r => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r, checked: chosen.has(r), 'data-ack-role': r }), ' ', fmt.label(r)));
  const roles = h('fieldset', { class: 'span ack-roles' }, h('legend', {}, 'Who must sign it in PowerDMS'),
    h('div', { class: 'row wrap' }, roleBoxes),
    h('p', { class: 'help', id: 'ack-roles-help' }, 'Staff in these roles see it under Policy sign-offs until a PowerDMS report (or a supervisor) records that they signed the revision above. Leave all unticked for a document nobody is asked to sign.'));
  const f = form([
    { name: 'title', label: 'Title', required: true, span: true },
    { name: 'category', label: 'Category', type: 'select', options: C.DOCUMENT_CATEGORIES, required: true },
    { name: 'effective_date', label: 'Effective date', type: 'date' }, { name: 'expires_at', label: 'Expires / renewal date', type: 'date' },
    { name: 'description', label: 'Description', type: 'textarea', span: true, rows: 3 },
    { name: 'powerdms_url', label: 'PowerDMS link', type: 'url', span: true, placeholder: 'https://powerdms.com/…', help: 'The document\'s own address in your PowerDMS site, if staff read and sign it there. With a link, a file here is optional.' },
    { name: 'revision', label: 'Revision staff must sign', placeholder: 'e.g. 4', help: 'As PowerDMS numbers it. When it changes, everyone asked to sign it is asked again.' },
  ], { values: values || {}, submitText: 'Save', onCancel: () => m.close(),
    extra: [h('div', { class: 'span' }, h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onClick: () => fileInput.click() }, isNew ? 'Choose file' : 'Replace file'), fileInput), fileNote), roles],
    onSubmit: async (d) => {
      if (file) { d.file_url = file; if (!d.filename) d.filename = fileLabel; }
      d.ack_roles = roleBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value);
      if (isNew && !file && !d.powerdms_url) { toast('Choose a file to upload, or give the PowerDMS link', 'error'); throw new Error('no file'); }
      if (isNew) await post('/api/documents', d); else await put(`/api/documents/${values.id}`, { ...d, if_updated_at: values.updated_at });
      toast(isNew ? 'Document uploaded' : 'Saved', 'ok'); m.close(); onDone();
    } });
  const m = modal(isNew ? 'Add a policy, procedure or contract' : 'Edit document', f, { wide: true });
}

route('documents', async (r) => {
  const cat = r.query.get('category') || '', q = (r.query.get('q') || '').toLowerCase(), inactive = r.query.get('inactive') === '1';
  const qs = new URLSearchParams(); if (cat) qs.set('category', cat); if (inactive) qs.set('all', '1'); if (q) qs.set('q', q);
  const data = await get(`/api/documents${qs.toString() ? '?' + qs : ''}`);
  const rows = data.documents.filter(d => (!inactive ? d.is_active : true));
  const refresh = () => nav(`documents?category=${cat}&q=${encodeURIComponent(q)}${inactive ? '&inactive=1' : ''}&_=${Date.now()}`);
  const search = h('input', { type: 'search', value: q, placeholder: 'A title, or a phrase from inside a document', onKeydown: e => { if (e.key === 'Enter') nav(`documents?category=${cat}&q=${encodeURIComponent(search.value)}`); } });
  const catSel = h('select', { onChange: () => nav(`documents?category=${catSel.value}&q=${encodeURIComponent(q)}`) }, h('option', { value: '' }, 'All categories'), data.categories.map(c => h('option', { value: c, selected: c === cat }, fmt.label(c))));
  const card = (d) => h('div', { class: `card doc-card ${d.is_active ? '' : 'inactive'}` },
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'start' } },
      h('div', {}, h('div', { class: 'row' }, h('span', {}, fileIcon(d.content_type)), h('b', {}, d.title)), h('div', { class: 'small' }, badge(fmt.label(d.category), catKind[d.category]), d.is_active ? null : [' ', badge('Retired', 'warn')])),
    ),
    d.description ? h('p', { class: 'small doc-desc' }, d.description) : null,
    d.snippet ? h('p', { class: 'small muted doc-snippet' }, h('b', {}, 'In the file: '), d.snippet) : null,
    h('div', { class: 'small muted' }, [d.effective_date ? `Effective ${fmt.date(d.effective_date)}` : null, d.expires_at ? `Expires ${fmt.date(d.expires_at)}` : null, d.revision ? `Revision ${d.revision}` : null].filter(Boolean).join(' · ') || `Updated ${fmt.date(d.updated_at)}`),
    rolesOf(d.ack_roles).length ? h('div', { class: 'small', 'data-ack-roles': d.ack_roles }, badge('Sign-off', 'info'), ' ', `${roleList(d.ack_roles)} sign it in PowerDMS`) : null,
    h('div', { class: 'btn-row tight' },
      d.has_file ? h('button', { class: 'btn sm primary', onClick: () => downloadCsv(`/api/documents/${d.id}/file`) }, 'Download') : (d.powerdms_url ? null : h('span', { class: 'small muted' }, 'No file')),
      d.powerdms_url ? powerdmsLink(d.powerdms_url) : null,
      can('documents:write') ? h('button', { class: 'btn sm', onClick: () => openDocumentForm(d, refresh) }, 'Edit') : null,
      can('documents:write') && d.is_active ? h('button', { class: 'btn sm ghost', 'aria-label': 'Retire this document', 'data-document-retire': d.id, onClick: async () => {
        // Reversible (it stays in the library, marked retired), so done at once with an Undo.
        await del(`/api/documents/${d.id}`); refresh();
        undoToast(`"${d.title}" retired. It stays in the library, marked retired.`, async () => { await put(`/api/documents/${d.id}`, { is_active: true }); refresh(); });
      } }, 'Retire') : null));
  return h('div', {},
    pageHead('Policies & contracts', can('documents:write') ? h('button', { class: 'btn primary', onClick: () => openDocumentForm(null, refresh) }, '+ Add') : null),
    h('p', { class: 'muted small' }, 'County policies, procedures and signed contracts. Search looks at the title, description and the text inside PDF, Word and plain-text files; a scanned image is found by its title only. A policy kept in PowerDMS opens there. ', state.local ? null : h('a', { href: '#/signoffs' }, 'Policy sign-offs'), state.local ? null : ' shows who has signed what.'),
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Category'), catSel),
      h('button', { class: 'btn', onClick: () => nav(`documents?category=${cat}&q=${encodeURIComponent(search.value)}`) }, 'Search'),
      can('documents:write') ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: inactive, onChange: (e) => nav(`documents?category=${cat}&q=${encodeURIComponent(q)}${e.target.checked ? '&inactive=1' : ''}`) }), ' Show retired') : null),
    rows.length ? h('div', { class: 'grid' }, rows.map(card)) : emptyState('No documents found', can('documents:write') ? 'Upload a policy, procedure or contract to get started, or try another search.' : 'Try another search. An administrator or supervisor uploads the program\'s policies and contracts.', can('documents:write') ? h('button', { class: 'btn primary', 'data-empty-action': 'document', onClick: () => openDocumentForm(null, refresh) }, '+ Upload a document') : null));
});

// ---- Policy sign-offs (docs/integration/POWERDMS.md) ----
// Everyone: the policies their role must sign in PowerDMS, and whether SUDS has a record of them signing the current
// revision. Supervisors and administrators (policies:manage): every staff member's, the PowerDMS report import, and a
// sign-off recorded by hand. Office server only: a device has its own accounts and asks nobody to sign anything.
const signedText = (a) => (a ? `Signed${a.revision ? ` revision ${a.revision}` : ''} on ${fmt.date(a.acknowledged_at)}${a.source === 'manual' ? ' (recorded by hand)' : ''}` : 'No signature recorded');

function mySignoffs(data) {
  if (!data.policies.length) return emptyState('Nothing to sign', 'No policy in the library asks your role to sign it. A supervisor or administrator chooses who signs each policy under Policies & contracts.');
  return h('div', { class: 'grid' }, data.policies.map(p => h('div', { class: 'card', 'data-signoff': p.id },
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'start' } },
      h('b', {}, p.title), p.signed ? badge('Signed', 'ok') : badge('Needs your signature', 'warn')),
    h('div', { class: 'small muted' }, p.revision ? `Current revision: ${p.revision}` : 'No revision named'),
    h('div', { class: 'small' }, p.signed ? signedText(p.acknowledgement) : (p.acknowledgement ? `${signedText(p.acknowledgement)}, an earlier revision: sign the current one` : 'Read and sign it in PowerDMS. SUDS shows it as signed once a supervisor imports the PowerDMS report.')),
    p.powerdms_url ? h('div', { class: 'btn-row tight' }, powerdmsLink(p.powerdms_url, p.signed ? 'Open in PowerDMS' : 'Read and sign in PowerDMS')) : null)));
}

function staffView(data, refresh) {
  if (!data.documents.length) return emptyState('No policy asks for sign-off yet', 'Edit a policy under Policies & contracts: give its PowerDMS link and revision, and tick who must sign it.', can('documents:write') ? h('a', { class: 'btn primary', href: '#/documents' }, 'Policies & contracts') : null);
  const titles = Object.fromEntries(data.documents.map(d => [d.id, d.title]));
  const record = (s) => {
    const owed = s.items.filter(x => !x.current);
    const f = form([
      { name: 'document_id', label: 'Policy', type: 'select', required: true, options: (owed.length ? owed : s.items).map(x => ({ value: x.document_id, label: titles[x.document_id] })) },
      { name: 'revision', label: 'Revision signed', help: 'As PowerDMS numbers it; the current revision unless they signed an earlier one.' },
      { name: 'acknowledged_at', label: 'Date signed', type: 'date', required: true },
    ], { values: { document_id: (owed[0] || s.items[0] || {}).document_id, revision: (data.documents.find(d => d.id === (owed[0] || s.items[0] || {}).document_id) || {}).revision || '' }, submitText: 'Record sign-off', onCancel: () => m.close(),
      onSubmit: async (d) => { await post('/api/policies/acknowledgements', { ...d, user_id: s.id }); toast('Sign-off recorded', 'ok'); m.close(); refresh(); } });
    const m = modal(`Record a sign-off for ${s.display_name}`, h('div', {}, h('p', { class: 'small muted' }, 'For a signature PowerDMS shows but no report has brought in yet, or one given on paper. It is audited with your name.'), f));
  };
  const removeAck = async (s, x) => {
    if (!x.acknowledgement || !x.acknowledgement.id) return;
    if (!(await confirmDialog(`Remove the sign-off recorded for ${s.display_name} on "${titles[x.document_id]}"?`, 'Only for one recorded in error. It is audited with your name; a PowerDMS report imported again records it again if PowerDMS shows it signed.', { okText: 'Remove', danger: true }))) return;
    await del(`/api/policies/acknowledgements/${x.acknowledgement.id}`); toast('Sign-off removed', 'ok'); refresh();
  };
  return h('div', {},
    h('h2', {}, 'By policy'),
    table([
      { label: 'Policy', render: d => d.powerdms_url ? h('a', { href: d.powerdms_url, target: '_blank', rel: 'noopener noreferrer' }, d.title, h('span', { class: 'sr-only' }, ' (opens PowerDMS in a new tab)')) : d.title },
      { label: 'Revision', render: d => d.revision || '—' },
      { label: 'Who signs', render: d => d.roles.map(r => fmt.label(r)).join(', ') },
      { label: 'Signed', num: true, render: d => h('span', { 'data-policy-signed': d.id }, `${d.signed} of ${d.owed}`) },
    ], data.documents),
    h('h2', {}, 'By person'),
    table([
      { label: 'Staff member', render: s => s.display_name },
      { label: 'Role', render: s => fmt.label(s.role) },
      { label: 'Signed', num: true, render: s => h('span', { 'data-staff-signed': s.id }, `${s.signed} of ${s.required}`) },
      { label: 'Still to sign', render: s => { const owed = s.items.filter(x => !x.current); return owed.length ? owed.map(x => titles[x.document_id]).join('; ') : badge('All signed', 'ok'); } },
      { label: 'Actions', render: s => h('div', { class: 'btn-row tight' },
        h('button', { class: 'btn sm', type: 'button', 'data-record-signoff': s.id, onClick: () => record(s) }, 'Record a sign-off', h('span', { class: 'sr-only' }, ` for ${s.display_name}`)),
        s.items.filter(x => x.current && x.acknowledgement && x.acknowledgement.id).map(x => h('button', { class: 'btn sm ghost', type: 'button', onClick: () => removeAck(s, x) }, `Remove "${titles[x.document_id]}"`, h('span', { class: 'sr-only' }, ` for ${s.display_name}`)))) },
    ], data.staff, { empty: 'Nobody holds a role asked to sign these policies.' }));
}

function importView(imports, refresh) {
  let fileData = null; let fileName = null;
  const out = h('div', { 'aria-live': 'polite' });
  const input = h('input', { type: 'file', id: 'powerdms-report', accept: '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', onChange: async () => {
    const f = input.files[0]; if (!f) return;
    fileData = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(f); });
    fileName = f.name; preview();
  } });
  const summary = (counts, labels) => h('ul', { class: 'small', 'data-report-counts': '' }, Object.entries(counts).map(([k, n]) => h('li', { 'data-outcome': k }, `${labels[k] || k}: ${n}`)));
  const preview = async () => {
    out.replaceChildren(h('p', { class: 'small muted' }, 'Reading the report…'));
    let p;
    try { p = await post('/api/policies/report/preview', { file_url: fileData, filename: fileName }); } catch (e) { out.replaceChildren(h('p', { class: 'error', role: 'alert' }, e.message)); return; }
    const n = p.counts.record || 0;
    out.replaceChildren(
      h('h2', {}, `${fileName}: ${p.total} row${p.total === 1 ? '' : 's'}`),
      summary(p.counts, p.labels),
      table([
        { label: 'Line', num: true, render: x => String(x.line) },
        { label: 'Staff member', render: x => x.staff || '—' },
        { label: 'Policy', render: x => x.document || '—' },
        { label: 'Revision', render: x => x.revision || '—' },
        { label: 'Signed', render: x => (x.acknowledged_at ? fmt.date(x.acknowledged_at) : '—') },
        { label: 'What SUDS does', render: x => (x.outcome === 'record' ? badge(p.labels[x.outcome], 'ok') : x.outcome === 'already' ? p.labels[x.outcome] : badge(p.labels[x.outcome], 'warn')) },
      ], p.rows, { compact: { primary: x => [h('span', {}, x.staff || '—'), ' ', x.outcome === 'record' ? badge(p.labels[x.outcome], 'ok') : badge(p.labels[x.outcome], x.outcome === 'already' ? '' : 'warn')], secondary: x => `${x.document || '—'}${x.revision ? `, revision ${x.revision}` : ''}${x.acknowledged_at ? `, signed ${fmt.date(x.acknowledged_at)}` : ''} (line ${x.line})` } }),
      ...(p.truncated ? [h('p', { class: 'small muted' }, `The first ${p.rows.length} rows are shown; all ${p.total} are counted above.`)] : []),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', disabled: !n, 'data-report-import': '', onClick: async () => {
        const r = await post('/api/policies/report/import', { file_url: fileData, filename: fileName });
        toast(`${r.recorded} sign-off${r.recorded === 1 ? '' : 's'} recorded`, 'ok'); refresh();
      } }, n ? `Record ${n} sign-off${n === 1 ? '' : 's'}` : 'Nothing new to record')));
  };
  return h('div', {},
    h('p', {}, 'In PowerDMS, run the signature status (or training completion) report for the policies listed here, and export it to Excel or CSV. SUDS matches each row to a staff account by email, user name or name, and to a policy by its PowerDMS document number or title. Nothing is recorded until you check the preview and choose Record.'),
    h('div', { class: 'field' }, h('label', { for: 'powerdms-report' }, 'PowerDMS report (Excel or CSV)'), input),
    out,
    h('h2', {}, 'Reports imported'),
    table([
      { label: 'When', render: i => fmt.date(i.created_at) },
      { label: 'File', render: i => i.filename || '—' },
      { label: 'Rows', num: true, render: i => String(i.rows_read) },
      { label: 'Recorded', num: true, render: i => String(i.recorded) },
      { label: 'Not matched', num: true, render: i => String(i.unmatched) },
      { label: 'By', render: i => i.imported_by_name || '—' },
    ], imports, { empty: 'No PowerDMS report imported yet.' }));
}

route('signoffs', async (r) => {
  if (state.local) return h('div', {}, pageHead('Policy sign-offs'), emptyState('On the office server', 'Policy sign-offs are kept by the programme\'s office server. Open SUDS at the office address to see yours.'));
  const manage = can('policies:manage');
  const tab = manage ? (r.query.get('tab') || 'mine') : 'mine';
  const refresh = () => nav(`signoffs?tab=${tab}&_=${Date.now()}`);
  let body;
  if (tab === 'staff') body = staffView(await get('/api/policies/compliance'), refresh);
  else if (tab === 'import') body = importView((await get('/api/policies/imports')).imports, refresh);
  else body = mySignoffs(await get('/api/policies/mine'));
  return h('div', {},
    pageHead('Policy sign-offs'),
    h('p', { class: 'muted small' }, 'The policies you must read and sign in PowerDMS, and whether SUDS has a record of you signing the current revision. SUDS does not connect to PowerDMS: a supervisor imports its signature report.'),
    manage ? tabStrip([['mine', 'Your sign-offs'], ['staff', 'Staff'], ['import', 'Import from PowerDMS']], tab, (k) => nav(`signoffs?tab=${k}`), { label: 'Policy sign-off sections' }) : null,
    body);
});
