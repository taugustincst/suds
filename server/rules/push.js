'use strict';
// Applying a device's push (POST /api/sync/push): each row through its table's rules (server/rules/<table>.js),
// in the stages every table shares —
//
//   prepare    legacy columns, a parent that was refused, clock skew, the office copy
//   authorise  purged, merged, caseload, another worker's record, the legal record, then the table's own
//   validate   the REST shape's fields, the programme module, then the table's check
//   resolve    last write wins: an older device edit loses and is reported as a conflict
//   normalise  who did the work, then the columns the office keeps for itself
//   apply      user ids, encryption, the write, its audit, tombstones, then the table's side effects
//
// A device may not do through sync what its user could not do through the API, and one bad row must never cost
// a device its ability to sync: each row is applied inside its own savepoint, and a refusal rejects that row
// (and the rows that hang off it) while the rest of the batch lands. A refusal marked `flag` lets the row land
// and tells the device and the audit trail why the office looked twice (sync.conflict, kept: 'device').
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { decrypt } = require('../crypto');
const SYNC = require('../sync-tables');
const rules = require('./index');
const { refusals, checkFields } = require('./core');

const NEVER = '1970-01-01T00:00:00.000Z';
function cols(table) {
  // PRAGMA once per table per push; a migration never runs while a push is being applied.
  return db.all(`PRAGMA table_info(${table})`).map(c => c.name);
}

/**
 * Which columns a device's row would change, by name. Encrypted columns are compared as plaintext (each
 * encryption uses a fresh IV, so ciphertext never matches ciphertext) and blind indexes are skipped; the
 * values themselves never leave this function.
 */
function changedColumns(t, existing, raw, existingCols) {
  const out = [];
  for (const k of existingCols) {
    if (k === 'id' || k === 'updated_at' || k === 'created_at' || k.endsWith('_idx') || raw[k] === undefined) continue;
    let was = existing[k];
    if (t.enc.includes(k) && was) { try { was = decrypt(was); } catch { was = null; } }
    if (String(was ?? '') !== String(raw[k] ?? '')) out.push(k);
  }
  return out;
}

/** Follow a merged-away client to the record that was kept (merges can chain). */
function keeperOf(clientId) {
  let cur = clientId;
  for (let i = 0; i < 25; i++) {
    const c = db.one(`SELECT merged_into FROM clients WHERE id=?`, cur);
    if (!c || !c.merged_into) return cur;
    cur = c.merged_into;
  }
  return cur;
}
// A clients tombstone only ever comes from a hard delete on the office side (the retention purge, sample data
// being removed), never from a device. Such a row must never come back, whatever a device's clock says.
const clientPurged = (clientId) => !!db.one(`SELECT 1 FROM tombstones WHERE table_name='clients' AND id=?`, clientId);

/** A short, non-PHI reason a row could not be applied. SQLite messages name columns, never values. */
function describeError(err) {
  const m = String(err && err.message || 'could not be applied');
  if (/FOREIGN KEY/i.test(m)) return 'refers to a record the office server does not have';
  if (/UNIQUE/i.test(m)) return 'conflicts with an existing record';
  if (/NOT NULL/i.test(m)) return 'is missing a required field';
  if (/CHECK constraint/i.test(m)) return 'has a value the office does not accept';
  return m.slice(0, 200);
}

/** Device-supplied audit detail: parsed if it is JSON, flattened to short scalars either way. */
function sanitiseDetails(d) {
  let o = d;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return { note: o.slice(0, 200) }; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 20)) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[String(k).slice(0, 40)] = v;
    else if (typeof v === 'string') out[String(k).slice(0, 40)] = v.slice(0, 200);
  }
  return out;
}

/**
 * A row that points at its own parent within the same table (a budget sub-allocation, a merged client) needs
 * that parent applied first. Stable topological sort by that column; a parent outside the batch needs no
 * reordering, and a cycle within the batch is left for the table's rules to refuse.
 */
function selfParentOrder(rows, col) {
  const ids = new Set(rows.map(r => r && r.id));
  const placed = new Set(); const out = []; let remaining = rows;
  while (remaining.length) {
    const [ready, waiting] = [[], []];
    for (const r of remaining) (!r || !r[col] || !ids.has(r[col]) || placed.has(r[col]) ? ready : waiting).push(r);
    if (!ready.length) { out.push(...waiting); break; }
    for (const r of ready) { out.push(r); if (r && r.id) placed.add(r.id); }
    remaining = waiting;
  }
  return out;
}

