// A client record's History tab (1.17.0, server/client-revisions.js): every change to the record's own details --
// who made it, when, how it arrived, and each field's value before and after -- newest first, with "Put this change
// back" for the primary worker and supervisors. Putting one back is a new change; nothing here is ever removed.
// Shown to the care team and records:manage-others (the record's `history.read`); on a device that syncs with an
// office the history is the office's, and the tab says so.
import { h, get, post, state, toast, table, badge, fmt, confirmDialog } from '../app.js';
import { clientFields, yesNoAsked } from './clients.js';

/** How a stored value reads: the form's own wording for a choice, Yes/No for a yes/no, a date as a date. */
function reader() {
  let fields = [];
  try { fields = clientFields(state.constants || {}, { isNew: false }).filter(f => f.name); } catch { fields = []; }
  const byName = new Map(fields.map(f => [f.name, f]));
  // Discharge date and reason are on the Episodes tab for most records, so the form may not list them.
  const extra = { discharge_reason: { type: 'select', list: 'DISCHARGE_REASONS' }, discharge_date: { type: 'date' } };
  const label = (ch) => (byName.get(ch.field) || {}).label || ch.label;
  const show = (field, v) => {
    const f = byName.get(field) || extra[field] || {};
    if (v === null || v === undefined || v === '') return h('span', { class: 'muted' }, f.placeholder === 'Not asked' ? 'Not asked' : '(blank)');
    if (f.type === 'checkbox') return v ? 'Yes' : 'No';
    if (f.placeholder === 'Not asked') return yesNoAsked(Number(v));
    if (f.type === 'date') return fmt.date(v);
    if (f.type === 'select') {
      if (f.list) return fmt.label(v, f.list);
      const o = (f.options || []).find(x => (typeof x === 'object' ? String(x.value) : x) === String(v));
      return o && typeof o === 'object' ? o.label : fmt.label(v);
    }
    return String(v);
  };
  return { label, show };
}

const VIA = { sync: ['From a device', 'info'], merge: ['Filled in by a merge', 'purple'] };

/** The History tab: `c` is the record (GET /api/clients/:id), `highlight` the revisions a change notice links to. */
export async function historyTab(id, c, { refresh, highlight = [] } = {}) {
  const access = c.history || {};
  const intro = h('p', { class: 'small muted' }, 'Each change to this client\'s details: who made it, when, and what each field held before and after. Putting a change back is recorded as a new change; nothing here is ever removed.');
  if (access.office_only) {
    return h('div', { class: 'card', 'data-client-history': 'office' }, h('h2', {}, 'Changes to this record'),
      h('p', { class: 'banner info', role: 'status' }, 'A client\'s change history is kept at the office, not on this device. Open this record in the office SUDS to see what changed or to put a change back.'));
  }
  let d;
  try { d = await get(`/api/clients/${id}/history`); }
  catch (e) { return h('div', { class: 'card', 'data-client-history': 'refused' }, h('h2', {}, 'Changes to this record'), h('p', { class: 'banner info', role: 'status' }, e.message || 'The history could not be loaded.')); }
  const { label, show } = reader();
  const marked = new Set(highlight);
  const byId = new Map(d.revisions.map(r => [r.id, r]));
  const revert = async (r) => {
    const names = r.changes.map(label).join(', ');
    if (!(await confirmDialog('Put this change back?', `${names} will go back to what ${r.changes.length === 1 ? 'it' : 'they'} held before ${r.by}'s change on ${fmt.dt(r.at)}. This is saved as a new change, and the history keeps both.`, { okText: 'Put it back' }))) return;
    try {
      await post(`/api/clients/${id}/history/${r.id}/revert`, { if_updated_at: c.updated_at });
      toast('Change put back', 'ok'); refresh && refresh();
    } catch (e) {
      // Some of its fields were changed again since (named by the server): the rest can still go back on their own.
      const rest = (e.data && e.data.revertible) || [];
      if (e.status === 409 && e.data && e.data.changed_since && rest.length) {
        const others = rest.map(x => label(x)).join(', ');
        if (!(await confirmDialog('Put back the other fields?', `${e.message} Put back ${others} now?`, { okText: `Put back ${rest.length === 1 ? 'that field' : 'those fields'}` }))) return;
        try {
          const fresh = (await get(`/api/clients/${id}`)).client;
          await post(`/api/clients/${id}/history/${r.id}/revert`, { fields: rest.map(x => x.field), if_updated_at: fresh.updated_at });
          toast(`${others} put back`, 'ok'); refresh && refresh();
        } catch (e2) { toast(e2.message || 'The change could not be put back', 'error'); }
        return;
      }
      toast(e.message || 'The change could not be put back', 'error');
    }
  };
  const entry = (r) => {
    const when = fmt.dt(r.at);
    const headId = `rev-${r.id}`;
    const tags = [
      VIA[r.via] ? badge(...VIA[r.via]) : null,
      r.reverts ? badge('Put back an earlier change', 'ok') : null,
      r.reverted_by && r.reverted_by.length ? badge('Put back later', 'warn') : null,
      marked.has(r.id) ? badge('From your notice', 'info') : null,
    ].filter(Boolean);
    const earlier = r.reverts && byId.get(r.reverts);
    return h('li', { class: `card rev-entry${marked.has(r.id) ? ' rev-highlight' : ''}`, 'data-revision': r.id, tabindex: marked.has(r.id) ? '-1' : null },
      h('div', { class: 'card-head' }, h('h3', { id: headId }, `${r.by} · ${when}`), tags.length ? h('div', { class: 'row' }, tags) : null),
      earlier ? h('p', { class: 'small muted' }, `Put back the change ${earlier.by} made on ${fmt.dt(earlier.at)}.`) : null,
      table([{ label: 'Field', render: ch => label(ch) }, { label: 'Before', render: ch => show(ch.field, ch.before) }, { label: 'After', render: ch => show(ch.field, ch.after) }], r.changes, { empty: 'No fields recorded.' }),
      d.may_revert && !(r.reverted_by && r.reverted_by.length) ? h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn sm', 'data-revert': r.id, 'aria-describedby': headId, onClick: () => revert(r) }, 'Put this change back')) : null);
  };
  const list = d.revisions.length ? h('ol', { class: 'rev-list', 'aria-label': 'Changes, newest first' }, d.revisions.map(entry))
    : h('p', { class: 'muted', 'data-history-empty': '1' }, 'No changes recorded yet. Changes made from 1.17.0 on appear here; earlier values were not kept.');
  const view = h('div', { 'data-client-history': 'list' }, h('div', { class: 'card' }, h('h2', {}, 'Changes to this record'), intro,
    d.may_revert ? null : h('p', { class: 'small muted' }, 'Only the primary worker, a supervisor or an administrator can put a change back.')), list);
  // Opened from a change notice ("See what changed"): the change it reports is brought into view and focused.
  if (marked.size) setTimeout(() => { const el = view.querySelector('.rev-highlight'); if (el) { el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); } }, 0);
  return view;
}
