'use strict';
// The prevention activity summary (1.17.0, docs/USER_GUIDE.md "Prevention"): group and community prevention
// events for a period — SABG primary prevention — totalled by CSAP strategy, by IOM population category, by the
// two together and by kind of event, with hours, attendance and the people trained (the attendance of the
// period's training events).
//
// What it is not: it is not a PPSDS submission file. SUDS has not mapped these fields to the Primary Prevention
// Substance Use Disorder Data Service (PPSDS), because that mapping has to follow the DHCS PPSDS data dictionary,
// which SUDS does not yet have; until then the summary is the programme's own record to key from (the export
// says so on its About sheet). Nothing here is about a person: attendance is a headcount of a group, with no
// names, no client and no demographic breakdown, so there are no people to protect with small-cell suppression,
// and it is never a publication release. It is run by anyone who may read reports (reports:read) and exported by
// anyone who may export (export:read); each run and export is audited.
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const O = require('./options');

const NAME = 'Prevention activity summary';
const PPSDS_NOTE = 'This is the program\'s own summary of its prevention events. It is not a PPSDS submission file: the mapping of these fields to the PPSDS data dictionary has not been done, and awaits the DHCS PPSDS data dictionary. Check the figures against your current SABG prevention reporting requirements before keying them.';
const COUNT_NOTE = 'Attendance is the number of people who came to, or were reached by, each event (estimated where marked), added up across events: someone who came to two events is counted twice. People trained is the attendance of the period\'s training events.';

const round2 = (x) => Math.round(x * 100) / 100;
const empty = () => ({ events: 0, hours: 0, attendance: 0 });
const add = (b, e) => { b.events++; b.hours += Number(e.hours) || 0; b.attendance += Number(e.attendance) || 0; };
const fix = (b) => ({ ...b, hours: round2(b.hours) });

/** The period's figures: every event whose date is in [from, to] (dates are calendar days). */
function figures({ from, to }) {
  const events = db.all(`SELECT event_type, strategy, iom_category, audience, hours, attendance, attendance_estimated FROM prevention_events WHERE event_date BETWEEN ? AND ?`, from, to);
  const t = { ...empty(), attendance_estimated: 0, people_trained: 0, training_events: 0 };
  const by = { strategy: new Map(), iom: new Map(), type: new Map(), audience: new Map(), cross: new Map() };
  const into = (m, k) => { if (!m.has(k)) m.set(k, empty()); return m.get(k); };
  for (const e of events) {
    add(t, e);
    if (e.attendance_estimated) t.attendance_estimated += Number(e.attendance) || 0;
    if (e.event_type === 'training') { t.training_events++; t.people_trained += Number(e.attendance) || 0; }
    add(into(by.strategy, e.strategy), e); add(into(by.iom, e.iom_category), e); add(into(by.type, e.event_type), e);
    add(into(by.audience, e.audience || ''), e); add(into(by.cross, `${e.strategy}|${e.iom_category}`), e);
  }
  // The national categories are listed whole, zeros included, in the programme's order (a report that leaves a
  // strategy out reads as though it was forgotten); a code no longer on the list but still on an event is kept.
  const listed = (key, m) => {
    const codes = [...O.known(key)]; for (const k of m.keys()) if (k && !codes.includes(k)) codes.push(k);
    return codes.map(code => ({ code, label: O.labelOf(key, code), ...fix(m.get(code) || empty()) }));
  };
  const used = (key, m) => [...m].map(([code, b]) => ({ code: code || null, label: code ? O.labelOf(key, code) : 'Not recorded', ...fix(b) })).sort((a, b) => b.attendance - a.attendance || a.label.localeCompare(b.label));
  const iomCodes = listed('PREVENTION_IOM', by.iom).map(x => x.code);
  const cross = listed('PREVENTION_STRATEGIES', by.strategy).map(s => ({
    code: s.code, label: s.label,
    cells: Object.fromEntries(iomCodes.map(i => [i, fix(by.cross.get(`${s.code}|${i}`) || empty())])),
  }));
  return {
    totals: { ...fix(t) },
    by_strategy: listed('PREVENTION_STRATEGIES', by.strategy),
    by_iom: listed('PREVENTION_IOM', by.iom),
    by_strategy_iom: cross, iom_codes: iomCodes,
    by_type: used('PREVENTION_EVENT_TYPES', by.type),
    by_audience: used('PREVENTION_AUDIENCES', by.audience),
  };
}

function build(range) {
  const { from, to } = range;
  return { name: NAME, from, to, ppsds_note: PPSDS_NOTE, count_note: COUNT_NOTE, ...figures(range) };
}

