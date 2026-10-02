// The menu (the sidebar on a computer, the ☰ drawer on a phone): every page, and where it goes for a person — by what
// their role may do and the programme's profile (server/programme.js). Pure data and functions with no DOM, so the
// node suite checks the placement for every role and profile (test/nav-menu.test.js) without a browser; app.js
// builds the menu from it and passes the context (navContext() there).
//
// Each entry shows for a role that holds its permission (perm). Where it goes:
//   front            — for a front-line worker (isFrontline() below: navigator, clinician) the placement: 'main' (the
//                      everyday list) or 'more' (a closed "More" group at the end of the menu). A string, or an
//                      object keyed by programme profile and 'phone' (the menu as the phone drawer, where a short
//                      list matters most), 'clinician_phone' (the phone drawer of someone who writes clinical
//                      notes, notes:clinical:write), with '*' for the rest; the most specific key wins (placementFor()).
//                      Absent: 'main'. Street outreach is in the everyday list wherever the profile shows it (1.23.0:
//                      it was under More); the Waitlist folds into More in a harm-reduction programme, which keeps
//                      no treatment waitlist to speak of, and Notes does on a phone, where Home's "Continue where you
//                      left off" and the unsigned-notes count lead to them — except for a clinician, whose day is
//                      notes (1.23.1): Notes stays in their phone menu and Supplies folds into More instead. Every page a front-line worker may open
//                      is in their menu, the programme's own pages (money, contracts, settings) under More.
//   programme: true  — the programme's own pages (money, contracts, imports, the funder report, settings), in the
//                      "Program" section for the roles that run the programme.
//   team: true       — for someone who supervises a team (isSupervising() below) it stays in the main list, and
//                      everything else folds into "More": their day is the supervision queue, the caseloads and
//                      the team's daily pages, not the programme's every page. Supervision leads their list.
//   show(c)          — shown only when this returns true (a reporting module switched on for the programme).
//   hideIn: [...]    — not shown under these programme profiles: the harm-reduction pages a program running SUDS as
//                      its Part 2 layer beside an EHR does not use (1.17.0). Their addresses still open for anyone
//                      whose role may; the menu just stops leading with them.
// The order within each section is by how often the page is used: a navigator's day is Home, Clients, to-dos and
// the street, then recording visits, calls and notes; reports come monthly.
// Nothing here changes a permission: the server decides what each role may do (server/auth.js PERMS).
//
// The context `c`: { can(perm), moduleOn(key), profile, local, programme, phone }.
export const NAV = [
  { sec: 'My day' },
  { name: 'dashboard', team: true, label: 'Home', ico: '⌂', help: 'What needs attention today, and where you left off on any device.' },
  { name: 'clients', team: true, label: 'Clients', ico: '👤', perm: 'clients:read', help: 'Everyone you serve. Open a client to see their whole story in one place.' },
  { name: 'waitlist', team: true, front: { harm_reduction: 'more' }, label: 'Waitlist', ico: '⧗', perm: 'clients:read', help: 'People waiting for a place, longest and highest risk first.' },
  { name: 'tasks', team: true, label: 'To-dos', ico: '☑', perm: 'tasks:read', help: 'Your to-dos: follow-ups and reminders. Check a box when it is done.' },
  { name: 'supervision', team: true, label: 'Supervision', ico: '✍', perm: ['notes:cosign', 'time:approve', 'assignments:manage'], help: (c) => (c.can('notes:cosign') || c.can('assignments:manage') ? 'Notes waiting for your countersignature, drafts your team has not finished, staff time to approve, and referrals with no outcome recorded.'
    : 'Staff time submitted for approval: approve it, or send it back to be corrected.') }, // Finance sees only the time (r9 L7)
  { sec: 'Record work' },
  { name: 'interventions', team: true, label: 'Visits', ico: '✚', perm: 'interventions:read', help: 'Every visit: the face-to-face or phone services you provide — outreach, screenings, warm handoffs, naloxone, transport and more.' },
  { name: 'calls', team: true, label: 'Calls & texts', ico: '☎', perm: 'calls:read', help: 'Phone calls and text messages with clients, families and providers — including ones that went to voicemail or got no reply.' },
  { name: 'notes', team: true, front: { phone: 'more', clinician_phone: 'main' }, label: 'Notes', ico: '✎', perm: 'notes:admin:read', help: 'Written documentation. Drafts save automatically and can be finished on any device; sign when complete.' },
  { name: 'supplies', hideIn: ['part2_layer'], front: { clinician_phone: 'more' }, label: 'Supplies', ico: '📦', perm: 'supplies:read', help: 'Naloxone, test strips, syringes and other harm-reduction supplies on hand at each site, by lot and expiry, with every delivery, move and count. A visit takes what it hands out off the stock automatically, the batch that expires soonest first.' },
  // Street outreach (1.17.0): the one-screen, phone-first logger for anonymous field contacts; also on + Log, and a
  // worker's start page if they choose (My profile, or the box on the screen).
  { name: 'outreach', hideIn: ['part2_layer'], label: 'Street outreach', ico: '🚶', perm: 'interventions:write', front: 'main', help: 'Log a field contact in a few taps: what kind, what you handed out, and roughly where. Anonymous, works with no connection on a device, and the supplies come off the stock.' },
  { name: 'overdose', hideIn: ['part2_layer'], label: 'Overdose & reversals', ico: '⛑', perm: 'overdose:read', help: 'Overdoses and naloxone reversals, including ones involving people who are not clients. These are the counts funders ask for.' },
  // Group and community prevention events (1.17.0): a front-line worker finds it under More. Whoever reads reports
  // but not visits (finance, read-only) gets its activity summary alone.
  { name: 'prevention', label: 'Prevention', ico: '☂', perm: ['interventions:read', 'reports:read'], front: 'more', help: 'Group and community prevention events — presentations, trainings, community events, campaigns — with their CSAP strategy, IOM population category, hours and attendance (counts, never names), and the prevention activity summary.' },
  { name: 'forms', label: 'Forms', ico: '🧾', perm: 'forms:read', front: 'more', help: 'County forms (releases, intake sheets, assistance requests). Fill one out from a client record: it is pre-filled from the chart, printable, and holds the signed copy.' },
  { name: 'time', hideIn: ['part2_layer'], label: 'My time', ico: '◷', perm: 'time:read', front: 'more', help: 'Your hours by activity. A call adds its time, and a visit does when you tick "Also log this as a time entry"; log meetings, travel and paperwork here.' },
  { sec: 'Connect clients' },
  { name: 'referrals', team: true, label: 'Referrals', ico: '⇢', perm: 'referrals:read', help: 'Track each referral from "sent" to "admitted" so nothing falls through the cracks.' },
  // Incoming referrals (1.24.0): the intake queue of people referred to the programme. A supervisor's team page; a
  // front-line worker finds it under More (Home's "New referrals" leads to it), so the phone menu stays short.
  { name: 'incoming', team: true, front: 'more', label: 'Incoming referrals', ico: '⇠', perm: 'intake:read', help: 'People referred to this program by a hospital, jail, detox, probation or a court, another provider, themselves or their family: try to reach them, then accept them as a client or close the referral.' },
  { name: 'resources', label: 'Resource directory', ico: '☰', perm: 'resources:read', help: 'Syringe services, drop-ins, shelters, MAT and treatment programs, legal aid and the other partners you refer people to.' },
  { sec: 'Program' },
  { name: 'reports', label: 'Reports', ico: '▤', perm: 'reports:read', front: 'more', help: 'Numbers for your funders and supervisors. Exports never include client names unless you ask.' },
  { name: 'funder', hideIn: ['part2_layer'], label: 'Funder report', ico: '▦', perm: 'reports:read', programme: true, front: 'more', help: 'Unduplicated counts — people, not services — by fiscal period and funding source, with admissions, discharges, demographics and overdose figures in the shape a grant report asks for.' },
  // The two state and federal reporting modules, for a programme that uses them (Settings › Program › Modules):
  // the same test the Reports page's cards use, so the entry and the card come and go together.
  { name: 'caloms', label: 'State reporting', ico: '⚑', perm: ['episodes:read', 'episodes:write', 'export:identified'], front: 'more', show: (c) => ((c.can('episodes:read') || c.can('episodes:write')) && c.moduleOn('caloms')) || (c.can('export:identified') && (c.moduleOn('caloms') || c.moduleOn('handoff'))), help: 'CalOMS Tx admission, discharge and annual update records for DHCS, their validation report and the extract, and the county EHR hand-off.' },
  { name: 'suprt', label: 'SUPRT-A', ico: '◎', perm: ['clients:read', 'reports:funder'], front: 'more', show: (c) => c.moduleOn('suprt'), help: 'SAMHSA SUPRT-A records for clients served with State Opioid Response money: completion, the follow-ups due, and the file for SPARS.' },
  // Settlement outcomes (1.17.0): each opioid settlement fund's spending beside what the program recorded of the work
  // it paid for. For the people who account for the money (reports:funder or reports:internal, with budget:read).
  { name: 'settlement', hideIn: ['part2_layer'], label: 'Settlement outcomes', ico: '◈', perm: ['reports:funder', 'reports:internal'], show: (c) => c.can('budget:read'), programme: true, front: 'more', help: 'For each opioid settlement fund: what it spent, what the program recorded of the work it paid for (kits, reversals, people served and linked to care, people trained), the cost per outcome where that means something, and the trend by month. Small counts of people are hidden as in the funder report.' },
  // The county view (docs/COUNTY-VIEW.md): for a county that runs SUDS, the signed submissions of the programmes it
  // funds, side by side and summed. For county:view once a programme is registered here (active or not: an inactive
  // one's files are still there), and for county:manage (who registers them) always. Never on SUDS on this device,
  // which has no county relationship.
  { name: 'county', label: 'County view', ico: '⊞', perm: 'county:view', show: (c) => !c.local && (c.can('county:manage') || !!(c.programme && c.programme.county_programmes)), programme: true, front: 'more', help: 'For a county that funds programs: the settlement spending and outcomes each one sends as a signed file, side by side and summed for a period or by quarter. Exact figures for authorised county staff, not for publication; people are each program\'s own count, added up.' },
  { name: 'budget', hideIn: ['part2_layer'], label: 'Funding & spending', ico: '$', perm: 'budget:read', programme: true, front: 'more', help: 'Grants and what has been spent, including client assistance such as bus passes and IDs.' },
  { name: 'documents', label: 'Policies & contracts', ico: '📋', perm: 'documents:read', programme: true, front: 'more', help: 'County policies, procedures and signed contracts, searchable by title and category.' },
  { name: 'compliance', label: 'Privacy & Part 2', ico: '⚖', perm: ['consents:read', 'complaints:read', 'incidents:read', 'settings:manage'], front: 'more', help: '42 CFR Part 2: the patient notice and who has not been given it, the privacy complaint log, and the incident and breach register with its 60-day notification clock.' },
  { name: 'imports', label: 'Import', ico: '⇩', perm: 'imports:write', programme: true, front: 'more', help: 'Bring in spreadsheets (Excel / CSV) of clients, visits, calls, resources and more, or notes from Pocket AI and OneNote. Everything is checked before it is saved.' },
  // A supervisor holds assignments:manage (moving a caseload when someone leaves lives on this page) but not
  // users:manage; gating the whole page on the latter locked them out of a feature built for them.
  { name: 'admin', team: true, label: 'Settings', ico: '⚙', perm: ['users:manage', 'assignments:manage'], programme: true, front: 'more', help: 'Staff accounts, security, connecting devices and backups — or, for a supervisor, moving a caseload and the audit log.' },
];

