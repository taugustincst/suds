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
   * Finish: print the tally and set a non-zero exit code if anything failed.
   * `errors` is the script's collected page/console errors.
   */
  const finish = (errors = []) => {
    const all = [...failures, ...errors];
    const passed = results.filter(r => r.passed).length;
    console.log(`\n${name}: ${passed}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}${all.length ? `, ${all.length} problem(s)` : ''}`);
    if (skipped.length) console.log('SKIPPED (known environment limitation):\n' + skipped.map(s => `  - ${s.description}: ${s.reason}`).join('\n'));
    if (all.length) { console.log('PROBLEMS:\n' + all.map(x => '  - ' + x).join('\n')); process.exitCode = 1; }
    else console.log('NO ERRORS');
    return all.length === 0;
  };

  return { ok, eq, fail, okUnless, finish, failures, results, skipped };
}
