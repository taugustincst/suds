import { h, route, get, post, state, toast, nav, table, badge, fmt, can, pageHead, downloadCsv, modal, confirmDialog, clear } from '../app.js';

// Spreadsheet import wizard: choose type → (template) → upload → review mapping & rows → import
export async function spreadsheetImportCard() {
  const { entities } = await get('/api/imports/data/entities');
  if (!entities.length) return null;
  // Patients and encounters exported from the host EHR as FHIR R4 (1.17.0, docs/integration/EHR-PART2-LAYER.md):
  // the same preview and commit, from a Bundle or Bulk Data NDJSON instead of a spreadsheet.
  const EHR = { clients: 'Patients from your EHR (FHIR export)', interventions: 'Encounters from your EHR (FHIR export; import its patients first)' };
  const entSel = h('select', { 'data-import-entity': '1' }, [...entities.map(e => h('option', { value: e.key }, e.label)),
    ...entities.filter(e => EHR[e.key]).map(e => h('option', { value: `ehr:${e.key}` }, EHR[e.key]))]);
  const entityOf = () => entSel.value.replace(/^ehr:/, '');
  const fromEhr = () => entSel.value.startsWith('ehr:');
  // .sr-only, not .hidden (display:none) — a good few mobile browsers/WebViews refuse to honor a
  // programmatic .click() on a file input that display:none has taken out of the render tree.
  const fileIn = h('input', { type: 'file', tabindex: '-1', 'aria-hidden': 'true', accept: '.xlsx,.csv,.json,.ndjson', class: 'sr-only' });
  // What is happening is said as it happens (a live region), and a file that cannot be read is an alert, in the
  // error colour, apart from it (1.17.1).
  const status = h('div', { class: 'small muted mt', role: 'status', 'aria-live': 'polite', 'data-import-status': '1' });
  const error = h('div', { class: 'err small mt', role: 'alert', 'data-import-error': '1' });
  const review = h('div', { class: 'mt' });
  let preview = null; let file = null;
  const drop = h('div', { class: 'dropzone', role: 'button', tabindex: '0', onClick: () => fileIn.click(), onKeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } }, onDragover: e => { e.preventDefault(); drop.classList.add('over'); }, onDragleave: () => drop.classList.remove('over'), onDrop: e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); } }, 'Drop an Excel (.xlsx) or CSV file — or, for the EHR choices, its FHIR export (.json or .ndjson) — here, or click to choose', h('div', { class: 'small' }, 'Column names are matched automatically; you can adjust them before anything is saved.'));
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) load(fileIn.files[0]); });
  async function load(f, mapping, sheet = 0) {
    file = f; status.textContent = `Reading ${f.name}…`; error.textContent = ''; clear(review);
    try {
      const buf = await f.arrayBuffer();
      const q = `entity=${entityOf()}&sheet=${sheet}${mapping ? '&mapping=' + encodeURIComponent(JSON.stringify(mapping)) : ''}`;
      preview = fromEhr() ? await post(`/api/imports/ehr/preview?entity=${entityOf()}`, buf, { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name } })
        : await post(`/api/imports/data/preview?${q}`, buf, { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name } });
      status.textContent = `${f.name}: ${preview.rows.length} row${preview.rows.length === 1 ? '' : 's'} read. Check the columns and rows below before importing.`; renderReview();
    } catch (e) { status.textContent = ''; error.textContent = `${f.name} could not be read: ${e.message}`; }
  }
  function renderReview() {
    const p = preview; clear(review);
    const fieldOpts = [{ value: '', label: '— skip this column —' }, ...p.fields.map(f => ({ value: f.key, label: f.label + (f.required ? ' *' : '') }))];
    const mapping = { ...p.mapping };
    const mapTable = h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Column in your file'), h('th', { scope: 'col' }, 'Goes into'), h('th', { scope: 'col' }, 'First value'))),
      h('tbody', {}, p.headers.map(hd => h('tr', {}, h('td', {}, hd), h('td', {}, h('select', { onChange: (e) => { mapping[hd] = e.target.value; if (!e.target.value) delete mapping[hd]; } }, fieldOpts.map(o => h('option', { value: o.value, selected: (mapping[hd] || '') === o.value }, o.label)))), h('td', { class: 'small muted' }, String(p.rows[0] ? (p.rows[0].record[mapping[hd]] ?? '') : '').slice(0, 40))))));
    const missing = p.fields.filter(f => f.required && !Object.values(mapping).includes(f.key));
    const errRows = p.rows.filter(r => r.errors.length);
    const dupes = p.rows.filter(r => r.record._duplicate_of);
    const shortYears = p.rows.flatMap(r => (r.dates || []).map(d => ({ n: r.n, ...d })));
    const skipDup = h('input', { type: 'checkbox', checked: true });
    review.append(...[
      h('div', { class: 'row mb' }, p.sheets.length > 1 ? h('select', { onChange: (e) => load(file, null, Number(e.target.value)) }, p.sheets.map((s, i) => h('option', { value: i, selected: i === p.sheet }, `Sheet: ${s.name} (${s.rows} rows)`))) : null, badge(`${p.rows.length} rows`), badge(`${p.valid} ready`, 'ok'), p.invalid ? badge(`${p.invalid} with problems`, 'danger') : null, dupes.length ? badge(`${dupes.length} look like existing clients`, 'warn') : null, p.truncated ? badge('Only the first 2000 rows are shown', 'warn') : null),
      h('details', { open: !!missing.length }, h('summary', {}, 'Column matching', missing.length ? h('span', { class: 'badge danger', style: { marginLeft: '.5rem' } }, `missing: ${missing.map(f => f.label).join(', ')}`) : h('span', { class: 'badge ok', style: { marginLeft: '.5rem' } }, 'all required columns found')), h('div', { class: 'table-wrap' }, mapTable), h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onClick: () => load(file, mapping, p.sheet) }, 'Re-check with these columns'))),
      errRows.length ? h('div', { class: 'card tight mt' }, h('h3', { class: 'eyebrow' }, 'Rows that need attention'), table([{ label: 'Row', key: 'n' }, { label: 'Problem', render: r => r.errors.join('; ') }], errRows.slice(0, 50), { wrap: false }), errRows.length > 50 ? h('div', { class: 'small muted' }, `…and ${errRows.length - 50} more`) : null) : null,
      // A two-digit year is a guess (a date of birth "1/5/27" is 1927, a due date "1/5/28" 2028): each one is shown with
      // what it was read as, so the person importing can check it before anything is saved (BO4).
      shortYears.length ? h('div', { class: 'card tight mt', 'data-import-dates': '1' }, h('h3', { class: 'eyebrow' }, 'Dates with a two-digit year: check how they were read'),
        table([{ label: 'Row', key: 'n' }, { label: 'Column', key: 'field' }, { label: 'In the file', key: 'raw' }, { label: 'Read as', render: d => fmt.date(d.value) }], shortYears.slice(0, 50), { wrap: false }),
        shortYears.length > 50 ? h('div', { class: 'small muted' }, `…and ${shortYears.length - 50} more`) : null) : null,
      dupes.length ? h('label', { class: 'check' }, skipDup, `Skip rows that match an existing client by name (${dupes.length})`) : null,
      h('div', { class: 'btn-row' },
        p.valid ? h('button', { class: 'btn primary', onClick: async (e) => {
          const ok = await confirmDialog('Import rows', `Import ${p.valid} ${entities.find(x => x.key === p.entity).label.toLowerCase()} row(s)${errRows.length ? ` and skip ${errRows.length} with problems` : ''}?`, { okText: 'Import' }); if (!ok) return;
          e.target.disabled = true;
          try { const r = await post('/api/imports/data/commit', { entity: p.entity, records: p.rows.filter(x => !x.errors.length).map(x => ({ ...x.record, _n: x.n })), partial: true, skip_duplicates: dupes.length ? skipDup.checked : false, source: p.source || undefined });
            toast(`Imported ${r.created} row(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ''}${r.skipped_duplicates ? `, ${r.skipped_duplicates} already imported` : ''}${r.errors.length ? `, ${r.errors.length} failed` : ''}`, r.errors.length ? 'error' : 'ok');
            clear(review); preview = null; if (r.errors.length) review.append(table([{ label: 'Row', key: 'n' }, { label: 'Problem', key: 'error' }], r.errors, { wrap: false })); else status.textContent = 'Done. You can import another file.';
          } catch (ex) { toast(ex.message, 'error'); e.target.disabled = false; }
        } }, `Import ${p.valid} row${p.valid === 1 ? '' : 's'}`) : h('span', { class: 'muted small' }, 'Fix the column matching or the file, then try again.'))].filter(Boolean));
  }
  // The templates are spreadsheets: an EHR's FHIR export has its own layout, so they are not offered for it.
  const templates = [h('button', { class: 'btn sm', 'data-import-template': 'xlsx', onClick: () => downloadCsv(`/api/imports/data/template/${entityOf()}`) }, 'Download Excel template'), h('button', { class: 'btn sm ghost', 'data-import-template': 'csv', onClick: () => downloadCsv(`/api/imports/data/template/${entityOf()}?format=csv`) }, 'CSV template')];
  const showTemplates = () => { for (const b of templates) b.classList.toggle('hidden', fromEhr()); };
  entSel.addEventListener('change', showTemplates); showTemplates();
  return h('div', { class: 'card', 'data-import-card': '1' }, h('h2', {}, 'Import a spreadsheet or EHR export'),
    h('p', { class: 'small muted' }, 'Bring in a list you already keep in a spreadsheet, or patients and encounters exported from your EHR (FHIR). For a spreadsheet, download the template for the exact columns or upload your own file — columns are matched by name. Every row is checked before anything is saved.'),
    h('div', { class: 'row mb' }, h('div', { class: 'field grow', style: { margin: 0 } }, h('label', {}, 'What are you importing?'), entSel), ...templates),
    drop, fileIn, status, error, review);
}

export function exportButtons({ kind, from, to, label = 'Export' }) {
  if (!can('export:read')) return null;
  const q = `from=${from || '2000-01-01'}&to=${to || fmt.today()}`;
  return h('div', { class: 'row', style: { gap: '.25rem' } }, h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/${kind}?${q}&format=xlsx`) }, `${label} to Excel`), h('button', { class: 'btn ghost', onClick: () => downloadCsv(`/api/reports/export/${kind}?${q}`) }, 'CSV'));
}
