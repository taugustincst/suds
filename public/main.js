// Entry point: register the views, then boot the app. Kept separate from app.js to avoid
// a circular top-level-await between app.js and the view modules.
//
// Only the sign-in page and Home are loaded before the app starts; every other page's module is fetched the
// first time it is opened (app.js lazyRoute). All of them used to be downloaded and compiled before the first
// screen: 890 kB of JavaScript, when a phone that opens SUDS to record a visit needs a third of it. The
// service worker still keeps every page for offline use (public/sw.js).
import { boot, lazyRoute } from './app.js';
import './views/login.js';
import './views/dashboard.js';

const views = {
  clients: ['clients'], client: ['client'], interventions: ['interventions'], calls: ['calls'], time: ['time'],
  resources: ['resources', 'resource'], referrals: ['referrals'], tasks: ['tasks'], budget: ['budget'], notes: ['notes'],
  imports: ['imports'], reports: ['reports'], admin: ['admin'], profile: ['profile'], setup: ['setup'], local: ['sync'],
  forms: ['forms'], documents: ['documents'], supervision: ['supervision'], episodes: ['waitlist'],
  overdose: ['overdose'], funder: ['funder'], caloms: ['caloms'], supplies: ['supplies'], compliance: ['compliance'], suprt: ['suprt'],
};
for (const [file, names] of Object.entries(views)) lazyRoute(names, () => import(`./views/${file}.js`));
boot();