/** The workbook's sheets and the CSV's long rows. */
function sheets(d, ctx) {
  const t = d.totals;
  const about = [
    { k: 'Report', v: NAME }, { k: 'Period', v: `${d.from} to ${d.to}` }, { k: 'Program', v: db.getSetting('org_name', '') || '' }, { k: 'County', v: db.getSetting('county_name', '') || '' },
    { k: 'Not a PPSDS file', v: d.ppsds_note }, { k: 'Counts', v: d.count_note },
    { k: 'Classification', v: 'Aggregate counts of group and community events: no names, no clients.' },
    { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
  ];
  const summary = [
    ['Totals', 'Prevention events', t.events], ['Totals', 'Hours of prevention activity', t.hours], ['Totals', 'Attendance (people reached)', t.attendance],
    ['Totals', 'Of that attendance, estimated', t.attendance_estimated], ['Totals', 'Training events', t.training_events], ['Totals', 'People trained', t.people_trained],
    ...d.by_strategy.flatMap(s => [[`Strategy (CSAP): ${s.label}`, 'Events', s.events], [`Strategy (CSAP): ${s.label}`, 'Hours', s.hours], [`Strategy (CSAP): ${s.label}`, 'Attendance', s.attendance]]),
    ...d.by_iom.flatMap(s => [[`Population (IOM): ${s.label}`, 'Events', s.events], [`Population (IOM): ${s.label}`, 'Hours', s.hours], [`Population (IOM): ${s.label}`, 'Attendance', s.attendance]]),
  ].map(([section, measure, value]) => ({ section, measure, value }));
  const long = [{ key: 'section', label: 'Section' }, { key: 'measure', label: 'Measure' }, { key: 'value', label: 'Value' }];
  const catCols = (first) => [{ key: 'label', label: first }, { key: 'events', label: 'Events' }, { key: 'hours', label: 'Hours' }, { key: 'attendance', label: 'Attendance' }];
  const iomLabels = Object.fromEntries(d.by_iom.map(x => [x.code, x.label]));
  const crossCols = [{ key: 'label', label: 'Strategy (CSAP)' }, ...d.iom_codes.map(c => ({ key: c, label: `${iomLabels[c]}: attendance` }))];
  const crossRows = d.by_strategy_iom.map(s => ({ label: s.label, ...Object.fromEntries(d.iom_codes.map(c => [c, s.cells[c].attendance])) }));
  return {
    workbook: [
      { name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about },
      { name: 'Summary', columns: long, rows: summary },
      { name: 'By strategy', columns: catCols('Strategy (CSAP)'), rows: d.by_strategy },
      { name: 'By IOM category', columns: catCols('Population (IOM)'), rows: d.by_iom },
      { name: 'Strategy by IOM', columns: crossCols, rows: crossRows },
      { name: 'By kind of event', columns: catCols('Kind of event'), rows: d.by_type },
      { name: 'By audience', columns: catCols('Audience'), rows: d.by_audience },
    ],
    csv: [...about.map(x => ({ section: 'About', measure: x.k, value: x.v })), ...summary,
      ...d.by_strategy_iom.flatMap(s => d.iom_codes.map(c => ({ section: `Strategy by IOM: ${s.label}`, measure: `${iomLabels[c]}: attendance`, value: s.cells[c].attendance }))),
      ...d.by_type.map(r => ({ section: 'Kind of event', measure: `${r.label}: attendance`, value: r.attendance }))],
    csvColumns: long,
  };
}

function routes(r, range) {
  r.get('/api/reports/prevention', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const d = build(range(ctx));
    audit.log({ user: ctx.user, action: 'report.prevention', ip: ctx.ip, details: { from: d.from, to: d.to, events: d.totals.events } });
    return d;
  });
  r.get('/api/reports/prevention/export', auth.requireAuth, auth.requirePerm('reports:read'), auth.requirePerm('export:read'), (ctx) => {
    const d = build(range(ctx)); const xlsx = ctx.query.get('format') === 'xlsx';
    const sh = sheets(d, ctx); const S = require('./spreadsheet');
    audit.log({ user: ctx.user, action: 'report.prevention.export', ip: ctx.ip, details: { from: d.from, to: d.to, events: d.totals.events, format: xlsx ? 'xlsx' : 'csv' } });
    ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-prevention-activity-summary-${d.from}_${d.to}.${xlsx ? 'xlsx' : 'csv'}"`,
      'X-SUDS-Export': 'Prevention activity summary (not a PPSDS file; the PPSDS field mapping awaits the DHCS data dictionary). Aggregate, no names.' });
    ctx.res.end(xlsx ? S.writeWorkbook(sh.workbook) : S.toCsv(sh.csv, sh.csvColumns));
  });
}

module.exports = { build, figures, sheets, routes, NAME, PPSDS_NOTE };
