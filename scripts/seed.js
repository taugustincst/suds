'use strict';
// Seeds a development database with demo users plus the fictional sample data set (server/demo.js).
// Usage: npm run seed   (refuses to run in production; the in-app "Load sample data" button is the production-safe path)
const config = require('../server/config');
if (config.isProd) { console.error('Refusing to seed a production database'); process.exit(1); }
const db = require('../server/db');
const { ensureBootstrap, adminUsername } = require('../server/bootstrap');
const { hashPassword, uuid } = require('../server/crypto');
const demo = require('../server/demo');

db.open();
ensureBootstrap();
const PW = process.env.SEED_PASSWORD || 'Navigator2026!!';
function user(username, display_name, role, title, hourly) {
  const ex = db.one(`SELECT id FROM users WHERE username=?`, username); if (ex) return ex.id;
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,title,hourly_cost,password_changed_at) VALUES(?,?,?,?,?,?,?,?)`, id, username, hashPassword(PW), display_name, role, title, hourly, db.now());
  return id;
}
const nav1 = user('mrivera', 'Maria Rivera', 'navigator', 'SUD Navigator', 42);
const nav2 = user('dchen', 'David Chen', 'navigator', 'Peer Navigator', 35);
const clin = user('kpatel', 'Dr. Kiran Patel', 'clinician', 'LCSW, Clinical Supervisor', 65);
const sup = user('jwalker', 'Jordan Walker', 'supervisor', 'Program Manager', 58);
user('afinance', 'Alex Finance', 'finance', 'Fiscal Analyst', 40);
user('rreader', 'Robin Reader', 'readonly', 'County Analyst', 0);
db.run(`UPDATE users SET must_change_password=0 WHERE username=?`, adminUsername());

if (demo.status().loaded) console.log('Sample data already loaded; skipping.');
else if (db.one(`SELECT COUNT(*) n FROM clients`).n > 0) console.log('Database already has clients; not adding sample data.');
else { const s = demo.seed({ actor: sup, workers: [nav1, nav2], clinician: clin, supervisor: sup }); console.log(`Seeded ${s.counts.clients} clients, ${s.counts.interventions} visits, ${s.counts.calls} calls, ${s.counts.notes} notes, ${s.counts.resources} resources.`); }
// The sample data has care plans, assessments and CalOMS-ready episodes, and the browser suite drives every
// module, so the development database is a treatment-adjacent programme (a new install is harm reduction).
db.setSetting('programme_profile', 'treatment');
console.log(`Demo logins (password "${PW}"): mrivera (navigator), dchen (navigator), kpatel (clinician), jwalker (supervisor), afinance (finance), rreader (read-only), admin`);
db.close();
