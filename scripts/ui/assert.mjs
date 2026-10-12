// Shared assertions for the browser scripts.
//
// These scripts used to fail only on a page error, a console error or an HTTP 5xx; everything they
// actually checked was printed with console.log and compared to nothing. sync-two-way.mjs printed
// "office sees phone goal: false" and exited 0 — the two-way sync test went green with sync broken.
// ok() makes an expectation a real pass or fail.
/**
 * Poll until `fn()` is truthy, then return it; give up at `timeout` and return the last value.
 * Browser work is asynchronous: sampling for an outcome at a fixed moment passes on a fast machine
 * and fails on a slow one, which is a broken test rather than a broken app.
 */
export async function until(fn, { timeout = 10000, every = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    // A probe that throws because the page is mid-navigation ("execution context was destroyed") is the
    // same as a probe that found nothing yet: keep polling until the deadline, then let the error out.
    try { last = await fn(); } catch (e) { if (Date.now() >= deadline) throw e; last = null; }
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await new Promise(r => setTimeout(r, every));
  }
}

/**
 * Wait until the app has finished what it was doing: no request in flight, nothing scheduled (the Home
 * tour), the current address rendered, and quiet for `quiet` ms (public/app.js keeps window.__sudsActivity).
 * This is what the fixed waitForTimeout() calls after a goto, a reload or a click were guessing at.
 * Throws on timeout, so a page that never settles fails the script instead of passing by luck.
 */
export async function settle(page, { timeout = 15000, quiet = 120 } = {}) {
  await page.waitForFunction((q) => {
    const a = window.__sudsActivity;
    return !!a && a.pending === 0 && a.rendered === location.hash && Date.now() - a.at >= q;
  }, quiet, { timeout, polling: 50 });
}

/** Wait until the in-browser kernel has written everything to IndexedDB (its save is debounced). */
export async function saved(page, { timeout = 15000 } = {}) {
  await page.waitForFunction(() => window.SUDS_LOCAL && !(window.SUDS_LOCAL.isDirty && window.SUDS_LOCAL.isDirty()), null, { timeout, polling: 50 });
}

/**
 * Put the first-visit welcome away the way a person does, deterministically: the card on Home (its Got it),
 * or on an older build the tour dialog Home scheduled 400 ms after it rendered (its Skip). Its own Skip records tour_done (on a device copy, in the kernel — waited for until it is on
 * disk, so a reload does not bring the tour back over the next click). Removing the dialog from the DOM
 * instead, as scripts used to, left the tour free to open again after a reload and take a click meant for
 * the page: device-audit and forms failed that way now and then.
 */
export async function skipTour(page) {
  await settle(page);
  // Since 1.14.0 the welcome is a card on Home ("Got it"), not a dialog; the dialog's Skip is still handled
  // for a build from before then (qa-retest replays an older static site).
  const skip = await page.$('.modal-bg .modal .btn-row button.ghost:has-text("Skip")');
  if (skip) { await skip.click(); await until(async () => !(await page.$('.modal-bg')), { timeout: 5000 }); await settle(page); }
  const gotIt = await page.$('[data-welcome-done]');
  if (gotIt) { await gotIt.click(); await until(async () => !(await page.$('[data-welcome]')), { timeout: 5000 }); await settle(page); }
  if (await page.evaluate(() => !!(window.SUDS_LOCAL && window.SUDS_LOCAL.isDirty))) await saved(page);
}

/**
 * The on-device app is locked after every page load until an account signs in (local/kernel.js,
 * docs/architecture/ADR-0008-device-encryption.md). Wait for the page to finish booting and, if it is
 * showing the sign-in form, sign in; resolves once the app is showing (on the page it was on before).
 */
export async function signInAgain(page, username, password, { timeout = 20000 } = {}) {
  await page.waitForSelector('.layout, .login input[name=username], .boot.error', { timeout });
  if (!(await page.$('.layout')) && (await page.$('.login input[name=username]'))) {
    await page.fill('.login input[name=username]', username); await page.fill('.login input[name=password]', password);
    await page.click('.login button[type=submit]');
    await page.waitForSelector('.layout', { timeout });
  }
}

/**
 * Past the recovery-code screen a device shows once after its first account is set up (public/views/local.js):
 * tick "I have saved my recovery code" and continue, as a person does. Nothing to do where the app did not show
 * it (an older build, the office server). Returns the code that was shown, or null.
 */