/**
 * What a table's rules see of the row being applied (core.js documents it): who, the office copy, and the
 * columns it changes, worked out once and only when asked.
 */
class RowContext {
  constructor(session, t, raw, existing, existingCols, incomingAt) {
    this.user = session.user; this.session = session; this.table = t; this.existing = existing; this.via = 'sync';
    this.incomingAt = incomingAt; this.flags = []; this._raw = raw; this._cols = existingCols; this._changed = null;
  }
  /** The columns this row changes on the office copy (all of them for a new row). */
  changed() { return this._changed || (this._changed = this.existing ? changedColumns(this.table, this.existing, this._raw, this._cols) : Object.keys(this._raw).filter(k => k !== 'id')); }
  /** A column's value on the office copy, in plain text. */
  was(col) {
    const e = this.existing; if (!e) return undefined;
    if (e[col] && this.table.enc.includes(col)) { try { return decrypt(e[col]); } catch { return null; } }
    return e[col];
  }
  /** A column's value after this write, in plain text. */
  plain(col) { return this._raw[col] !== undefined ? this._raw[col] : this.was(col); }
}

class PushSession {
  constructor(user, payload) {
    this.user = user; this.payload = payload;
    this.tables = payload.tables || {};
    this.applied = {}; this.rejected = []; this.conflicts = []; this.warnings = [];
    this.rejectedIds = new Map(); // `${table}:${id}` -> permanent?
    // Device clocks are not trusted: the device's own bookkeeping timestamps are shifted by the measured offset
    // so last-write-wins compares in server time. Only created_at and updated_at: signed_at, approved_at and the
    // rest are clinical and legal facts. The shifted updated_at is for the comparison only; what is stored is
    // the server's own clock, so every other device's incremental pull sees the row.
    const deviceNow = payload.device_now ? Date.parse(payload.device_now) : NaN;
    this.offsetMs = Number.isFinite(deviceNow) ? Date.now() - deviceNow : 0;
    // One lookup instead of one per user-reference column per row.
    this.users = new Map(db.all(`SELECT id, is_active FROM users`).map(u => [u.id, u]));
    this.knownUsers = new Set(this.users.keys());
    // Tables' own per-push state (self-assignments, device accounting rows): see each table's prepare().
    this.state = {};
    this.colsByTable = new Map();
    // A push is thousands of rows about a few dozen clients. What is asked of each client is asked once:
    // whether it was purged and which record it was merged into (neither can change during a push: purges and
    // merges re-point child rows, and the clients rows are applied before any child's), and whether the user
    // may reach it -- remembered only when yes, and forgotten whenever an assignment or client row is written.
    this.memo = { purged: new Map(), keeper: new Map(), access: new Set() };
  }
  clientPurged(id) { let v = this.memo.purged.get(id); if (v === undefined) this.memo.purged.set(id, v = clientPurged(id)); return v; }
  keeperOf(id) { let v = this.memo.keeper.get(id); if (v === undefined) this.memo.keeper.set(id, v = keeperOf(id)); return v; }
  canAccess(id, deidentified) {
    const k = `${deidentified ? 1 : 0}:${id}`;
    if (this.memo.access.has(k)) return true;
    const ok = auth.canAccessClient(this.user, id, { deidentified });
    if (ok) this.memo.access.add(k);
    return ok;
  }
  shift(ts) {
    if (!ts || !this.offsetMs) return ts;
    const t = Date.parse(ts);
    return Number.isFinite(t) ? new Date(t + this.offsetMs).toISOString() : ts;
  }
  cols(table) { if (!this.colsByTable.has(table)) this.colsByTable.set(table, cols(table)); return this.colsByTable.get(table); }
  // permanent: the office has ruled and a retry can never succeed, so the device stops resending the row.
  reject(table, id, reason, permanent = SYNC.isPermanentReason(reason)) { this.rejected.push({ table, id, reason, permanent }); }

