import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, kv, clientPicker, emptyState, downloadCsv, clear } from '../app.js';
import { shrinkImage } from './resources.js';

const FIELD_KINDS = [['text', 'Short answer'], ['textarea', 'Long answer'], ['date', 'Date'], ['number', 'Number'], ['checkbox', 'Checkbox'], ['select', 'Choice list'], ['signature', 'Signature (typed name)'], ['section', 'Section heading'], ['note', 'Instruction text']];
const fileKind = (t) => !t ? '' : t.includes('pdf') ? 'PDF' : t.includes('word') || t.includes('msword') ? 'Word' : t.startsWith('image/') ? 'Picture' : 'File';
const openFile = (path) => { if (state.local) downloadCsv(path); else window.open(path, '_blank', 'noopener'); };
const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read file')); r.readAsDataURL(file); });

// ---------- Library ----------
route('forms', async (r) => {
  const cat = r.query.get('category') || '', q = (r.query.get('q') || '').toLowerCase(), inactive = r.query.get('inactive') === '1';
  const data = await get(`/api/forms/templates${inactive ? '?active=0' : ''}`);
  const rows = data.templates.filter(t => (!cat || t.category === cat) && (!q || `${t.name} ${t.description || ''}`.toLowerCase().includes(q)));
  const refresh = () => nav(`forms?category=${cat}&q=${encodeURIComponent(q)}${inactive ? '&inactive=1' : ''}&_=${Date.now()}`);
  const search = h('input', { type: 'search', value: q, placeholder: 'Form name or description', onKeydown: e => { if (e.key === 'Enter') nav(`forms?category=${cat}&q=${encodeURIComponent(search.value)}`); } });
  const catSel = h('select', { onChange: () => nav(`forms?category=${catSel.value}&q=${encodeURIComponent(q)}`) }, h('option', { value: '' }, 'All categories'), data.categories.map(c => h('option', { value: c, selected: c === cat }, fmt.label(c))));
  // A one-click shortcut for the common case — someone already has the county's PDF/Word file in hand and
  // wants it in the library — instead of the full "+ Add a county form" flow (name, category, fields...)
  // being the only door in. It opens straight into the designer with the file already attached and the
  // name guessed from the filename, so the rest is just confirming, not starting from a blank form.
  const uploadInput = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,application/pdf,image/*', class: 'hidden', onChange: async () => {
    const file = uploadInput.files[0]; uploadInput.value = ''; if (!file) return;
    try {
      const data = file.type.startsWith('image/') ? (await shrinkImage(file, 2000, 0.85)).dataUrl : await readFile(file);
      openDesigner(null, refresh, { data, name: file.name });
    } catch (e) { toast(e.message, 'error'); }
  } });
  // Bulk-downloads every form currently in view: the original file where one was uploaded, otherwise the
  // blank PDF generated from its fields — the same two things "Blank PDF" / "Original file" already offer
  // per card, just for the whole library (or the current search/category filter) in one click.
  const downloadAll = async () => {
    if (!rows.length) { toast('No forms to download', 'error'); return; }
    toast(`Downloading ${rows.length} form${rows.length === 1 ? '' : 's'}…`, 'ok');
    for (const t of rows) {
      await downloadCsv(t.has_file ? `/api/forms/templates/${t.id}/file` : `/api/forms/templates/${t.id}/blank.pdf`);
      await new Promise((res) => setTimeout(res, 300)); // browsers block a burst of simultaneous downloads
    }
  };
  // The card itself must not be role="button" (or otherwise interactive): it holds real <button> elements
  // for the individual actions, and an interactive control cannot nest another one. Opening the template
  // by name/description is its own button instead of a click-anywhere card.
  const card = (t) => h('div', { class: `card tpl-card ${t.is_active ? '' : 'inactive'}`, 'data-template': t.id },
    h('div', { class: 'tpl-icon' }, t.has_file ? (t.content_type?.includes('pdf') ? '📄' : t.content_type?.startsWith('image/') ? '🖼' : '📝') : '🧾'),
    h('div', { class: 'grow' }, h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'start' } }, h('button', { class: 'tpl-open-name', onClick: () => openTemplate(t.id, refresh) }, t.name), h('span', {}, badge(fmt.label(t.category), 'info'), t.is_active ? null : [' ', badge('Retired', 'warn')])),
      t.description ? h('p', { class: 'small tpl-desc' }, t.description) : null,
      h('div', { class: 'small muted' }, `${t.field_count} field${t.field_count === 1 ? '' : 's'}`, t.has_file ? ` · ${fileKind(t.content_type)} attached` : ' · no file (printable from fields)', t.version ? ` · v${t.version}` : '', t.use_count ? ` · used ${t.use_count}×` : ''),
      h('div', { class: 'btn-row tight' }, can('forms:write') ? h('button', { class: 'btn sm primary', onClick: () => useWithClient(t) }, 'Fill out for a client') : null,
        h('button', { class: 'btn sm', onClick: () => openFile(`/api/forms/templates/${t.id}/blank.pdf`) }, 'Blank PDF'), t.has_file ? h('button', { class: 'btn sm', onClick: () => downloadCsv(`/api/forms/templates/${t.id}/file`) }, 'Original file') : null,
        can('forms:manage') ? h('button', { class: 'btn sm ghost', onClick: () => openDesigner(t.id, refresh) }, 'Edit') : null)));
  return h('div', {},
    pageHead('Form library',
      can('forms:manage') ? h('button', { class: 'btn', onClick: () => openStarters(refresh) }, 'Add starter forms') : null,
      can('forms:manage') ? h('button', { class: 'btn', onClick: () => uploadInput.click() }, 'Upload form') : null,
      can('forms:manage') ? uploadInput : null,
      rows.length ? h('button', { class: 'btn', onClick: downloadAll }, 'Download forms') : null,
      can('forms:manage') ? h('button', { class: 'btn primary', onClick: () => openDesigner(null, refresh) }, '+ Add a county form') : null),
    h('p', { class: 'muted small' }, 'County forms your program uses. Open a form from a client record (Forms tab) or here: it is pre-filled from the chart, saved to the client, printable as a PDF, and a signed copy can be attached.'),
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Category'), catSel), h('button', { class: 'btn', onClick: () => nav(`forms?category=${cat}&q=${encodeURIComponent(search.value)}`) }, 'Search'),
      can('forms:manage') ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: inactive, onChange: e => nav(`forms?category=${cat}&q=${encodeURIComponent(q)}${e.target.checked ? '&inactive=1' : ''}`) }), 'Show retired') : null),
    rows.length ? h('div', { class: 'grid cols-2' }, rows.map(card))
      : emptyState('No forms in the library yet',
        can('forms:manage')
          ? 'Start with the built-in forms — including the 42 CFR Part 2 consent you need before any record can be shared — then add your own county forms.'
          : 'Ask an administrator or supervisor to add the county forms you use.',
        can('forms:manage') ? h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onClick: () => openStarters(refresh) }, 'Add starter forms'),
          h('button', { class: 'btn', onClick: () => openDesigner(null, refresh) }, '+ Add a county form')) : null));
});

async function openTemplate(id, refresh) {
  const { template: t } = await get(`/api/forms/templates/${id}`);
  const fields = t.fields.filter(f => !['section', 'note'].includes(f.type));
  const m = modal(t.name, h('div', {},
    h('div', { class: 'row mb' }, badge(fmt.label(t.category), 'info'), t.version ? badge(`v${t.version}`) : null, t.has_file ? badge(`${fileKind(t.content_type)} attached`, 'ok') : badge('No file', 'warn')),
    t.description ? h('p', {}, t.description) : null, t.instructions ? h('div', { class: 'banner small' }, t.instructions) : null,
    h('h4', {}, `Fields (${fields.length})`), fields.length ? h('ul', { class: 'small' }, fields.map(f => h('li', {}, f.label, f.required ? ' *' : '', h('span', { class: 'muted' }, ` — ${FIELD_KINDS.find(k => k[0] === f.type)?.[1] || f.type}${f.autofill ? `, pre-filled from ${f.autofill.replace('.', ' ').replace(/_/g, ' ')}` : ''}`)))) : h('p', { class: 'muted small' }, 'No fields described yet; the form can still be printed and completed by hand.'),
    h('div', { class: 'btn-row' }, can('forms:write') ? h('button', { class: 'btn primary', onClick: () => { m.close(); useWithClient(t); } }, 'Fill out for a client') : null, h('button', { class: 'btn', onClick: () => openFile(`/api/forms/templates/${t.id}/blank.pdf`) }, 'Blank PDF'), t.has_file ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/forms/templates/${t.id}/file`) }, 'Original file') : null, can('forms:manage') ? h('button', { class: 'btn ghost', onClick: () => { m.close(); openDesigner(t.id, refresh); } }, 'Edit') : null)), { wide: true });
}

// "Fill out for a client": pick the client, then open the filler
function useWithClient(t) {
  const f = form([{ name: 'client_id', label: 'Client', type: 'client', required: true }], { submitText: 'Start form', onCancel: () => m.close(), onSubmit: async (d) => { const r = await post(`/api/clients/${d.client_id}/forms`, { template_id: t.id }); m.close(); openClientForm(r.id, { onChange: () => nav(`client/${d.client_id}/forms?_=${Date.now()}`) }); } });
  const m = modal(`Fill out: ${t.name}`, f);
}

// ---------- Designer (upload a county form, describe its fields) ----------
// initialFile — { data, name } — lets the library's "Upload form" shortcut jump straight in with the file
// already attached, rather than someone having to attach it themselves after opening this from scratch.
export async function openDesigner(id, onDone, initialFile) {
  const C = state.constants; const t = id ? (await get(`/api/forms/templates/${id}`)).template : { name: '', category: 'other', fields: [], is_active: 1 };
  if (initialFile && !id) t.name = initialFile.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  let fields = t.fields.map(f => ({ ...f })); let fileData = initialFile?.data || null, fileName = initialFile?.name || null, removeFile = false;
  const list = h('div', { class: 'designer' });
  const rowFor = (f, i) => {
    const kind = h('select', { onChange: () => { f.type = kind.value; draw(); } }, FIELD_KINDS.map(([v, l]) => h('option', { value: v, selected: f.type === v }, l)));
    const label = h('input', { value: f.label || '', placeholder: f.type === 'section' ? 'Section title' : f.type === 'note' ? 'Instruction shown on the form' : 'Question / label', onInput: () => { f.label = label.value; } });
    const meta = ['section', 'note'].includes(f.type) ? null : h('div', { class: 'row small' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!f.required, onChange: e => { f.required = e.target.checked; } }), 'Required'),
      h('label', {}, 'Pre-fill: ', h('select', { onChange: e => { f.autofill = e.target.value || undefined; } }, h('option', { value: '' }, '— nothing —'), (C.FORM_AUTOFILL || []).map(a => h('option', { value: a, selected: f.autofill === a }, a.replace('.', ': ').replace(/_/g, ' '))))),
      f.type === 'select' ? h('input', { value: (f.options || []).join(', '), placeholder: 'Choices, comma separated', style: { minWidth: '220px' }, onInput: e => { f.options = e.target.value.split(',').map(x => x.trim()).filter(Boolean); } }) : null);
    return h('div', { class: `dfield ${f.type}` }, h('div', { class: 'dgrip muted small' }, i + 1),
      h('div', { class: 'grow' }, h('div', { class: 'row' }, kind, label), meta),
      h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm ghost', title: 'Move up', onClick: () => { if (i > 0) { [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; draw(); } } }, '↑'), h('button', { class: 'btn sm ghost', title: 'Move down', onClick: () => { if (i < fields.length - 1) { [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; draw(); } } }, '↓'), h('button', { class: 'btn sm ghost', title: 'Remove', onClick: () => { fields.splice(i, 1); draw(); } }, '✕')));
  };
  const draw = () => { clear(list); if (!fields.length) list.append(h('p', { class: 'muted small' }, 'No fields yet. Upload a fillable PDF to detect its fields automatically, or add them below.')); fields.forEach((f, i) => list.append(rowFor(f, i))); };
  draw();
  const fileInfo = h('div', { class: 'small muted' }, initialFile ? `${initialFile.name} will be saved with the form.` : t.has_file ? `${fileKind(t.content_type)} attached: ${t.filename || ''}` : 'No file attached (a blank PDF is generated from the fields).');
  const fileInput = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,application/pdf,image/*', class: 'hidden', onChange: async () => {
    const file = fileInput.files[0]; if (!file) return; fileName = file.name; fileInfo.textContent = `Reading ${file.name}…`;
    try { fileData = file.type.startsWith('image/') ? (await shrinkImage(file, 2000, 0.85)).dataUrl : await readFile(file); removeFile = false; fileInfo.textContent = `${file.name} (${Math.round(file.size / 1024)} KB) will be saved with the form.`; if (file.type === 'application/pdf' && !fields.length) fileInfo.textContent += ' Fields inside the PDF will be detected when you save.'; }
    catch (e) { fileInfo.textContent = e.message; fileData = null; }
  } });
  const f = form([
    { name: 'name', label: 'Form name', required: true, span: true, placeholder: 'e.g. Consent for Release of Information (Part 2)' }, { name: 'category', label: 'Category', type: 'select', options: C.FORM_CATEGORIES, noBlank: true }, { name: 'version', label: 'Version / revision date', placeholder: 'e.g. 2026-01' },
    { name: 'description', label: 'What this form is for', type: 'textarea', rows: 2, span: true }, { name: 'instructions', label: 'Instructions for staff (shown while filling out)', type: 'textarea', rows: 2, span: true },
    id ? { name: 'is_active', label: 'Available to staff', type: 'checkbox' } : null,
  ].filter(Boolean), { values: t, submitText: id ? 'Save form' : 'Add to library', onCancel: () => m.close(), onSubmit: async (d) => {
    if (fields.some(x => !String(x.label || '').trim())) throw new Error('Every field needs a label');
    const body = { ...d, fields, file_url: fileData || undefined, filename: fileName || undefined, remove_file: removeFile || undefined };
    let r; if (id) { await put(`/api/forms/templates/${id}`, body); r = { id }; } else r = await post('/api/forms/templates', body);
    toast(r.detected ? `Form added; ${r.detected} fields detected in the PDF` : 'Form saved', 'ok'); m.close(); onDone && onDone(r.id);
  } });
  f.querySelector('.btn-row').before(
    h('div', { class: 'field span' }, h('label', {}, 'County form file (PDF, Word or picture)'), h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onClick: () => fileInput.click() }, t.has_file ? 'Replace file' : 'Upload file'), t.has_file ? h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { removeFile = true; fileData = null; fileInfo.textContent = 'File will be removed when you save.'; } }, 'Remove file') : null, fileInput), fileInfo, h('div', { class: 'help' }, 'Staff can download the original to print or fill by hand. Filling out in SUDS uses the fields below.'), h('div', { class: 'err' })),
    h('div', { class: 'field span' }, h('label', {}, 'Fields to fill out'), list, h('div', { class: 'row mt' }, h('button', { class: 'btn sm', type: 'button', onClick: () => { fields.push({ key: '', label: '', type: 'text' }); draw(); list.lastChild.querySelector('input').focus(); } }, '+ Field'), h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { fields.push({ key: '', label: '', type: 'section' }); draw(); } }, '+ Section heading'), h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { fields.push({ key: '', label: '', type: 'note' }); draw(); } }, '+ Instruction text'),
      h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { fields.push({ key: 'client_name', label: 'Client name', type: 'text', autofill: 'client.full_name', required: true }, { key: 'dob', label: 'Date of birth', type: 'date', autofill: 'client.dob' }, { key: 'phone', label: 'Phone', type: 'text', autofill: 'client.phone' }, { key: 'address', label: 'Address', type: 'text', autofill: 'client.address' }, { key: 'date', label: 'Date', type: 'date', autofill: 'today' }, { key: 'worker', label: 'Navigator', type: 'text', autofill: 'worker.name' }); draw(); } }, '+ Usual client header fields')), h('div', { class: 'err' })));
  const m = modal(id ? 'Edit form' : 'Add a county form', f, { wide: true });
}

// ---------- Client forms tab ----------
export async function clientFormsTab(clientId, { refresh } = {}) {
  const { forms } = await get(`/api/clients/${clientId}/forms`);
  const start = async () => {
    const data = await get('/api/forms/templates'); if (!data.templates.length) { toast('No forms in the library yet' + (can('forms:manage') ? ' — add one under Forms' : ''), 'error'); return; }
    const m = modal('Which form?', h('div', { class: 'quick-list' }, data.templates.map(t => h('button', { class: 'btn quick-item', 'data-template': t.id, onClick: async () => { const r = await post(`/api/clients/${clientId}/forms`, { template_id: t.id }); m.close(); openClientForm(r.id, { onChange: refresh }); } }, h('b', {}, t.name), h('span', { class: 'small muted' }, `${fmt.label(t.category)}${t.description ? ' · ' + t.description.slice(0, 80) : ''}`)))));
  };
  return h('div', {},
    h('div', { class: 'row mb' }, can('forms:write') ? h('button', { class: 'btn primary', onClick: start }, '+ Fill out a form') : null, h('a', { class: 'btn', href: '#/forms' }, 'Form library')),
    forms.length ? table([
      { label: 'Form', render: f => h('b', {}, f.template_name) }, { label: 'Status', render: f => badge(fmt.label(f.status), f.status === 'completed' ? 'ok' : f.status === 'void' ? 'warn' : 'info') },
      { label: 'Completed', render: f => f.completed_at ? `${fmt.date(f.completed_at)} · ${f.completed_by_name || ''}` : '—' }, { label: 'Started', render: f => `${fmt.date(f.created_at)} · ${f.created_by_name}` },
      { label: 'Signed copy', render: f => f.attachments ? badge(`${f.attachments} attached`, 'ok') : h('span', { class: 'muted small' }, 'none') },
    ], forms, { onRow: f => openClientForm(f.id, { onChange: refresh }) }) : emptyState('No forms for this client yet', 'Releases of information, intake sheets and assistance requests you fill out here are saved to the record, printable, and can hold the signed copy.', can('forms:write') ? h('button', { class: 'btn primary', onClick: start }, '+ Fill out a form') : null));
}

// ---------- Filler ----------
export async function openClientForm(id, { onChange } = {}) {
  const { form: f } = await get(`/api/forms/${id}`);
  const locked = f.status === 'completed' && !can('forms:manage'); const editable = can('forms:write') && !locked && f.status !== 'void';
  const values = { ...f.values }; const inputs = {}; let dirty = false, timer = null; const status = h('span', { class: 'small muted' });
  const save = async (extra = {}) => { clearTimeout(timer); if (!editable) return; status.textContent = 'Saving…'; const r = await put(`/api/forms/${id}`, { values, ...extra }); dirty = false; status.textContent = 'Saved'; return r; };
  const queue = () => { dirty = true; status.textContent = 'Unsaved changes'; clearTimeout(timer); timer = setTimeout(() => save().catch(e => { status.textContent = e.message; }), 1200); };
  const field = (fd) => {
    if (fd.type === 'section') return h('h4', { class: 'ff-section' }, fd.label);
    if (fd.type === 'note') return h('p', { class: 'small muted ff-note' }, fd.label);
    const v = values[fd.key]; let input;
    const on = (e) => { values[fd.key] = fd.type === 'checkbox' ? e.target.checked : e.target.value; queue(); };
    if (fd.type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!v, disabled: !editable, onChange: on });
    else if (fd.type === 'textarea') input = h('textarea', { rows: 3, disabled: !editable, onInput: on }, v || '');
    else if (fd.type === 'select') input = h('select', { disabled: !editable, onChange: on }, h('option', { value: '' }, '—'), (fd.options || []).map(o => h('option', { value: o, selected: v === o }, o)));
    else if (fd.type === 'signature') input = h('input', { type: 'text', value: v || '', placeholder: 'Type full name to sign', disabled: !editable, onInput: on, class: 'sig' });
    else input = h('input', { type: fd.type === 'date' ? 'date' : fd.type === 'number' ? 'number' : 'text', value: v || '', disabled: !editable, onInput: on });
    inputs[fd.key] = input;
    return h('div', { class: `field ${fd.type === 'textarea' || fd.type === 'signature' ? 'span' : ''}`, 'data-field': fd.key }, fd.type === 'checkbox' ? h('label', { class: 'check' }, input, fd.label) : [h('label', {}, fd.label, fd.required ? ' *' : '', fd.autofill ? h('span', { class: 'muted small', title: 'Pre-filled from the client record' }, ' ⟳') : null), input], fd.help ? h('div', { class: 'help' }, fd.help) : null);
  };
  const body = h('div', { class: 'form-grid ff' }, f.fields.map(field));
  const files = h('div', {});
  const drawFiles = () => { clear(files); if (!f.files.length) files.append(h('span', { class: 'muted small' }, 'No signed copy attached yet.')); f.files.forEach(x => files.append(h('div', { class: 'today-item' }, h('span', {}, x.content_type.startsWith('image/') ? '🖼 ' : '📄 ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); openFile(`/api/forms/${id}/files/${x.id}`); } }, x.filename), h('span', { class: 'muted small' }, ` · ${Math.round(x.bytes / 1024)} KB · ${fmt.date(x.created_at)}`)), can('forms:write') ? h('button', { class: 'btn sm ghost', 'aria-label': `Remove ${x.filename}`, onClick: async () => { if (!await confirmDialog('Remove attachment', `Remove ${x.filename}?`, { danger: true, okText: 'Remove' })) return; await del(`/api/forms/${id}/files/${x.id}`); f.files = f.files.filter(y => y.id !== x.id); drawFiles(); } }, '✕') : null))); };
  drawFiles();
  const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf', class: 'hidden', onChange: async () => {
    const file = fileInput.files[0]; fileInput.value = ''; if (!file) return;
    try { status.textContent = `Attaching ${file.name}…`; const dataUrl = file.type.startsWith('image/') ? (await shrinkImage(file, 2000, 0.85)).dataUrl : await readFile(file); const r = await post(`/api/forms/${id}/files`, { file_url: dataUrl, filename: file.name }); f.files.push({ ...r, created_at: new Date().toISOString() }); drawFiles(); status.textContent = 'Signed copy attached'; toast('Attached', 'ok'); }
    catch (e) { status.textContent = e.message; toast(e.message, 'error'); }
  } });
  const complete = async () => {
    const miss = f.fields.filter(x => x.required && !values[x.key]); if (miss.length) { toast(`Please fill in: ${miss.map(x => x.label).join(', ')}`, 'error'); inputs[miss[0].key]?.focus(); return; }
    if (!await confirmDialog('Mark completed', 'Mark this form completed? It becomes read-only (a supervisor can reopen it).', { okText: 'Mark completed' })) return;
    await save({ status: 'completed' }); toast('Form completed', 'ok'); m.close(); onChange && onChange();
  };
  const m = modal(f.template_name, h('div', { class: 'ff-wrap' },
    h('div', { class: 'row mb', style: { justifyContent: 'space-between' } }, h('div', { class: 'row' }, badge(fmt.label(f.status), f.status === 'completed' ? 'ok' : f.status === 'void' ? 'warn' : 'info'), f.completed_at ? h('span', { class: 'small muted' }, `completed ${fmt.dt(f.completed_at)}`) : null, locked ? h('span', { class: 'small muted' }, '· read-only') : null), status),
    f.template?.instructions ? h('div', { class: 'banner small' }, f.template.instructions) : null,
    f.fields.some(x => x.autofill) && editable && f.status === 'draft' ? h('p', { class: 'small muted' }, 'Fields marked ⟳ were pre-filled from the client record; check them and correct anything that is out of date.') : null,
    body,
    h('div', { class: 'card tight mt' }, h('div', { class: 'card-head' }, h('h4', {}, 'Signed / scanned copy'), can('forms:write') && f.status !== 'void' ? h('div', {}, h('button', { class: 'btn sm', onClick: () => fileInput.click() }, '+ Attach photo or PDF'), fileInput) : null), files),
    h('div', { class: 'btn-row mt', style: { flexWrap: 'wrap' } },
      editable ? h('button', { class: 'btn primary', onClick: async () => { await save(); toast('Draft saved', 'ok'); onChange && onChange(); } }, 'Save') : null,
      editable && f.status === 'draft' ? h('button', { class: 'btn ok', onClick: complete }, '✓ Mark completed') : null,
      h('button', { class: 'btn', onClick: () => openFile(`/api/forms/${id}/pdf`) }, 'Print / PDF'),
      f.template?.has_file ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/forms/templates/${f.template_id}/file`) }, 'Original county form') : null,
      f.status === 'completed' && can('forms:manage') ? h('button', { class: 'btn ghost', onClick: async () => { await put(`/api/forms/${id}`, { status: 'draft' }); toast('Reopened as draft', 'ok'); m.close(); openClientForm(id, { onChange }); } }, 'Reopen') : null,
      can('forms:write') && (f.status === 'draft' || can('forms:manage')) ? h('button', { class: 'btn danger ghost', onClick: async () => { if (!await confirmDialog('Remove form', 'Remove this form from the client record?', { danger: true, okText: 'Remove' })) return; await del(`/api/forms/${id}`); toast('Form removed', 'ok'); m.close(); onChange && onChange(); } }, 'Remove') : null,
      h('button', { class: 'btn ghost', onClick: async () => { if (dirty) await save().catch(() => {}); m.close(); onChange && onChange(); } }, 'Close'))), { wide: true });
  m.el.classList.add('ff-modal');
}


/**
 * Install the built-in starter forms. A county will edit the wording, but shipping with an empty library
 * meant a new installation had no consent form at all — and no record can lawfully be shared without one.
 */
export async function openStarters(onDone) {
  const { starters } = await get('/api/forms/starters');
  const chosen = new Set(starters.filter(s => !s.installed).map(s => s.key));
  const body = h('div', {},
    h('p', { class: 'small muted' }, 'These are starting points, not legal advice: have your county counsel check the wording before first use. Installing one never overwrites a form you have already added.'),
    h('div', {}, starters.map(s => h('label', { class: 'check list-item' },
      h('input', { type: 'checkbox', checked: !s.installed, disabled: s.installed, onChange: (e) => { if (e.target.checked) chosen.add(s.key); else chosen.delete(s.key); } }),
      h('span', {}, h('b', {}, s.name), ' ', badge(fmt.label(s.category), 'info'), s.installed ? [' ', badge('Already added', 'ok')] : null,
        h('div', { class: 'small muted' }, s.description), h('div', { class: 'small muted' }, `${s.fields} fields`))))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async () => {
        if (!chosen.size) { toast('Nothing selected', 'error'); return; }
        try {
          const r = await post('/api/forms/starters', { keys: [...chosen] });
          toast(r.added.length ? `${r.added.length} form${r.added.length === 1 ? '' : 's'} added` : 'Those forms were already in the library', r.added.length ? 'ok' : '');
          m.close(); onDone && onDone();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Add selected forms')));
  const m = modal('Starter forms', body, { wide: true });
  return m;
}
