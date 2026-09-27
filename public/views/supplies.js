// Supplies (docs/SUPPLIES.md): what is on hand at each site, in lots with an expiry date, and every movement
// in and out — stock received, moved between sites, adjusted after a count, disposed of, and handed out on
// visits (server/supplies.js). Field staff see the stock and record deliveries at their site; supervisors and
// administrators run the cupboard (items, sites, transfers, adjustments, disposal) and see the expiry alerts
// on Home. The syringe services summary for a period is here too, for those who may run it.
import { h, route, get, post, put, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, pageTabs, stat, flag, pagedList, downloadCsv } from '../app.js';
import { mayRunInternalReports, runKindBanner } from './funder.js';

const labelIn = (list, code) => ((list || []).find(x => x.code === code) || { label: code || '' }).label;
const lotKey = (l) => `${l.lot_number || ''}|${l.expires_on || ''}`;
const fromKey = (k) => { const [lot_number, expires_on] = String(k || '|').split('|'); return { lot_number, expires_on: expires_on || null }; };
const lotLabel = (l) => [l.lot_number ? `Lot ${l.lot_number}` : 'No lot', l.expires_on ? `expires ${fmt.date(l.expires_on)}` : 'no expiry'].join(', ');
const signed = (n) => (n > 0 ? `+${fmt.num(n)}` : `−${fmt.num(-n)}`);
const refresh = (q = '') => nav(`supplies?${q}${q ? '&' : ''}_=${Date.now()}`);
const lastMonth = () => { const t = fmt.today(); const y = Number(t.slice(0, 4)); const m = Number(t.slice(5, 7)); const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1; const pad = (x) => String(x).padStart(2, '0'); return [`${py}-${pad(pm)}-01`, new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10)]; };

/** The badge a lot's expiry earns: words, never colour alone. */
function expiryBadge(l) {
  if (l.state === 'expired') return badge('Expired', 'danger');
  if (l.state === 'expiring') return badge('Expires soon', 'warn');
  return null;
}

/** Home: the alerts a supervisor or administrator acts on, and a tile that opens the lots. */
export async function supplyHome() {
  const a = await get('/api/supplies/alerts', { quiet: true }).catch(() => null);
  if (!a) return null;
  const c = a.counts; const alerts = [];
  if (c.expired) alerts.push(['danger', `${c.expired} supply lot${c.expired > 1 ? 's' : ''} expired: dispose of ${c.expired > 1 ? 'them' : 'it'}`, '#/supplies?tab=lots']);
  if (c.expiring) alerts.push(['warn', `${c.expiring} supply lot${c.expiring > 1 ? 's expire' : ' expires'} within ${a.warn_days} days`, '#/supplies?tab=lots']);
  if (c.low) alerts.push(['warn', `${c.low} suppl${c.low > 1 ? 'ies are' : 'y is'} running low`, '#/supplies']);
  if (c.shortfalls) alerts.push(['warn', `${c.shortfalls} supply shortfall${c.shortfalls > 1 ? 's' : ''} to check`, '#/supplies?tab=history&flagged=1']);
  const n = c.expired + c.expiring;
  return { alerts, tile: h('div', { 'data-supply-tile': '1', style: { display: 'contents' } }, stat('Supply lots expired or expiring', fmt.num(n), c.expired ? 'danger' : c.expiring ? 'warn' : '', 'supplies?tab=lots', `Expired, or expiring within ${a.warn_days} days`)) };
}

