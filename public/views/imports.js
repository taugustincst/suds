import { h, route, get, post, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, clientPicker } from '../app.js';
import { spreadsheetImportCard } from './dataimport.js';

route('imports', async (r) => {
  if (r.id) return importDetail(r.id);
  const [list, one] = await Promise.all([get('/api/imports'), get('/api/imports/onenote/status')]);
  const refresh = () => nav(`imports?_=${Date.now()}`);
  // --- upload widgets
  const srcSel = h('select', {}, [['pocket_ai', 'Pocket AI export (.json / .md / .txt)'], ['onenote', 'OneNote export (.mht / .html / .docx / .txt)'], ['generic', 'Other text / markdown']].map(([v, l]) => h('option', { value: v }, l)));
  const fileIn = h('input', { type: 'file', multiple: true, accept: '.json,.md,.txt,.mht,.mhtml,.html,.htm,.docx' });
  const drop = h('div', { class: 'dropzone', onClick: () => fileIn.click(), onDragover: e => { e.preventDefault(); drop.classList.add('over'); }, onDragleave: () => drop.classList.remove('over'), onDrop: async e => { e.preventDefault(); drop.classList.remove('over'); await uploadFiles(e.dataTransfer.files); } }, 'Drop export files here or click to choose', h('div', { class: 'small' }, 'Files are parsed on the server, staged for your review, and only become notes after you assign a client.'));
  fileIn.addEventListener('change', () => uploadFiles(fileIn.files));
  async function uploadFiles(files) {
    let lastId;
    for (const f of files) {
      try { const buf = await f.arrayBuffer(); const res = await post(`/api/imports/upload?source=${srcSel.value}&filename=${encodeURIComponent(f.name)}`, buf, { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name } }); toast(`${f.name}: ${res.count} note(s) staged`, 'ok'); lastId = res.id; }
      catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
    if (lastId) nav(`imports/${lastId}`);
  }
  const pasteArea = h('textarea', { rows: 6, placeholder: 'Paste one or more notes. Separate notes with a line containing --- ; a "Date: ..." line sets the date of service.' });
  const pasteBtn = h('button', { class: 'btn', onClick: async () => { if (!pasteArea.value.trim()) return; try { const res = await post('/api/imports/upload', { source: srcSel.value, filename: 'pasted.txt', text: pasteArea.value }); nav(`imports/${res.id}`); } catch (e) { toast(e.message, 'error'); } } }, 'Stage pasted text');
  // --- OneNote Graph
  const graph = h('div', {});
  if (one.configured) {
    const status = h('div', { class: 'muted small' }, `Connected as ${one.user}`);
    const nbBox = h('div', {});
    graph.append(status, h('button', { class: 'btn sm', onClick: async () => { nbBox.replaceChildren(h('div', { class: 'muted' }, 'Loading notebooks…')); try { const { notebooks } = await get('/api/imports/onenote/notebooks'); nbBox.replaceChildren(notebooks.length ? notebooks.map(nb => h('details', { class: 'list-item' }, h('summary', {}, h('b', {}, nb.name), ' ', h('span', { class: 'muted small' }, `${nb.sections.length} sections`)), nb.sections.map(s => h('div', { style: { paddingLeft: '1rem' } }, h('a', { href: '#', onClick: async (e) => { e.preventDefault(); await pickPages(s); } }, s.name))))) : h('div', { class: 'muted' }, 'No notebooks found')); } catch (e) { nbBox.replaceChildren(h('div', { class: 'banner danger' }, e.message)); } } }, 'Browse notebooks'), nbBox);
  } else {
    graph.append(h('div', { class: 'muted small' }, 'Direct OneNote sync is not configured. An administrator can set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_ONENOTE_USER (see docs/IMPORTS.md). Until then, export pages from OneNote (File → Export → Single File Web Page) and upload them above.'));
  }
  async function pickPages(section) {
    const { pages } = await get(`/api/imports/onenote/sections/${encodeURIComponent(section.id)}/pages`);
    const checks = pages.map(p => ({ p, cb: h('input', { type: 'checkbox', checked: true }) }));
    const m = modal(`Pages in "${section.name}"`, h('div', {}, checks.length ? checks.map(({ p, cb }) => h('label', { class: 'check list-item' }, cb, p.title || '(untitled)', ' ', h('span', { class: 'muted small' }, `modified ${fmt.date(p.modified)}`))) : h('div', { class: 'muted' }, 'No pages'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onClick: async () => { const ids = checks.filter(c => c.cb.checked).map(c => c.p.id); if (!ids.length) return; try { const res = await post('/api/imports/onenote/fetch', { page_ids: ids }); m.close(); nav(`imports/${res.id}`); } catch (e) { toast(e.message, 'error'); } } }, 'Import selected'))));
  }
  const sheetCard = await spreadsheetImportCard();
  return h('div', {},
    pageHead('Import'),
    sheetCard ? h('div', { class: 'mb' }, sheetCard) : null,
    h('h2', {}, 'Import notes from Pocket AI / OneNote'),
    h('div', { class: 'banner small' }, h('b', {}, 'Workflow: '), 'upload or paste → review each staged note → match it to a client and choose Administrative or Clinical → commit. Committed notes are created as drafts you then sign. Staged text is encrypted at rest and purged when you discard it.'),
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' }, h('h3', {}, 'Upload export files'), h('div', { class: 'field' }, h('label', {}, 'Source'), srcSel), drop, h('div', { class: 'hidden' }, fileIn), h('details', { class: 'mt small' }, h('summary', {}, 'How to export'), h('ul', {}, h('li', {}, h('b', {}, 'Pocket AI: '), 'open the recording or note → Share / Export → choose JSON, Markdown or Text. Or set up the automatic intake (Administration → API keys) and share directly to the SUDS intake URL.'), h('li', {}, h('b', {}, 'OneNote (desktop): '), 'File → Export → Page or Section → "Single File Web Page (*.mht)" or "Word Document (*.docx)".'), h('li', {}, h('b', {}, 'OneNote (web/mobile): '), 'copy the page text and paste below, or use the Microsoft Graph sync at right.')))),
      h('div', { class: 'card' }, h('h3', {}, 'Paste text'), pasteArea, h('div', { class: 'btn-row' }, pasteBtn), h('h3', { class: 'mt' }, 'OneNote (Microsoft Graph)'), graph)),
    h('div', { class: 'card' }, h('h3', {}, 'Import batches'), table([{ label: 'Date', render: i => fmt.dt(i.created_at) }, { label: 'Source', render: i => badge(fmt.label(i.source)) }, { label: 'File', render: i => i.filename || '—' }, { label: 'By', key: 'imported_by_name' }, { label: 'Items', key: 'item_count', num: true }, { label: 'Staged', render: i => i.staged ? badge(i.staged, 'warn') : '0', num: true }, { label: 'Committed', key: 'committed', num: true }, { label: 'Discarded', key: 'discarded', num: true }, { label: 'Status', render: i => badge(fmt.label(i.status), statusKind(i.status)) },
      { label: '', render: i => i.status !== 'purged' && i.staged ? h('button', { class: 'btn sm ghost', onClick: async (e) => { e.stopPropagation(); if (await confirmDialog('Purge staged items', 'Discard all remaining staged (uncommitted) items in this batch?', { danger: true, okText: 'Purge' })) { await del(`/api/imports/${i.id}`); refresh(); } } }, 'Purge') : null }], list.imports, { onRow: i => nav(`imports/${i.id}`), empty: 'No imports yet.' })));
});

