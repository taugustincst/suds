# SUDS — notes for contributors and AI assistants

* Zero runtime dependencies: Node 22 built-ins only (`node:sqlite`, `node:crypto`, `node:http`). Do not add npm packages without a strong reason; the small supply chain is a security feature.
* Backend: `server/` — `app.js` (request pipeline), `auth.js` (sessions, RBAC matrix, caseload scoping), `crud.js` (generic client-scoped CRUD), `routes/*`, `importers/*`, `schema.sql`.
* All PHI columns end in `_enc` (AES-256-GCM via `server/crypto.js`); searchable copies end in `_idx` (HMAC blind index). Never write PHI into plaintext columns, audit details, or logs.
* Every PHI read/write must call `audit.log`. The audit table is hash-chained — never UPDATE or DELETE rows except via the retention purge.
* Frontend: `public/` vanilla ES modules, no build step. `app.js` has the DOM/form helpers; views register with `route()` and are imported in `main.js`. CSP forbids inline scripts.
* Tests: `npm test` (node:test). Add an API test for every new permission or route. Run the browser smoke test (`scripts/ui-smoke.mjs`) after UI changes.
* Dev data: `npm run seed` (fictional clients). Never seed production.