export async function passRecoveryCode(page) {
  // A build from before 1.9.x keeps no activity record to settle on (multitab and qa-retest replay one); it
  // has no recovery code either.
  if (!(await page.evaluate(() => !!window.__sudsActivity).catch(() => false))) return null;
  await settle(page);
  if (!(await page.$('[data-recovery-screen]'))) return null;
  const code = (await page.textContent('[data-recovery-code]')).trim();
  await page.check('[data-recovery-screen] input[name=saved]');
  await page.click('[data-recovery-screen] button[type=submit]');
  await page.waitForSelector('[data-recovery-screen]', { state: 'detached', timeout: 15000 });
  await settle(page);
  return code;
}

// Playwright's WebKit on a Linux runner (CI's advisory `webkit` job) is WebKitGTK/WPE with Playwright's own
// storage and network emulation, not iOS Safari. Two service-worker cache checks fail there on every run
// while the same code passes in Chromium, and while, in the same WebKit run, the installed app itself boots
// offline from that very cache:
//  * in a persistent profile relaunched on a newer build, the new worker's shell cache stays empty — every
//    Cache.put fails, including the ones the fetch handler makes for files the page demonstrably loaded;
//  * with the context set offline, a page-level fetch('get-app.html') fails ("Load failed") although the
//    page is controlled and the entry is in the cache.
// Neither pattern is a code path a device takes differently, so they are treated as environment limitations
// there — reported as SKIP with the diagnostic detail, never skipped in Chromium or on macOS — and offline
// after an upgrade is checked on a real iPhone (docs/ADOPTION.md §4). If one starts passing it counts as ok.
export const PLAYWRIGHT_WEBKIT_LINUX = (process.env.SUDS_BROWSER || 'chromium') === 'webkit' && process.platform === 'linux';
export const WEBKIT_LINUX_SW_CACHE = 'Playwright WebKit on Linux does not reproduce iOS service-worker cache storage/offline emulation; checked on a real iPhone instead (docs/ADOPTION.md §4)';

/**
 * The first navigation of a fresh context: go to `url` and wait for `selector` (1.25.6; evaluation of 1.25.5, J4). In
 * CI's WebKit a fresh context's first load has now and then never shown the sign-up form, and the log said only
 * "TimeoutError". On any failure this gathers how far the page got (its ready state, the service worker, whether the
 * kernel (window.SUDS_LOCAL) is there and its phase, the boot text, which kernel, WebAssembly, boot and worker files
 * were requested and which finished, failed or are still pending, with their timings, and the console errors so far)
 * and fails with it in one line, so the next failure names the stage that stalled. It never retries: a stall is a
 * failure. Prints a FAIL line unless `quiet` (a caller that reports what it catches), and throws.
 */
const BOOT_FILES = /local\/kernel\.js|sql-wasm\.wasm|local-boot\.js|\/sw\.js|\/app\.js|audit-worker\.js/;
export async function firstLoad(page, url, selector, { timeout = 20000, quiet = false } = {}) {
  const t0 = Date.now(); const ms = () => Date.now() - t0;
  const errorsSoFar = []; const files = new Map();
  const name = (u) => { try { const x = new URL(u); return x.pathname + (x.search ? '?…' : ''); } catch { return String(u).slice(0, 80); } };
  const onConsole = (m) => { if (m.type() === 'error' && errorsSoFar.length < 8) errorsSoFar.push(m.text().slice(0, 200)); };
  const onPageError = (e) => { if (errorsSoFar.length < 8) errorsSoFar.push(`PAGEERROR ${String(e.message).slice(0, 200)}`); };
  const onRequest = (r) => { if (BOOT_FILES.test(r.url())) files.set(r, { file: name(r.url()), at: ms(), sw: !!r.serviceWorker && !!r.serviceWorker() }); };
  const onDone = (how) => (r) => { const f = files.get(r); if (f) { f.done = how === 'failed' ? `failed ${r.failure() ? r.failure().errorText : ''}`.trim() : 'ok'; f.after = ms() - f.at; } };
  const finished = onDone('ok'); const failed = onDone('failed');
  page.on('console', onConsole); page.on('pageerror', onPageError); page.on('request', onRequest); page.on('requestfinished', finished); page.on('requestfailed', failed);
  try {
    // As the scripts did before: the navigation on Playwright's own 30 s, then `timeout` for the selector.
    await page.goto(url, { timeout: 30000 });
    await page.waitForSelector(selector, { timeout });
  } catch (e) {
    const probe = page.evaluate(async () => {
      const sw = navigator.serviceWorker; let reg = null;
      try { const r = sw && await Promise.race([sw.getRegistration(), new Promise(res => setTimeout(() => res('no answer in 2 s'), 2000))]); reg = typeof r === 'string' ? r : r ? { installing: r.installing && r.installing.state, waiting: r.waiting && r.waiting.state, active: r.active && r.active.state } : 'none'; } catch (x) { reg = String(x); }
      const L = window.SUDS_LOCAL; let phase = null; try { phase = L && typeof L.phase === 'function' ? L.phase() : null; } catch (x) { phase = String(x); }
      const boot = document.querySelector('.boot');
      const res = performance.getEntriesByType('resource').filter(r => /kernel\.js|sql-wasm\.wasm|local-boot\.js|sw\.js|app\.js/.test(r.name))
        .map(r => `${new URL(r.name).pathname} at ${Math.round(r.startTime)} ms took ${Math.round(r.duration)} ms`);
      const nav = performance.getEntriesByType('navigation')[0];
      return { readyState: document.readyState, hash: location.hash, sinceNavigation: Math.round(performance.now()), domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null, load: nav ? Math.round(nav.loadEventEnd) : null,
        controlled: !!(sw && sw.controller), controllerState: sw && sw.controller ? sw.controller.state : null, registration: reg,
        SUDS_LOCAL: !!L, phase, boot: boot ? boot.textContent.trim().slice(0, 120) : null, resources: res, body: document.body ? document.body.innerText.trim().slice(0, 120) : null };
    });
    const trace = await Promise.race([probe, new Promise(res => setTimeout(() => res('the page did not answer a probe within 5 s'), 5000))]).catch(x => `the probe failed: ${String(x.message || x).split('\n')[0]}`);
    const requested = [...files.values()].map(f => `${f.file}${f.sw ? ' (worker)' : ''} at ${f.at} ms: ${f.done ? `${f.done} after ${f.after} ms` : 'PENDING'}`);
    const message = `first load of ${url} did not show ${selector} (${String(e.message || e).split('\n')[0]}) — trace: ${JSON.stringify({ page: trace, requested, consoleErrors: errorsSoFar })}`;
    if (!quiet) console.log(` FAIL  ${message}`);
    const stalled = new Error(message);
    throw stalled;
  } finally {
    page.off('console', onConsole); page.off('pageerror', onPageError); page.off('request', onRequest); page.off('requestfinished', finished); page.off('requestfailed', failed);
  }
}

