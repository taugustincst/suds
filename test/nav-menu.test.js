'use strict';
// The menu by role and programme profile (1.23.0; public/nav.js), checked for every role in server/auth.js PERMS,
// every programme profile, with the reporting modules on and off, on a phone and a computer:
//   * every page a role may open (its permission, its module on, its profile showing it) is in that role's menu,
//     in the main list or under More — nothing a person may use is left to be found by its address;
//   * a page a role may not open is never in the menu (the menu is presentation; permissions are the server's);
//   * a front-line worker's phone menu has at most 12 top-level entries (More counted as one);
//   * Street outreach is in the main menu of every front-line role that may record it, in the harm-reduction and
//     treatment-adjacent profiles; the monthly pages (reports, state reporting, SUPRT-A, import, the funder report)
//     are under More for them.
// The browser side (scripts/ui/menu-home.mjs) checks the menu as drawn for the seed's navigators.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PERMS } = require('../server/auth');
const { PROFILES } = require('../server/programme');

let M;
before(async () => { M = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '..', 'public', 'nav.js')).toString('base64')); });

// public/app.js can(), for a role's default permissions: wildcards, and write implies read.
const canFor = (role) => (perm) => {
  const p = PERMS[role]; const [ns] = perm.split(':');
  return p.includes(perm) || p.includes(`${ns}:*`) || (perm.endsWith(':read') && p.includes(perm.replace(/:read$/, ':write')));
};
const MODULES = { all_on: {}, all_off: { caloms: false, suprt: false, handoff: false, careplan: false, assessments: false } };
function contexts() {
  const out = [];
  for (const role of Object.keys(PERMS)) for (const profile of Object.keys(PROFILES)) for (const [mods, m] of Object.entries(MODULES)) for (const phone of [false, true]) {
    out.push({ role, mods, c: { can: canFor(role), moduleOn: (k) => m[k] !== false, profile, local: false, programme: { profile, modules: m, county_programmes: 1 }, phone } });
  }
  return out;
}
const label = (x) => `${x.role} / ${x.c.profile} / modules ${x.mods} / ${x.c.phone ? 'phone' : 'computer'}`;
const anyOf = (c, perm) => (Array.isArray(perm) ? perm.some(p => c.can(p)) : c.can(perm));

test('every page a role may open is in its menu, main list or More; none it may not open is', () => {
  let checked = 0;
  for (const x of contexts()) {
    const { main, more } = M.menuFor(x.c);
    const shown = new Set([...main, ...more]);
    assert.equal(shown.size, main.length + more.length, `${label(x)}: no page twice`);
    for (const n of M.NAV.filter(e => e.name)) {
      const may = (!n.perm || anyOf(x.c, n.perm)) && (!n.show || n.show(x.c)) && !(n.hideIn || []).includes(x.c.profile);
      assert.equal(shown.has(n.name), may, `${label(x)}: ${n.name} ${may ? 'is reachable from the menu' : 'is not offered'}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, `${checked} role × profile × page checks`);
});

test('a front-line worker\'s phone menu has at most 12 top-level entries; Street outreach leads it in the street profiles', () => {
  const front = contexts().filter(x => M.isFrontline(x.c));
  assert.deepEqual([...new Set(front.map(x => x.role))].sort(), ['clinician', 'navigator'], 'the front-line roles');
  for (const x of front) {
    const m = M.menuFor(x.c);
    if (x.c.phone) assert.ok(m.top <= 12, `${label(x)}: ${m.top} top-level entries (${m.main.join(', ')} + More)`);
    assert.ok(m.top <= 13, `${label(x)}: ${m.top} top-level entries on a computer`);
    if (x.c.profile === 'part2_layer') assert.ok(!m.main.includes('outreach') && !m.more.includes('outreach'), `${label(x)}: no Street outreach beside an EHR`);
    else assert.ok(m.main.includes('outreach'), `${label(x)}: Street outreach is in the main menu`);
    for (const p of ['reports', 'funder', 'caloms', 'suprt', 'imports', 'settlement', 'budget', 'documents']) assert.ok(!m.main.includes(p), `${label(x)}: ${p} is not in the main list`);
    assert.equal(m.main.includes('waitlist'), x.c.profile !== 'harm_reduction', `${label(x)}: Waitlist in the main list except in a harm-reduction programme`);
    // 1.23.1: a clinician's day is notes, so Notes stays in their phone menu (and Supplies, where shown, folds instead).
    const clinician = x.c.can('notes:clinical:write');
    assert.equal(m.main.includes('notes'), !x.c.phone || clinician, `${label(x)}: Notes in the main list on a computer${clinician ? ' and on a clinician\'s phone' : ', under More on a navigator\'s phone'}`);
    if (x.c.phone && clinician && x.c.profile !== 'part2_layer') assert.ok(m.more.includes('supplies') && !m.main.includes('supplies'), `${label(x)}: Supplies under More on a clinician's phone`);
    assert.equal(m.main[0], 'dashboard', 'Home first');
  }
});

test('the other roles keep their menus: a supervisor led by Supervision, everyone else every page in the main list', () => {
  for (const x of contexts()) {
    const m = M.menuFor(x.c);
    if (x.role === 'supervisor') {
      assert.equal(m.main[1], 'supervision', `${label(x)}: Supervision straight after Home`);
      assert.ok(m.more.includes('reports') && m.more.includes('imports'), `${label(x)}: the programme's pages under More`);
    } else if (!M.isFrontline(x.c)) {
      assert.equal(m.more.length, 0, `${label(x)}: no More group`);
    }
  }
  // The phone flag only moves a front-line worker's entries.
  for (const x of contexts().filter(y => !M.isFrontline(y.c) && y.c.phone)) assert.deepEqual(M.menuFor(x.c), M.menuFor({ ...x.c, phone: false }), label(x));
});

test('placementFor: a profile or phone key wins over the default, and an absent mark is the main list', () => {
  const f = { harm_reduction: 'more', phone: 'more', '*': 'main' };
  assert.equal(M.placementFor(undefined, {}), 'main');
  assert.equal(M.placementFor('more', {}), 'more');
  assert.equal(M.placementFor(f, { profile: 'treatment', phone: false }), 'main');
  assert.equal(M.placementFor(f, { profile: 'harm_reduction', phone: false }), 'more');
  assert.equal(M.placementFor(f, { profile: 'treatment', phone: true }), 'more');
  assert.equal(M.placementFor({ phone: 'more' }, { profile: 'treatment', phone: false }), 'main');
});
