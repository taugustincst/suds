import { h, route, get, post, put, del, state, form, modal, toast, badge, fmt, can, pageHead, confirmDialog, nav, downloadCsv, emptyState } from '../app.js';

const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read file')); r.readAsDataURL(file); });
const fileIcon = (t) => !t ? '📄' : t.includes('pdf') ? '📄' : t.includes('word') || t.includes('msword') ? '📝' : t.startsWith('image/') ? '🖼' : '📄';
const catKind = { policy: 'info', procedure: '', contract: 'warn' };

function openDocumentForm(values, onDone) {
  const C = state.constants; const isNew = !values;
  let file = null; let fileLabel = values?.filename || null;
  // .sr-only, not .hidden (display:none) — a programmatic .click() on a display:none file input is silently
  // ignored by a good few mobile browsers/WebViews.
  const fileInput = h('input', { type: 'file', class: 'sr-only', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/*', onChange: async () => {
    const f = fileInput.files[0]; if (!f) return;
    try { file = await readFile(f); fileLabel = f.name; fileNote.textContent = `Selected: ${f.name}`; } catch (e) { toast(e.message, 'error'); }
  } });
  const fileNote = h('div', { class: 'small muted' }, fileLabel ? `Current file: ${fileLabel}` : 'No file yet');
  const f = form([
    { name: 'title', label: 'Title', required: true, span: true },
    { name: 'category', label: 'Category', type: 'select', options: C.DOCUMENT_CATEGORIES, required: true },
    { name: 'effective_date', label: 'Effective date', type: 'date' }, { name: 'expires_at', label: 'Expires / renewal date', type: 'date' },
    { name: 'description', label: 'Description', type: 'textarea', span: true, rows: 3 },
  ], { values: values || {}, submitText: isNew ? 'Upload' : 'Save', onCancel: () => m.close(),
    extra: h('div', { class: 'span' }, h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onClick: () => fileInput.click() }, isNew ? 'Choose file' : 'Replace file'), fileInput), fileNote),
    onSubmit: async (d) => {
      if (file) { d.file_url = file; if (!d.filename) d.filename = fileLabel; }
      if (isNew && !file) { toast('Choose a file to upload', 'error'); throw new Error('no file'); }
      if (isNew) await post('/api/documents', d); else await put(`/api/documents/${values.id}`, { ...d, if_updated_at: values.updated_at });
      toast(isNew ? 'Document uploaded' : 'Saved', 'ok'); m.close(); onDone();
    } });
  const m = modal(isNew ? 'Upload a policy, procedure or contract' : 'Edit document', f, { wide: true });
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
    h('div', { class: 'small muted' }, [d.effective_date ? `Effective ${fmt.date(d.effective_date)}` : null, d.expires_at ? `Expires ${fmt.date(d.expires_at)}` : null].filter(Boolean).join(' · ') || `Updated ${fmt.date(d.updated_at)}`),
    h('div', { class: 'btn-row tight' },
      d.has_file ? h('button', { class: 'btn sm primary', onClick: () => downloadCsv(`/api/documents/${d.id}/file`) }, 'Download') : h('span', { class: 'small muted' }, 'No file'),
      can('documents:write') ? h('button', { class: 'btn sm', onClick: () => openDocumentForm(d, refresh) }, 'Edit') : null,
      can('documents:write') && d.is_active ? h('button', { class: 'btn sm ghost', 'aria-label': 'Retire this document', onClick: async () => { if (await confirmDialog('Retire document', `Retire "${d.title}"? It stays in the library, marked retired.`, { danger: true, okText: 'Retire' })) { await del(`/api/documents/${d.id}`); refresh(); } } }, 'Retire') : null));
  return h('div', {},
    pageHead('Policies & contracts', can('documents:write') ? h('button', { class: 'btn primary', onClick: () => openDocumentForm(null, refresh) }, '+ Upload') : null),
    h('p', { class: 'muted small' }, 'County policies, procedures and signed contracts. Search looks at the title, description and the text inside PDF, Word and plain-text files; a scanned image is found by its title only.'),
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Category'), catSel),
      h('button', { class: 'btn', onClick: () => nav(`documents?category=${cat}&q=${encodeURIComponent(search.value)}`) }, 'Search'),
      can('documents:write') ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: inactive, onChange: (e) => nav(`documents?category=${cat}&q=${encodeURIComponent(q)}${e.target.checked ? '&inactive=1' : ''}`) }), ' Show retired') : null),
    rows.length ? h('div', { class: 'grid' }, rows.map(card)) : emptyState('No documents found', 'Upload a policy, procedure or contract to get started.'));
});
