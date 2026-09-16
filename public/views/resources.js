import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, confirmDialog, nav, kv } from '../app.js';

export function openResourceForm(values, onDone) {
  const C = state.constants; const isNew = !values;
  const f = form([
    { name: 'name', label: 'Program / service name', required: true, span: true }, { name: 'category', label: 'Category', type: 'select', options: C.RESOURCE_CATEGORIES, required: true }, { name: 'organization', label: 'Organization' },
    { name: 'phone', label: 'Phone' }, { name: 'fax', label: 'Fax' }, { name: 'email', label: 'Email' }, { name: 'website', label: 'Website' }, { name: 'contact_person', label: 'Contact person' },
    { name: 'address', label: 'Address', span: true }, { name: 'city', label: 'City' }, { name: 'zip', label: 'ZIP' }, { name: 'hours', label: 'Hours' }, { name: 'languages', label: 'Languages' },
    { name: 'accepts_medicaid', label: 'Accepts Medicaid', type: 'checkbox' }, { name: 'accepts_uninsured', label: 'Accepts uninsured / sliding scale', type: 'checkbox' }, { name: 'mat_offered', label: 'MAT offered (e.g. buprenorphine, methadone)' },
    { name: 'services', label: 'Services', type: 'textarea', span: true, rows: 2 }, { name: 'eligibility', label: 'Eligibility / admission criteria', type: 'textarea', span: true, rows: 2 }, { name: 'capacity_notes', label: 'Capacity / waitlist notes', type: 'textarea', span: true, rows: 2 },
    { name: 'last_verified_at', label: 'Last verified', type: 'date' }, { name: 'is_active', label: 'Active', type: 'checkbox', value: values ? values.is_active : true }, { name: 'notes', label: 'Internal notes', type: 'textarea', span: true, rows: 2 },
  ], { values: values || {}, submitText: isNew ? 'Add resource' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => { if (isNew) await post('/api/resources', d); else await put(`/api/resources/${values.id}`, d); toast('Resource saved', 'ok'); m.close(); onDone && onDone(); } });
  const m = modal(isNew ? 'Add resource' : 'Edit resource', f, { wide: true });
}
route('resources', async (r) => {
  const q = r.query.get('q') || '', cat = r.query.get('category') || '', inactive = r.query.get('inactive') === '1';
  const data = await get(`/api/resources?limit=1000${q ? '&q=' + encodeURIComponent(q) : ''}${cat ? '&category=' + cat : ''}${inactive ? '&active=0' : ''}`);
  const refresh = () => nav(`resources?q=${encodeURIComponent(q)}&category=${cat}${inactive ? '&inactive=1' : ''}&_=${Date.now()}`);
  const search = h('input', { type: 'search', value: q, placeholder: 'Name, organization, service, city', onKeydown: e => { if (e.key === 'Enter') nav(`resources?q=${encodeURIComponent(search.value)}&category=${cat}`); } });
  const catSel = h('select', { onChange: () => nav(`resources?q=${encodeURIComponent(q)}&category=${catSel.value}`) }, h('option', { value: '' }, 'All categories'), state.constants.RESOURCE_CATEGORIES.map(c => h('option', { value: c, selected: c === cat }, fmt.label(c))));
  const stale = x => !x.last_verified_at || Date.now() - Date.parse(x.last_verified_at) > 180 * 86400000;
  return h('div', {},
    pageHead('Resource directory', can('resources:write') ? h('button', { class: 'btn primary', onClick: () => openResourceForm(null, refresh) }, '+ Add resource') : null, h('button', { class: 'btn', onClick: () => window.__suds.downloadCsv('/api/reports/export/resources?format=xlsx') }, 'Export to Excel'), can('resources:write') ? h('a', { class: 'btn ghost', href: '#/imports' }, 'Import from Excel') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Category'), catSel), h('button', { class: 'btn', onClick: () => nav(`resources?q=${encodeURIComponent(search.value)}&category=${cat}`) }, 'Search'), h('button', { class: `btn sm ${inactive ? 'primary' : ''}`, onClick: () => nav(`resources?q=${encodeURIComponent(q)}&category=${cat}${inactive ? '' : '&inactive=1'}`) }, 'Show inactive')),
    h('div', { class: 'muted small mb' }, `${data.total} resources`),
    table([
      { label: 'Resource', render: x => h('div', {}, h('b', {}, x.name), x.organization ? h('div', { class: 'small muted' }, x.organization) : null) }, { label: 'Category', render: x => fmt.label(x.category) },
      { label: 'Contact', render: x => h('div', { class: 'small' }, x.phone ? h('div', {}, '☎ ', x.phone) : null, x.city ? h('div', { class: 'muted' }, x.city) : null, x.website ? h('a', { href: x.website.startsWith('http') ? x.website : 'https://' + x.website, target: '_blank', rel: 'noopener noreferrer' }, 'website') : null) },
      { label: 'Accepts', render: x => [x.accepts_medicaid ? badge('Medicaid', 'ok') : null, ' ', x.accepts_uninsured ? badge('Uninsured', 'info') : null, x.mat_offered ? [' ', badge('MAT', 'purple')] : null] },
      { label: 'Referrals', key: 'referral_count', num: true }, { label: 'Verified', render: x => h('span', { style: stale(x) ? { color: 'var(--warn)' } : {} }, x.last_verified_at ? fmt.date(x.last_verified_at) : 'never') }, { label: '', render: x => !x.is_active ? badge('Inactive') : '' },
    ], data.rows, { onRow: x => openResource(x.id, refresh), empty: 'No resources yet. Add treatment providers, MAT clinics, shelters, and other referral partners.' }));
});
async function openResource(id, refresh) {
  const x = (await get(`/api/resources/${id}`)).row;
  const m = modal(x.name, h('div', {},
    h('div', { class: 'row mb' }, badge(fmt.label(x.category), 'info'), x.accepts_medicaid ? badge('Medicaid', 'ok') : null, x.accepts_uninsured ? badge('Uninsured OK', 'info') : null, x.mat_offered ? badge(`MAT: ${x.mat_offered}`, 'purple') : null, !x.is_active ? badge('Inactive', 'danger') : null),
    kv([['Organization', x.organization], ['Phone', x.phone], ['Fax', x.fax], ['Email', x.email], ['Website', x.website], ['Contact', x.contact_person], ['Address', [x.address, x.city, x.zip].filter(Boolean).join(', ')], ['Hours', x.hours], ['Languages', x.languages], ['Services', x.services], ['Eligibility', x.eligibility], ['Capacity', x.capacity_notes], ['Last verified', x.last_verified_at ? fmt.date(x.last_verified_at) : 'never'], ['Notes', x.notes]]),
    x.referral_stats.length ? h('div', { class: 'mt' }, h('h4', {}, 'Referral outcomes'), x.referral_stats.map(s => [badge(`${fmt.label(s.status)}: ${s.n}`), ' '])) : null,
    h('div', { class: 'btn-row' }, can('resources:write') ? h('button', { class: 'btn', onClick: () => { m.close(); openResourceForm(x, refresh); } }, 'Edit') : null,
      can('resources:write') ? h('button', { class: 'btn', onClick: async () => { await put(`/api/resources/${x.id}`, { last_verified_at: fmt.today() }); toast('Marked verified today', 'ok'); m.close(); refresh(); } }, 'Verified today') : null,
      can('resources:write') && x.is_active ? h('button', { class: 'btn danger', onClick: async () => { if (await confirmDialog('Deactivate', 'Hide this resource from referral pickers?', { danger: true, okText: 'Deactivate' })) { await del(`/api/resources/${x.id}`); m.close(); refresh(); } } }, 'Deactivate') : null)));
}