  run() {
    for (const t of SYNC.tables) { const R = rules.forTable(t.name); if (R.prepare) R.prepare(this, this.tables[t.name] || []); }
    // One read of each Settings → Lists list for the whole push (options.js cached), not one per row.
    require('../options').cached(() => db.transaction(() => {
      for (const t of SYNC.tables) {
        const rows = this.tables[t.name];
        if (Array.isArray(rows) && rows.length) this.table(t, rows);
      }
      const deleting = new Set((this.payload.tombstones || []).map(ts => ts && `${ts.table_name}:${ts.id}`));
      for (const ts of this.payload.tombstones || []) this.tombstone(ts, deleting);
      // What a table does once the whole batch (rows and deletions) has landed: the office's supply draw-down
      // for the visits this push touched weighs a visit and its items together (server/rules/interventions.js).
      for (const t of SYNC.tables) { const R = rules.forTable(t.name); if (R.finish) R.finish(this); }
      this.deviceAudit(this.payload.audit);
    }));
    return { applied: this.applied, rejected: this.rejected, conflicts: this.conflicts, warnings: this.warnings, server_now: db.now(), clock_offset_ms: this.offsetMs, audit_accepted: this.applied._audit || 0 };
  }

  table(t, rows) {
    const R = rules.forTable(t.name);
    if (t.selfParent) rows = selfParentOrder(rows, t.selfParent);
    if (R.pushable === false) return; // users: never overwritten from devices
    if (R.order) rows = R.order(rows, this);
    // Shared program state the office alone keeps (supply counts): a device's copy is never the truth.
    if (t.serverOwned) {
      for (const raw of rows) if (raw && typeof raw.id === 'string') this.reject(t.name, raw.id, 'server-owned');
      this.applied[t.name] = 0; return;
    }
    // Syncing is not a way around a role's limits: the permission the REST route requires applies here too,
    // unless the table's rules say this row is one the REST door would take anyway (a worker's own
    // assignment on a client they just created, as POST /api/clients makes it).
    if (t.writePerm && !auth.hasPerm(this.user, t.writePerm)) {
      const kept = [];
      for (const raw of rows) {
        if (!raw || typeof raw.id !== 'string') continue;
        if (R.permitsWithoutWritePerm && R.permitsWithoutWritePerm(raw, this)) { kept.push(raw); continue; }
        this.reject(t.name, raw.id, `your role cannot write ${t.name}`);
      }
      if (!kept.length) { this.applied[t.name] = 0; return; }
      rows = kept;
    }
    const existingCols = this.cols(t.name); let n = 0;
    for (const raw of rows) {
      if (!raw || typeof raw.id !== 'string') continue;
      if (this.row(R, t, raw, existingCols) === true) n++;
    }
    this.applied[t.name] = n;
  }

  /** One row through the stages. Returns true when it was written. */
  row(R, t, raw, existingCols) {
    // prepare: a device on an older kernel names a renamed column the old way; without this its value is dropped.
    SYNC.upgradeLegacyRow(t, raw);
    // A child whose parent was refused has nothing to attach to, and inherits the parent's permanence.
    if (t.parent && raw[t.parent[1]] && this.rejectedIds.has(`${t.parent[0]}:${raw[t.parent[1]]}`)) {
      const permanent = this.rejectedIds.get(`${t.parent[0]}:${raw[t.parent[1]]}`);
      this.reject(t.name, raw.id, `its ${t.parent[0]} row was rejected`, permanent); this.rejectedIds.set(`${t.name}:${raw.id}`, permanent);
      return false;
    }
    const before = this.rejected.length;
    const ok = db.savepoint(() => this.apply(R, t, raw, existingCols), (err) => this.reject(t.name, raw.id, describeError(err)));
    // A merged-away client is the one refusal its children do not inherit: they are re-pointed at the record
    // that was kept and applied on their own merits.
    if (ok !== true && this.rejected.length > before) {
      const last = this.rejected[this.rejected.length - 1];
      if (last.id === raw.id && last.table === t.name && last.reason !== 'merged into another record') this.rejectedIds.set(`${t.name}:${raw.id}`, last.permanent);
    }
    return ok;
  }