async function importDetail(id) {
  const data = await get(`/api/imports/${id}`);
  const refresh = () => nav(`imports/${id}?_=${Date.now()}`);
  const items = data.items;
  const staged = items.filter(i => i.status === 'staged');
  const C = state.constants;
  const kinds = ['admin', 'clinical'].filter(k => can(`notes:${k}:write`));
  const cards = staged.map(it => {
    const picker = clientPicker('client_id', it.suggested_client_id || '', { display: it.suggested_client_name ? `${it.suggested_client_name} (${it.suggested_client_code})` : undefined, required: true });
    const kindSel = h('select', {}, kinds.map(k => h('option', { value: k }, k === 'clinical' ? 'Clinical note' : 'Administrative / contact note')));
    const fmtSel = h('select', {}, C.NOTE_FORMATS.map(f => h('option', { value: f, selected: f === 'contact' }, f)));
    const title = h('input', { value: it.title || '' });
    const when = h('input', { type: 'datetime-local', value: it.captured_at ? fmt.isoLocal(new Date(it.captured_at)) : fmt.isoLocal() });
    const content = h('textarea', { rows: 8 }, it.content);
    const mkInt = h('input', { type: 'checkbox' }); const intType = h('select', {}, C.INTERVENTION_TYPES.map(t => h('option', { value: t, selected: t === 'case_management' }, fmt.label(t)))); const dur = h('input', { type: 'number', min: 0, step: 1, value: it.metadata?.duration ? Math.round(Number(it.metadata.duration) / 60) : 15, style: { width: '90px' } });
    const err = h('div', { class: 'banner danger hidden' });
    return h('div', { class: 'card mb' },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, it.title || '(untitled)'), h('div', { class: 'small muted' }, it.captured_at ? `Captured ${fmt.dt(it.captured_at)}` : 'No date detected', it.external_id ? ` · ref ${it.external_id}` : '', it.metadata?.section ? ` · ${it.metadata.section}` : '', it.metadata?.tags?.length ? ` · ${it.metadata.tags.join(', ')}` : '')),
        h('div', { class: 'row' }, it.hints?.names?.length ? badge(`Mentions: ${it.hints.names.join(', ')}`, 'info') : null, it.hints?.codes?.length ? badge(it.hints.codes.join(', '), 'info') : null, it.suggested_client_id ? badge('Client suggested', 'ok') : badge('No client match', 'warn'))),
      err,
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', {}, 'Client *'), picker), h('div', { class: 'field' }, h('label', {}, 'Note type'), kindSel), h('div', { class: 'field' }, h('label', {}, 'Format'), fmtSel), h('div', { class: 'field' }, h('label', {}, 'Date of service'), when),
        h('div', { class: 'field span' }, h('label', {}, 'Title'), title), h('div', { class: 'field span' }, h('label', {}, 'Content (edit before committing if needed)'), content),
        h('div', { class: 'field span row' }, h('label', { class: 'check', style: { marginTop: 0 } }, mkInt, 'Also log an intervention:'), intType, dur, h('span', { class: 'muted small' }, 'min')),
      ),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn ghost', onClick: async () => { await post(`/api/imports/items/${it.id}/discard`, {}); refresh(); } }, 'Discard'),
        h('button', { class: 'btn primary', onClick: async (e) => { err.classList.add('hidden'); if (!picker.value) { err.textContent = 'Select a client first.'; err.classList.remove('hidden'); return; } e.target.disabled = true; try { await post(`/api/imports/items/${it.id}/commit`, { client_id: picker.value, kind: kindSel.value, format: fmtSel.value, title: title.value, content: content.value, occurred_at: new Date(when.value).toISOString(), create_intervention: mkInt.checked, intervention_type: intType.value, duration_minutes: Number(dur.value) || 0 }); toast('Note created as draft', 'ok'); refresh(); } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); e.target.disabled = false; } } }, 'Commit as note')));
  });
  return h('div', {},
    pageHead(`Review import: ${data.import.filename || fmt.label(data.import.source)}`, h('a', { class: 'btn', href: '#/imports' }, '← All imports')),
    h('div', { class: 'row mb' }, badge(`${staged.length} to review`, staged.length ? 'warn' : ''), badge(`${items.filter(i => i.status === 'committed').length} committed`, 'ok'), badge(`${items.filter(i => i.status === 'discarded').length} discarded`)),
    cards.length ? cards : h('div', { class: 'empty' }, 'All items in this batch have been processed.'),
    items.some(i => i.status !== 'staged') ? h('div', { class: 'card' }, h('h3', {}, 'Processed'), table([{ label: 'Title', key: 'title' }, { label: 'Captured', render: i => i.captured_at ? fmt.dt(i.captured_at) : '—' }, { label: 'Status', render: i => badge(fmt.label(i.status), statusKind(i.status)) }, { label: 'Note', render: i => i.note_id ? h('a', { href: '#', onClick: async (e) => { e.preventDefault(); (await import('./notes.js')).openNote(i.note_id, {}); } }, 'Open note') : '' }], items.filter(i => i.status !== 'staged'))) : null);
}