// Known defects (1.25.6; evaluation of 1.25.5, J4). A check that fails on every run in one browser, for a reason not
// yet fixed, is a known defect, not a flake (docs/RELEASE.md, *Known defects*). Each has a row there, under its id, and
// one entry here: the browser it is known in (SUDS_BROWSER) and the failure it is known by (`signature`, tested
// against the check's detail). Only that failure, in that browser, is reported as KNOWN DEFECT and does not fail the
// script; anything else, and the same check in any other browser, is an ordinary check. A known defect that does not
// reproduce says so, so its row can be closed.
export const KNOWN_DEFECTS = {
  // The same reload either crashes the page or hangs it (page.reload timing out; first on main's run 38314191087).
  'WK-1': { browser: 'webkit', signature: /Page crashed|page\.reload: Timeout/,
    title: 'Playwright WebKit on Linux crashes the page at the reload after Start over, a restore and a sign-out (the records survive)',
    register: 'docs/RELEASE.md#known-defects' },
};
const browserName = () => process.env.SUDS_BROWSER || 'chromium';

/**
 * Text a page must never show: a null or undefined written out as a word ("nullnull" under My shift, r10 H1 —
 * the DOM's own append() and replaceChildren() write a null as the text "null", where h() leaves it out), NaN, or
 * "[object Object]". Looks at every text node outside script/style/form fields and user-written blocks (a note's
 * <pre>, code, a record's stored JSON such as the audit log's details), and at the names and hints a screen reader or a pointer shows (aria-label, title, placeholder,
 * alt). Returns one line per finding, naming the element and the nearest dialog, card or section.
 */
