// Harm-reduction supply cupboard: what is on the shelf right now. Visits that hand out naloxone kits or
// test strips take them off these counts automatically (server/routes/supplies.js); deliveries and
// stock-takes are recorded here.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, confirmDialog, nav, emptyState } from '../app.js';

const LOW = 5;

route('supplies', async () => {
  const { rows, drawdown } = await get('/api/supplies');
  const refresh = () => nav('supplies?_=' + Date.now());
  const writable = can('interventions:write');
  const tracked = Object.values(drawdown || {});
  const addItem = () => {
    const f = form([
      { name: 'item', label: 'Item', required: true, placeholder: 'e.g. Naloxone kit', help: `Name it "${tracked[0]}" or "${tracked[1]}" and visits draw it down automatically.` },
      { name: 'quantity', label: 'Quantity on hand', type: 'number', min: 0, step: 1, required: true, value: 0 },
    ], { submitText: 'Save', onCancel: () => m.close(), onSubmit: async (d) => { await post('/api/supplies', d); toast('Saved', 'ok'); m.close(); refresh(); } });
    const m = modal('Add a supply item', f);
  };
  const adjust = async (x, delta) => {
    try { const r = await put(`/api/supplies/${x.id}`, { adjust: delta }); toast(`${x.item}: ${r.quantity} on hand`, 'ok'); refresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const setCount = (x) => {
    const f = form([{ name: 'quantity', label: `${x.item} — counted on the shelf`, type: 'number', min: 0, step: 1, required: true, value: x.quantity }], { submitText: 'Record count', onCancel: () => m.close(), onSubmit: async (d) => { await put(`/api/supplies/${x.id}`, { quantity: d.quantity }); toast('Count recorded', 'ok'); m.close(); refresh(); } });
    const m = modal('Stock-take', f);
  };
  return h('div', {},
    pageHead('Supplies', writable ? h('button', { class: 'btn primary', onClick: addItem }, '+ Add item') : null),
    h('p', { class: 'muted small' }, `Recording a visit with naloxone kits or fentanyl test strips takes them off "${tracked.join('" and "')}" here, so this is what is actually left. ${writable ? 'Use + / − for a delivery or a hand-out that was not logged as a visit, and Stock-take after counting the shelf.' : ''}`),
    rows.length ? table([
      { label: 'Item', render: x => [h('b', {}, x.item), tracked.some(t => t.toLowerCase() === x.item.toLowerCase()) ? [' ', badge('auto', 'info')] : null] },
      { label: 'On hand', render: x => [h('b', { 'data-qty': x.item }, fmt.num(x.quantity)), x.quantity <= LOW ? [' ', badge(x.quantity === 0 ? 'Out' : 'Low', 'danger')] : null], num: true },
      { label: 'Last updated', render: x => `${fmt.dt(x.updated_at)}${x.updated_by_name ? ' · ' + x.updated_by_name : ''}` },
      { label: '', render: x => writable ? h('div', { class: 'row nowrap' },
        h('button', { class: 'btn sm', 'aria-label': `One fewer ${x.item}`, onClick: () => adjust(x, -1) }, '−'),
        h('button', { class: 'btn sm', 'aria-label': `One more ${x.item}`, onClick: () => adjust(x, 1) }, '+'),
        h('button', { class: 'btn sm', onClick: () => adjust(x, 10) }, '+10'),
        h('button', { class: 'btn sm ghost', onClick: () => setCount(x) }, 'Stock-take'),
        h('button', { class: 'btn sm ghost', 'aria-label': `Remove ${x.item}`, onClick: async () => { if (await confirmDialog('Remove item', `Stop tracking ${x.item}?`, { danger: true, okText: 'Remove' })) { await del(`/api/supplies/${x.id}`); refresh(); } } }, '✕')) : null },
    ], rows, { empty: 'Nothing tracked yet.', compact: { primary: x => [h('span', {}, x.item), h('b', {}, fmt.num(x.quantity), x.quantity <= LOW ? [' ', badge(x.quantity === 0 ? 'Out' : 'Low', 'danger')] : null)], secondary: x => `updated ${fmt.ago(x.updated_at)}`, onTap: writable ? (x) => setCount(x) : null } })
      : emptyState('No supplies tracked yet', writable ? `Add "${tracked[0]}" and "${tracked[1]}" to have visits draw them down automatically.` : 'Field staff will add the cupboard here.', writable ? h('button', { class: 'btn primary', onClick: addItem }, '+ Add item') : null));
});
