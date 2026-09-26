// Harm-reduction supply cupboard: what is on the shelf right now. Visits that hand out naloxone kits or
// test strips take them off these counts automatically (server/routes/supplies.js); deliveries and
// stock-takes are recorded here.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, confirmDialog, nav, emptyState } from '../app.js';

const LOW = 5;

route('supplies', async () => {
  const { rows, drawdown } = await get('/api/supplies');
  const refresh = () => nav('supplies?_=' + Date.now());
  // A device that syncs with an office shows the office's shelf count: a change made here would never be
  // sent and is refused (local/kernel.js), so the buttons are there but disabled, with the reason given,
  // rather than failing on Save. SUDS on this device (no office) keeps its own cupboard.
  const officeCopy = state.local && !window.SUDS_STATIC_HOST;
  const writable = can('interventions:write') && !officeCopy;
  const whyNot = 'Supply counts are kept at the office: change them in the office SUDS. Visits you record here draw the office count down when you sync.';
  const off = (attrs) => officeCopy && can('interventions:write') ? { ...attrs, disabled: true, title: whyNot, 'aria-describedby': 'supplies-office-note' } : attrs;
  const tracked = Object.values(drawdown || {});
  const addItem = () => {
    const f = form([
      { name: 'item', label: 'Item', required: true, placeholder: 'e.g. Naloxone kit', help: `Name it "${tracked[0]}" or "${tracked[1]}" and visits draw it down automatically.` },
      { name: 'quantity', label: 'Quantity on hand', type: 'number', min: 0, step: 1, required: true, value: 0 },
    ], { submitText: 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
      // The error also goes in a toast: the dialog's own banner can be above where a phone has scrolled.
      try { await post('/api/supplies', d); } catch (e) { toast(e.message || 'The item could not be saved.', 'error'); throw e; }
      toast('Saved', 'ok'); m.close(); refresh();
    } });
    const m = modal('Add a supply item', f);
  };
  // The two items visits draw down, when the cupboard has not got them yet: added in one click (with 0 on
  // hand; + / Stock-take records what is on the shelf). Until then, kits and strips given out on a visit are
  // not taken off any count, which the visit form says each time.
  const missing = tracked.filter(t => !rows.some(x => x.item.toLowerCase() === t.toLowerCase()));
  const addStandard = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { for (const item of missing) await post('/api/supplies', { item, quantity: 0 }); toast(`Added ${missing.join(' and ')}. Record what is on the shelf with Stock-take.`, 'ok'); refresh(); }
    catch (err) { btn.disabled = false; toast(err.message || 'The items could not be added.', 'error'); }
  };
  const standardBanner = missing.length ? h('div', { class: 'banner info mb', 'data-supplies-missing': missing.join('|') },
    h('p', { style: { margin: 0 } }, `Visits that hand out ${missing.map(t => t.toLowerCase()).join(' or ')} take them off the count only when there is an item named "${missing.join('" and "')}" here. Until it is added, what visits hand out is not taken off anything.`),
    writable ? h('div', { class: 'btn-row', style: { justifyContent: 'flex-start', marginTop: '.5rem' } }, h('button', { class: 'btn primary sm', type: 'button', 'data-add-standard-supplies': '1', onClick: addStandard }, missing.length === 2 ? 'Add naloxone kits and test strips' : `Add ${missing[0]}`)) : null) : null;
  const adjust = async (x, delta) => {
    try { const r = await put(`/api/supplies/${x.id}`, { adjust: delta }); toast(`${x.item}: ${r.quantity} on hand`, 'ok'); refresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const setCount = (x) => {
    const f = form([{ name: 'quantity', label: `${x.item} — counted on the shelf`, type: 'number', min: 0, step: 1, required: true, value: x.quantity }], { submitText: 'Record count', onCancel: () => m.close(), onSubmit: async (d) => { try { await put(`/api/supplies/${x.id}`, { quantity: d.quantity }); } catch (e) { toast(e.message || 'The count could not be saved.', 'error'); throw e; } toast('Count recorded', 'ok'); m.close(); refresh(); } });
    const m = modal('Stock-take', f);
  };
  return h('div', {},
    pageHead('Supplies', writable || officeCopy && can('interventions:write') ? h('button', off({ class: 'btn primary', onClick: addItem }), '+ Add item') : null),
    officeCopy ? h('div', { class: 'banner info small', id: 'supplies-office-note', 'data-supplies-office': '1' }, whyNot) : null,
    officeCopy ? null : standardBanner,
    h('p', { class: 'muted small' }, `Recording a visit with naloxone kits or fentanyl test strips takes them off "${tracked.join('" and "')}" here, so this is what is actually left. ${writable ? 'Use + / − for a delivery or a hand-out that was not logged as a visit, and Stock-take after counting the shelf.' : ''}`),
    rows.length ? table([
      { label: 'Item', render: x => [h('b', {}, x.item), tracked.some(t => t.toLowerCase() === x.item.toLowerCase()) ? [' ', badge('auto', 'info')] : null] },
      { label: 'On hand', render: x => [h('b', { 'data-qty': x.item }, fmt.num(x.quantity)), x.quantity <= LOW ? [' ', badge(x.quantity === 0 ? 'Out' : 'Low', 'danger')] : null], num: true },
      { label: 'Last updated', render: x => `${fmt.dt(x.updated_at)}${x.updated_by_name ? ' · ' + x.updated_by_name : ''}` },
      { label: '', render: x => officeCopy && can('interventions:write') ? h('div', { class: 'row nowrap' },
        h('button', off({ class: 'btn sm', 'aria-label': `One fewer ${x.item}` }), '−'), h('button', off({ class: 'btn sm', 'aria-label': `One more ${x.item}` }), '+'), h('button', off({ class: 'btn sm ghost' }), 'Stock-take'))
        : writable ? h('div', { class: 'row nowrap' },
        h('button', { class: 'btn sm', 'aria-label': `One fewer ${x.item}`, onClick: () => adjust(x, -1) }, '−'),
        h('button', { class: 'btn sm', 'aria-label': `One more ${x.item}`, onClick: () => adjust(x, 1) }, '+'),
        h('button', { class: 'btn sm', onClick: () => adjust(x, 10) }, '+10'),
        h('button', { class: 'btn sm ghost', onClick: () => setCount(x) }, 'Stock-take'),
        h('button', { class: 'btn sm ghost', 'aria-label': `Remove ${x.item}`, onClick: async () => { if (await confirmDialog('Remove item', `Stop tracking ${x.item}?`, { danger: true, okText: 'Remove' })) { await del(`/api/supplies/${x.id}`); refresh(); } } }, '✕')) : null },
    ], rows, { empty: 'Nothing tracked yet.', compact: { primary: x => [h('span', {}, x.item), h('b', {}, fmt.num(x.quantity), x.quantity <= LOW ? [' ', badge(x.quantity === 0 ? 'Out' : 'Low', 'danger')] : null)], secondary: x => `updated ${fmt.ago(x.updated_at)}`, onTap: writable ? (x) => setCount(x) : null } })
      : emptyState('No supplies tracked yet', writable ? `Add "${tracked[0]}" and "${tracked[1]}" to have visits draw them down automatically.` : 'Field staff will add the cupboard here.', writable ? h('button', { class: 'btn primary', onClick: addItem }, '+ Add item') : null));
});
