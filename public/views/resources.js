import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, confirmDialog, nav, kv, prefs, emptyState, clear, downloadCsv, img, setImage, contactLinks, mapLink } from '../app.js';

const tagOpts = (list) => list.map(t => ({ value: t, label: fmt.label(t) }));
// Comma-separated tag fields are edited as a checkbox grid
function tagPicker(name, list, value) {
  const set = new Set(String(value || '').split(',').map(x => x.trim()).filter(Boolean));
  const box = h('div', { class: 'tag-grid', 'data-tags': name }, list.map(t => h('label', { class: 'check tag' }, h('input', { type: 'checkbox', value: t, checked: set.has(t) }), fmt.label(t))));
  box.getValue = () => [...box.querySelectorAll('input:checked')].map(i => i.value).join(',');
  return box;
}
export function openResourceForm(values, onDone) {
  const C = state.constants; const isNew = !values;
  const tags = tagPicker('service_tags', C.SERVICE_TAGS, values?.service_tags); const pops = tagPicker('populations', C.POPULATIONS, values?.populations);
  const f = form([
    { type: 'section', label: 'Basics', collapsible: true, open: true },
    { name: 'name', label: 'Program / service name', required: true, span: true }, { name: 'category', label: 'Category', type: 'select', options: C.RESOURCE_CATEGORIES, required: true }, { name: 'organization', label: 'Organization' },
    { name: 'summary', label: 'About this program (shown at the top of the profile)', type: 'textarea', span: true, rows: 3, placeholder: 'What they do, who it is for, what makes them a good fit. Plain language.' },
    { type: 'section', label: 'Contact & location', collapsible: true, open: true },
    { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'fax', label: 'Fax', type: 'tel' }, { name: 'email', label: 'Email' }, { name: 'website', label: 'Website' }, { name: 'contact_person', label: 'Contact person' },
    { name: 'address', label: 'Address', span: true }, { name: 'city', label: 'City' }, { name: 'zip', label: 'ZIP' }, { name: 'hours', label: 'Hours' }, { name: 'languages', label: 'Languages' },
    { type: 'section', label: 'Services & admission', collapsible: true, open: !isNew },
    { name: 'levels_of_care', label: 'Levels of care (ASAM, comma separated)', placeholder: 'e.g. 3.5, 3.7, OTP' }, { name: 'mat_offered', label: 'MAT offered (e.g. buprenorphine, methadone)' },
    { name: 'accepts_medicaid', label: 'Accepts Medicaid', type: 'checkbox' }, { name: 'accepts_uninsured', label: 'Accepts uninsured / sliding scale', type: 'checkbox' },
    { name: 'services', label: 'Services (details)', type: 'textarea', span: true, rows: 2 }, { name: 'eligibility', label: 'Eligibility / admission criteria', type: 'textarea', span: true, rows: 2 },
    { name: 'intake_process', label: 'How to refer / intake process', type: 'textarea', span: true, rows: 2, placeholder: 'Who to call, what paperwork, how long it usually takes' }, { name: 'cost_notes', label: 'Cost / payment', type: 'textarea', span: true, rows: 2 },
    { name: 'capacity_notes', label: 'Capacity / waitlist notes', type: 'textarea', span: true, rows: 2 },
    { type: 'section', label: 'Verification & notes', collapsible: true, open: false },
    { name: 'last_verified_at', label: 'Last verified', type: 'date' }, { name: 'is_active', label: 'Active', type: 'checkbox', value: values ? values.is_active : true }, { name: 'notes', label: 'Internal notes', type: 'textarea', span: true, rows: 2 },
  ], { values: values || {}, submitText: isNew ? 'Add resource' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    d.service_tags = tags.getValue(); d.populations = pops.getValue();
    let id = values?.id; if (isNew) id = (await post('/api/resources', d)).id; else await put(`/api/resources/${id}`, d);
    toast('Resource saved', 'ok'); m.close(); onDone && onDone(id);
  } });
  // tag pickers live inside the "Services & admission" section
  const sec = f.querySelectorAll('details.section')[2]?.querySelector('.form-grid') || f.querySelector('.form-grid');
  const anchor = sec.querySelector('[data-field=services]');
  sec.insertBefore(h('div', { class: 'field span' }, h('label', {}, 'Services offered (tick all that apply)'), tags), anchor);
  sec.insertBefore(h('div', { class: 'field span' }, h('label', {}, 'Populations served'), pops), anchor);
  const m = modal(isNew ? 'Add resource' : 'Edit resource', f, { wide: true });
}