export const STRAY_TEXT_PROBE = () => {
  const out = [];
  const where = (el) => { const box = el.closest('.modal, [data-ai-panel], [data-outreach-shift], .card, section, main, nav, header'); return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} in ${box ? (box.getAttribute('aria-label') || box.className || box.tagName).toString().slice(0, 40) : 'body'}`; };
  const bad = (t) => /\b(null|undefined|NaN)\b|(null|undefined){2,}|\[object \w+\]/.test(t);
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest('script, style, textarea, template, noscript, code, pre, [contenteditable]')) continue;
    const t = n.textContent.trim();
    // A record shown as its stored JSON (the audit log's details) says null legitimately.
    if (t && bad(t) && !/^[[{]"/.test(t)) out.push(`${where(p)}: "${t.slice(0, 60)}"`);
  }
  for (const el of document.body.querySelectorAll('[aria-label], [title], [placeholder], img[alt]')) {
    for (const a of ['aria-label', 'title', 'placeholder', 'alt']) { const v = el.getAttribute(a); if (v && /\b(undefined|null|NaN)\b|\[object \w+\]/.test(v)) out.push(`${where(el)} [${a}]: "${v.slice(0, 60)}"`); }
  }
  return [...new Set(out)];
};
/** STRAY_TEXT_PROBE on the page as it is now. */
export const strayText = (page) => page.evaluate(STRAY_TEXT_PROBE);

export function makeChecks(name) {
  const failures = [];
  const results = [];

  /** Assert a condition. Prints the outcome and records a failure if it is falsy. */
  const ok = (condition, description, detail) => {
    const passed = !!condition;
    results.push({ passed, description });
    if (!passed) failures.push(`${description}${detail === undefined ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    console.log(`${passed ? '  ok  ' : ' FAIL '} ${description}${passed || detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
    return passed;
  };

  /** Assert two values are equal. */
  const eq = (actual, expected, description) => ok(actual === expected, `${description} (expected ${JSON.stringify(expected)})`, actual);

  /** Record a failure without a condition — for a step that threw. */
  const fail = (message) => { failures.push(message); console.log(` FAIL  ${message}`); };

  /**
   * ok(), except that where `known` is true (an environment the check is known not to work in, e.g. Playwright
   * WebKit on Linux) a failure is reported as SKIP with `reason` and its detail instead of failing the script.
   * A pass is a pass either way. Callers must make `known` specific (never true in Chromium), and say where
   * the check is covered instead.
   */
  const okUnless = (known, reason, condition, description, detail) => {
    if (!known || condition) return ok(condition, description, detail);
    skipped.push({ description, reason });
    console.log(` SKIP  ${description} — ${reason}${detail === undefined ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    return false;
  };
  const skipped = [];

  /**
   * ok(), for a check with a registered known defect (KNOWN_DEFECTS[id]). In the browser it is known for, a failure
   * whose detail matches its signature prints "KNOWN DEFECT <id>" with its register row and does not fail the script;
   * a pass there prints "KNOWN DEFECT <id> did not reproduce". In every other browser it is ok().
   */
  const knownDefect = (id, condition, description, detail) => {
    const d = KNOWN_DEFECTS[id];
    if (!d) { fail(`${description}: no known defect ${id} is registered (scripts/ui/assert.mjs KNOWN_DEFECTS)`); return false; }
    if (browserName() !== d.browser) return ok(condition, description, detail);
    if (condition) {
      const passed = ok(true, description);
      known.push({ id, description, reproduced: false });
      console.log(` KNOWN DEFECT ${id} did not reproduce: ${description} — close its row (${d.register})`);
      return passed;
    }
    if (!d.signature.test(String(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail)))) return ok(condition, `${description} (not the known defect ${id}'s failure)`, detail);
    known.push({ id, description, reproduced: true });
    console.log(` KNOWN DEFECT ${id} ${description} — ${d.title}; ${d.register}${detail === undefined ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    return false;
  };
  const known = [];

  /**
   * Finish: print the tally and set a non-zero exit code if anything failed.
   * `errors` is the script's collected page/console errors.
   */
  const finish = (errors = []) => {
    const all = [...failures, ...errors];
    const passed = results.filter(r => r.passed).length;
    const seen = known.filter(k => k.reproduced);
    console.log(`\n${name}: ${passed}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}${seen.length ? `, ${seen.length} known defect(s)` : ''}${all.length ? `, ${all.length} problem(s)` : ''}`);
    if (skipped.length) console.log('SKIPPED (known environment limitation):\n' + skipped.map(s => `  - ${s.description}: ${s.reason}`).join('\n'));
    if (known.length) console.log('KNOWN DEFECTS (registered in docs/RELEASE.md; not failing this script):\n' + known.map(k => `  - ${k.id}${k.reproduced ? '' : ' did not reproduce'}: ${k.description}`).join('\n'));
    if (all.length) { console.log('PROBLEMS:\n' + all.map(x => '  - ' + x).join('\n')); process.exitCode = 1; }
    else console.log('NO ERRORS');
    return all.length === 0;
  };

  /** ok() that the page shows no stray "null", "undefined", NaN or "[object Object]" (STRAY_TEXT_PROBE). */
  const noStrayText = async (page, where) => {
    const found = await strayText(page).catch((e) => [`the check could not run: ${e.message}`]);
    return ok(found.length === 0, `${where}: no stray "null" or "undefined" text`, found.length ? found.slice(0, 8) : undefined);
  };

  return { ok, eq, fail, okUnless, knownDefect, finish, noStrayText, failures, results, skipped, known };
}