route('supplies', async (r) => {
  const d = await get('/api/supplies');
  const M = d.meta; const can2 = d.can;
  const tabs = [['stock', 'Stock'], ['lots', `Lots & expiry${d.alerts.counts.expired + d.alerts.counts.expiring ? ` (${d.alerts.counts.expired + d.alerts.counts.expiring})` : ''}`], ['history', 'History']];
  if (can2.manage) tabs.push(['setup', 'Items & sites']);
  const sspOk = can('reports:read') && mayRunInternalReports({ caseloadScoped: true });
  // Short enough to fit a phone's tab strip; the full name is in its accessible name and on the tab's page.
  if (sspOk) tabs.push(['ssp', h('span', {}, 'SSP report', h('span', { class: 'sr-only' }, ' (syringe services program)')), { title: 'Syringe services program report', 'data-tab-ssp': '1' }]);
  const tab = tabs.some(t => t[0] === r.query.get('tab')) ? r.query.get('tab') : 'stock';
  const siteId = d.sites.some(s => s.id === r.query.get('site')) ? r.query.get('site') : '';
  const items = new Map(d.items.map(i => [i.id, i])); const sites = new Map(d.sites.map(s => [s.id, s]));
  const activeItems = d.items.filter(i => i.is_active); const activeSites = d.sites.filter(s => s.is_active);
  const itemName = (id) => (items.get(id) || { name: '?' }).name;
  const siteName = (id) => (sites.get(id) || { name: '?' }).name;
  const inSite = (x) => !siteId || x.site_id === siteId;
  const qs = (extra = '') => `tab=${tab}${siteId ? `&site=${siteId}` : ''}${extra}`;
  // A device that syncs with an office shows the office's items and sites; stock moved here is sent there.
  const officeCopy = state.local && !window.SUDS_STATIC_HOST;
  const onErr = (fallback) => (e) => { toast(e.message || fallback, 'error'); throw e; };

  // ---- the forms ----
  const itemOptions = () => activeItems.map(i => ({ value: i.id, label: `${i.name} (${i.unit})` }));
  const siteOptions = (list = activeSites) => list.map(s => ({ value: s.id, label: s.name }));
  const lotsOf = (item, site, { withEmpty = false } = {}) => d.lots.filter(l => l.item_id === item && l.site_id === site && (withEmpty || l.quantity > 0));
  const fillLots = (sel, item, site, first) => {
    const lots = lotsOf(item, site);
    sel.replaceChildren(...[first ? h('option', { value: '' }, first) : null, ...lots.map(l => h('option', { value: lotKey(l) }, `${lotLabel(l)} — ${fmt.num(l.quantity)} on hand`))].filter(Boolean));
    if (!first && !lots.length) sel.append(h('option', { value: '|' }, 'No lot'));
  };
  const openReceive = (pre = {}) => {
    const funds = can('budget:read') ? (state.funds || []) : [];
    const f = form([
      { name: 'item_id', label: 'Item', type: 'select', required: true, options: itemOptions(), value: pre.item_id },
      { name: 'quantity', label: 'Quantity received', type: 'number', min: 1, step: 1, required: true },
      { name: 'site_id', label: 'Received at', type: 'select', required: true, noBlank: true, options: siteOptions(), value: pre.site_id || siteId || d.my_effective_site_id },
      { name: 'received_on', label: 'Date received', type: 'date', required: true, value: fmt.today() },
      { name: 'lot_number', label: 'Lot number', maxLen: 60, help: 'As printed on the box. Leave blank if it has none.' },
      { name: 'expires_on', label: 'Expiry date', type: 'date', help: 'Stock that expires first is handed out first.' },
      { name: 'source', label: 'Where it came from', type: 'select', options: M.sources.map(s => ({ value: s.code, label: s.label })) },
      funds.length ? { name: 'funding_source_id', label: 'Paid for from (a purchase)', type: 'select', options: funds.map(x => ({ value: x.id, label: x.name })) } : null,
      { name: 'reference', label: 'Reference (order or shipment number)', maxLen: 120, help: 'No names here.' },
    ].filter(Boolean), { submitText: 'Record delivery', onCancel: () => m.close(), onSubmit: async (v) => {
      await post('/api/supplies/receipts', v).catch(onErr('The delivery could not be recorded.'));
      toast(`${itemName(v.item_id)}: ${v.quantity} received`, 'ok'); m.close(); refresh(qs());
    } });
    const m = modal('Receive stock', f);
  };
  const openTransfer = (pre = {}) => {
    const f = form([
      { name: 'item_id', label: 'Item', type: 'select', required: true, options: itemOptions(), value: pre.item_id },
      { name: 'from_site_id', label: 'From', type: 'select', required: true, noBlank: true, options: siteOptions(d.sites), value: pre.site_id || siteId || d.my_effective_site_id },
      { name: 'to_site_id', label: 'To', type: 'select', required: true, options: siteOptions() },
      { name: 'quantity', label: 'Quantity to move', type: 'number', min: 1, step: 1, required: true },
      { name: 'lot', label: 'Lot', type: 'select', options: [], help: 'Leave on "Earliest expiry first" unless you are moving a particular box.' },
      { name: 'occurred_on', label: 'Date', type: 'date', value: fmt.today() },
      { name: 'reference', label: 'Reference', maxLen: 120 },
    ], { submitText: 'Move stock', onCancel: () => m.close(), onSubmit: async (v) => {
      const body = { ...v, ...(v.lot ? fromKey(v.lot) : {}) }; delete body.lot;
      await post('/api/supplies/transfers', body).catch(onErr('The stock could not be moved.'));
      toast(`${itemName(v.item_id)}: ${v.quantity} moved to ${siteName(v.to_site_id)}`, 'ok'); m.close(); refresh(qs());
    } });
    const sync = () => fillLots(f.inputs.lot, f.inputs.item_id.value, f.inputs.from_site_id.value, 'Earliest expiry first');
    f.inputs.item_id.addEventListener('change', sync); f.inputs.from_site_id.addEventListener('change', sync); sync();
    if (pre.lot) f.inputs.lot.value = pre.lot;
    const m = modal('Move stock to another site', f);
  };
  const openAdjust = (pre = {}) => {
    const f = form([
      { name: 'item_id', label: 'Item', type: 'select', required: true, options: d.items.map(i => ({ value: i.id, label: i.name })), value: pre.item_id },
      { name: 'site_id', label: 'Site', type: 'select', required: true, noBlank: true, options: siteOptions(d.sites), value: pre.site_id || siteId || d.my_effective_site_id },
      { name: 'lot', label: 'Lot', type: 'select', options: [] },
      { name: 'reason', label: 'Reason', type: 'select', required: true, noBlank: true, options: M.adjust_reasons.map(x => ({ value: x.code, label: x.label })) },
      { name: 'counted', label: 'Counted on the shelf', type: 'number', min: 0, step: 1, help: 'For a count correction: what is actually there. SUDS records the difference.' },
      { name: 'quantity', label: 'Or the change (+ or −)', type: 'number', step: 1, help: 'Damaged, expired or lost stock is a negative number.' },
      { name: 'occurred_on', label: 'Date', type: 'date', value: fmt.today() },
    ], { submitText: 'Record adjustment', onCancel: () => m.close(), onSubmit: async (v) => {
      const body = { ...v, ...fromKey(v.lot) }; delete body.lot;
      if (body.counted === null) delete body.counted; if (body.quantity === null) delete body.quantity;
      const res = await post('/api/supplies/adjustments', body).catch(onErr('The adjustment could not be recorded.'));
      toast(`${itemName(v.item_id)}: ${signed(res.quantity)} recorded`, 'ok'); m.close(); refresh(qs());
    } });
    const sync = () => fillLots(f.inputs.lot, f.inputs.item_id.value, f.inputs.site_id.value, null);
    f.inputs.item_id.addEventListener('change', sync); f.inputs.site_id.addEventListener('change', sync); sync();
    if (pre.lot) f.inputs.lot.value = pre.lot;
    const m = modal('Adjust stock', f);
  };
  const openDispose = (l) => {
    const f = form([
      { name: 'quantity', label: `How many ${items.get(l.item_id)?.unit || ''} to dispose of`, type: 'number', min: 1, max: l.quantity, step: 1, required: true, value: l.quantity },
      { name: 'reason', label: 'Reason', type: 'select', required: true, noBlank: true, options: M.disposal_reasons.map(x => ({ value: x.code, label: x.label })), value: l.state === 'expired' ? 'expired' : undefined },
      { name: 'occurred_on', label: 'Date', type: 'date', value: fmt.today() },
    ], { submitText: 'Record disposal', onCancel: () => m.close(), onSubmit: async (v) => {
      await post('/api/supplies/disposals', { ...v, item_id: l.item_id, site_id: l.site_id, lot_number: l.lot_number, expires_on: l.expires_on }).catch(onErr('The disposal could not be recorded.'));
      toast(`${itemName(l.item_id)}: ${v.quantity} disposed of`, 'ok'); m.close(); refresh(qs());
    } });
    const m = modal(`Dispose of ${itemName(l.item_id)} (${lotLabel(l)}) at ${siteName(l.site_id)}`, f);
  };
  const openItem = (it = null) => {
    const f = form([
      { name: 'name', label: 'Item name', required: true, maxLen: 80, placeholder: 'e.g. Syringes 1 mL 29G' },
      { name: 'category', label: 'Category', type: 'select', required: true, noBlank: true, options: M.categories.map(c => ({ value: c.code, label: c.label })), help: 'Naloxone and fentanyl test strips are what the naloxone and test strip counts on every report add up.' },
      { name: 'product', label: 'Naloxone product', type: 'select', options: M.products.map(p => ({ value: p.code, label: p.label })), help: 'Naloxone only. It is carried to the NDP log.' },
      { name: 'unit', label: 'Counted in', maxLen: 30, placeholder: 'kit, strip, syringe, container…' },
      { name: 'low_stock', label: 'Running low at (per site)', type: 'number', min: 0, step: 1, help: 'Leave blank for no alert.' },
      { name: 'quick', label: 'One tap on the visit form (a usual item)', type: 'checkbox' },
      it ? { name: 'is_active', label: 'In use', type: 'checkbox', value: true } : null,
      it ? null : { name: 'opening', label: 'Quantity on the shelf now', type: 'number', min: 0, step: 1, help: `Recorded as its opening stock at ${siteName(d.settings.default_site_id)}. Receive later deliveries with Receive stock.` },
    ].filter(Boolean), { values: it || { category: 'other' }, submitText: 'Save', onCancel: () => m.close(), onSubmit: async (v) => {
      const body = { ...v }; if (body.category !== 'naloxone') body.product = null;
      if (it) await put(`/api/supplies/items/${it.id}`, body).catch(onErr('The item could not be saved.'));
      else { const o = body.opening; delete body.opening; if (o) body.opening = { quantity: o }; await post('/api/supplies/items', body).catch(onErr('The item could not be added.')); }
      toast(it ? 'Saved' : 'Item added', 'ok'); m.close(); refresh(qs());
    } });
    const m = modal(it ? `Edit ${it.name}` : 'Add a supply item', f);
  };
  const openSite = (s = null) => {
    const f = form([
      { name: 'name', label: 'Name', required: true, maxLen: 80, placeholder: 'e.g. Outreach van' },
      { name: 'kind', label: 'Kind of site', type: 'select', required: true, noBlank: true, options: M.site_kinds.map(k => ({ value: k.code, label: k.label })), value: 'van' },
      s ? { name: 'is_active', label: 'In use', type: 'checkbox', value: true } : null,
    ].filter(Boolean), { values: s || {}, submitText: s ? 'Save site' : 'Add site', onCancel: () => m.close(), onSubmit: async (v) => {
      if (s) await put(`/api/supplies/sites/${s.id}`, v).catch(onErr('The site could not be saved.')); else await post('/api/supplies/sites', v).catch(onErr('The site could not be added.'));
      toast(s ? 'Saved' : 'Site added', 'ok'); m.close(); refresh(qs());
    } });
    const m = modal(s ? `Edit ${s.name}` : 'Add a site', f);
  };

  // Hand out: supplies given to someone on the street, with or without a name. It is a visit (the visit form,
  // preset to a naloxone distribution, or outreach for other supplies: both may be anonymous), so the stock,
  // the NDP log and the funder report all count it the way they count any other visit.
  const mayHandOut = can('interventions:write');
  const handOut = async (item = null) => {
    const { openInterventionForm } = await import('./interventions.js');
    const preset = { type: !item || item.category === 'naloxone' ? 'naloxone_distribution' : 'outreach' };
    if (item) preset.supplies = [{ item_id: item.id, item: item.name, unit: item.unit, category: item.category, quantity: 1 }];
    if (siteId) preset.supply_site_id = siteId;
    openInterventionForm(null, { preset, onDone: () => refresh(qs()) });
  };
  // ---- the page ----
  const actions = [
    mayHandOut ? h('button', { class: 'btn primary', 'data-supply-hand-out': '1', onClick: () => handOut() }, 'Hand out') : null,
    can2.receive ? h('button', { class: mayHandOut ? 'btn' : 'btn primary', 'data-supply-receive': '1', onClick: () => openReceive() }, 'Receive stock') : null,
    can2.configure ? h('button', { class: 'btn', 'data-supply-add-item': '1', onClick: () => openItem() }, '+ Add item')
      // On a device that syncs with an office the button is there, switched off, with the reason beside it.
      : officeCopy && (can2.manage || can('interventions:write')) ? h('button', { class: 'btn', disabled: true, 'aria-describedby': 'supplies-office-note', title: 'Items are kept at the office' }, '+ Add item') : null,
  ];
  const siteSel = h('select', { id: 'supply-site-filter', onChange: () => nav(`supplies?tab=${tab}${siteSel.value ? `&site=${siteSel.value}` : ''}`) }, h('option', { value: '' }, 'All sites'), d.sites.map(s => h('option', { value: s.id, selected: s.id === siteId }, `${s.name}${s.is_active ? '' : ' (not in use)'}`)));
  const mySel = can2.choose_site ? h('select', { id: 'supply-my-site', 'data-my-site': '1', onChange: async () => {
    try { await put('/api/supplies/my-site', { site_id: mySel.value || null }); toast(mySel.value ? `Your visits now draw from ${siteName(mySel.value)}` : 'Your visits draw from the program\'s default site', 'ok'); } catch (e) { toast(e.message, 'error'); }
  } }, h('option', { value: '' }, `The program default (${siteName(d.settings.default_site_id)})`), activeSites.map(s => h('option', { value: s.id, selected: s.id === d.my_site_id }, s.name))) : null;
  const al = d.alerts.counts;
  const alertRow = al.expired || al.expiring || al.low || al.shortfalls ? h('div', { class: 'row mb', 'data-supply-alerts': '1' },
    al.expired ? h('a', { class: 'badge danger', href: '#/supplies?tab=lots' }, `${al.expired} expired lot${al.expired > 1 ? 's' : ''}`) : null,
    al.expiring ? h('a', { class: 'badge warn', href: '#/supplies?tab=lots' }, `${al.expiring} expiring within ${d.alerts.warn_days} days`) : null,
    al.low ? h('a', { class: 'badge warn', href: '#/supplies' }, `${al.low} running low`) : null,
    al.shortfalls ? h('a', { class: 'badge warn', href: '#/supplies?tab=history&flagged=1' }, `${al.shortfalls} shortfall${al.shortfalls > 1 ? 's' : ''} to check`) : null) : null;

  // The two items visits count for every report, when the programme keeps neither yet: added in one click
  // (with nothing on hand; Receive stock records what is on the shelf). Until then, kits and strips given out
  // on a visit are not taken off any stock, which the visit form says each time.
  const STANDARD = [['naloxone', 'Naloxone kit'], ['fentanyl_test_strips', 'Fentanyl test strips']];
  const missing = STANDARD.filter(([cat]) => !activeItems.some(i => i.category === cat)).map(([, name]) => name);
  const addStandard = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { for (const item of missing) await post('/api/supplies', { item, quantity: 0 }); toast(`Added ${missing.join(' and ')}. Record what is on the shelf with Receive stock.`, 'ok'); refresh(qs()); }
    catch (err) { btn.disabled = false; toast(err.message || 'The items could not be added.', 'error'); }
  };
  const standardBanner = missing.length && !officeCopy ? h('div', { class: 'banner info mb', 'data-supplies-missing': missing.join('|') },
    h('p', { style: { margin: 0 } }, `Visits that hand out ${missing.map(t => t.toLowerCase()).join(' or ')} take them off the stock only when there is a ${missing.map(t => `"${t}"`).join(' and a ')} item here. Until then, what visits hand out is not taken off anything.${can2.configure ? '' : ' A supervisor or administrator adds items.'}`),
    can2.configure ? h('div', { class: 'btn-row', style: { justifyContent: 'flex-start', marginTop: '.5rem' } }, h('button', { class: 'btn primary sm', type: 'button', 'data-add-standard-supplies': '1', onClick: addStandard }, missing.length === 2 ? 'Add naloxone kits and test strips' : `Add ${missing[0]}`)) : null) : null;

  let body;
  if (tab === 'stock') {
    const rows = d.items.filter(i => i.is_active || d.stock.some(x => x.item_id === i.id && x.quantity)).map(i => {
      const at = d.stock.filter(x => x.item_id === i.id && inSite(x));
      const low = d.alerts.low.filter(x => x.item_id === i.id && inSite(x));
      return { ...i, on_hand: at.reduce((n, x) => n + x.quantity, 0), at, low };
    });
    const onHandCell = (x) => flag(h('b', { 'data-qty': x.name }, fmt.num(x.on_hand)), x.low.length > 0, x.on_hand <= 0 ? 'none on hand' : `running low${x.low.length && siteId ? '' : ` at ${x.low.map(l => siteName(l.site_id)).join(', ')}`}`, x.on_hand <= 0 ? 'danger' : 'warn');
    const btns = (x) => h('div', { class: 'row nowrap' },
      mayHandOut && x.is_active ? h('button', { class: 'btn sm primary', 'aria-label': `Hand out ${x.name}`, 'data-hand-out-item': x.id, onClick: (e) => { e.stopPropagation(); handOut(x); } }, 'Hand out') : null,
      can2.receive ? h('button', { class: 'btn sm', 'aria-label': `Receive ${x.name}`, onClick: (e) => { e.stopPropagation(); openReceive({ item_id: x.id, site_id: siteId }); } }, 'Receive') : null,
      can2.manage && activeSites.length > 1 ? h('button', { class: 'btn sm ghost', 'aria-label': `Move ${x.name}`, onClick: (e) => { e.stopPropagation(); openTransfer({ item_id: x.id, site_id: siteId }); } }, 'Move') : null,
      can2.manage ? h('button', { class: 'btn sm ghost', 'aria-label': `Adjust ${x.name}`, onClick: (e) => { e.stopPropagation(); openAdjust({ item_id: x.id, site_id: siteId }); } }, 'Adjust') : null);
    body = rows.length ? table([
      { label: 'Item', render: x => [h('b', {}, x.name), h('div', { class: 'small muted' }, [labelIn(M.categories, x.category), x.product ? labelIn(M.products, x.product) : null].filter(Boolean).join(' · '))] },
      { label: 'On hand', num: true, render: onHandCell },
      { label: 'Counted in', key: 'unit' },
      siteId ? null : { label: 'By site', render: x => x.at.length ? h('span', { class: 'small' }, x.at.map(s => `${siteName(s.site_id)} ${fmt.num(s.quantity)}`).join(' · ')) : h('span', { class: 'muted small' }, 'None on hand') },
      { label: '', render: btns },
    ].filter(Boolean), rows, { compact: { primary: x => [h('span', {}, x.name), onHandCell(x)], secondary: x => [x.unit, siteId ? null : x.at.map(s => `${siteName(s.site_id)} ${fmt.num(s.quantity)}`).join(' · ')].filter(Boolean).join(' — '), onTap: can2.receive ? (x) => openReceive({ item_id: x.id, site_id: siteId }) : null } })
      : emptyState('No supply items yet', can2.configure ? 'Add the items your program hands out: naloxone by product, test strips, syringes by size, sharps containers and the rest.' : 'A supervisor adds the items your program hands out.', can2.configure ? h('button', { class: 'btn primary', onClick: () => openItem() }, '+ Add item') : null);
  } else if (tab === 'lots') {
    const rows = d.lots.filter(l => l.quantity > 0 && inSite(l)).sort((a, b) => ['expired', 'expiring', 'ok', 'no_expiry'].indexOf(a.state) - ['expired', 'expiring', 'ok', 'no_expiry'].indexOf(b.state) || String(a.expires_on || '9').localeCompare(String(b.expires_on || '9')));
    const expCell = (l) => [l.expires_on ? fmt.date(l.expires_on) : h('span', { class: 'muted' }, 'None recorded'), expiryBadge(l) ? [' ', expiryBadge(l)] : null];
    const btns = (l) => can2.manage ? h('div', { class: 'row nowrap' },
      h('button', { class: `btn sm ${l.state === 'expired' ? 'danger' : 'ghost'}`, 'aria-label': `Dispose of ${itemName(l.item_id)}, ${lotLabel(l)}, at ${siteName(l.site_id)}`, onClick: (e) => { e.stopPropagation(); openDispose(l); } }, 'Dispose'),
      activeSites.length > 1 ? h('button', { class: 'btn sm ghost', 'aria-label': `Move ${itemName(l.item_id)}, ${lotLabel(l)}`, onClick: (e) => { e.stopPropagation(); openTransfer({ item_id: l.item_id, site_id: l.site_id, lot: lotKey(l) }); } }, 'Move') : null) : null;
    body = h('div', {},
      h('p', { class: 'small muted' }, `Visits hand out the lot that expires first. Lots expiring within ${d.alerts.warn_days} days are marked; expired stock is handed out only when nothing else is on the books, and should be disposed of.`),
      rows.length ? table([
        { label: 'Item', render: l => h('b', {}, itemName(l.item_id)) }, { label: 'Site', render: l => siteName(l.site_id) }, { label: 'Lot', render: l => l.lot_number || h('span', { class: 'muted' }, 'No lot') },
        { label: 'Expires', render: expCell }, { label: 'On hand', num: true, render: l => fmt.num(l.quantity) }, { label: '', render: btns },
      ], rows, { compact: { primary: l => [h('span', {}, `${itemName(l.item_id)} · ${siteName(l.site_id)}`), h('b', {}, fmt.num(l.quantity))], secondary: l => [lotLabel(l), ' ', expiryBadge(l)], onTap: can2.manage ? openDispose : null } })
        : emptyState('No stock on hand', 'Lots appear here once stock is received.'));
  } else if (tab === 'history') {
    const flagged = r.query.get('flagged') === '1'; const kind = r.query.get('kind') || '';
    const q = `${siteId ? `site_id=${siteId}&` : ''}${flagged ? 'flagged=1&' : ''}${kind ? `kind=${kind}&` : ''}`;
    const first = await get(`/api/supplies/ledger?${q}limit=100`);
    const kindSel = h('select', { id: 'supply-kind-filter', onChange: () => nav(`supplies?${qs(`${kindSel.value ? `&kind=${kindSel.value}` : ''}${flagged ? '&flagged=1' : ''}`)}`) }, h('option', { value: '' }, 'Every kind of entry'), Object.entries(M.kinds).map(([k, v]) => h('option', { value: k, selected: k === kind }, v)));
    const what = (x) => [M.kinds[x.kind] || x.kind, x.reason ? ` — ${x.reason === 'shortfall' ? 'shortfall (more handed out than the books held)' : labelIn(x.kind === 'disposal' ? M.disposal_reasons : M.adjust_reasons, x.reason)}` : '', x.source ? ` — ${labelIn(M.sources, x.source)}` : '', x.fund_name ? ` (${x.fund_name})` : ''].join('');
    body = h('div', {},
      h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Kind'), kindSel),
        h('label', { class: 'check', style: { marginTop: 0 } }, h('input', { type: 'checkbox', checked: flagged, onChange: (e) => nav(`supplies?${qs(`${kind ? `&kind=${kind}` : ''}${e.target.checked ? '&flagged=1' : ''}`)}`) }), 'Shortfalls only')),
      h('p', { class: 'small muted' }, 'Every movement, newest first. Entries are never changed or deleted: a mistake is corrected by another entry.'),
      pagedList({ first, url: `/api/supplies/ledger?${q.replace(/&$/, '')}`, limit: 100, render: (rows) => table([
        { label: 'Date', render: x => h('span', { class: 'nowrap' }, fmt.date(x.occurred_on)) },
        { label: 'Item', render: x => h('b', {}, x.item_name) }, siteId ? null : { label: 'Site', key: 'site_name' },
        { label: 'Entry', render: x => [what(x), x.flagged ? [' ', badge('Check', 'warn')] : null] },
        { label: 'Quantity', num: true, render: x => h('span', { class: 'nowrap' }, `${signed(x.quantity)} ${x.unit}`) },
        { label: 'Lot', render: x => (x.lot_number || x.expires_on ? lotLabel(x) : '') }, { label: 'Reference', render: x => x.reference || '' }, { label: 'By', render: x => x.user_name || '' },
      ].filter(Boolean), rows, { empty: 'Nothing recorded yet.', compact: { primary: x => [h('span', {}, `${x.item_name} ${signed(x.quantity)}`), h('span', { class: 'small' }, fmt.date(x.occurred_on))], secondary: x => [what(x), siteId ? '' : ` · ${x.site_name}`, x.flagged ? ' · check' : ''].join('') } }),
      summary: (rows, total) => h('div', { class: 'muted small mb' }, `${fmt.num(total)} entr${total === 1 ? 'y' : 'ies'}`) }));
  } else if (tab === 'setup') {
    const settingsForm = can2.configure ? form([
      { name: 'default_site_id', label: 'Default site', type: 'select', noBlank: true, options: siteOptions(), value: d.settings.default_site_id, help: 'Where a visit\'s supplies come from when the worker has not chosen a site of their own.' },
      { name: 'expiry_warn_days', label: 'Warn about expiry this many days ahead', type: 'number', min: 1, max: 365, step: 1, value: d.settings.expiry_warn_days },
      { name: 'syringes_per_litre', label: 'Syringes per litre of returned sharps', type: 'number', min: 1, max: 1000, step: 1, value: d.settings.syringes_per_litre, help: 'Your program\'s own conversion, used when a return is estimated from the container\'s volume instead of counted.' },
    ], { submitText: 'Save settings', onSubmit: async (v) => { await put('/api/supplies/settings', v).catch(onErr('The settings could not be saved.')); toast('Saved', 'ok'); refresh('tab=setup'); } }) : null;
    body = h('div', {},
      !can2.configure ? h('div', { class: 'banner info small', 'data-supplies-office': '1' }, 'Items, sites and supply settings are kept at the office: change them in the office SUDS. Stock you receive, move or count here is sent there when you sync.') : null,
      h('section', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h2', {}, 'Items'), can2.configure ? h('button', { class: 'btn sm', onClick: () => openItem() }, '+ Add item') : null),
        d.items.length ? table([
          { label: 'Item', render: i => [h('b', {}, i.name), i.is_active ? null : [' ', badge('Not in use', '')]] }, { label: 'Category', render: i => labelIn(M.categories, i.category) },
          { label: 'Product', render: i => (i.product ? labelIn(M.products, i.product) : '') }, { label: 'Counted in', key: 'unit' }, { label: 'Usual', render: i => (i.quick ? 'Yes' : '') },
          { label: 'Low at', num: true, render: i => (i.low_stock === null ? '' : fmt.num(i.low_stock)) },
          { label: '', render: i => can2.configure ? h('button', { class: 'btn sm ghost', 'aria-label': `Edit ${i.name}`, onClick: () => openItem(i) }, 'Edit') : null },
        ], d.items, { wrap: true }) : h('p', { class: 'muted' }, 'No items yet.')),
      h('section', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h2', {}, 'Sites'), can2.configure ? h('button', { class: 'btn sm', onClick: () => openSite() }, '+ Add site') : null),
        table([
          { label: 'Site', render: s => [h('b', {}, s.name), s.is_active ? null : [' ', badge('Not in use', '')], s.id === d.settings.default_site_id ? [' ', badge('Default', 'info')] : null] },
          { label: 'Kind', render: s => labelIn(M.site_kinds, s.kind) },
          { label: '', render: s => can2.configure ? h('button', { class: 'btn sm ghost', 'aria-label': `Edit ${s.name}`, onClick: () => openSite(s) }, 'Edit') : null },
        ], d.sites)),
      settingsForm ? h('section', { class: 'card' }, h('h2', {}, 'Settings'), settingsForm) : null);
  } else if (tab === 'ssp') {
    const [lf, lt] = lastMonth();
    const from = r.query.get('from') || lf; const to = r.query.get('to') || lt;
    const fromI = h('input', { type: 'date', value: from }); const toI = h('input', { type: 'date', value: to });
    const rep = await get(`/api/reports/ssp?from=${from}&to=${to}`);
    const t = rep.totals;
    const ratio = (x) => (x === null || x === undefined ? '—' : x.toFixed(2));
    const monthCols = [{ label: 'Contacts', key: 'contacts', num: true }, { label: 'Anonymous', key: 'anonymous_contacts', num: true }, { label: 'Syringes out', key: 'syringes_distributed', num: true }, { label: 'Returned', key: 'syringes_returned', num: true }, { label: 'Returned per syringe', num: true, render: x => ratio(x.return_ratio) }, { label: 'Naloxone kits', key: 'naloxone_kits', num: true }];
    const file = (fmtX) => downloadCsv(`/api/reports/ssp/export?from=${from}&to=${to}${fmtX ? '&format=xlsx' : ''}`);
    body = h('div', { 'data-ssp-report': '1' },
      h('h2', {}, 'Syringe services program report'),
      h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI),
        h('button', { class: 'btn', onClick: () => nav(`supplies?tab=ssp&from=${fromI.value}&to=${toI.value}`) }, 'Apply'),
        can('export:read') ? [h('button', { class: 'btn', 'data-ssp-export': 'xlsx', onClick: () => file(true) }, 'Excel'), h('button', { class: 'btn ghost', 'data-ssp-export': 'csv', onClick: () => file(false) }, 'CSV')] : null),
      runKindBanner(rep),
      rep.caseload_scope_note ? h('p', { class: 'small muted' }, rep.caseload_scope_note) : null,
      h('div', { class: 'grid cols-4 mb' }, stat('Participants served', typeof t.participants === 'number' ? fmt.num(t.participants) : t.participants), stat('Contacts', fmt.num(t.contacts)), stat('Syringes distributed', fmt.num(t.syringes_distributed)),
        stat('Syringes returned', fmt.num(t.syringes_returned)), stat('Returned per syringe distributed', ratio(t.return_ratio)), stat('Sharps containers given', fmt.num(t.sharps_containers)),
        stat('Naloxone kits', fmt.num(t.naloxone_kits)), stat('Fentanyl test strips', fmt.num(t.fentanyl_strips)), stat('Referrals made', typeof t.referrals === 'number' ? fmt.num(t.referrals) : t.referrals)),
      h('p', { class: 'small muted' }, `${rep.returns_note} ${t.syringes_returned_estimated ? `${fmt.num(t.syringes_returned_estimated)} of the ${fmt.num(t.syringes_returned)} returned were estimated.` : ''}`),
      h('section', { class: 'card mb' }, h('h2', {}, 'By month'), table([{ label: 'Month', key: 'month' }, ...monthCols], rep.by_month, { empty: 'No contacts in this period.' })),
      h('section', { class: 'card mb' }, h('h2', {}, 'By site'), table([{ label: 'Site', key: 'site' }, ...monthCols], rep.by_site, { empty: 'No contacts in this period.' })),
      h('div', { class: 'grid cols-2' },
        h('section', { class: 'card' }, h('h2', {}, 'Supplies given'), table([{ label: 'Item', key: 'item' }, { label: 'Category', key: 'category_label' }, { label: 'Quantity', num: true, render: x => `${fmt.num(x.quantity)} ${x.unit}` }], rep.by_item, { empty: 'None recorded by item in this period.' })),
        h('section', { class: 'card' }, h('h2', {}, 'Naloxone by product'), table([{ label: 'Product', key: 'label' }, { label: 'Kits', key: 'kits', num: true }], rep.naloxone_by_product, { empty: 'No naloxone in this period.' }))),
      h('p', { class: 'small muted mt' }, rep.template_note));
  }

  return h('div', {},
    pageHead('Supplies', ...actions),
    officeCopy ? h('div', { class: 'banner info small', id: 'supplies-office-note', 'data-supplies-office': '1' }, 'Items and sites are kept at the office: add or change them in the office SUDS. Deliveries, moves and counts you record here are sent there when you sync, and visits you record here draw the office stock down.') : null,
    alertRow,
    standardBanner,
    h('div', { class: 'filters' },
      tab !== 'setup' && tab !== 'ssp' ? h('div', { class: 'field' }, h('label', {}, 'Site'), siteSel) : null,
      mySel && tab === 'stock' ? h('div', { class: 'field' }, h('label', {}, 'Your visits draw from'), mySel) : null),
    pageTabs(tabs, tab, (k) => nav(`supplies?tab=${k}${siteId && k !== 'setup' && k !== 'ssp' ? `&site=${siteId}` : ''}`), { label: 'Supplies sections' }),
    body);
});