const tagBadges = (csv, kind = '') => String(csv || '').split(',').filter(Boolean).map(t => [badge(fmt.label(t), kind), ' ']);
const stale = x => !x.last_verified_at || Date.now() - Date.parse(x.last_verified_at) > 180 * 86400000;
const siteHref = w => w ? (w.startsWith('http') ? w : 'https://' + w) : null;

// Starter directory for a whole region: load real programs in one click instead of typing the directory.
async function regionCard(refresh) {
  if (!can('resources:write')) return null;
  let data; try { data = await get('/api/regions', { quiet: true }); } catch { return null; }
  const box = h('div', {});
  const draw = (regions) => {
    clear(box);
    for (const rg of regions) {
      const busy = h('div', { class: 'small muted' });
      const load = async () => {
        busy.textContent = `Adding ${rg.provider_count} programs…`;
        const out = await post(`/api/regions/${rg.id}/load`, {});
        toast(`${out.added} programs added, ${out.enriched} filled in`, 'ok');
        busy.textContent = ''; refresh();
      };
      const downloadPictures = async () => {
        const { pending } = await get(`/api/regions/${rg.id}/pictures`);
        if (!pending.length) { toast('Every program already has a picture from its own website', 'ok'); return; }
        let done = 0, ok = 0; const failures = [];
        for (let i = 0; i < pending.length; i += 5) {
          const batch = pending.slice(i, i + 5);
          busy.textContent = `Downloading pictures from provider websites… ${done} of ${pending.length}`;
          try { const res = await post(`/api/regions/${rg.id}/pictures`, { keys: batch.map(p => p.key) });
            for (const x of res.results) { if (x.ok) ok++; else failures.push(`${x.name}: ${x.error}`); }
          } catch (e) { failures.push(e.message); }
          done += batch.length;
        }
        busy.textContent = ok ? `${ok} picture${ok === 1 ? '' : 's'} downloaded.${failures.length ? ` ${failures.length} could not be fetched (the generated card stays).` : ''}` : `No pictures could be downloaded. ${failures[0] || ''} Programs keep their generated cards.`;
        if (ok) { toast(`${ok} provider pictures downloaded`, 'ok'); refresh(); }
      };
      const remove = async () => {
        if (!await confirmDialog('Remove starter directory', `Remove the ${rg.name} programs that nobody has used or verified? Programs with referrals, or ones you marked verified, are kept and simply hidden from the pickers.`, { danger: true, okText: 'Remove' })) return;
        const out = await del(`/api/regions/${rg.id}`); toast(`${out.removed} removed, ${out.kept} kept`, 'ok'); refresh();
      };
      box.append(h('div', { class: 'card region-card', 'data-region': rg.id },
        h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, rg.name, ' starter directory'), h('div', { class: 'small muted' }, rg.counties.join(' · '))),
          rg.loaded ? badge(`${rg.present} loaded`, 'ok') : badge(`${rg.provider_count} programs`, 'info')),
        h('p', { class: 'small' }, rg.description),
        rg.loaded ? [
          rg.unverified ? h('div', { class: 'banner warn small' }, h('b', {}, `${rg.unverified} of these still need checking. `), 'Open each program, call to confirm the address, phone number and intake, then press "Verified today".') : h('div', { class: 'banner small' }, 'Every imported program has been verified by your staff.'),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: load }, 'Check for updates'), h('button', { class: 'btn', onClick: downloadPictures }, 'Download provider pictures'), h('button', { class: 'btn danger ghost sm', onClick: remove }, 'Remove starter directory'), busy)]
        : [h('p', { class: 'small muted' }, rg.sources_note),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: load }, `Add ${rg.provider_count} programs`), busy)]));
    }
  };
  draw(data.regions);
  return box;
}

