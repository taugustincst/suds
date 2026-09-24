// The report a funder actually asks for. Every count here is unduplicated — people, not services — which
// the platform previously could not produce: it could say "1,400 services" but not "310 people".
import { h, route, get, state, fmt, can, pageHead, bars, stat, table, downloadCsv, nav, emptyState } from '../app.js';

const num = (n) => Number(n || 0).toLocaleString();

route('funder', async (r) => {
  const to = r.query.get('to') || fmt.today();
  const from = r.query.get('from') || `${to.slice(0, 4)}-01-01`;
  const fund = r.query.get('funding_source_id') || '';
  const d = await get(`/api/reports/funder?from=${from}&to=${to}${fund ? `&funding_source_id=${fund}` : ''}`);

  const fromI = h('input', { type: 'date', value: from, 'aria-label': 'From' });
  const toI = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  const fundI = h('select', { 'aria-label': 'Funding source' },
    h('option', { value: '' }, 'All funding sources'),
    state.funds.map(f => h('option', { value: f.id, selected: f.id === fund }, f.name)));

  // Fiscal-year shortcuts, because that is the period a grant report covers.
  const fy = (startMonth) => {
    const now = new Date();
    const y = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
    const s = `${y}-${String(startMonth).padStart(2, '0')}-01`;
    const e = new Date(Date.UTC(y + 1, startMonth - 1, 0)).toISOString().slice(0, 10);
    return [s, e];
  };

  const u = d.unduplicated;
  const admitRate = u.with_a_referral ? Math.round((u.admitted_after_referral / u.with_a_referral) * 100) : null;

  return h('div', {},
    pageHead('Funder report',
      can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/workbook?from=${from}&to=${to}`) }, 'Export everything to Excel') : null),
    h('p', { class: 'muted' }, 'Counts of people, each counted once however many times they were served. This is the shape most grant and CalOMS reporting asks for.',
      d.small_cell_threshold ? ` Breakdown rows with fewer than ${d.small_cell_threshold} people are shown as "<${d.small_cell_threshold}" so nobody can be picked out of a small group; totals are exact.` : ''),

    h('div', { class: 'filters' },
      h('div', { class: 'field' }, h('label', {}, 'From'), fromI),
      h('div', { class: 'field' }, h('label', {}, 'To'), toI),
      h('div', { class: 'field' }, h('label', {}, 'Funding source'), fundI),
      h('button', { class: 'btn primary', onClick: () => nav(`funder?from=${fromI.value}&to=${toI.value}${fundI.value ? `&funding_source_id=${fundI.value}` : ''}`) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { const [s, e] = fy(7); nav(`funder?from=${s}&to=${e}`); } }, 'Fiscal year (Jul–Jun)'),
      h('button', { class: 'btn ghost sm', onClick: () => { const [s, e] = fy(10); nav(`funder?from=${s}&to=${e}`); } }, 'Fiscal year (Oct–Sep)'),
      h('button', { class: 'btn ghost sm', onClick: () => nav(`funder?from=${to.slice(0, 4)}-01-01&to=${to}`) }, 'Calendar year')),

    h('section', { class: 'card' },
      h('h2', {}, 'People served'),
      h('p', { class: 'small muted' }, `Between ${fmt.date(from)} and ${fmt.date(to)}${fund ? `, charged to ${state.funds.find(f => f.id === fund)?.name || 'the selected fund'}` : ''}.`),
      h('div', { class: 'grid cols-4' },
        stat('Unduplicated clients served', num(u.served)),
        stat('New admissions', num(u.new_admissions)),
        stat('Received a referral', num(u.with_a_referral)),
        stat('Admitted after a referral', num(u.admitted_after_referral), admitRate !== null && admitRate < 40 ? 'warn' : ''),
        stat('On medication for opioid use disorder', num(u.on_mat)),
        stat('Episodes opened', num(d.episodes.admissions)),
        stat('Episodes closed', num(d.episodes.discharges)),
        stat('Open at end of period', num(d.episodes.open_at_end))),
      admitRate !== null ? h('p', { class: 'small muted' }, `${admitRate}% of the people referred in this period were admitted somewhere — the question "did our warm handoffs actually land?" in one number.`) : null),

    h('section', { class: 'card' },
      h('h2', {}, 'Overdose & naloxone'),
      h('div', { class: 'grid cols-4' },
        stat('Overdose events recorded', num(d.overdose.events)),
        stat('Reversed with naloxone', num(d.overdose.reversals), 'ok'),
        stat('Fatal', num(d.overdose.fatal), d.overdose.fatal ? 'danger' : ''),
        stat('Reported from the community', num(d.overdose.community_reported)),
        stat('Naloxone doses used', num(d.overdose.naloxone_doses)),
        stat('Naloxone kits distributed', num(d.naloxone_distribution.kits)),
        stat('— of those, community distribution', num(d.naloxone_distribution.community_kits)),
        stat('Fentanyl test strips', num(d.naloxone_distribution.strips))),
      d.overdose.by_administered_by.length ? h('div', { class: 'grid cols-2 mt' },
        h('div', {}, h('h3', {}, 'Who gave the naloxone'), bars(d.overdose.by_administered_by, { valueKey: 'n', labelKey: 'k', list: 'ADMINISTERED_BY' })),
        h('div', {}, h('h3', {}, 'By month'), bars(d.overdose.by_month.map(x => ({ k: x.month, n: x.n })), { valueKey: 'n', labelKey: 'k' }))) : null),

    h('section', { class: 'card' },
      h('h2', {}, 'Who was served'),
      h('p', { class: 'small muted' }, 'Each person counted once. Race is recorded as codes a funder can count; because people may report more than one, those figures add up to more than the number served.'),
      h('div', { class: 'grid cols-3' },
        h('div', {}, h('h3', {}, 'Race'), bars(d.demographics.by_race_code, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h3', {}, 'Ethnicity'), bars(d.demographics.by_ethnicity, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h3', {}, 'Gender'), bars(d.demographics.by_gender, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h3', {}, 'Language'), bars(d.demographics.by_language, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h3', {}, 'Housing'), bars(d.demographics.by_housing, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h3', {}, 'Insurance'), bars(d.demographics.by_insurance, { valueKey: 'n', labelKey: 'k' })))),

    h('section', { class: 'card' },
      h('h2', {}, 'Discharges'),
      d.episodes.median_length_of_stay_days !== null
        ? h('p', {}, `Median length of stay: ${d.episodes.median_length_of_stay_days} days.`)
        : h('p', { class: 'muted' }, 'No episodes were closed in this period.'),
      d.episodes.by_discharge_reason.length
        ? bars(d.episodes.by_discharge_reason, { valueKey: 'n', labelKey: 'k', list: 'DISCHARGE_REASONS' })
        : emptyState('Nothing to show', 'Discharge reasons appear here once episodes are closed. Close an episode from a client\'s Episodes tab.')),

    h('section', { class: 'card' },
      h('h2', {}, 'By funding source'),
      table([
        { label: 'Fund', key: 'name' },
        { label: 'Grant number', render: f => f.grant_number || '—' },
        { label: 'Fiscal year', render: f => [f.fiscal_year_start, f.fiscal_year_end].filter(Boolean).map(fmt.date).join(' – ') || '—' },
        { label: 'People served', render: f => num(f.clients_served), num: true },
        { label: 'Services', render: f => num(f.services), num: true },
        { label: 'Approved staff hours', render: f => (f.approved_minutes / 60).toFixed(1), num: true },
      ], d.by_funding_source, { empty: 'No active funding sources.' }),
      h('p', { class: 'small muted' }, 'Staff hours count only time that has been approved, so this matches what a county would invoice.')));
});
