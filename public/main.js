// Entry point: register the views, then boot the app. Kept separate from app.js to avoid
// a circular top-level-await between app.js and the view modules.
//
// Only the sign-in page and Home are loaded before the app starts; every other page's module is fetched the
// first time it is opened (app.js lazyRoute). All of them used to be downloaded and compiled before the first
// screen: 890 kB of JavaScript, when a phone that opens SUDS to record a visit needs a third of it. The
// service worker still keeps every page for offline use (public/sw.js).
import { boot, lazyRoute, loadingFor } from './app.js';
import './views/login.js';
import './views/dashboard.js';

const views = {
  clients: ['clients'], client: ['client'], interventions: ['interventions'], calls: ['calls'], time: ['time'],
  resources: ['resources', 'resource'], referrals: ['referrals'], tasks: ['tasks'], budget: ['budget'], notes: ['notes'],
  imports: ['imports'], reports: ['reports'], admin: ['admin'], profile: ['profile'], setup: ['setup'], local: ['sync', 'recovery-code'],
  forms: ['forms'], documents: ['documents'], supervision: ['supervision'], episodes: ['waitlist'],
  overdose: ['overdose'], funder: ['funder'], caloms: ['caloms'], supplies: ['supplies', 'ssp'], compliance: ['compliance'], suprt: ['suprt'],
  outreach: ['outreach'], settlement: ['settlement'],
};
for (const [file, names] of Object.entries(views)) lazyRoute(names, () => import(`./views/${file}.js`));
// What the slower pages say while they work, from the first opening (before their module has arrived; the
// module may register a more exact text, e.g. the funder report's for a publication release).
loadingFor('reports', () => 'Counting visits, clients, calls and referrals for the period…');
loadingFor('budget', () => 'Adding up funds, budget lines and spending…');
loadingFor('funder', (r) => (r.query.get('purpose') === 'publication' ? 'Checking small counts before the release is shown…' : 'Working out the funder report for the period…'));
loadingFor('caloms', () => 'Checking the CalOMS records for the period…');
loadingFor('settlement', () => 'Adding up settlement spending and what it paid for…');
loadingFor('suprt', () => 'Counting SUPRT-A records due and done…');
boot();
