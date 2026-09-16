// Entry point: register all views, then boot the app. Kept separate from app.js to avoid
// a circular top-level-await between app.js and the view modules.
import { boot } from './app.js';
import './views/login.js';
import './views/dashboard.js';
import './views/clients.js';
import './views/client.js';
import './views/interventions.js';
import './views/calls.js';
import './views/time.js';
import './views/resources.js';
import './views/referrals.js';
import './views/tasks.js';
import './views/budget.js';
import './views/notes.js';
import './views/imports.js';
import './views/reports.js';
import './views/admin.js';
import './views/profile.js';
import './views/setup.js';
import './views/local.js';
import './views/dataimport.js';
boot();