  apply(R, t, raw, existingCols) {
    const user = this.user;
    // The device's own idea of when it last touched the row, in server time: for the comparison only.
    const incomingAt = this.shift(raw.updated_at || raw.created_at) || NEVER;
    const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
    // created_at is shifted once, when the office first sees the row; re-shifting it on every round trip
    // from a differently-skewed device walked it away from the truth.
    if (existing) delete raw.created_at; else if (raw.created_at) raw.created_at = this.shift(raw.created_at);
    delete raw.updated_at;
    const c = new RowContext(this, t, raw, existing, existingCols, incomingAt);
    const refused = (list) => this.settle(list, t, raw, c);

    // ---- authorise ----
    if (refused(this.authorise(R, t, raw, c))) return false;
    if (R.authorise && refused(R.authorise(raw, c))) return false;
    // ---- validate ----
    if (refused(this.validate(R, t, raw, c))) return false;
    // ---- resolve: last write wins ----
    if (existing && !c.allowedChange && (existing.updated_at || existing.created_at || NEVER) >= incomingAt) {
      // The office copy is newer, so the device's edit loses. It must not lose silently: the person who typed
      // it saw "saved". The columns that differ (never the values) go to the audit log and to the device.
      const lost = changedColumns(t, existing, raw, existingCols);
      if (lost.length && (existing.updated_at || existing.created_at || NEVER) > incomingAt) {
        this.conflicts.push({ table: t.name, id: raw.id, label: t.name === 'clients' ? existing.client_code : null, columns: lost, server_updated_at: existing.updated_at, device_updated_at: incomingAt });
        audit.log({ user, action: 'sync.conflict', entity: t.name, entityId: raw.id, clientId: t.clientCol ? raw[t.clientCol] : null, ip: 'device', details: { columns: lost, server_had: existing.updated_at, device_sent: incomingAt, kept: 'office' } });
      }
      return false;
    }
    // ---- normalise ----
    if (refused(this.attribute(R, t, raw, c))) return false;
    if (R.normalise && refused(R.normalise(raw, c))) return false;
    if (db.one(`SELECT 1 FROM tombstones WHERE table_name=? AND id=? AND deleted_at > ?`, t.name, raw.id, incomingAt)) return false; // deleted on the server after the device's edit
    if (R.beforeWrite && refused(R.beforeWrite(raw, c))) return false;
    // ---- apply ----
    // A user id minted on the device means nothing here, so it becomes the syncing user.
    for (const col of SYNC.user_ref_cols) if (raw[col] && !this.knownUsers.has(raw[col]) && existingCols.includes(col)) raw[col] = user.id;
    if (R.beforeStore) R.beforeStore(raw, c);
    const o = SYNC.importRow(t, raw, existingCols);
    if (R.storeRow) R.storeRow(o, raw, c);
    // Stamped in server time so every other device's next incremental pull picks the row up.
    if (existingCols.includes('updated_at')) o.updated_at = db.now();
    const keys = Object.keys(o).filter(k => k !== 'id');
    if (existing) {
      // Last write wins at row granularity, so a device's edit can quietly revert a field someone changed at the
      // office. It still wins, but not silently: the columns it replaced are recorded, by name only.
      const overwritten = keys.filter(k => k !== 'updated_at' && k !== 'created_at' && String(existing[k] ?? '') !== String(o[k] ?? ''));
      if (overwritten.length) {
        audit.log({ user, action: 'sync.overwrite', entity: t.name, entityId: raw.id, clientId: t.clientCol ? raw[t.clientCol] : null, ip: 'device',
          details: { columns: overwritten, server_had: existing.updated_at, device_sent: incomingAt } });
      }
      db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
    } else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
    // A row that comes back after being deleted must not leave its tombstone behind, or other devices are told
    // to delete a row that is alive here.
    db.run(`DELETE FROM tombstones WHERE table_name=? AND id=?`, t.name, raw.id);
    if (R.afterApply) R.afterApply(raw, o, c);
    if (t.name === 'assignments' || t.name === 'clients') this.memo.access.clear(); // who may reach whom may have changed
    // Flagged: the row stands, and the device (sync screen) and the audit trail say what the office noticed.
    for (const f of c.flags) {
      this.warnings.push({ table: t.name, id: raw.id, reason: f.reason, flagged: true });
      audit.log({ user, action: 'sync.conflict', entity: t.name, entityId: raw.id, clientId: t.clientCol ? raw[t.clientCol] : (t.name === 'clients' ? raw.id : null), ip: 'device',
        details: { kept: 'device', flagged: f.code || 'rule', columns: f.fields ? Object.keys(f.fields) : undefined } });
    }
    return true;
  }

