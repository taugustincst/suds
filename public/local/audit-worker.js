(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // server/small-cells.js
  var require_small_cells = __commonJS({
    "server/small-cells.js"(exports, module) {
      "use strict";
      var SECONDARY = "suppressed";
      var WITHHELD = "withheld";
      var primary = (T) => `<${T}`;
      var FOLDED = "Other (combined)";
      var isSmall = (v, T) => typeof v === "number" && v > 0 && v < T;
      var isNum = (v) => typeof v === "number";
      var BIG = 1e12;
      function cell(v, { threshold, exact }) {
        return !exact && isSmall(v, threshold) ? primary(threshold) : v;
      }
      function pinned(hidden, S) {
        if (hidden.length === 1) return true;
        const sumLo = hidden.reduce((a, c) => a + c.lo, 0);
        const sumHi = hidden.reduce((a, c) => a + c.hi, 0);
        return hidden.some((c) => Math.max(c.lo, S - (sumHi - c.hi)) === Math.min(c.hi, S - (sumLo - c.lo)));
      }
      function star({ total, partitions = [], subsets = [], cover = [] }, { threshold: T, exact = false, fixedTotal = false, hidden = {} }) {
        if (exact) return { total, partitions: partitions.map((p) => [...p]), subsets: [...subsets], cover: [...cover] };
        const mk = (v) => ({ v, st: isSmall(v, T) ? "pri" : "vis" });
        const tot = { v: total, st: isSmall(total, T) ? "pri" : "vis" };
        const parts = partitions.map((p) => p.map(mk));
        const subs = subsets.map(mk);
        const cov = cover.map(mk);
        const force = (c) => {
          if (c && c.st === "vis" && c.v > 0) {
            c.st = "sec";
            c.sens = true;
          }
        };
        for (const [g, i] of hidden.partitions || []) force(parts[g][i]);
        for (const i of hidden.subsets || []) force(subs[i]);
        if (hidden.total) force(tot);
        const lo = (c) => c.st === "vis" ? c.v : c.st === "pri" ? 1 : T;
        const hi = (c) => c.st === "vis" ? c.v : c.st === "pri" ? T - 1 : Infinity;
        const vis = (cs) => cs.reduce((a, c) => a + (c.st === "vis" ? c.v : 0), 0);
        const hid = (cs) => cs.filter((c) => c.st !== "vis");
        const sum = (xs) => xs.reduce((a, b) => a + b, 0);
        const withheld = /* @__PURE__ */ new Set();
        const live = (g) => !withheld.has(g);
        function range() {
          let nlo = fixedTotal ? total : lo(tot);
          let nhi = fixedTotal ? total : hi(tot);
          const bounds = [];
          for (const p of parts.filter(live)) {
            const V = vis(p);
            const h = hid(p);
            bounds.push({ g: p, table: p, lo: V + sum(h.map(lo)), hi: V + sum(h.map(hi)) });
          }
          for (const s of subs.filter(live)) bounds.push({ g: [s], lo: lo(s), hi: Infinity });
          if (cov.length && live(cov)) {
            const V = vis(cov);
            const h = hid(cov);
            bounds.push({ g: cov, table: cov, lo: Math.max(0, ...cov.map(lo)), hi: V + sum(h.map(hi)) });
          }
          for (const b of bounds) {
            nlo = Math.max(nlo, b.lo);
            nhi = Math.min(nhi, b.hi);
          }
          return { nlo, nhi, bounds };
        }
        function exposures() {
          const { nlo, nhi, bounds } = range();
          const out = [];
          const smallRest = (s) => isSmall(total - s.v, T);
          if ((tot.st === "pri" || tot.sens) && nlo === nhi) out.push({ home: [] });
          for (const p of parts.filter(live)) {
            const V = vis(p);
            const h = hid(p);
            for (const c of h) {
              if (c.st !== "pri" && !c.sens) continue;
              const o = h.filter((x) => x !== c);
              const a = Math.max(lo(c), nlo - V - sum(o.map(hi)));
              const b = Math.min(hi(c), nhi - V - sum(o.map(lo)));
              if (a === b) out.push({ home: p, table: p });
            }
          }
          for (const s of subs.filter(live)) {
            if ((s.st === "pri" || s.sens) && lo(s) === Math.min(hi(s), nhi)) out.push({ home: [s], sub: s });
            if (smallRest(s) && Math.max(0, nlo - hi(s)) === nhi - lo(s)) out.push({ home: [s], own: s, sub: s });
          }
          if (cov.length && live(cov)) {
            const probes = (k) => {
              const others = cov.filter((x) => x !== k && x.st !== "vis");
              return [nlo, isFinite(nhi) ? nhi : BIG, ...others.map(hi).filter((x) => isFinite(x) && x > nlo && x < nhi)];
            };
            for (const k of cov) {
              const Vo = sum(cov.filter((x) => x !== k && x.st === "vis").map((x) => x.v));
              const others = cov.filter((x) => x !== k && x.st !== "vis");
              const g = (N) => N - Vo - sum(others.map((x) => Math.min(hi(x), N)));
              let a = lo(k);
              let b = Math.min(hi(k), nhi);
              if (k.st !== "vis") a = Math.max(lo(k), Math.min(...probes(k).map(g)));
              else {
                a = k.v;
                b = k.v;
              }
              if (k.st === "pri" && a === b) out.push({ home: cov, table: cov });
              if (smallRest(k)) {
                const restLo = k.st === "vis" ? nlo - k.v : Math.max(0, nlo - hi(k));
                const topN = isFinite(nhi) ? nhi : BIG;
                const restHi = k.st === "vis" ? nhi - k.v : Math.min(nhi - lo(k), Vo + sum(others.map((x) => Math.min(hi(x), topN))));
                if (restLo === restHi) out.push({ home: cov, own: k, table: cov });
              }
            }
          }
          return { out, nlo, nhi, bounds };
        }
        const hideSmallest = (cs, prefer) => {
          cs = cs.filter(live);
          if (prefer && prefer.st === "vis" && prefer.v > 0) {
            prefer.st = "sec";
            return true;
          }
          let best = null;
          for (const c of cs) if (c.st === "vis" && c.v > 0 && (!best || c.v < best.v)) best = c;
          if (!best) return false;
          best.st = "sec";
          return true;
        };
        for (let guard = 0; guard < 1e4; guard++) {
          const { out, nlo, nhi, bounds } = exposures();
          if (!out.length) break;
          const e = out[0];
          if (hideSmallest(e.home, e.own)) continue;
          if (!fixedTotal && tot.st === "vis" && tot.v > 0) {
            tot.st = "sec";
            continue;
          }
          let did = false;
          for (const b of bounds) if ((b.lo === nlo || b.hi === nhi) && hideSmallest(b.g)) did = true;
          if (did) continue;
          if (![...parts.flat(), ...subs, ...cov].some((c) => hideSmallest([c]))) break;
        }
        for (let guard = 0; guard < 1e3; guard++) {
          const { out, nlo, nhi, bounds } = exposures();
          if (!out.length) break;
          const e = out.find((x) => x.table);
          if (e) {
            withheld.add(e.table);
            continue;
          }
          let did = false;
          for (const b of bounds) if (b.table && (b.lo === nlo || b.hi === nhi)) {
            withheld.add(b.table);
            did = true;
          }
          if (did) continue;
          for (const x of out) if (x.sub) withheld.add(x.sub);
          if (!out.some((x) => x.sub)) break;
        }
        const show = (c) => withheld.has(c) ? WITHHELD : c.st === "vis" ? c.v : c.st === "pri" ? primary(T) : SECONDARY;
        return { total: fixedTotal ? total : show(tot), partitions: parts.map((p) => withheld.has(p) ? null : p.map(show)), subsets: subs.map(show), cover: withheld.has(cov) ? null : cov.map(show) };
      }
      function noLonely(shown) {
        const out = [...shown];
        if (out.filter((v) => !isNum(v)).length !== 1) return out;
        let next = -1;
        out.forEach((v, i) => {
          if (isNum(v) && v > 0 && (next < 0 || v < out[next])) next = i;
        });
        if (next >= 0) out[next] = SECONDARY;
        return out;
      }
      function table(rows, keys, { threshold: T, exact = false, totals = {}, mirror = {}, hidden = {} }) {
        const out = rows.map((r) => ({ ...r }));
        const tot = { ...totals };
        if (exact) return { rows: out, totals: tot };
        const hiddenIdx = {};
        for (const key of keys) {
          let shown;
          if (isNum(totals[key])) {
            const s = star({ total: totals[key], partitions: [rows.map((r) => r[key])] }, { threshold: T, hidden: { partitions: (hidden[key] || []).map((i) => [0, i]) } });
            shown = s.partitions[0] || rows.map(() => WITHHELD);
            tot[key] = s.total;
          } else {
            shown = noLonely(rows.map((r) => cell(r[key], { threshold: T })));
          }
          hiddenIdx[key] = /* @__PURE__ */ new Set();
          shown.forEach((v, i) => {
            out[i][key] = v;
            if (!isNum(v)) {
              hiddenIdx[key].add(i);
              out[i].suppressed = true;
            }
          });
        }
        for (const [key, of] of Object.entries(mirror)) {
          const idx = /* @__PURE__ */ new Set();
          const src = hiddenIdx[of] || new Set(out.map((r, i) => r[of] === null || r[of] === void 0 || isNum(r[of]) ? -1 : i).filter((i) => i >= 0));
          for (const i of src) if (out[i][key] !== null && out[i][key] !== void 0) {
            idx.add(i);
            out[i][key] = SECONDARY;
          }
          const mirrored = new Set(idx);
          const total = tot[key];
          const published = isNum(total);
          for (; ; ) {
            const hiddenCells = [...idx].map((i) => ({ v: rows[i][key], ...mirrored.has(i) ? { lo: 0, hi: Infinity } : { lo: 1, hi: Infinity } }));
            if (!hiddenCells.length) break;
            const visibleSum = out.reduce((a, r, i) => a + (idx.has(i) || !isNum(r[key]) ? 0 : r[key]), 0);
            const visibleNonZero = out.some((r, i) => !idx.has(i) && isNum(r[key]) && r[key] > 0);
            const risky = published ? pinned(hiddenCells, total - visibleSum) : hiddenCells.length === 1 && visibleNonZero;
            if (!risky) break;
            let next = -1;
            out.forEach((r, i) => {
              if (!idx.has(i) && isNum(r[key]) && r[key] > 0 && (next < 0 || r[key] < out[next][key])) next = i;
            });
            if (next < 0) {
              if (published) tot[key] = SECONDARY;
              break;
            }
            idx.add(next);
            out[next][key] = SECONDARY;
            out[next].suppressed = true;
          }
        }
        return { rows: out, totals: tot };
      }
      var withCell = (x, key, v) => ({ ...x, [key]: v, ...isNum(v) ? {} : { suppressed: true } });
      module.exports = { cell, table, star, noLonely, pinned, isSmall, withCell, SECONDARY, WITHHELD, FOLDED, primary };
    }
  });

  // server/sdc.js
  var require_sdc = __commonJS({
    "server/sdc.js"(exports, module) {
      "use strict";
      var EPS = 1e-9;
      var FEAS = 1e-7;
      function simplex(n, rows, lb, ub, c) {
        const R = [];
        for (const r of rows) {
          let b = r.b;
          for (let j = 0; j < n; j++) b -= r.a[j] * lb[j];
          R.push({ a: r.a.slice(), op: r.op, b });
        }
        for (let j = 0; j < n; j++) {
          if (ub[j] === Infinity) continue;
          if (ub[j] < lb[j] - FEAS) return { status: "infeasible", work: n };
          const a2 = new Array(n).fill(0);
          a2[j] = 1;
          R.push({ a: a2, op: "<=", b: ub[j] - lb[j] });
        }
        for (const r of R) if (r.b < 0) {
          r.a = r.a.map((x2) => -x2);
          r.b = -r.b;
          r.op = r.op === "<=" ? ">=" : r.op === ">=" ? "<=" : "=";
        }
        const m = R.length;
        let nS = 0;
        let nA = 0;
        for (const r of R) {
          if (r.op !== "=") nS++;
          if (r.op !== "<=") nA++;
        }
        const W = n + nS + nA;
        const T = [];
        const basis = [];
        const isArt = new Uint8Array(W);
        let s = n;
        let a = n + nS;
        for (let i = 0; i < m; i++) {
          const row = new Float64Array(W + 1);
          const r = R[i];
          for (let j = 0; j < n; j++) row[j] = r.a[j];
          row[W] = r.b;
          if (r.op === "<=") {
            row[s] = 1;
            basis.push(s);
            s++;
          } else if (r.op === ">=") {
            row[s] = -1;
            s++;
            row[a] = 1;
            isArt[a] = 1;
            basis.push(a);
            a++;
          } else {
            row[a] = 1;
            isArt[a] = 1;
            basis.push(a);
            a++;
          }
          T.push(row);
        }
        let work = m * (W + 1);
        const pivot = (z2, pi, pj) => {
          work += m + 2 * (W + 1);
          const p = T[pi];
          const v = p[pj];
          for (let k = 0; k <= W; k++) p[k] /= v;
          for (let i = 0; i < m; i++) {
            if (i === pi) continue;
            const f2 = T[i][pj];
            if (Math.abs(f2) < EPS) continue;
            const row = T[i];
            for (let k = 0; k <= W; k++) row[k] -= f2 * p[k];
            work += W + 1;
          }
          const f = z2[pj];
          if (Math.abs(f) > EPS) for (let k = 0; k <= W; k++) z2[k] -= f * p[k];
          basis[pi] = pj;
        };
        const phase = (d2, allowed) => {
          const z2 = new Float64Array(W + 1);
          for (let j = 0; j < W; j++) z2[j] = d2[j] || 0;
          work += W + 1;
          for (let i = 0; i < m; i++) {
            const db = d2[basis[i]] || 0;
            if (db) {
              for (let k = 0; k <= W; k++) z2[k] -= db * T[i][k];
              work += W + 1;
            }
          }
          for (let iter = 0; iter < 5e4; iter++) {
            let pj = -1;
            for (let j = 0; j < W; j++) if (allowed(j) && z2[j] > FEAS) {
              pj = j;
              break;
            }
            if (pj < 0) return { z: z2, bounded: true };
            let pi = -1;
            let best = Infinity;
            for (let i = 0; i < m; i++) {
              const t = T[i][pj];
              if (t <= FEAS) continue;
              const ratio = T[i][W] / t;
              if (ratio < best - EPS || Math.abs(ratio - best) <= EPS && basis[i] < basis[pi]) {
                best = ratio;
                pi = i;
              }
            }
            if (pi < 0) return { z: z2, bounded: false };
            pivot(z2, pi, pj);
          }
          throw new Error("simplex did not converge");
        };
        if (nA) {
          const d2 = new Array(W).fill(0);
          for (let j = 0; j < W; j++) if (isArt[j]) d2[j] = -1;
          const { z: z2 } = phase(d2, () => true);
          if (-z2[W] < -FEAS) return { status: "infeasible", work };
          for (let i = 0; i < m; i++) {
            if (!isArt[basis[i]]) continue;
            for (let j = 0; j < W; j++) if (!isArt[j] && Math.abs(T[i][j]) > FEAS) {
              pivot(new Float64Array(W + 1), i, j);
              break;
            }
          }
        }
        const d = new Array(W).fill(0);
        for (let j = 0; j < n; j++) d[j] = c[j] || 0;
        const { z, bounded } = phase(d, (j) => !isArt[j]);
        if (!bounded) return { status: "unbounded", work };
        const x = lb.slice();
        for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] += T[i][W];
        let value = 0;
        for (let j = 0; j < n; j++) value += (c[j] || 0) * x[j];
        return { status: "optimal", x, value, work };
      }
      function newMeter(limit = Infinity, timeLimitMs = Infinity) {
        return { steps: 0, calls: 0, limit, deadline: Date.now() + timeLimitMs, over: false, backstop: false };
      }
      function tick(m, cost = 1) {
        if (m.over) return true;
        m.steps += cost + 1;
        if (m.steps > m.limit) {
          m.over = true;
          return true;
        }
        if ((++m.calls & 31) === 0 && Date.now() > m.deadline) {
          m.over = true;
          m.backstop = true;
          return true;
        }
        return false;
      }
      function intMax(prob, c, known, { enough = Infinity, budget = 4e3, meter = null } = {}) {
        const dot = (x) => c.reduce((s, cj, j) => s + cj * x[j], 0);
        let best = known ? Math.round(dot(known)) : -Infinity;
        let bestX = known ? known.slice() : null;
        if (best >= enough) return { value: best, exact: true, x: bestX };
        const stack = [[prob.lb.slice(), prob.ub.slice()]];
        let nodes = 0;
        while (stack.length) {
          if (++nodes > budget || meter && meter.over) return { value: best, exact: false, x: bestX };
          const [lb, ub] = stack.pop();
          const r = simplex(prob.n, prob.rows, lb, ub, c);
          if (meter && tick(meter, r.work)) return { value: best, exact: false, x: bestX };
          if (r.status === "infeasible") continue;
          if (r.status === "unbounded") return { value: Infinity, exact: true, x: null };
          const bound = Math.floor(r.value + 1e-6);
          if (bound <= best) continue;
          let fj = -1;
          for (let j = 0; j < prob.n; j++) if (Math.abs(r.x[j] - Math.round(r.x[j])) > 1e-6) {
            fj = j;
            break;
          }
          if (fj < 0) {
            const v = Math.round(r.value);
            if (v > best) {
              best = v;
              bestX = r.x.map(Math.round);
            }
            if (best >= enough) return { value: best, exact: true, x: bestX };
            continue;
          }
          const f = Math.floor(r.x[fj]);
          const up = [lb.slice(), ub.slice()];
          up[0][fj] = f + 1;
          const down = [lb.slice(), ub.slice()];
          down[1][fj] = f;
          stack.push(up, down);
        }
        return { value: best, exact: true, x: bestX };
      }
      function intFeasibleIn(prob, c, lo, hi, { budget = 4e3, meter = null } = {}) {
        const rows = lo === hi ? [...prob.rows, { a: c, op: "=", b: lo }] : [...prob.rows, { a: c, op: ">=", b: lo }, { a: c, op: "<=", b: hi }];
        const zero = new Array(prob.n).fill(0);
        const stack = [[prob.lb.slice(), prob.ub.slice()]];
        let nodes = 0;
        while (stack.length) {
          if (++nodes > budget || meter && meter.over) return { feasible: false, exact: false };
          const [lb, ub] = stack.pop();
          const r = simplex(prob.n, rows, lb, ub, zero);
          if (meter && tick(meter, r.work)) return { feasible: false, exact: false };
          if (r.status !== "optimal") {
            if (r.status === "unbounded") return { feasible: true, exact: true };
            continue;
          }
          let fj = -1;
          for (let j = 0; j < prob.n; j++) if (Math.abs(r.x[j] - Math.round(r.x[j])) > 1e-6) {
            fj = j;
            break;
          }
          if (fj < 0) return { feasible: true, exact: true };
          const f = Math.floor(r.x[fj]);
          const up = [lb.slice(), ub.slice()];
          up[0][fj] = f + 1;
          const down = [lb.slice(), ub.slice()];
          down[1][fj] = f;
          stack.push(up, down);
        }
        return { feasible: false, exact: true };
      }
      var intFeasible = (prob, c, v, opts) => intFeasibleIn(prob, c, v, v, opts);
      function widenRange({ a, b, lo, hi, x, T, P, shows, over = () => false }) {
        const inside = (v) => v >= lo && v <= hi && v >= x - 2 * T && v <= x + 2 * T;
        const holes = [];
        for (let v = a - 1; b - a < P && inside(v) && !over(); v--) {
          if (shows(v)) a = v;
          else if (!holes.length && inside(v - 1) && !over() && shows(v - 1)) {
            holes.push(v);
            a = v - 1;
            v--;
          } else break;
        }
        for (let v = b + 1; b - a < P && inside(v) && !over(); v++) {
          if (shows(v)) b = v;
          else if (!holes.length && inside(v + 1) && !over() && shows(v + 1)) {
            holes.push(v);
            b = v + 1;
            v++;
          } else break;
        }
        return { range: [a, b], holes };
      }
      function auditor(model, T, { budget, meter = newMeter() }) {
        const { vars, derived = [], mirror = [] } = model;
        const P = Math.ceil(T / 2);
        const small = (x) => x > 0 && x < T;
        const opt = { budget, meter };
        const tableOf = /* @__PURE__ */ new Map();
        vars.forEach((v, i) => {
          if (!tableOf.has(v.table)) tableOf.set(v.table, []);
          tableOf.get(v.table).push(i);
        });
        const cache = /* @__PURE__ */ new Map();
        function relationships(values) {
          const cons = [];
          const dropped = [];
          model.cons.forEach((k, ci) => {
            const lhs = k.terms.reduce((s, [i, c]) => s + c * values[i], 0);
            const ok = k.op === "=" ? lhs === k.rhs : k.op === "<=" ? lhs <= k.rhs : lhs >= k.rhs;
            if (!ok && model.strict && !k.soft) throw new Error(`the truth violates ${JSON.stringify(k.terms.map(([i, c]) => [vars[i].id, c]))} ${k.op} ${k.rhs}`);
            if (ok) cons.push(k);
            else dropped.push(ci);
          });
          const byVar = vars.map(() => []);
          cons.forEach((k, ci) => {
            for (const [i] of k.terms) byVar[i].push(ci);
          });
          return { cons, byVar, sig: dropped.join(",") };
        }
        function world(values) {
          const { cons, byVar, sig } = relationships(values);
          const applyMirror = (s) => {
            for (const [p, f] of mirror) if ((s[p] === "pri" || s[p] === "sec") && s[f] === "vis") s[f] = "sec";
            else if (s[p] === "withheld" && s[f] === "vis") s[f] = "withheld";
          };
          const bounds = (s, i) => {
            switch (s[i]) {
              case "vis":
                return [values[i], values[i]];
              case "pri":
                return [1, T - 1];
              case "sec":
                return vars[i].people ? [T, Infinity] : [0, Infinity];
              default:
                return [0, Infinity];
            }
          };
          function problem(s, terms, all = false) {
            const idx = /* @__PURE__ */ new Map();
            const queue = [];
            const add = (i) => {
              if (s[i] !== "vis" && !idx.has(i)) {
                idx.set(i, idx.size);
                queue.push(i);
              }
            };
            if (all) vars.forEach((_, i) => add(i));
            else for (const [i] of terms) add(i);
            let scan = terms.length;
            for (let q = 0; q < queue.length; q++) for (const ci of byVar[queue[q]]) {
              const k = cons[ci].terms;
              scan += k.length;
              for (const [j] of k) add(j);
            }
            const members = queue;
            const n = members.length;
            const touched = /* @__PURE__ */ new Set();
            for (const i of members) for (const ci of byVar[i]) touched.add(ci);
            const order = [...touched].sort((a, b) => a - b);
            const rhs = order.map((ci) => {
              let b = cons[ci].rhs;
              for (const [j, c2] of cons[ci].terms) if (!idx.has(j)) b -= c2 * values[j];
              return b;
            });
            tick(meter, 2 * scan + n);
            let constant = 0;
            for (const [i, co] of terms) if (!idx.has(i)) constant += co * values[i];
            const key = `${sig}|${members.map((i) => i + s[i]).join(",")}|${rhs.join(",")}|${constant}`;
            let prob = null;
            let c = null;
            const build = () => {
              const rows = order.map((ci, r) => {
                const a = new Array(n).fill(0);
                for (const [j, co] of cons[ci].terms) if (idx.has(j)) a[idx.get(j)] += co;
                return { a, op: cons[ci].op, b: rhs[r] };
              });
              prob = { n, rows, lb: members.map((i) => bounds(s, i)[0]), ub: members.map((i) => bounds(s, i)[1]) };
              c = new Array(n).fill(0);
              for (const [i, co] of terms) if (idx.has(i)) c[idx.get(i)] += co;
            };
            return { get prob() {
              if (!prob) build();
              return prob;
            }, get c() {
              if (!c) build();
              return c;
            }, constant, key, n, members, idx };
          }
          function reaches(p) {
            if (p.n === 0) return small(p.constant);
            const r = intFeasibleIn(p.prob, p.c, 1 - p.constant, T - 1 - p.constant, opt);
            return r.feasible || !r.exact;
          }
          const classCode = (s, i) => s[i] === "pri" ? "s" : s[i] === "vis" ? values[i] === 0 ? "0" : vars[i].people ? "b" : "a" : s[i] === "sec" && vars[i].people ? "b" : "a";
          const classSigs = /* @__PURE__ */ new WeakMap();
          function targets(s, q) {
            if (!classSigs.has(s)) classSigs.set(s, vars.map((_, i) => classCode(s, i)).join(""));
            const quick = `${sig}|sym|${q.id}|${classSigs.get(s)}`;
            if (cache.has(quick)) return cache.get(quick);
            const out = targetsOf(s, q);
            cache.set(quick, out);
            return out;
          }
          function targetsOf(s, q) {
            const cls = (i) => {
              if (s[i] === "pri") return [1, T - 1];
              if (s[i] === "vis") return values[i] === 0 ? [0, 0] : vars[i].people ? [T, Infinity] : [0, Infinity];
              if (s[i] === "sec" && vars[i].people) return [T, Infinity];
              return [0, Infinity];
            };
            const idx = /* @__PURE__ */ new Map();
            const queue = [];
            const add = (i) => {
              if (!idx.has(i)) {
                idx.set(i, idx.size);
                queue.push(i);
              }
            };
            for (const [i] of q.terms) add(i);
            for (let k = 0; k < queue.length; k++) {
              const [lo2, hi2] = cls(queue[k]);
              if (lo2 === hi2) continue;
              for (const ci of byVar[queue[k]]) for (const [j] of cons[ci].terms) add(j);
            }
            const key = `${sig}|sym|${q.id}|${queue.map((i) => `${i}:${cls(i).join(":")}`).join(",")}`;
            if (cache.has(key)) return cache.get(key);
            const n = queue.length;
            const touched = /* @__PURE__ */ new Set();
            for (const i of queue) {
              const [lo2, hi2] = cls(i);
              if (lo2 !== hi2) for (const ci of byVar[i]) touched.add(ci);
            }
            const rows = [...touched].sort((a2, b2) => a2 - b2).map((ci) => {
              const a2 = new Array(n).fill(0);
              for (const [j, c2] of cons[ci].terms) a2[idx.get(j)] += c2;
              return { a: a2, op: cons[ci].op, b: cons[ci].rhs };
            });
            const lb = queue.map((i) => cls(i)[0]);
            const ub = queue.map((i) => cls(i)[1]);
            const c = new Array(n).fill(0);
            for (const [i, co] of q.terms) c[idx.get(i)] += co;
            const hi = simplex(n, rows, lb, ub, c);
            const lo = simplex(n, rows, lb, ub, c.map((x) => -x));
            tick(meter, hi.work + lo.work);
            const a = lo.status === "optimal" ? Math.max(1, Math.ceil(-lo.value - 1e-6)) : 1;
            const b = hi.status === "optimal" ? Math.min(T - 1, Math.floor(hi.value + 1e-6)) : T - 1;
            const out = a > b ? [] : a === b ? [a] : [a, b];
            out.open = hi.status !== "optimal" || hi.value >= T - 1e-6;
            cache.set(key, out);
            return out;
          }
          function deficit(s, q) {
            const p = problem(s, q.terms);
            if (q.kind === "cond") {
              const rk = `${q.id}|reach|${p.key}`;
              if (!cache.has(rk)) cache.set(rk, reaches(p));
              if (!cache.get(rk)) return 0;
            }
            const t = q.kind === "sec" ? null : targets(s, q);
            const key = `${q.id}|${q.kind}|${p.key}|${t ? `${t.join(",")}:${t.open}` : ""}`;
            if (cache.has(key)) return cache.get(key);
            let d = 0;
            if (q.kind === "pri" || q.kind === "cond") {
              if (p.n === 0) d = t.filter((v) => p.constant !== v).length + (q.kind === "cond" && t.open ? 1 : 0);
              else {
                d = t.filter((v) => !intFeasible(p.prob, p.c, v - p.constant, opt).feasible).length;
                if (q.kind === "cond" && t.open && intMax(p.prob, p.c, null, { ...opt, enough: T - p.constant }).value + p.constant < T) d += 1;
              }
            } else {
              const lo = -intMax(p.prob, p.c.map((x) => -x), null, opt).value + p.constant;
              const hi = intMax(p.prob, p.c, null, { ...opt, enough: lo - p.constant + P }).value + p.constant;
              d = hi - lo >= P ? 0 : Number.isFinite(hi - lo) ? P - (hi - lo) : P + 1;
            }
            cache.set(key, d);
            return d;
          }
          function quantities(s) {
            const out = [];
            vars.forEach((v, i) => {
              if (!v.people || v.aux) return;
              if (s[i] === "pri") out.push({ id: v.id, terms: [[i, 1]], kind: "pri", home: [i] });
              else if (s[i] === "sec") out.push({ id: v.id, terms: [[i, 1]], kind: "sec", home: [i] });
              else if ((s[i] === "withheld" || s[i] === "unpub") && byVar[i].length) out.push({ id: v.id, terms: [[i, 1]], kind: "cond", home: [i] });
            });
            for (const q of derived) out.push({ id: q.id, terms: q.terms, kind: "cond", derived: true, home: q.terms.map(([i]) => i) });
            return out;
          }
          function levels(q) {
            const level = /* @__PURE__ */ new Map();
            let frontier = [...new Set(q.home)];
            frontier.forEach((i) => level.set(i, 0));
            for (let d = 1; frontier.length; d++) {
              const next = [];
              for (const i of frontier) for (const ci of byVar[i]) for (const [j] of cons[ci].terms) if (!level.has(j)) {
                level.set(j, d);
                next.push(j);
              }
              frontier = next;
            }
            return level;
          }
          return { applyMirror, problem, deficit, quantities, levels, reaches, targets, values, cons, byVar };
        }
        const TRIES = 12;
        const WITNESS_TRIES = 8;
        const WORLD_RUNS = 400;
        const WITNESS_RUNS = 24;
        function run(values, forced = []) {
          const w = world(values);
          const withheldTables = new Set(forced);
          const hideable = (s2, i) => s2[i] === "vis" && vars[i].published && values[i] > 0 && !withheldTables.has(vars[i].table);
          const withStatus = (s2, i, x) => {
            const t = s2.slice();
            t[i] = x;
            w.applyMirror(t);
            return t;
          };
          const withTable = (s2, table) => {
            const t = s2.slice();
            for (const i of tableOf.get(table)) if (vars[i].published) t[i] = "withheld";
            w.applyMirror(t);
            return t;
          };
          let s = vars.map((v, i) => !v.published ? "unpub" : withheldTables.has(v.table) ? "withheld" : v.people && small(values[i]) ? "pri" : "vis");
          for (const k of w.cons) {
            if (k.op !== "=" || k.rhs !== 0) continue;
            const tot = k.terms.filter(([, c]) => c === -1);
            const parts = k.terms.filter(([, c]) => c === 1);
            if (tot.length !== 1 || parts.length + 1 !== k.terms.length || parts.length < 2) continue;
            const t = tot[0][0];
            if (!vars[t].people || s[t] !== "vis" || values[t] === 0) continue;
            if (parts.every(([i]) => s[i] === "pri" || s[i] === "vis" && values[i] === 0) && parts.some(([i]) => s[i] === "pri")) s[t] = "sec";
          }
          const covers = [];
          for (const k of w.cons) {
            if (k.rhs !== 0 || k.op === "=" || k.terms.some(([, c]) => Math.abs(c) !== 1)) continue;
            const sign = k.op === ">=" ? 1 : -1;
            const parts = k.terms.filter(([, c]) => c === sign).map(([i]) => i);
            const tot = k.terms.filter(([, c]) => c === -sign);
            if (tot.length === 1 && parts.length >= 2 && vars[tot[0][0]].people && parts.every((i) => vars[i].people)) covers.push({ total: tot[0][0], parts });
          }
          const hiddenTotals = new Set(vars.map((_, i) => i).filter((i) => s[i] === "sec"));
          for (const k of w.cons) {
            if (k.op !== "<=" || k.rhs !== 0 || k.terms.length !== 2) continue;
            const [[a, ca], [b, cb]] = k.terms;
            const [sub, tot] = ca === 1 && cb === -1 ? [a, b] : ca === -1 && cb === 1 ? [b, a] : [null, null];
            if (sub !== null && hiddenTotals.has(tot) && vars[sub].people && s[sub] === "vis" && values[sub] >= T) s[sub] = "sec";
          }
          w.applyMirror(s);
          const watch = model.watch || {};
          for (const cover of covers) {
            const pri = cover.parts.flatMap((i) => s[i] === "pri" ? [i] : s[i] === "unpub" && watch[i] ? watch[i] : []);
            if (!pri.length) continue;
            const c = cover.parts.filter((i) => hideable(s, i)).sort((a, b) => vars[b].people - vars[a].people || a - b)[0];
            if (c === void 0) continue;
            const t = withStatus(s, c, "sec");
            const pc = w.problem(t, [[c, 1]]);
            const low = intMax(pc.prob, pc.c.map((x) => -x), null, opt);
            let pin = !low.exact || !Number.isFinite(low.value);
            const cmin = -low.value + pc.constant;
            for (const q of pri) {
              if (pin) break;
              const pq = w.problem(t, [[q, 1]]);
              if (!pq.idx.has(c)) continue;
              const a = new Array(pq.n).fill(0);
              a[pq.idx.get(c)] = 1;
              const prob = { ...pq.prob, rows: [...pq.prob.rows, { a, op: "=", b: cmin }] };
              for (const v of w.targets(t, { id: vars[q].id, terms: [[q, 1]] })) {
                const r = intFeasible(prob, pq.c, v - pq.constant, opt);
                if (!r.feasible) {
                  pin = true;
                  break;
                }
              }
            }
            if (pin) s = t;
          }
          const passed = /* @__PURE__ */ new Map();
          const touchOf = (st, q) => {
            const p = w.problem(st, q.terms);
            const t = new Set(q.terms.map(([i]) => i));
            let scan = 0;
            for (const i of p.members) {
              t.add(i);
              for (const ci of w.byVar[i]) {
                scan += w.cons[ci].terms.length;
                for (const [j] of w.cons[ci].terms) t.add(j);
              }
            }
            for (const [i] of q.terms) for (const ci of w.byVar[i]) {
              scan += w.cons[ci].terms.length;
              for (const [j] of w.cons[ci].terms) t.add(j);
            }
            tick(meter, scan);
            return t;
          };
          const follow = (st) => {
            const hl = model.headlineVar;
            if (hl === void 0 || st[hl] === "vis") return st;
            let t = null;
            for (const i of model.companions || []) if (st[i] === "vis" && vars[i].published && values[i] >= T) {
              t = t || st.slice();
              t[i] = "sec";
            }
            if (!t) return st;
            w.applyMirror(t);
            const changed = [];
            t.forEach((x, i) => {
              if (x !== st[i]) changed.push(i);
            });
            for (const [id, touch] of passed) if (changed.some((i) => touch.has(i))) passed.delete(id);
            return t;
          };
          for (let guard = 0; guard < 5e3; guard++) {
            if (meter.over) break;
            s = follow(s);
            let bad = null;
            let bd = 0;
            for (const q of w.quantities(s)) {
              if (passed.has(q.id)) continue;
              const d = w.deficit(s, q);
              if (d > 0) {
                bad = q;
                bd = d;
                break;
              }
              passed.set(q.id, touchOf(s, q));
            }
            if (!bad) break;
            const level = w.levels(bad);
            const cands = [...level.keys()].filter((i) => hideable(s, i)).sort((a, b) => level.get(a) - level.get(b) || vars[a].total - vars[b].total || vars[b].people - vars[a].people || a - b);
            if (cands.length) {
              let choice = null;
              let helped2 = null;
              for (const i of cands.slice(0, TRIES)) {
                const t2 = withStatus(s, i, "sec");
                const d = w.deficit(t2, bad);
                if (d === 0) {
                  choice = t2;
                  break;
                }
                if (d < bd && !helped2) helped2 = t2;
              }
              const next = choice || helped2 || withStatus(s, cands[0], "sec");
              const changed = [];
              next.forEach((x, i) => {
                if (x !== s[i]) changed.push(i);
              });
              for (const [id, touch] of passed) if (changed.some((i) => touch.has(i))) passed.delete(id);
              s = next;
              continue;
            }
            const tables = [];
            const seen = /* @__PURE__ */ new Set();
            for (const i of [...level.keys()].sort((a, b) => level.get(a) - level.get(b) || a - b)) {
              const t2 = vars[i].table;
              if (seen.has(t2) || withheldTables.has(t2) || !vars[i].published) continue;
              seen.add(t2);
              tables.push(t2);
            }
            if (!tables.length) break;
            let pick = null;
            let helped = null;
            for (const t2 of tables.slice(0, TRIES)) {
              const d = w.deficit(withTable(s, t2), bad);
              if (d === 0) {
                pick = t2;
                break;
              }
              if (d < bd && !helped) helped = t2;
            }
            const t = pick || helped || tables[0];
            withheldTables.add(t);
            s = withTable(s, t);
            passed.clear();
          }
          const unprotected = [];
          if (!meter.over) for (const q of w.quantities(s)) {
            if (!passed.has(q.id) && w.deficit(s, q) > 0) unprotected.push(q.id);
            if (meter.over) break;
          }
          return { status: s, withheldTables: [...withheldTables], verified: !meter.over && !unprotected.length, unprotected, outOfBudget: meter.over, world: w };
        }
        function consistent(base, forced = [], { validate = null, derived: checkDerived = null } = {}) {
          const S = base.status;
          const tables = [...base.withheldTables].sort().join("|");
          const w = base.world;
          const truth = w.values;
          const G = [truth];
          const seen = /* @__PURE__ */ new Map([[truth.join(","), true]]);
          let gaveUp = false;
          const valueOf = (vals, terms) => terms.reduce((a, [i, c]) => a + c * vals[i], 0);
          const same = (r) => r.verified && [...r.withheldTables].sort().join("|") === tables && r.status.every((x, i) => x === S[i]);
          const tryWorld = (vals) => {
            const key = vals.join(",");
            if (seen.has(key)) return seen.get(key);
            if (seen.size >= WORLD_RUNS) {
              gaveUp = true;
              return false;
            }
            let ok = false;
            try {
              ok = same(run(vals, forced)) && (!validate || validate(vals));
            } catch {
              ok = false;
            }
            seen.set(key, ok);
            if (ok) G.push(vals);
            return ok;
          };
          function* candidates(q, v) {
            const p = w.problem(S, q.terms);
            if (!p.n) return;
            const n = p.n;
            const prob = { ...p.prob, rows: [...p.prob.rows, { a: p.c, op: "=", b: v - p.constant }] };
            const worldOf = (x) => {
              const vals = truth.slice();
              p.members.forEach((i, j) => {
                vals[i] = x[j];
              });
              return vals;
            };
            const cls = (x) => x === 0 ? [0, 0] : x < T ? [1, T - 1] : [T, Infinity];
            const keep = { ...prob, rows: prob.rows.slice(), lb: prob.lb.slice(), ub: prob.ub.slice() };
            p.members.forEach((i, j) => {
              if (vars[i].people && !q.terms.some(([t]) => t === i)) {
                const [a, b] = cls(truth[i]);
                keep.lb[j] = Math.max(keep.lb[j], a);
                keep.ub[j] = Math.min(keep.ub[j], b);
              }
            });
            for (const dq of derived) {
              if (dq.id === q.id) continue;
              const a = new Array(n).fill(0);
              let k2 = 0;
              let moves = false;
              for (const [i, co] of dq.terms) {
                if (p.idx.has(i)) {
                  a[p.idx.get(i)] += co;
                  moves = true;
                } else k2 += co * truth[i];
              }
              if (!moves) continue;
              const [lo, hi] = cls(valueOf(truth, dq.terms));
              keep.rows.push({ a, op: ">=", b: lo - k2 });
              if (hi !== Infinity) keep.rows.push({ a, op: "<=", b: hi - k2 });
            }
            const nearest = (pr, anchor) => {
              const pad = new Array(n).fill(0);
              const rows = pr.rows.map((r2) => ({ a: [...r2.a, ...pad], op: r2.op, b: r2.b }));
              p.members.forEach((i, j) => {
                const up = new Array(2 * n).fill(0);
                up[j] = 1;
                up[n + j] = -1;
                rows.push({ a: up, op: "<=", b: anchor[i] });
                const dn = new Array(2 * n).fill(0);
                dn[j] = -1;
                dn[n + j] = -1;
                rows.push({ a: dn, op: "<=", b: -anchor[i] });
              });
              const r = intMax({ n: 2 * n, rows, lb: [...pr.lb, ...pad], ub: [...pr.ub, ...new Array(n).fill(Infinity)] }, [...pad, ...new Array(n).fill(-1)], null, opt);
              return r.x ? r.x.slice(0, n) : null;
            };
            for (const pr of [keep, prob]) {
              for (const anchor of [truth, ...G.slice(1).slice(-3).reverse()]) {
                if (meter.over || gaveUp) return;
                const x = nearest(pr, anchor);
                if (x) yield worldOf(x);
              }
            }
            let k = 0;
            for (const i of p.members) {
              if (!vars[i].people || q.terms.some(([t]) => t === i) || k++ >= 6) continue;
              for (const dir of [1, -1]) {
                if (meter.over || gaveUp) return;
                const o = new Array(n).fill(0);
                o[p.idx.get(i)] = dir;
                const r = intMax(keep, o, null, opt);
                if (r.x && Number.isFinite(r.value)) yield worldOf(r.x);
              }
            }
            const own = new Set(q.terms.map(([i]) => i));
            const nonzero = { ...prob, lb: p.members.map((i, j) => vars[i].people && !own.has(i) ? Math.max(1, prob.lb[j]) : prob.lb[j]) };
            const down = p.members.map(() => -1);
            const tight = down.slice();
            for (const dq of derived) for (const [i, co] of dq.terms) if (p.idx.has(i)) tight[p.idx.get(i)] -= 4 * co;
            let seed = 2166136261;
            for (const ch of `${q.id}|${v}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
            const rnd = () => {
              seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
              return seed / 2 ** 32;
            };
            const corners = [[nonzero, down], [nonzero, tight], [prob, tight], [prob, down]];
            for (let k2 = 0; k2 < WITNESS_TRIES; k2++) corners.push([nonzero, p.members.map(() => -(1 + Math.floor(rnd() * 8)))]);
            for (const [pr, o] of corners) {
              if (meter.over || gaveUp) return;
              const r = intMax(pr, o, null, opt);
              if (r.x) yield worldOf(r.x);
            }
            let m = 0;
            for (const i of p.members) {
              if (!vars[i].people || own.has(i) || m++ >= 4) continue;
              const j = p.idx.get(i);
              for (let x = prob.lb[j]; x <= prob.lb[j] + 2 * T && x <= prob.ub[j]; x++) {
                if (meter.over || gaveUp) return;
                const fixed = { ...prob, lb: prob.lb.slice(), ub: prob.ub.slice() };
                fixed.lb[j] = x;
                fixed.ub[j] = x;
                const y = nearest(fixed, truth);
                if (y) yield worldOf(y);
              }
            }
          }
          const witness = (q, v, cap = WITNESS_RUNS) => {
            if (G.some((vals) => valueOf(vals, q.terms) === v)) return true;
            let runs = 0;
            for (const vals of candidates(q, v)) {
              const fresh = !seen.has(vals.join(","));
              if (tryWorld(vals) && valueOf(vals, q.terms) === v) return true;
              if (fresh && ++runs >= cap) return false;
            }
            return false;
          };
          const widen = (q, a, b, lo, hi, x) => {
            const r = widenRange({ a, b, lo, hi, x, T, P, shows: (v) => witness(q, v, 8), over: () => meter.over });
            if (probe.onWiden) probe.onWiden({ id: q.id, T, P, from: [a, b], range: r.range, holes: r.holes, shown: [...new Set(G.map((vals) => valueOf(vals, q.terms)).filter((y) => y >= r.range[0] && y <= r.range[1]))].sort((m, n) => m - n) });
            return r.range;
          };
          const unprotected = [];
          for (const q of w.quantities(S)) {
            if (meter.over) break;
            if (gaveUp) {
              unprotected.push(q.id);
              continue;
            }
            let ok = true;
            const bigWithheld = checkDerived && q.kind === "cond" && !q.derived && q.terms.length === 1 && checkDerived.has(q.terms[0][0]) && truth[q.terms[0][0]] >= T;
            if (bigWithheld) {
              const x = truth[q.terms[0][0]];
              let a = x;
              let b = x;
              for (const vals of G) {
                const y = valueOf(vals, q.terms);
                if (y >= T) {
                  a = Math.min(a, y);
                  b = Math.max(b, y);
                }
              }
              [a, b] = widen(q, a, b, T, Infinity, x);
              ok = b - a >= P;
            } else if (q.kind === "pri" || q.kind === "cond" && (!q.derived || checkDerived && q.terms.some(([i]) => checkDerived.has(i)))) {
              const t = q.kind === "pri" || w.reaches(w.problem(S, q.terms)) ? w.targets(S, q) : [];
              if (t.length) {
                const [L, U] = [t[0], t[t.length - 1]];
                const top = Math.min(U, L + P - 1);
                ok = witness(q, L);
                const high = () => G.some((vals) => {
                  const x = valueOf(vals, q.terms);
                  return x >= top && x <= U;
                });
                for (let v = U; ok && !high() && v >= top && !meter.over; v--) witness(q, v);
                ok = ok && high();
              }
            } else if (q.kind === "sec") {
              const p = w.problem(S, q.terms);
              const x = valueOf(truth, q.terms);
              const lo = -intMax(p.prob, p.c.map((c) => -c), null, opt).value + p.constant;
              const hi = intMax(p.prob, p.c, null, opt).value + p.constant;
              const found = G.map((vals) => valueOf(vals, q.terms));
              let a = Math.min(x, ...found);
              let b = Math.max(x, ...found);
              [a, b] = widen(q, a, b, lo, hi, x);
              ok = b - a >= P;
            }
            if (!ok) unprotected.push(q.id);
          }
          return { ok: !meter.over && !gaveUp && !unprotected.length, unprotected, gaveUp, worlds: G.length, tried: seen.size, G };
        }
        return { run, consistent };
      }
      var STEP_LIMIT = 4e8;
      var DEGRADE_BUDGET_FACTOR = 8;
      var DEGRADE_BUDGET_MIN = 2e6;
      function protect(model, T, { budget = 4e3, stepLimit = STEP_LIMIT, timeLimitMs = Infinity, consistency = true, degrade = true, debug = false } = {}) {
        const meter = newMeter(stepLimit, timeLimitMs);
        const a = auditor(model, T, { budget, meter });
        const values = model.vars.map((v) => v.value);
        const keep = new Set(model.keep || []);
        const byId = new Map(model.vars.map((v, i) => [v.id, i]));
        const derivedById = new Map((model.derived || []).map((d) => [d.id, d]));
        const neighbours = (i) => {
          const out2 = [];
          for (const k of model.cons) if (k.terms.some(([j]) => j === i)) {
            for (const [j] of k.terms) if (j !== i) out2.push(j);
          }
          return out2;
        };
        const tablesFor = (id) => {
          let idx = byId.has(id) ? [byId.get(id)] : (derivedById.get(id)?.terms || []).map(([j]) => j);
          if (idx.some((i) => !model.vars[i].published)) idx = [...idx.filter((i) => model.vars[i].published), ...idx.filter((i) => !model.vars[i].published).flatMap(neighbours)];
          const t = [...new Set(idx.filter((i) => model.vars[i].published).map((i) => model.vars[i].table))];
          const other = t.filter((x) => !keep.has(x));
          return other.length ? other : t;
        };
        const full = (vals, first2, known = null) => {
          const base2 = known || a.run(vals, []);
          const { world: world2, ...out2 } = base2;
          let res2 = out2;
          if (base2.verified && consistency) {
            const c = a.consistent(base2, []);
            res2 = { ...out2, verified: c.ok, unprotected: c.unprotected, gaveUp: c.gaveUp, consistency: { worlds: c.worlds, tried: c.tried }, ...first2 && debug ? { G: c.G } : {} };
          }
          if (res2.verified) return { res: res2, forced: [] };
          if (meter.over || res2.gaveUp || !degrade) return { res: res2, forced: null };
          const done = new Set(res2.withheldTables);
          const more = [...new Set(res2.unprotected.flatMap(tablesFor))].filter((t) => !done.has(t)).sort();
          if (!more.length || more.some((t) => keep.has(t))) return { res: { ...res2, headline: more.some((t) => keep.has(t)) }, forced: null };
          return { res: res2, forced: more };
        };
        const stats = (res2, forced2, rounds) => ({ headline: false, ...res2, degraded: forced2, outOfBudget: meter.over, backstop: meter.backstop, steps: meter.steps, rounds });
        const first = full(values, true);
        if (!first.forced || !first.forced.length) return stats(first.res, [], 1);
        const forced = first.forced;
        const key = forced.join("|");
        const memo = /* @__PURE__ */ new Map();
        const sameFailure = (vals) => {
          const r = a.run(vals, []);
          const printout = `${r.verified}|${r.withheldTables.join("|")}|${r.status.map((x, i) => x === "vis" ? vals[i] : x).join(",")}`;
          if (!memo.has(printout)) {
            const f = full(vals, false, r);
            memo.set(printout, !!f.forced && f.forced.join("|") === key);
          }
          return memo.get(printout);
        };
        const whole = meter.limit;
        meter.limit = Math.min(whole, meter.steps + DEGRADE_BUDGET_FACTOR * meter.steps + DEGRADE_BUDGET_MIN);
        const base = a.run(values, forced);
        const { world, ...out } = base;
        let res = out;
        if (base.verified) {
          const inForced = new Set(model.vars.map((v, i) => forced.includes(v.table) ? i : -1).filter((i) => i >= 0));
          const c = a.consistent(base, forced, { validate: sameFailure, derived: inForced });
          res = { ...out, verified: c.ok, unprotected: c.unprotected, gaveUp: c.gaveUp, consistency: { worlds: c.worlds, tried: c.tried }, ...debug ? { G: c.G } : {} };
        }
        if (meter.over && !meter.backstop && meter.limit < whole) {
          meter.over = false;
          res = { ...res, verified: false };
        }
        meter.limit = whole;
        return stats(res, forced, 2);
      }
      var probe = { onWiden: null };
      module.exports = { simplex, intMax, intFeasible, intFeasibleIn, protect, STEP_LIMIT, probe, widenRange };
    }
  });

  // server/clinical.js
  var require_clinical = __commonJS({
    "server/clinical.js"(exports, module) {
      "use strict";
      var ICD10_RE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
      function normalizeIcd10(raw) {
        if (raw === null || raw === void 0) return null;
        let s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
        if (!s) return null;
        if (!s.includes(".") && s.length > 3) s = `${s.slice(0, 3)}.${s.slice(3)}`;
        return ICD10_RE.test(s) ? s : null;
      }
      var Z_RANGE_RE = /^Z(5[5-9]|6[0-5])(\.[0-9A-Z]{1,4})?$/;
      var isZCode = (code) => Z_RANGE_RE.test(code || "");
      var Z_CODES = [
        { code: "Z55.0", label: "Illiteracy and low-level literacy" },
        { code: "Z55.9", label: "Problems related to education and literacy, unspecified" },
        { code: "Z56.0", label: "Unemployment, unspecified" },
        { code: "Z56.9", label: "Unspecified problems related to employment" },
        { code: "Z59.00", label: "Homelessness, unspecified" },
        { code: "Z59.01", label: "Sheltered homelessness" },
        { code: "Z59.02", label: "Unsheltered homelessness" },
        { code: "Z59.1", label: "Inadequate housing" },
        { code: "Z59.41", label: "Food insecurity" },
        { code: "Z59.6", label: "Low income" },
        { code: "Z59.7", label: "Insufficient social insurance and welfare support" },
        { code: "Z59.811", label: "Housing instability, housed, with risk of homelessness" },
        { code: "Z59.82", label: "Transportation insecurity" },
        { code: "Z59.86", label: "Financial insecurity" },
        { code: "Z60.2", label: "Problems related to living alone" },
        { code: "Z60.4", label: "Social exclusion and rejection" },
        { code: "Z60.5", label: "Target of (perceived) adverse discrimination and persecution" },
        { code: "Z62.9", label: "Problem related to upbringing, unspecified" },
        { code: "Z63.0", label: "Problems in relationship with spouse or partner" },
        { code: "Z63.4", label: "Disappearance and death of family member" },
        { code: "Z63.72", label: "Alcoholism and drug addiction in family" },
        { code: "Z63.8", label: "Other specified problems related to primary support group" },
        { code: "Z64.4", label: "Discord with counselors" },
        { code: "Z65.1", label: "Imprisonment and other incarceration" },
        { code: "Z65.2", label: "Problems related to release from prison" },
        { code: "Z65.3", label: "Problems related to other legal circumstances" },
        { code: "Z65.4", label: "Victim of crime and terrorism" },
        { code: "Z65.8", label: "Other specified problems related to psychosocial circumstances" }
      ];
      var PROBLEM_STATUSES = ["active", "resolved", "inactive"];
      var PROBLEM_SOURCES = ["self_report", "assessment", "referral", "other"];
      var GOAL_STATUSES = ["active", "met", "partially_met", "not_met", "discontinued"];
      var STEP_OWNERS = ["client", "staff", "family_support", "other_provider"];
      var STEP_STATUSES = ["open", "done", "cancelled"];
      var ASAM_DIMENSIONS = [
        { key: "d1", label: "Dimension 1: Acute intoxication and/or withdrawal potential" },
        { key: "d2", label: "Dimension 2: Biomedical conditions and complications" },
        { key: "d3", label: "Dimension 3: Emotional, behavioral, or cognitive conditions and complications" },
        { key: "d4", label: "Dimension 4: Readiness to change" },
        { key: "d5", label: "Dimension 5: Relapse, continued use, or continued problem potential" },
        { key: "d6", label: "Dimension 6: Recovery/living environment" }
      ];
      var ASAM_RATINGS = [
        { value: 0, label: "0 \u2014 No risk / no current problem" },
        { value: 1, label: "1 \u2014 Mild" },
        { value: 2, label: "2 \u2014 Moderate" },
        { value: 3, label: "3 \u2014 Significant" },
        { value: 4, label: "4 \u2014 Severe" }
      ];
      var ASAM_DISCREPANCY_REASONS = ["client_preference", "level_not_available", "waitlist", "geographic_accessibility", "family_responsibilities", "legal_issues", "language_or_cultural", "clinical_judgment", "payment_or_coverage", "other"];
      var FREQ4 = [{ value: 0, label: "Not at all" }, { value: 1, label: "Several days" }, { value: 2, label: "More than half the days" }, { value: 3, label: "Nearly every day" }];
      var YES_NO = [{ value: 1, label: "Yes" }, { value: 0, label: "No" }];
      var INSTRUMENTS = {
        phq9: {
          code: "phq9",
          name: "PHQ-9",
          title: "Patient Health Questionnaire (depression)",
          better: "lower",
          max: 27,
          stem: "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
          credit: "PHQ-9 \xA9 Pfizer Inc. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues. No permission required to reproduce, translate, display or distribute.",
          items: [
            "Little interest or pleasure in doing things",
            "Feeling down, depressed, or hopeless",
            "Trouble falling or staying asleep, or sleeping too much",
            "Feeling tired or having little energy",
            "Poor appetite or overeating",
            "Feeling bad about yourself \u2014 or that you are a failure or have let yourself or your family down",
            "Trouble concentrating on things, such as reading the newspaper or watching television",
            "Moving or speaking so slowly that other people could have noticed? Or the opposite \u2014 being so fidgety or restless that you have been moving around a lot more than usual",
            "Thoughts that you would be better off dead or of hurting yourself in some way"
          ].map((text) => ({ text, options: FREQ4 })),
          bands: [[0, 4, "Minimal"], [5, 9, "Mild"], [10, 14, "Moderate"], [15, 19, "Moderately severe"], [20, 27, "Severe"]],
          positiveAt: 10,
          // Item 9 (index 8) above "Not at all" is a safety alert whatever the total.
          safetyItem: 8
        },
        gad7: {
          code: "gad7",
          name: "GAD-7",
          title: "Generalized Anxiety Disorder scale",
          better: "lower",
          max: 21,
          stem: "Over the last 2 weeks, how often have you been bothered by the following problems?",
          credit: "GAD-7 \xA9 Pfizer Inc. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues. No permission required to reproduce, translate, display or distribute.",
          items: [
            "Feeling nervous, anxious, or on edge",
            "Not being able to stop or control worrying",
            "Worrying too much about different things",
            "Trouble relaxing",
            "Being so restless that it is hard to sit still",
            "Becoming easily annoyed or irritable",
            "Feeling afraid, as if something awful might happen"
          ].map((text) => ({ text, options: FREQ4 })),
          bands: [[0, 4, "Minimal"], [5, 9, "Mild"], [10, 14, "Moderate"], [15, 21, "Severe"]],
          positiveAt: 10
        },
        auditc: {
          code: "auditc",
          name: "AUDIT-C",
          title: "Alcohol Use Disorders Identification Test \u2014 consumption",
          better: "lower",
          max: 12,
          stem: "Think about your drinking over the past year.",
          credit: "AUDIT-C: the first three questions of the AUDIT (World Health Organization); public domain.",
          items: [
            { text: "How often do you have a drink containing alcohol?", options: [{ value: 0, label: "Never" }, { value: 1, label: "Monthly or less" }, { value: 2, label: "2\u20134 times a month" }, { value: 3, label: "2\u20133 times a week" }, { value: 4, label: "4 or more times a week" }] },
            { text: "How many standard drinks containing alcohol do you have on a typical day?", options: [{ value: 0, label: "1 or 2" }, { value: 1, label: "3 or 4" }, { value: 2, label: "5 or 6" }, { value: 3, label: "7 to 9" }, { value: 4, label: "10 or more" }] },
            { text: "How often do you have six or more drinks on one occasion?", options: [{ value: 0, label: "Never" }, { value: 1, label: "Less than monthly" }, { value: 2, label: "Monthly" }, { value: 3, label: "Weekly" }, { value: 4, label: "Daily or almost daily" }] }
          ],
          // A positive screen is 4 or more for men and 3 or more for women. When the variant is not given the
          // lower cut-off is used, so nobody is screened negative by a missing answer.
          variants: [{ value: "men", label: "Cut-off for men (4 or more)", positiveAt: 4 }, { value: "women", label: "Cut-off for women (3 or more)", positiveAt: 3 }, { value: "unspecified", label: "Not specified (3 or more)", positiveAt: 3 }],
          positiveAt: 3
        },
        dast10: {
          code: "dast10",
          name: "DAST-10",
          title: "Drug Abuse Screening Test",
          better: "lower",
          max: 10,
          optional: true,
          stem: 'These questions refer to the past 12 months. "Drug use" means use of prescribed or over-the-counter drugs in excess of the directions, and any non-medical use of drugs. Do not include alcohol or tobacco.',
          credit: "DAST-10 \xA9 1982 Harvey A. Skinner, PhD. Reproduced for non-commercial clinical use with credit.",
          items: [
            { text: "Have you used drugs other than those required for medical reasons?", options: YES_NO },
            { text: "Do you abuse more than one drug at a time?", options: YES_NO },
            // Reverse scored: "No" is the answer that counts.
            { text: "Are you always able to stop using drugs when you want to?", options: [{ value: 0, label: "Yes" }, { value: 1, label: "No" }] },
            { text: 'Have you had "blackouts" or "flashbacks" as a result of drug use?', options: YES_NO },
            { text: "Do you ever feel bad or guilty about your drug use?", options: YES_NO },
            { text: "Does your spouse (or parents) ever complain about your involvement with drugs?", options: YES_NO },
            { text: "Have you neglected your family because of your use of drugs?", options: YES_NO },
            { text: "Have you engaged in illegal activities in order to obtain drugs?", options: YES_NO },
            { text: "Have you ever experienced withdrawal symptoms (felt sick) when you stopped taking drugs?", options: YES_NO },
            { text: "Have you had medical problems as a result of your drug use (e.g., memory loss, hepatitis, convulsions, bleeding)?", options: YES_NO }
          ],
          bands: [[0, 0, "No problems reported"], [1, 2, "Low level"], [3, 5, "Moderate level"], [6, 8, "Substantial level"], [9, 10, "Severe level"]],
          positiveAt: 3
        },
        wellbeing: {
          code: "wellbeing",
          name: "Wellbeing (0\u201310)",
          title: "Self-rated wellbeing",
          better: "higher",
          max: 10,
          stem: "A single question, answered by the person in their own words and numbers.",
          credit: "A single self-rating item written for SUDS; not a validated instrument.",
          items: [{ text: "Overall, how are things going for you right now? (0 = the worst they could be, 10 = the best they could be)", options: Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) })) }],
          bands: [[0, 3, "Low"], [4, 6, "Moderate"], [7, 10, "Good"]]
        }
      };
      var INSTRUMENT_CODES = Object.keys(INSTRUMENTS);
      var OPTIONAL_INSTRUMENTS = {
        dast10: {
          setting: "instrument_dast10_enabled",
          notice: "The DAST-10 is \xA9 1982 Harvey A. Skinner, PhD. It may be reproduced free of charge for non-commercial clinical, research and training use, with credit to the author. SUDS may be supplied commercially, so the DAST-10 is off until an administrator confirms this program holds the rights to use it.",
          confirmation: "I confirm that this program holds the rights to use the DAST-10 as it will be used here (for example, non-commercial clinical use with credit to the author, or written permission from the copyright holder)."
        }
      };
      function score(code, responses, { variant } = {}) {
        const ins = INSTRUMENTS[code];
        if (!ins) {
          const e = new Error(`Unknown instrument ${code}`);
          e.fields = { instrument: `must be one of ${INSTRUMENT_CODES.join(", ")}` };
          throw e;
        }
        if (!Array.isArray(responses) || responses.length !== ins.items.length) {
          const e = new Error(`${ins.name} needs an answer to each of its ${ins.items.length} questions`);
          e.fields = { responses: `must have ${ins.items.length} answers` };
          throw e;
        }
        const values = responses.map((raw, i) => {
          const v = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
          if (typeof v !== "number" || !Number.isInteger(v) || !ins.items[i].options.some((o) => o.value === v)) {
            const e = new Error(`${ins.name} question ${i + 1} has no valid answer`);
            e.fields = { responses: `question ${i + 1} is missing or out of range` };
            throw e;
          }
          return v;
        });
        const total = values.reduce((a, b) => a + b, 0);
        let positiveAt = ins.positiveAt;
        let usedVariant = null;
        if (ins.variants) {
          const vv = ins.variants.find((x) => x.value === variant) || ins.variants.find((x) => x.value === "unspecified");
          positiveAt = vv.positiveAt;
          usedVariant = vv.value;
        }
        let band;
        if (ins.bands) band = (ins.bands.find(([lo, hi]) => total >= lo && total <= hi) || [])[2] || null;
        else band = total >= positiveAt ? "Positive screen" : "Negative screen";
        const positive = positiveAt === void 0 ? null : total >= positiveAt ? 1 : 0;
        const safety = ins.safetyItem !== void 0 && values[ins.safetyItem] > 0 ? 1 : 0;
        return { total, band, positive, safety_flag: safety, responses: values, variant: usedVariant };
      }
      function direction(code, baseline, latest) {
        const ins = INSTRUMENTS[code];
        if (!ins || baseline === null || latest === null) return 0;
        if (latest === baseline) return 0;
        return (ins.better === "higher" ? latest > baseline : latest < baseline) ? 1 : -1;
      }
      module.exports = {
        ICD10_RE,
        normalizeIcd10,
        isZCode,
        Z_CODES,
        PROBLEM_STATUSES,
        PROBLEM_SOURCES,
        GOAL_STATUSES,
        STEP_OWNERS,
        STEP_STATUSES,
        ASAM_DIMENSIONS,
        ASAM_RATINGS,
        ASAM_DISCREPANCY_REASONS,
        INSTRUMENTS,
        INSTRUMENT_CODES,
        OPTIONAL_INSTRUMENTS,
        score,
        direction
      };
    }
  });

  // server/constants.js
  var require_constants = __commonJS({
    "server/constants.js"(exports, module) {
      "use strict";
      var CL = require_clinical();
      var RACE_CODES = [
        { code: "american_indian_alaska_native", label: "American Indian or Alaska Native" },
        { code: "asian", label: "Asian" },
        { code: "black_african_american", label: "Black or African American" },
        { code: "native_hawaiian_pacific_islander", label: "Native Hawaiian or Other Pacific Islander" },
        { code: "white", label: "White" },
        { code: "other", label: "Other" },
        { code: "declined", label: "Declined to answer" },
        { code: "unknown", label: "Unknown" }
      ];
      var ETHNICITY_CODES = [
        { code: "hispanic_latino", label: "Hispanic or Latino" },
        { code: "not_hispanic_latino", label: "Not Hispanic or Latino" },
        { code: "declined", label: "Declined to answer" },
        { code: "unknown", label: "Unknown" }
      ];
      var SETTLEMENT_USES = [
        { code: "core_a", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "A. Naloxone or other FDA-approved drug to reverse opioid overdoses" },
        { code: "core_b", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "B. Medication for opioid use disorder (MOUD) distribution and other opioid-related treatment" },
        { code: "core_c", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "C. Pregnant and postpartum women" },
        { code: "core_d", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "D. Expanding treatment for neonatal abstinence syndrome (NAS)" },
        { code: "core_e", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "E. Expansion of warm hand-off programs and recovery services" },
        { code: "core_f", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "F. Treatment for incarcerated population" },
        { code: "core_g", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "G. Prevention programs" },
        { code: "core_h", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "H. Expanding syringe service programs" },
        { code: "core_i", schedule: "Exhibit E, Schedule A (Core Strategies)", label: "I. Evidence-based data collection and research on abatement strategies" },
        { code: "approved_a", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Treatment", label: "A. Treat opioid use disorder (OUD)" },
        { code: "approved_b", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Treatment", label: "B. Support people in treatment and recovery" },
        { code: "approved_c", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Treatment", label: "C. Connect people who need help to the help they need (connections to care)" },
        { code: "approved_d", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Treatment", label: "D. Address the needs of criminal justice-involved persons" },
        { code: "approved_e", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Treatment", label: "E. Address the needs of pregnant or parenting women and their families, including babies with NAS" },
        { code: "approved_f", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Prevention", label: "F. Prevent over-prescribing and ensure appropriate prescribing and dispensing of opioids" },
        { code: "approved_g", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Prevention", label: "G. Prevent misuse of opioids" },
        { code: "approved_h", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Prevention", label: "H. Prevent overdose deaths and other harms (harm reduction)" },
        { code: "approved_i", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Other strategies", label: "I. First responders" },
        { code: "approved_j", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Other strategies", label: "J. Leadership, planning and coordination" },
        { code: "approved_k", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Other strategies", label: "K. Training" },
        { code: "approved_l", schedule: "Exhibit E, Schedule B (Approved Uses) \u2014 Other strategies", label: "L. Research" },
        { code: "none", schedule: "Not an opioid remediation use", label: "Not an opioid remediation use (for example, administrative cost)" }
      ];
      var SETTLEMENT_HIAA = [
        { code: "hiaa_1", label: "1. Matching funds or operating costs for SUD facilities with an approved Behavioral Health Continuum Infrastructure Program (BHCIP) project" },
        { code: "hiaa_2", label: "2. Creating new or expanded substance use disorder (SUD) treatment infrastructure" },
        { code: "hiaa_3", label: "3. Addressing the needs of communities of color and vulnerable populations (including sheltered and unsheltered homeless populations) disproportionately impacted by SUD" },
        { code: "hiaa_4", label: "4. Diversion of people with SUD from the justice system into treatment, including training and resources for first and early responders, and outreach, diversion, deflection and harm reduction" },
        { code: "hiaa_5", label: "5. Interventions to prevent drug addiction in vulnerable youth" },
        { code: "hiaa_6", label: "6. The purchase of naloxone for distribution and efforts to expand access to naloxone for opioid overdose reversals" }
      ];
      var NALOXONE_DOSES_MAX = 20;
      module.exports = {
        RACE_CODES,
        ETHNICITY_CODES,
        SETTLEMENT_USES,
        SETTLEMENT_HIAA,
        NALOXONE_DOSES_MAX,
        INTERVENTION_TYPES: ["outreach", "screening_sbirt", "assessment", "intake", "care_coordination", "warm_handoff", "referral", "case_management", "harm_reduction", "naloxone_distribution", "peer_support", "crisis_response", "post_overdose_follow_up", "transport", "housing_assistance", "benefits_enrollment", "employment_support", "family_support", "education", "court_or_probation", "hospital_or_ed_visit", "jail_in_reach", "recovery_check_in", "discharge_planning", "other"],
        // The services that can be recorded with no identified client: street outreach and community naloxone
        // distribution (a kit handed to a stranger). Every other type is work with a person on the caseload, and
        // needs the client (server/routes/interventions.js and the visit form enforce the same list).
        CLIENTLESS_INTERVENTION_TYPES: ["outreach", "naloxone_distribution"],
        // 'street' (Street / Outdoor) is where a harm-reduction programme's visits mostly happen, and the default
        // Location of its visit and overdose forms (server/programme.js defaultLocation).
        LOCATIONS: ["office", "street", "field", "home", "phone", "telehealth", "hospital", "emergency_dept", "jail", "court", "shelter", "treatment_facility", "community", "other"],
        // Places an overdose cannot happen: not offered as the overdose form's "Where".
        REMOTE_LOCATIONS: ["phone", "telehealth"],
        // The words for codes that the generic wording ("Court Or Probation", "Detox Withdrawal Mgmt") gets wrong:
        // used by every list (server/options.js) and by fmt.code() in the browser for a code shown outside one.
        CODE_LABELS: {
          screening_sbirt: "Screening (SBIRT)",
          court_or_probation: "Court or Probation",
          hospital_or_ed_visit: "Hospital or ED Visit",
          post_overdose_follow_up: "Post-Overdose Follow-Up",
          jail_in_reach: "Jail In-Reach",
          recovery_check_in: "Recovery Check-In",
          declined_by_client: "Declined by Client",
          declined_by_provider: "Declined by Provider",
          no_show: "No-Show",
          detox_withdrawal_mgmt: "Detox / Withdrawal Management",
          emergency_dept: "Emergency Department",
          street: "Street / Outdoor",
          ids_documents: "IDs and Documents",
          pregnancy_parenting: "Pregnancy and Parenting",
          phones_communication: "Phones and Communication",
          food_basic_needs: "Food and Basic Needs",
          // Codes the generic wording printed as "Opioids Fentanyl", "Court Probation", "Ems", "Va", "Crisis 24 7",
          // "Non Binary" and "Readonly" (the third UX review, 1.14.0). Exports' labels come from here too.
          opioids_fentanyl: "Opioids (fentanyl)",
          opioids_heroin: "Opioids (heroin)",
          opioids_rx: "Opioids (prescription)",
          court_probation: "Court / probation",
          ems: "EMS",
          va: "VA",
          non_binary: "Non-binary",
          transgender_female: "Transgender female",
          transgender_male: "Transgender male",
          buprenorphine_xr: "Buprenorphine XR",
          naltrexone_xr: "Naltrexone XR",
          naltrexone_oral: "Naltrexone (oral)",
          doubled_up: "Doubled up",
          crisis_24_7: "24/7 crisis",
          co_occurring: "Co-occurring",
          walk_in: "Walk-in",
          same_day_intake: "Same-day intake",
          trauma_informed: "Trauma-informed",
          faith_based: "Faith-based",
          lgbtq: "LGBTQ+",
          deaf_hard_of_hearing: "Deaf or hard of hearing",
          pregnant_parenting: "Pregnant or parenting",
          sor_grant: "SOR grant",
          samhsa: "SAMHSA",
          state_block_grant: "State block grant",
          county_general: "County general fund",
          opioid_settlement: "Opioid settlement",
          readonly: "Read-only"
        },
        MODALITIES: ["in_person", "phone", "video", "text", "email", "collateral"],
        OUTCOMES: ["completed", "partial", "client_declined", "no_show", "unable_to_locate", "rescheduled", "crisis_resolved", "transported", "admitted", "other"],
        STAGES: ["precontemplation", "contemplation", "preparation", "action", "maintenance", "relapse"],
        CALL_CONTACT_TYPES: ["client", "family", "provider", "agency", "hospital", "law_enforcement", "hotline", "pharmacy", "insurance", "other"],
        CALL_OUTCOMES: ["reached", "voicemail", "no_answer", "busy", "wrong_number", "disconnected", "callback_scheduled", "crisis_escalated"],
        // A contact logged under calls is either a phone call or a text message; a text has its own outcomes,
        // because "voicemail" and "busy" mean nothing to a text and "no reply" means nothing to a call.
        CONTACT_METHODS: ["phone", "text"],
        TEXT_OUTCOMES: ["replied", "sent", "no_reply", "undeliverable", "wrong_number", "opted_out"],
        TIME_CATEGORIES: ["direct_service", "documentation", "travel", "care_coordination", "outreach", "meeting", "training", "supervision", "admin", "on_call"],
        RESOURCE_CATEGORIES: ["detox_withdrawal_mgmt", "residential", "inpatient", "partial_hospitalization", "intensive_outpatient", "outpatient", "mat_otp", "mat_obot", "sober_living", "housing", "shelter", "mental_health", "primary_care", "harm_reduction", "syringe_services", "naloxone", "crisis_line", "transportation", "employment", "legal", "food", "benefits", "peer_support", "recovery_community", "family_support", "pregnancy_parenting", "veterans", "other"],
        REFERRAL_STATUSES: ["pending", "contacted", "accepted", "waitlisted", "scheduled", "admitted", "declined_by_client", "declined_by_provider", "no_show", "completed", "closed"],
        BUDGET_CATEGORIES: ["staffing", "client_assistance", "transportation", "naloxone_supplies", "harm_reduction_supplies", "housing_assistance", "treatment_fees", "medication", "phones_communication", "food_basic_needs", "ids_documents", "training", "outreach_materials", "supplies", "indirect", "other"],
        FUNDING_TYPES: ["opioid_settlement", "sor_grant", "samhsa", "state_block_grant", "county_general", "medicaid", "foundation", "other"],
        // 'handoff' is the shift hand-off note (what the next worker on needs to know), 'safety_plan' a structured
        // safety plan (see SECTIONS in public/views/notes.js); both are ordinary notes as far as access rules go.
        NOTE_FORMATS: ["narrative", "SOAP", "DAP", "BIRP", "GIRP", "intake", "progress", "discharge", "contact", "collateral", "crisis", "supervision", "handoff", "safety_plan"],
        // part2_* are 42 CFR Part 2 consents (§2.31): every element is required of them. part2_tpo is the 2024
        // rule's single consent for all future treatment, payment and health care operations; part2_counseling_notes
        // is the separate consent SUD counseling notes need (§2.31(b)); part2_proceedings is the stand-alone consent
        // for use in a civil, criminal, administrative or legislative proceeding (§2.31(d)), which may not be
        // combined with any other. 'roi' is a general release, which Part 2 says is not sufficient on its own.
        CONSENT_TYPES: ["part2_disclosure", "part2_tpo", "part2_counseling_notes", "part2_proceedings", "roi", "treatment", "telehealth", "contact_preferences", "research", "photo_media"],
        PART2_CONSENT_TYPES: ["part2_disclosure", "part2_tpo", "part2_counseling_notes", "part2_proceedings"],
        // The categories of information a consent can cover, recorded as codes (consents.info_categories) beside
        // the free-text scope the signed form carries, so that an automated disclosure (the FHIR API) shares only
        // what the consent covers (server/disclosure.js CATEGORY_OF_FHIR_TYPE). 'all' covers every category.
        CONSENT_INFO_CATEGORIES: ["demographics", "encounters", "diagnoses_assessments", "referrals", "tasks", "documents", "risk_overdose", "all"],
        CONSENT_INFO_CATEGORY_LABELS: {
          demographics: "Identity and contact details (name, date of birth, address, phone, Medi-Cal ID)",
          encounters: "Attendance and services (episodes of care, visits, calls)",
          diagnoses_assessments: "SUD diagnosis and assessments (problems, ASAM, screening results)",
          referrals: "Referrals and care coordination",
          tasks: "Tasks and follow-ups",
          documents: "Signed notes \u2014 titles and dates only, never their text",
          risk_overdose: "Risk level and overdose events",
          all: "All of the above"
        },
        CONSENT_SIGNERS: ["patient", "parent_or_guardian", "personal_representative", "court_appointed_guardian"],
        COURT_ORDER_TYPES: ["noncriminal_2_64", "criminal_patient_2_65", "program_investigation_2_66", "undercover_2_67"],
        PART2_NOTICE_METHODS: ["in_person_paper", "electronic", "mail", "verbal_with_copy"],
        // 42 CFR §2.32(a)(1) as amended by the 2024 final rule (89 FR 12472): the notice that must accompany
        // every disclosure made with the patient's written consent. PART2_NOTICE_SHORT is §2.32(a)(2)'s
        // abbreviated form, used as the label on screens and printouts.
        PART2_NOTICE_VERSION: "2024",
        PART2_REDISCLOSURE_NOTICE: "This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2). These rules prohibit you from using or disclosing this record, or testimony that describes the information contained in this record, in any civil, criminal, administrative, or legislative proceedings by any Federal, State, or local authority, against the patient, unless authorized by the consent of the patient, except as provided at 42 CFR 2.12(c)(5) or as authorized by a court in accordance with 42 CFR 2.64 or 2.65. In addition, the Federal rules prohibit you from making any other use or disclosure of this record unless at least one of the following applies: (i) Further use or disclosure is expressly permitted by the written consent of the individual whose information is being disclosed in this record or as otherwise permitted by 42 CFR part 2. (ii) You are a covered entity or business associate and have received the record for treatment, payment, or health care operations, or (iii) You have received the record from a covered entity or business associate as permitted by 45 CFR part 164, subparts A and E. A general authorization for the release of medical or other information is NOT sufficient to meet the required elements of written consent to further use or redisclose the record (see 42 CFR 2.31).",
        PART2_NOTICE_SHORT: "42 CFR part 2 prohibits unauthorized use or disclosure of these records.",
        SUBSTANCES: ["opioids_fentanyl", "opioids_heroin", "opioids_rx", "alcohol", "methamphetamine", "cocaine", "benzodiazepines", "cannabis", "synthetic_cannabinoids", "xylazine", "nicotine", "other", "unknown"],
        SERVICE_TAGS: ["detox", "residential", "inpatient", "partial_hospitalization", "intensive_outpatient", "outpatient", "mat_buprenorphine", "mat_methadone", "mat_naltrexone", "medication_management", "individual_counseling", "group_counseling", "family_program", "peer_support", "case_management", "mental_health", "trauma_informed", "co_occurring", "medical_care", "harm_reduction", "naloxone", "syringe_services", "housing", "sober_living", "employment", "legal_help", "transportation", "childcare", "telehealth", "walk_in", "same_day_intake", "crisis_24_7", "aftercare", "faith_based", "spanish_speaking"],
        POPULATIONS: ["adults", "adolescents", "women", "men", "pregnant_parenting", "families", "veterans", "lgbtq", "justice_involved", "unhoused", "older_adults", "native_american", "spanish_speakers", "deaf_hard_of_hearing"],
        FORM_CATEGORIES: ["consent_release", "intake_screening", "assessment", "treatment_plan", "referral", "assistance_request", "transportation", "housing", "benefits", "discharge", "incident", "grievance", "other"],
        DOCUMENT_CATEGORIES: ["policy", "procedure", "contract"],
        FORM_FIELD_TYPES: ["text", "textarea", "date", "number", "checkbox", "select", "signature", "section", "note"],
        FORM_AUTOFILL: ["client.full_name", "client.first_name", "client.last_name", "client.preferred_name", "client.dob", "client.phone", "client.email", "client.address", "client.city", "client.zip", "client.client_code", "client.gender", "client.pronouns", "client.insurance", "client.medicaid_id", "client.emergency_contact", "client.primary_substance", "client.mat_status", "client.intake_date", "worker.name", "worker.title", "org.name", "org.county", "today"],
        // The overdose form's "What happened" and "Given by". The kinds are fixed by a CHECK constraint on
        // overdose_events.kind and each drives a count, so Settings → Lists can reword them but not add to them.
        OVERDOSE_KINDS: ["overdose", "reversal", "fatal"],
        ADMINISTERED_BY: ["bystander", "first_responder", "staff", "self", "family", "unknown"],
        // Why an episode of care ended ('deceased' also marks the client deceased: server/routes/episodes.js).
        // Safety flags on a client (free text, comma separated; these are the codes a flag may also be stored
        // as, e.g. by an import or the sample data, shown with their label rather than the code).
        CLIENT_FLAGS: ["no_home_visits", "visit_in_pairs", "do_not_contact_family", "no_voicemail", "safety_plan"],
        DISCHARGE_REASONS: ["completed", "transferred", "incarcerated", "moved", "lost_contact", "declined", "deceased", "administrative", "other"],
        // A referral outcome's "If it did not happen, why" (stored encrypted in referrals.barrier_enc).
        REFERRAL_BARRIERS: ["none", "transportation", "insurance", "waitlist", "no_beds", "client_declined", "childcare", "documentation", "legal", "phone_access", "other"],
        ASAM: ["0.5", "1.0", "2.1", "2.5", "3.1", "3.3", "3.5", "3.7", "4.0", "OTP", "unknown"],
        // Problem list, care plan, ASAM dimensions and the screening instruments (server/clinical.js).
        Z_CODES: CL.Z_CODES,
        PROBLEM_STATUSES: CL.PROBLEM_STATUSES,
        PROBLEM_SOURCES: CL.PROBLEM_SOURCES,
        GOAL_STATUSES: CL.GOAL_STATUSES,
        STEP_OWNERS: CL.STEP_OWNERS,
        STEP_STATUSES: CL.STEP_STATUSES,
        ASAM_DIMENSIONS: CL.ASAM_DIMENSIONS,
        ASAM_RATINGS: CL.ASAM_RATINGS,
        ASAM_DISCREPANCY_REASONS: CL.ASAM_DISCREPANCY_REASONS,
        INSTRUMENTS: CL.INSTRUMENTS,
        // Group and community prevention events (server/routes/prevention.js, 1.17.0): SABG primary prevention.
        // The six CSAP strategies and the three IOM population categories (universal split into direct and indirect,
        // as SABG prevention reporting counts them) are national categories, so Settings → Lists can reword them
        // but not add to them; the kind of event and the audience are the programme's own lists. A 'training' event's
        // attendance is the "people trained" count (server/prevention.js), so that code cannot be retired.
        PREVENTION_STRATEGIES: ["information_dissemination", "education", "alternatives", "problem_identification_referral", "community_based_process", "environmental"],
        PREVENTION_IOM: ["universal_direct", "universal_indirect", "selective", "indicated"],
        PREVENTION_EVENT_TYPES: ["presentation", "workshop", "training", "community_event", "media_campaign", "coalition_meeting", "alternative_activity", "screening_event", "policy_work", "other"],
        PREVENTION_AUDIENCES: ["youth", "young_adults", "parents_families", "school_staff", "general_community", "older_adults", "health_providers", "first_responders", "employers", "faith_community", "other"]
      };
    }
  });

  // server/release-audit.js
  var require_release_audit = __commonJS({
    "server/release-audit.js"(exports, module) {
      "use strict";
      var SC = require_small_cells();
      var SDC = require_sdc();
      var C = require_constants();
      var PARTITIONS = ["by_gender", "by_language", "by_housing", "by_insurance", "by_ethnicity"];
      var DOSES_MAX = C.NALOXONE_DOSES_MAX;
      var AUDIT_BACKSTOP_MS = 6e4;
      var HEADLINE = "unduplicated.served";
      var byKey = (a, b) => {
        const x = String(a);
        const y = String(b);
        return x < y ? -1 : x > y ? 1 : 0;
      };
      function monthsOf(from, to) {
        const out = [];
        let y = Number(from.slice(0, 4));
        let m = Number(from.slice(5, 7));
        const end = to.slice(0, 7);
        while (out.length < 1200) {
          const k = `${y}-${String(m).padStart(2, "0")}`;
          if (k > end) break;
          out.push(k);
          if (++m > 12) {
            m = 1;
            y++;
          }
        }
        return out;
      }
      function onDomain(rows, keys, key, zero, byKeyAll = false) {
        const have = new Map(rows.map((x) => [x[key], x]));
        const set = new Set(keys || []);
        const out = (keys || []).map((k) => ({ row: have.get(k) || zero(k), fixed: true })).concat(rows.filter((x) => !set.has(x[key])).sort((a, b) => byKey(a[key], b[key])).map((x) => ({ row: x, fixed: false })));
        return byKeyAll ? out.sort((a, b) => byKey(a.row[key], b.row[key])) : out;
      }
      var keyOrder = (rows) => rows.slice().sort((a, b) => (a.k === SC.FOLDED) - (b.k === SC.FOLDED) || byKey(a.k, b.k));
      function prepare(raw, domains = {}) {
        const od = raw.overdose;
        const ep = raw.episodes;
        const months = onDomain(od.by_month, domains.months, "month", (month) => ({ month, n: 0, reversals: 0, reversal_doses: 0 }), true);
        const by = onDomain(od.by_administered_by, domains.administered_by, "k", (k) => ({ k, n: 0 }));
        const dis = onDomain(ep.by_discharge_reason, domains.discharge_reasons, "k", (k) => ({ k, n: 0 }));
        return {
          ...raw,
          demographics: Object.fromEntries(Object.entries(raw.demographics).map(([k, rows]) => [k, keyOrder(rows)])),
          episodes: { ...ep, by_discharge_reason: dis.map((x) => x.row) },
          overdose: { ...od, by_month: months.map((x) => x.row), by_administered_by: by.map((x) => x.row) },
          fixed: { months: months.map((x) => x.fixed), by: by.map((x) => x.fixed), dis: dis.map((x) => x.fixed) }
        };
      }
      function buildModel({ funder: raw, perFund, settlement }, T) {
        const vars = [];
        const cons = [];
        const derived = [];
        const mirror = [];
        const v = (id, value, o = {}) => {
          vars.push({ id, value, people: o.people !== false, total: !!o.total, table: o.table || id, published: o.published !== false, ...o.aux ? { aux: true } : {} });
          return vars.length - 1;
        };
        const rel = (terms, op, rhs = 0) => cons.push({ terms, op, rhs });
        const soft = (terms, op, rhs = 0) => cons.push({ terms, op, rhs, soft: true });
        const fixed = raw.fixed || {};
        const present = (idx, f = []) => idx.forEach((i, j) => {
          if (!f[j]) rel([[i, 1]], ">=", 1);
        });
        const h = {};
        const u = raw.unduplicated;
        const N = h.N = v("served", u.served, { total: true, table: "unduplicated.served" });
        h.newAdm = v("new_admissions", u.new_admissions, { table: "unduplicated.new_admissions" });
        const subset = (id, value, table, o = {}) => {
          const i = v(id, value, { table, ...o });
          rel([[i, 1], [N, -1]], "<=");
          derived.push({ id: `${id}:rest`, terms: [[N, 1], [i, -1]] });
          return i;
        };
        h.mat = subset("on_mat", u.on_mat, "unduplicated.on_mat");
        h.ref = subset("with_a_referral", u.with_a_referral, "unduplicated.with_a_referral");
        h.adm = subset("admitted_after_referral", u.admitted_after_referral, "unduplicated.admitted_after_referral");
        h.dem = {};
        for (const k of PARTITIONS) {
          h.dem[k] = raw.demographics[k].map((x) => v(`${k}.${x.k}`, x.n, { table: `demographics.${k}` }));
          rel([...h.dem[k].map((i) => [i, 1]), [N, -1]], "=");
        }
        const race = raw.demographics.by_race_code;
        h.race = race.map((x) => subset(`by_race_code.${x.k}`, x.n, "demographics.by_race_code"));
        if (h.race.length) rel([...h.race.map((i) => [i, 1]), [N, -1]], ">=");
        const unknown = race.findIndex((x) => x.k === "unknown");
        if (unknown >= 0) h.race.forEach((i, j) => {
          if (j !== unknown) rel([[i, 1], [h.race[unknown], 1], [N, -1]], "<=");
        });
        const fundVars = /* @__PURE__ */ new Map();
        h.funds = raw.by_funding_source.map((f) => {
          if (f.combined) return null;
          const p = subset(`fund.${f.id}.people`, f.clients_served, "by_funding_source");
          const s = v(`fund.${f.id}.services`, f.services, { people: false, table: "by_funding_source" });
          rel([[p, 1], [s, -1]], "<=");
          mirror.push([p, s]);
          fundVars.set(f.id, { p, s });
          return { p, s };
        });
        const partOf = /* @__PURE__ */ new Map();
        h.folds = [];
        const watch = {};
        const fold = raw.fund_fold;
        if (fold) {
          for (const g of fold.groups) {
            const k = g.members.length;
            const tag = `fund.${fold.id}/${g.key === null ? "-" : g.key}`;
            const table = `unpublished.fund.${fold.id}`;
            let x;
            if (g.key === null) {
              x = v(`${tag}.one`, perFund.get(g.members[0])?.clients_served || 1, { table, published: false });
              rel([[x, 1], [N, -1]], "<=");
            } else {
              const q = v(`${tag}.people`, g.people, { table, published: false, aux: k > 1 });
              const t = v(`${tag}.services`, g.services, { people: false, table, published: false });
              rel([[q, 1], [t, -1]], "<=");
              rel([[q, 1], [N, -1]], "<=");
              const part = { p: q, s: t, aux: k > 1 };
              for (const id of g.members) partOf.set(id, part);
              if (k === 1) x = q;
              else {
                x = v(`${tag}.one`, perFund.get(g.members[0])?.clients_served || 1, { table, published: false });
                rel([[x, 1], [q, -1]], "<=");
                rel([[q, 1], [x, -1]], "<=", (k - 1) * (T - 1));
              }
              watch[q] = [x];
              rel([[x, 1], [t, -1]], "<=", -(k - 1));
            }
            rel([[x, 1]], ">=", 1);
            rel([[x, 1]], "<=", T - 1);
            derived.push({ id: `${vars[x].id}:rest`, terms: [[N, 1], [x, -1]] });
            h.folds.push({ key: g.key, x });
          }
        }
        const byUseKey = /* @__PURE__ */ new Map();
        const listed = /* @__PURE__ */ new Set();
        for (const f of settlement.fundKeys) {
          const act = perFund.get(f.id);
          if (!act || !act.services) continue;
          if (partOf.has(f.id)) {
            const part = partOf.get(f.id);
            if (listed.has(part)) continue;
            listed.add(part);
            if (!byUseKey.has(f.key)) byUseKey.set(f.key, []);
            byUseKey.get(f.key).push(part);
            continue;
          }
          if (!fundVars.has(f.id)) {
            const p = subset(`fund.${f.id}.people`, act.clients_served, `unpublished.fund.${f.id}`, { published: false });
            const s = v(`fund.${f.id}.services`, act.services, { people: false, table: `unpublished.fund.${f.id}`, published: false });
            rel([[p, 1], [s, -1]], "<=");
            fundVars.set(f.id, { p, s });
          }
          if (!byUseKey.has(f.key)) byUseKey.set(f.key, []);
          byUseKey.get(f.key).push(fundVars.get(f.id));
        }
        h.uses = settlement.services_by_use.map((x) => {
          const p = subset(`use.${x.use_code}.people`, x.people, "settlement.services_by_use");
          const s = v(`use.${x.use_code}.services`, x.services, { people: false, table: "settlement.services_by_use" });
          rel([[p, 1], [s, -1]], "<=");
          mirror.push([p, s]);
          const fs = byUseKey.get(x.use_code) || [];
          if (fs.length) {
            rel([[s, 1], ...fs.map((f) => [f.s, -1])], "=");
            rel([[p, 1], ...fs.map((f) => [f.p, -1])], "<=");
            for (const f of fs) {
              rel([[p, 1], [f.p, -1]], ">=");
              if (!f.aux) derived.push({ id: `use.${x.use_code}-${vars[f.p].id}`, terms: [[p, 1], [f.p, -1]] });
            }
            for (const fo of h.folds) if (fo.key === x.use_code && !fs.some((f) => f.p === fo.x)) derived.push({ id: `use.${x.use_code}-${vars[fo.x].id}`, terms: [[p, 1], [fo.x, -1]] });
          }
          return { p, s };
        });
        const ep = raw.episodes;
        h.epAdm = v("episodes.admissions", ep.admissions, { table: "episodes.admissions" });
        h.epOpen = v("episodes.open_at_end", ep.open_at_end, { table: "episodes.open_at_end" });
        h.D = v("episodes.discharges", ep.discharges, { total: true, table: "episodes.discharges" });
        h.dis = ep.by_discharge_reason.map((x) => v(`discharge.${x.k}`, x.n, { table: "episodes.by_discharge_reason" }));
        rel([...h.dis.map((i) => [i, 1]), [h.D, -1]], "=");
        present(h.dis, fixed.dis);
        soft([[h.epAdm, 1], [h.D, -1], [h.epOpen, -1]], "<=");
        derived.push({ id: "episodes.carried_in", terms: [[h.D, 1], [h.epOpen, 1], [h.epAdm, -1]] });
        const od = raw.overdose;
        const E = h.E = v("overdose.events", od.events, { total: true, table: "overdose.events" });
        const R = h.R = v("overdose.reversals", od.reversals, { total: true, table: "overdose.reversals" });
        const F = h.F = v("overdose.fatal", od.fatal, { table: "overdose.fatal" });
        const Cm = h.C = v("overdose.community_reported", od.community_reported, { table: "overdose.community_reported" });
        h.r = od.by_month.map((x) => v(`overdose.${x.month}.reversals`, x.reversals, { table: "overdose.by_month.reversals" }));
        h.by = od.by_administered_by.map((x) => v(`overdose.by.${x.k}`, x.n, { table: "overdose.by_administered_by" }));
        rel([...h.r.map((i) => [i, 1]), [R, -1]], "=");
        rel([...h.by.map((i) => [i, 1]), [R, -1]], "=");
        rel([[R, 1], [E, -1]], "<=");
        present(h.by, fixed.by);
        rel([[F, 1], [E, -1]], "<=");
        rel([[Cm, 1], [E, -1]], "<=");
        soft([[F, 1], [R, 1], [E, -1]], "<=");
        derived.push(
          { id: "overdose.not_reversed", terms: [[E, 1], [R, -1]] },
          { id: "overdose.not_fatal", terms: [[E, 1], [F, -1]] },
          { id: "overdose.not_community", terms: [[E, 1], [Cm, -1]] },
          { id: "overdose.neither", terms: [[E, 1], [R, -1], [F, -1]] }
        );
        h.d = od.by_month.map((x) => v(`ndp.${x.month}.reversal_doses`, x.reversal_doses || 0, { people: false, table: "ndp.by_month.reversal_doses" }));
        const Dr = h.Dr = v("ndp.reversal_doses", od.by_month.reduce((a, x) => a + (x.reversal_doses || 0), 0), { people: false, total: true, table: "ndp.reversal_doses" });
        const Dall = h.Dall = v("overdose.naloxone_doses", od.naloxone_doses || 0, { people: false, total: true, table: "overdose.naloxone_doses" });
        rel([...h.d.map((i) => [i, 1]), [Dr, -1]], "=");
        h.d.forEach((d, m) => {
          soft([[d, 1], [h.r[m], -1]], ">=");
          soft([[d, 1], [h.r[m], -DOSES_MAX]], "<=");
          mirror.push([h.r[m], d]);
        });
        soft([[Dall, 1], [Dr, -1]], ">=");
        soft([[Dall, 1], [E, -DOSES_MAX]], "<=");
        soft([[Dall, 1], [Dr, -1], [E, -DOSES_MAX], [R, DOSES_MAX]], "<=");
        mirror.push([R, Dr], [R, Dall], [E, Dall]);
        return { model: { vars, cons, derived, mirror, watch, keep: [HEADLINE], headlineVar: N, companions: [h.newAdm, h.epAdm] }, h };
      }
      function digest(text) {
        let h1 = 2166136261;
        let h2 = 16777619;
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i);
          h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
          h2 = Math.imul(h2 ^ c, 1540483477) >>> 0;
        }
        return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
      }
      var TABLE_LABEL = {
        "unduplicated.new_admissions": "New admissions",
        "unduplicated.on_mat": "On medication for opioid use disorder",
        "unduplicated.with_a_referral": "Received a referral",
        "unduplicated.admitted_after_referral": "Admitted after a referral",
        "demographics.by_gender": "Gender",
        "demographics.by_language": "Language",
        "demographics.by_housing": "Housing",
        "demographics.by_insurance": "Insurance",
        "demographics.by_ethnicity": "Ethnicity",
        "demographics.by_race_code": "Race",
        by_funding_source: "People and services by funding source",
        "settlement.services_by_use": "Settlement report: people and services by allowable use",
        "episodes.admissions": "Episodes opened",
        "episodes.open_at_end": "Episodes open at the end of the period",
        "episodes.discharges": "Episodes closed",
        "episodes.by_discharge_reason": "Discharge reasons",
        "overdose.events": "Overdose events",
        "overdose.reversals": "Reversals",
        "overdose.fatal": "Fatal overdoses",
        "overdose.community_reported": "Overdoses reported from the community",
        "overdose.by_month.reversals": "Reversals by month (and the NDP log's reversals)",
        "overdose.by_administered_by": "Who gave the naloxone",
        "ndp.by_month.reversal_doses": "Naloxone doses used in reversals, by month",
        "ndp.reversal_doses": "Naloxone doses used in reversals",
        "overdose.naloxone_doses": "Naloxone doses used"
      };
      var NOT_PUBLISHED = [{
        table: "overdose.by_month.n",
        label: "Overdose events by month",
        why: "A publication release gives the period's overdose events as totals and the reversals by month. The events by month are left out of every publication release: beside the reversals by month they would show each month's events that were not reversed, often a handful, and checking that took most periods past what the check can afford. The program's own submission to its funder still has them."
      }];
      var WITHHELD_WHY = {
        protect: "Too few people to show it without giving someone away.",
        check: "The automatic check could not confirm that its small counts are protected, so it was left out and the rest of the release was checked again without it."
      };
      function withheldReasons(tables, degraded = []) {
        const d = new Set(degraded);
        return [...tables].sort().map((t) => ({ table: t, label: TABLE_LABEL[t] || t, reason: d.has(t) ? "check" : "protect", why: WITHHELD_WHY[d.has(t) ? "check" : "protect"] }));
      }
      function refusalMessage(r, months = 0) {
        const why = r.backstop ? "the check of this period's figures ran past the server's time limit" : r.outOfBudget ? "the check of this period's figures reached its limit before it could finish" : r.headline ? "the number of people served could not be shown without giving someone away" : "the check could not confirm that every small count in it is protected";
        const tell = "tell whoever supports your SUDS (your IT partner or county) which period was refused; the server log records the check's figures. A programme with no one to tell can report it at https://github.com/taugustincst/suds/issues (the period and this message only, never a client's details).";
        const next = months >= 12 ? `A year is the longest standard period. Its four quarters may be tried instead, each once its figures are complete: each is checked on its own and may be refused too. Never publish a quarter beside its year: a year and its quarters can be subtracted from each other. If the quarters are refused as well, this year cannot be published in this version of SUDS; ${tell}` : months >= 3 ? `Its fiscal year may be tried instead once the year has ended, unless the year was refused too or another quarter of it is already published (a year and its quarters can be subtracted from each other). Otherwise this quarter cannot be published in this version of SUDS; ${tell}` : "Publish a longer standard period (a quarter or a year).";
        return `This period cannot be published: ${why}, so no publication release was made. ${next} The program's own submission to its funder, which is not for publication, is unaffected.`;
      }
      function protectFigures(inputs, T, { strict = false, budget, stepLimit, timeLimitMs = AUDIT_BACKSTOP_MS, degrade = true } = {}) {
        const raw = prepare(inputs.funder, inputs.domains);
        const { model, h } = buildModel({ ...inputs, funder: raw }, T);
        model.strict = strict;
        const audit = SDC.protect(model, T, { ...budget === void 0 ? {} : { budget }, ...stepLimit === void 0 ? {} : { stepLimit }, timeLimitMs, degrade });
        const { status, withheldTables } = audit;
        const stats = { steps: audit.steps, rounds: audit.rounds, degraded: audit.degraded };
        if (!audit.verified) {
          return { refused: { out_of_budget: audit.outOfBudget, backstop: audit.backstop, headline: audit.headline, unprotected: audit.unprotected.length, message: refusalMessage(audit, (inputs.domains?.months || []).length) }, withheld_tables: withheldTables, status, model, audit: stats };
        }
        const show = (i) => status[i] === "vis" ? model.vars[i].value : status[i] === "pri" ? SC.primary(T) : status[i] === "sec" ? SC.SECONDARY : SC.WITHHELD;
        const gone = new Set(withheldTables);
        const withheld = [];
        const demographics = {};
        for (const k of [...PARTITIONS.slice(0, 4), "by_race_code", "by_ethnicity"]) {
          const idx = k === "by_race_code" ? h.race : h.dem[k];
          if (gone.has(`demographics.${k}`)) {
            withheld.push(k);
            demographics[k] = [];
            continue;
          }
          demographics[k] = raw.demographics[k].map((x, i) => SC.withCell(x, "n", show(idx[i])));
        }
        const ep = raw.episodes;
        const od = raw.overdose;
        const disGone = gone.has("episodes.by_discharge_reason");
        const byGone = gone.has("overdose.by_administered_by");
        const revGone = gone.has("overdose.by_month.reversals");
        const monthsGone = revGone;
        if (disGone) withheld.push("by_discharge_reason");
        if (byGone) withheld.push("by_administered_by");
        if (monthsGone) withheld.push("by_month");
        const smallGroup = ep.discharges > 0 && ep.discharges < T;
        const byFund = raw.by_funding_source.map((f, i) => h.funds[i] ? { ...SC.withCell(f, "clients_served", show(h.funds[i].p)), services: show(h.funds[i].s) } : f);
        const none = byFund.find((f) => f.id === null);
        const funder = {
          unduplicated: { served: show(h.N), new_admissions: show(h.newAdm), with_a_referral: show(h.ref), admitted_after_referral: show(h.adm), on_mat: show(h.mat) },
          demographics,
          withheld,
          episodes: {
            ...ep,
            admissions: show(h.epAdm),
            discharges: show(h.D),
            open_at_end: show(h.epOpen),
            by_discharge_reason: disGone ? [] : ep.by_discharge_reason.map((x, i) => SC.withCell(x, "n", show(h.dis[i]))),
            // A median over fewer people than the threshold is one of them.
            median_length_of_stay_days: smallGroup || show(h.D) === SC.WITHHELD ? SC.SECONDARY : ep.median_length_of_stay_days
          },
          overdose: {
            ...od,
            events: show(h.E),
            reversals: show(h.R),
            fatal: show(h.F),
            community_reported: show(h.C),
            naloxone_doses: show(h.Dall),
            by_month: monthsGone ? [] : od.by_month.map((x, m) => {
              const r = show(h.r[m]);
              return { month: x.month, reversals: r, ...typeof r === "number" ? {} : { suppressed: true } };
            }),
            by_administered_by: byGone ? [] : od.by_administered_by.map((x, i) => SC.withCell(x, "n", show(h.by[i])))
          },
          naloxone_distribution: raw.naloxone_distribution,
          by_funding_source: byFund,
          attribution: { ...raw.attribution, unattributed_clients: none ? none.clients_served : 0, unattributed_services: none ? none.services : raw.attribution.unattributed_services }
        };
        const uses = h.uses.map((x) => ({ people: show(x.p), services: show(x.s) }));
        const ndp = { rows: revGone ? [] : od.by_month.map((x, m) => ({ month: x.month, reversals: show(h.r[m]), reversal_doses: show(h.d[m]) })), reversals: show(h.R), reversal_doses: show(h.Dr) };
        const id = digest(JSON.stringify(model.vars.map((x, i) => x.published ? [x.id, show(i)] : null).filter(Boolean)));
        return { funder, uses, ndp, withheld_tables: withheldTables, withheld_reasons: withheldReasons(withheldTables, audit.degraded), id, status, model, audit: stats };
      }
      module.exports = { protectFigures, buildModel, prepare, digest, monthsOf, withheldReasons, refusalMessage, TABLE_LABEL, NOT_PUBLISHED, HEADLINE, AUDIT_BACKSTOP_MS };
    }
  });

  // local/audit-worker.js
  var require_audit_worker = __commonJS({
    "local/audit-worker.js"() {
      var import_release_audit = __toESM(require_release_audit());
      self.onmessage = (ev) => {
        const { id, inputs, T, opts } = ev.data || {};
        let out;
        try {
          out = { id, result: import_release_audit.default.protectFigures(inputs, T, opts || {}) };
        } catch (e) {
          out = { id, error: String(e && e.message || e) };
        }
        self.postMessage(out);
      };
      self.postMessage({ ready: true });
    }
  });
  require_audit_worker();
})();