/** Does the person hold any of these permissions? */
export const canAnyOf = (c, perm) => (Array.isArray(perm) ? perm.some(p => c.can(p)) : c.can(perm));
/**
 * A front-line worker (navigator, clinician): records work with clients and does not run the programme's
 * money, staff or settings. Presentation only — the short menu and a Home without the budget.
 */
export const isFrontline = (c) => c.can('interventions:write') && !c.can('budget:approve') && !c.can('assignments:manage') && !c.can('users:manage') && !c.can('settings:manage');
/**
 * Someone who supervises a team (a supervisor): countersigns notes and moves caseloads, but does not run the
 * programme's accounts or settings. Presentation only, from permissions (deny-aware can()), not the role name:
 * a menu led by Supervision with the rest under More, and the client record's Episodes and Care team tabs.
 */
export const isSupervising = (c) => c.can('notes:cosign') && c.can('assignments:manage') && !c.can('users:manage') && !c.can('settings:manage');
/** An entry's front-line placement for this profile and screen (see `front` above). */
export function placementFor(front, { profile = null, phone = false, clinician = false } = {}) {
  if (!front) return 'main';
  if (typeof front === 'string') return front;
  return (phone && clinician && front.clinician_phone) || (phone && front.phone) || front[profile] || front['*'] || 'main';
}
/** Where a NAV entry goes in this person's menu: 'main', 'more' (folded away), or null (not shown). */
export function placement(n, c) {
  if (!n.name || (n.perm && !canAnyOf(c, n.perm)) || (n.show && !n.show(c))) return null;
  if (n.hideIn && n.hideIn.includes(c.profile)) return null;
  // SUDS as the Part 2 layer beside an EHR: Privacy & Part 2 is what it is for, so it leads for everyone who may open it.
  if (n.name === 'compliance' && c.profile === 'part2_layer') return 'main';
  if (isSupervising(c)) return n.team ? 'main' : 'more';
  if (!isFrontline(c)) return 'main';
  return placementFor(n.front, { profile: c.profile, phone: c.phone, clinician: c.can('notes:clinical:write') });
}
/**
 * The menu as lists of names: { main, more, top } — `top` counts the entries a person scans before opening
 * anything (the main list, and More as one). The order is NAV's, with Supervision straight after Home for a
 * supervisor (app.js sidebar() draws the same).
 */
export function menuFor(c) {
  const main = [], more = [];
  for (const n of NAV) { const where = n.name ? placement(n, c) : null; if (where === 'main') main.push(n.name); else if (where === 'more') more.push(n.name); }
  if (isSupervising(c)) { const i = main.indexOf('supervision'); if (i > 1) main.splice(1, 0, ...main.splice(i, 1)); }
  return { main, more, top: main.length + (more.length ? 1 : 0) };
}