  /**
   * Act on a stage's refusals (null, one, or a list): a flag is kept for when the row lands; the first fatal one
   * rejects the row. Returns true when the row stops here.
   */
  settle(list, t, raw, c) {
    if (!list) return false;
    for (const r of Array.isArray(list) ? list : [list]) {
      if (!r) continue;
      if (r.quiet) return true; // nothing to apply, and nothing to tell the device
      if (r.flag) { c.flags.push(r); continue; }
      this.reject(t.name, raw.id, r.reason, r.permanent);
      if (r.audit) audit.log({ user: this.user, ip: 'device', success: false, ...r.audit });
      return true;
    }
    return false;
  }

  /** What every table shares before its own rules: purged, merged, caseload, whose record, the legal record. */
  authorise(R, t, raw, c) {
    const { user, existing } = c;
    // A purged record stays purged: nothing a device holds can bring back a client the retention policy removed.
    if (t.name === 'clients' && clientPurged(raw.id)) return { reason: 'purged' };
    if (t.clientCol && t.name !== 'clients' && raw[t.clientCol] && this.clientPurged(raw[t.clientCol])) return { reason: 'purged' };
    if (t.scope === 'via-note' && raw.note_id && db.one(`SELECT 1 FROM tombstones WHERE table_name='notes' AND id=?`, raw.note_id)) return { reason: 'purged' };
    // A merge is the office's decision about who is the same person. A device that still holds the duplicate
    // keeps working on it offline; what it sends is re-pointed at the record that was kept, and an existing
    // child never moves between clients by sync at all.
    if (t.name === 'clients' && existing && existing.merged_into) return { reason: 'merged into another record' };
    if (t.clientCol && t.name !== 'clients') {
      if (existing) raw[t.clientCol] = existing[t.clientCol];
      else if (raw[t.clientCol]) raw[t.clientCol] = this.keeperOf(raw[t.clientCol]);
    }
    // Caseload scoping applies to everything that carries a client, the optional-client tables included.
    // deidentified: as over REST (crud.js), finance may file an expenditure against a client it knows by code.
    if ((t.scope === 'client' || t.scope === 'client-or-null') && raw[t.clientCol] && t.name !== 'clients' && !(R.outsideCaseload && R.outsideCaseload(raw, c)) && !this.canAccess(raw[t.clientCol], true)) return { reason: 'not on caseload' };
    if (t.name === 'clients' && existing && !this.canAccess(raw.id, false)) return { reason: 'not on caseload' };
    // Another worker's record with no client is not this device's to change: the owner rule REST, pull and exports
    // share (sync-tables.js clientOrNullScope, and mayReachUnlinked for one row).
    if (existing && !SYNC.mayReachUnlinked(t.name, user, existing, auth.hasPerm)) return { reason: 'not permitted' };
    // Another worker's record the REST routes would not let this user edit (crud.js canEdit, the same rule),
    // unless the change is one their own work makes as a side effect (a discharge cancelling the client's to-dos).
    if (existing && R.editableBy) {
      const no = R.editableBy(user, existing);
      if (no && !(R.othersMayChange && R.othersMayChange(existing, raw, c.changed(), c))) return no;
    }
    // The legal record (consents, disclosures, addenda, a problem's history...): a device may add to it, never
    // rewrite it. The one change a table allows (a consent's revocation) changes nothing else.
    if (existing && R.immutable) {
      const changed = c.changed();
      const allowed = R.allowChange ? R.allowChange(existing, raw, changed, c) : null;
      if (!allowed) return changed.length ? { reason: 'immutable' } : { reason: null, quiet: true };
      c.allowedChange = true;
      for (const k of Object.keys(raw)) if (k !== 'id' && !allowed.includes(k)) delete raw[k];
    }
    return null;
  }

  /** The table's own check, the REST shape's fields and the programme module: fatal refusals first. */
  validate(R, t, raw, c) {
    const out = R.check ? refusals(R.check(raw, c)) : [];
    if (!R.module && !R.stored.length) return out;
    if (R.module && (!c.existing || c.changed().length) && !require('../programme').moduleOn(R.module)) {
      // Presentation and new-work gating, not a permission: the device showed the module when this was
      // recorded, so the work lands and the office is told it arrived while the module is off.
      out.push(require('./core').flag(`was accepted, but ${require('../programme').MODULES.find(m => m.key === R.module).label} is switched off at the office; an administrator can switch it on in Settings › Program › Modules`, { code: 'module_off' }));
    }
    if (R.stored.length) {
      let changed = null;
      if (c.existing) {
        const cols = new Set(c.changed());
        changed = new Set(Object.entries(R.columns).filter(([, col]) => cols.has(col)).map(([k]) => k));
      }
      out.push(...checkFields(R, raw, { existing: c.existing, changed }));
    }
    // Fatal refusals first, so a flag cannot hide one.
    return out.length > 1 ? out.sort((a, b) => Number(a.flag) - Number(b.flag)) : out;
  }

