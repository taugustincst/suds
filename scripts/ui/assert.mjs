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
   * Finish: print the tally and set a non-zero exit code if anything failed.
   * `errors` is the script's collected page/console errors.
   */
  const finish = (errors = []) => {
    const all = [...failures, ...errors];
    const passed = results.filter(r => r.passed).length;
    console.log(`\n${name}: ${passed}/${results.length} checks passed${all.length ? `, ${all.length} problem(s)` : ''}`);
    if (all.length) { console.log('PROBLEMS:\n' + all.map(x => '  - ' + x).join('\n')); process.exitCode = 1; }
    else console.log('NO ERRORS');
    return all.length === 0;
  };

  return { ok, eq, fail, finish, failures, results };
}