route('resources', async (r) => {
  const q = r.query.get('q') || '', cat = r.query.get('category') || '', inactive = r.query.get('inactive') === '1', tag = r.query.get('tag') || '';
  const view = r.query.get('view') || prefs.get('resources_view') || 'cards';
  const data = await get(`/api/resources?limit=1000${q ? '&q=' + encodeURIComponent(q) : ''}${cat ? '&category=' + cat : ''}${inactive ? '&active=0' : ''}`);
  const rows = tag ? data.rows.filter(x => String(x.service_tags || '').split(',').includes(tag)) : data.rows;
  const link = (o = {}) => `resources?q=${encodeURIComponent(o.q ?? q)}&category=${o.category ?? cat}&tag=${o.tag ?? tag}${(o.inactive ?? inactive) ? '&inactive=1' : ''}${o.view ? '&view=' + o.view : ''}`;
  const refresh = () => nav(link() + `&_=${Date.now()}`);
  const search = h('input', { type: 'search', value: q, placeholder: 'Name, organization, service, city', onKeydown: e => { if (e.key === 'Enter') nav(link({ q: search.value })); } });
  const catSel = h('select', { onChange: () => nav(link({ category: catSel.value })) }, h('option', { value: '' }, 'All categories'), state.constants.RESOURCE_CATEGORIES.map(c => h('option', { value: c, selected: c === cat }, fmt.label(c))));
  const tagSel = h('select', { onChange: () => nav(link({ tag: tagSel.value })) }, h('option', { value: '' }, 'Any service'), state.constants.SERVICE_TAGS.map(c => h('option', { value: c, selected: c === tag }, fmt.label(c))));
  const setView = (v) => { prefs.set('resources_view', v); nav(link({ view: v })); };
  const thumb = (x, cls = 'thumb') => x.cover_url ? img(x.cover_url, { class: cls, alt: '', loading: 'lazy' }) : h('div', { class: `${cls} placeholder`, 'aria-hidden': 'true' }, (x.name || '?').slice(0, 1).toUpperCase());
  const cards = () => rows.length ? h('div', { class: 'grid cols-3 res-cards' }, rows.map(x => h('a', { class: 'card res-card', href: `#/resource/${x.id}` },
    thumb(x, 'res-cover'),
    h('div', { class: 'res-body' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('b', {}, x.name), badge(fmt.label(x.category), 'info')), x.organization ? h('div', { class: 'small muted' }, x.organization) : null,
      x.summary ? h('p', { class: 'small res-summary' }, x.summary) : x.services ? h('p', { class: 'small res-summary muted' }, x.services) : null,
      h('div', { class: 'res-tags small' }, tagBadges(String(x.service_tags || '').split(',').slice(0, 5).join(','), 'purple'), x.accepts_medicaid ? badge('Medicaid', 'ok') : null, ' ', x.accepts_uninsured ? badge('Uninsured OK', 'info') : null),
      h('div', { class: 'small muted' }, x.city || '', x.phone ? ` · ☎ ${x.phone}` : '', x.photo_count ? ` · ${x.photo_count} photo${x.photo_count > 1 ? 's' : ''}` : '', stale(x) ? h('span', { style: { color: 'var(--warn)' } }, ' · needs verification') : null)))))
    : emptyState('No resources match', 'Try another search, or add the program.', can('resources:write') ? h('button', { class: 'btn primary', onClick: () => openResourceForm(null, (id) => nav(`resource/${id}`)) }, '+ Add resource') : null);
  const list = () => table([
    { label: '', render: x => thumb(x) },
    { label: 'Resource', render: x => h('div', {}, h('b', {}, x.name), x.organization ? h('div', { class: 'small muted' }, x.organization) : null) }, { label: 'Category', render: x => fmt.label(x.category) },
    { label: 'Services', render: x => h('div', { class: 'small' }, tagBadges(String(x.service_tags || '').split(',').slice(0, 4).join(','), 'purple')) },
    { label: 'Contact', render: x => h('div', { class: 'small' }, x.phone ? h('div', {}, '☎ ', contactLinks(x.phone)) : null, x.city ? h('div', { class: 'muted' }, x.city) : null, x.website ? h('a', { href: siteHref(x.website), target: '_blank', rel: 'noopener', onClick: e => e.stopPropagation() }, 'website') : null) },
    { label: 'Accepts', render: x => [x.accepts_medicaid ? badge('Medicaid', 'ok') : null, ' ', x.accepts_uninsured ? badge('Uninsured', 'info') : null, x.mat_offered ? [' ', badge('MAT', 'purple')] : null] },
    { label: 'Referrals', key: 'referral_count', num: true }, { label: 'Verified', render: x => h('span', { style: stale(x) ? { color: 'var(--warn)' } : {} }, x.last_verified_at ? fmt.date(x.last_verified_at) : 'never') }, { label: '', render: x => x.is_active ? null : badge('Inactive', 'warn') },
  ], rows, { onRow: x => nav(`resource/${x.id}`), empty: 'No resources yet. Add treatment providers, MAT clinics, shelters, and other referral partners.' });
  return h('div', {},
    pageHead('Resource directory', can('resources:write') ? h('button', { class: 'btn primary', onClick: () => openResourceForm(null, (id) => nav(`resource/${id}`)) }, '+ Add resource') : null, can('export:read') ? h('button', { class: 'btn', onClick: () => window.__suds.downloadCsv('/api/reports/export/resources') }, 'Export') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Category'), catSel), h('div', { class: 'field' }, h('label', {}, 'Service'), tagSel),
      h('button', { class: 'btn', onClick: () => nav(link({ q: search.value })) }, 'Search'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: inactive, onChange: e => nav(link({ inactive: e.target.checked })) }), 'Show inactive'),
      h('div', { class: 'seg' }, h('button', { class: view === 'cards' ? 'active' : '', onClick: () => setView('cards'), title: 'Cards' }, '▦'), h('button', { class: view === 'list' ? 'active' : '', onClick: () => setView('list'), title: 'List' }, '☰'))),
    await regionCard(refresh),
    h('div', { class: 'muted small mb' }, `${rows.length} of ${data.total} resources`),
    view === 'list' ? list() : cards());
});