  /**
   * Who did the work. A device may name another worker only when it names a real, active office account and
   * the syncing user could have done the same over REST; otherwise the row is refused rather than quietly
   * re-attributed to whoever happened to press Sync on a shared phone.
   */
  attribute(R, t, raw, c) {
    if (!R.owner) return null;
    const { col, all } = R.owner; const { user, existing } = c;
    const want = raw[col];
    if (existing && (!want || !auth.hasPerm(user, all))) raw[col] = existing[col];
    else if (!want) raw[col] = user.id;
    else if (want !== user.id && want !== (existing && existing[col])) {
      const target = this.users.get(want);
      // An id the office has never heard of is a device-minted local account, not another worker: it is
      // remapped to the syncing user with every other user reference.
      if (target && !target.is_active) return { reason: 'attributed to a user the office has deactivated' };
      if (target && !auth.hasPerm(user, all)) return { reason: 'attributed to another user, which your role cannot do' };
    }
    return null;
  }

  tombstone(ts, deleting) {
    const user = this.user;
    const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t || t.name === 'users' || typeof ts.id !== 'string') return;
    const R = rules.forTable(t.name);
    ts.deleted_at = this.shift(ts.deleted_at);
    if (t.serverOwned) { this.reject(t.name, ts.id, 'server-owned'); return; }
    if (t.writePerm && !auth.hasPerm(user, t.writePerm)) { this.reject(t.name, ts.id, `your role cannot delete ${t.name}`); return; }
    const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ts.id);
    if (!existing) return;
    if (R.tombstone === 'never') return; // never hard-deleted through sync (the legal record)
    const clientId = t.clientCol ? existing[t.clientCol] : null;
    if (clientId && !auth.canAccessClient(user, clientId)) { this.reject(t.name, ts.id, 'not on caseload'); return; }
    if (t.scope === 'all' && !auth.hasPerm(user, 'clients:all')) return; // shared reference data is not deleted from devices
    // Whose record it is: the REST DELETE route's rule, and a record with no client is its owners'.
    if (!SYNC.mayReachUnlinked(t.name, user, existing, auth.hasPerm)) { this.reject(t.name, ts.id, 'not permitted'); return; }
    const no = R.deletableBy ? R.deletableBy(user, existing, { deleting }) : R.editableBy ? R.editableBy(user, existing) : null;
    if (no === 'skip') return;
    if (no) { this.reject(t.name, ts.id, no.reason, no.permanent); return; }
    if ((existing.updated_at || existing.created_at || NEVER) < ts.deleted_at) {
      db.savepoint(() => { db.run(`DELETE FROM ${t.name} WHERE id=?`, ts.id); db.tombstone(t.name, ts.id); }, (err) => this.reject(t.name, ts.id, describeError(err)));
      if (R.afterDelete) R.afterDelete(existing, this);
    }
  }

  // A device's audit rows are its own record of what its user did: re-logged here under that user, the
  // free-text details kept but bounded so a device cannot write arbitrary structure (or PHI) into the trail.
  deviceAudit(rows) {
    const auditRows = (rows || []).slice(0, 5000);
    for (const a of auditRows) {
      if (!a || !a.action) continue;
      db.savepoint(() => audit.log({ user: this.user, action: `device.${String(a.action).slice(0, 80)}`, entity: a.entity ? String(a.entity).slice(0, 60) : undefined, entityId: a.entity_id, clientId: a.client_id, ip: 'device', success: a.success !== 0, details: { at: a.at, device: true, ...sanitiseDetails(a.details) } }), () => {});
    }
    this.applied._audit = auditRows.length;
  }
}

/** Apply a device's push as `user`. */
function push(user, payload) { return new PushSession(user, payload).run(); }

module.exports = { push, PushSession, changedColumns, describeError, keeperOf, NEVER };