// ---------- Profile page ----------
route('resource', async (r) => {
  const x = (await get(`/api/resources/${r.id}`)).row;
  const refresh = () => nav(`resource/${x.id}?_=${Date.now()}`);
  const photos = x.photos || [];
  const gallery = h('div', { class: 'gallery' });
  const renderGallery = () => {
    gallery.replaceChildren();
    if (!photos.length) { gallery.append(h('div', { class: 'gallery-empty' }, h('div', { class: 'big' }, '📷'), h('div', { class: 'muted small' }, can('resources:write') ? 'No pictures yet. Add photos of the building, entrance and rooms so staff and clients know what to expect.' : 'No pictures yet.'))); return; }
    const hero = photos[0];
    gallery.append(h('figure', { class: 'hero' }, img(hero.data_url, { alt: hero.caption || x.name, onClick: () => lightbox(0) }), hero.caption ? h('figcaption', {}, hero.caption) : null));
    if (photos.length > 1) gallery.append(h('div', { class: 'thumbs' }, photos.map((p, i) => h('button', { class: 'thumb-btn', type: 'button', title: p.caption || '', onClick: () => lightbox(i) }, img(p.thumb_url || p.data_url, { alt: p.caption || '', loading: 'lazy' })))));
  };
  const lightbox = (i) => {
    let idx = i; const lightboxImg = h('img', { alt: '' }); const cap = h('div', { class: 'small muted mt' }); const count = h('span', { class: 'small muted' });
    const show = () => { const p = photos[idx]; setImage(lightboxImg, p.data_url); cap.textContent = p.caption || ''; count.textContent = `${idx + 1} / ${photos.length}`; };
    const prev = () => { idx = (idx - 1 + photos.length) % photos.length; show(); }; const next = () => { idx = (idx + 1) % photos.length; show(); };
    const m = modal(x.name, h('div', { class: 'lightbox' }, lightboxImg, cap, h('div', { class: 'row mt', style: { justifyContent: 'space-between' } },
      h('div', { class: 'row' }, photos.length > 1 ? [h('button', { class: 'btn sm', onClick: prev }, '‹ Prev'), h('button', { class: 'btn sm', onClick: next }, 'Next ›')] : null, count),
      can('resources:write') ? h('div', { class: 'row' },
        h('button', { class: 'btn sm', onClick: async () => { const c = prompt('Caption for this picture', photos[idx].caption || ''); if (c === null) return; await put(`/api/resources/${x.id}/photos/${photos[idx].id}`, { caption: c }); photos[idx].caption = c; show(); renderGallery(); } }, 'Caption'),
        idx > 0 ? h('button', { class: 'btn sm', onClick: async () => { await put(`/api/resources/${x.id}/photos/${photos[idx].id}`, { sort_order: 0 }); toast('Set as main picture', 'ok'); m.close(); refresh(); } }, 'Make main picture') : null,
        h('button', { class: 'btn sm danger', onClick: async () => { if (!await confirmDialog('Remove picture', 'Remove this picture from the profile?', { danger: true, okText: 'Remove' })) return; await del(`/api/resources/${x.id}/photos/${photos[idx].id}`); photos.splice(idx, 1); toast('Picture removed', 'ok'); m.close(); renderGallery(); } }, 'Remove')) : null)), { wide: true });
    show();
    const key = (e) => { if (!document.body.contains(lightboxImg)) { document.removeEventListener('keydown', key); return; } if (e.key === 'ArrowLeft') prev(); if (e.key === 'ArrowRight') next(); }; document.addEventListener('keydown', key);
  };
  renderGallery();
  const status = h('div', { class: 'small muted mt' });
  // The file input *is* the button: a <label class="btn"> with the input laid transparently over it
  // (.file-btn). A tap anywhere on the button lands on the input itself, so the native picker opens as a
  // direct user gesture on every browser and WebView — nothing relies on a programmatic .click() on an
  // off-screen input, which Android WebViews refuse and which automated testers report as "the file
  // control is obscured" (an off-screen input can only be reached through the button that forwards to it).
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, 'aria-label': 'Add pictures', onChange: async () => {
    const files = [...fileInput.files]; fileInput.value = '';
    let added = 0;
    for (const f of files) {
      if (photos.length >= 12) { toast('A resource can have at most 12 pictures', 'error'); break; }
      status.textContent = `Preparing ${f.name}…`;
      try {
        const pic = await shrinkImage(f, 1600, 0.85); const th = await shrinkImage(f, 240, 0.7, true);
        status.textContent = `Uploading ${f.name}…`;
        const r = await post(`/api/resources/${x.id}/photos`, { data_url: pic.dataUrl, thumb_url: th.dataUrl, width: pic.width, height: pic.height, caption: '' });
        photos.push({ ...r.photo, data_url: pic.dataUrl, thumb_url: th.dataUrl }); added++; renderGallery();
      } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
    status.textContent = added ? `${added} picture${added > 1 ? 's' : ''} added` : '';
  } });
  const head = h('div', { class: 'res-head' },
    h('div', {}, h('div', { class: 'row mb', style: { gap: '.35rem' } }, badge(fmt.label(x.category), 'info'), x.is_active ? null : badge('Inactive', 'warn'), x.accepts_medicaid ? badge('Medicaid', 'ok') : null, x.accepts_uninsured ? badge('Uninsured OK', 'info') : null, x.mat_offered ? badge(`MAT: ${x.mat_offered}`, 'purple') : null, stale(x) ? badge(x.last_verified_at ? `verified ${fmt.date(x.last_verified_at)}` : 'never verified', 'warn') : badge(`verified ${fmt.date(x.last_verified_at)}`, 'ok')),
      x.organization ? h('div', { class: 'muted' }, x.organization) : null,
      x.summary ? h('p', { class: 'res-lead' }, x.summary) : h('p', { class: 'muted small' }, can('resources:write') ? 'No summary yet. Click Edit to describe what this program offers.' : 'No summary yet.')));
  const contact = kv([['Phone', contactLinks(x.phone)], ['Fax', x.fax], ['Email', x.email ? h('a', { href: `mailto:${x.email}` }, x.email) : null], ['Website', x.website ? h('a', { href: siteHref(x.website), target: '_blank', rel: 'noopener' }, x.website) : null], ['Contact', x.contact_person],
    ['Address', mapLink([x.address, x.city, x.zip].filter(Boolean).join(', ') || null)], ['Hours', x.hours], ['Languages', x.languages]]);
  const services = h('div', {},
    x.service_tags ? h('div', { class: 'mb' }, tagBadges(x.service_tags, 'purple')) : null,
    kv([['Levels of care', x.levels_of_care], ['MAT / medications', x.mat_offered], ['Populations served', x.populations ? String(x.populations).split(',').map(fmt.label).join(', ') : null], ['Services (details)', x.services], ['Eligibility', x.eligibility], ['How to refer', x.intake_process], ['Cost / payment', x.cost_notes], ['Capacity / waitlist', x.capacity_notes]].filter(([, v]) => v)),
    !x.service_tags && !x.services && !x.eligibility ? h('p', { class: 'muted small' }, 'No service details yet.') : null);
  const outcomes = x.referral_stats.length ? h('div', {}, x.referral_stats.map(s => [badge(`${fmt.label(s.status)}: ${s.n}`), ' '])) : h('p', { class: 'muted small' }, 'No referrals yet.');
  const recent = (x.recent_referrals || []).length ? table([{ label: 'Client', render: y => h('a', { href: `#/client/${y.client_id}/referrals` }, y.client_code) }, { label: 'Referred', render: y => fmt.date(y.referred_at) }, { label: 'Status', render: y => badge(fmt.label(y.status)) }], x.recent_referrals) : null;
  return h('div', {},
    pageHead(x.name, h('a', { class: 'btn', href: '#/resources' }, '← Directory'),
      can('referrals:write') ? h('button', { class: 'btn', onClick: async () => (await import('./referrals.js')).openReferralForm(null, { resourceId: x.id, onDone: refresh }) }, '+ Refer a client') : null,
      can('resources:write') ? h('button', { class: 'btn', onClick: async () => { await put(`/api/resources/${x.id}`, { last_verified_at: fmt.today() }); toast('Marked verified today', 'ok'); refresh(); } }, 'Verified today') : null,
      can('resources:write') ? h('button', { class: 'btn primary', onClick: () => openResourceForm(x, refresh) }, 'Edit') : null),
    head,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Pictures'), can('resources:write') ? h('div', {}, h('label', { class: 'btn sm file-btn' }, '+ Add pictures', fileInput)) : null), gallery, status,
        can('resources:write') ? h('p', { class: 'small muted mt' }, 'Pictures are shrunk on this device before saving. Do not upload pictures of clients.') : null),
      h('div', {}, h('div', { class: 'card mb' }, h('h3', {}, 'Services offered'), services), h('div', { class: 'card' }, h('h3', {}, 'Contact & location'), contact))),
    h('div', { class: 'grid cols-2 mt' }, h('div', { class: 'card' }, h('h3', {}, 'Referral outcomes'), outcomes, recent ? h('div', { class: 'mt' }, recent) : null),
      x.notes || can('resources:write') ? h('div', { class: 'card' }, h('h3', {}, 'Internal notes'), x.notes ? h('p', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, x.notes) : h('p', { class: 'muted small' }, 'Nothing noted.'),
        can('resources:write') && x.is_active ? h('div', { class: 'btn-row' }, h('button', { class: 'btn danger sm', onClick: async () => { if (await confirmDialog('Deactivate', 'Hide this resource from referral pickers?', { danger: true, okText: 'Deactivate' })) { await del(`/api/resources/${x.id}`); toast('Resource deactivated', 'ok'); refresh(); } } }, 'Deactivate')) : null) : null));
});

// Resize a picture in the browser (canvas) so uploads stay small and phones do not send 8 MB originals.
export function shrinkImage(file, max, quality, forceJpeg = false) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale)), hgt = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = hgt; const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); ctx.drawImage(img, 0, 0, w, hgt);
      const type = forceJpeg || file.type !== 'image/png' ? 'image/jpeg' : 'image/png';
      resolve({ dataUrl: c.toDataURL(type, quality), width: w, height: hgt, type });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a picture the browser can open (use JPEG, PNG or WebP)')); };
    img.src = url;
  });
}
