'use strict';
// Wait for a condition instead of sleeping a fixed time and hoping. A fixed sleep is either too short on a
// loaded CI runner (the test flakes) or needlessly long everywhere else. The timeout is only a backstop for
// a condition that never comes true; a passing test returns as soon as it does.

/**
 * Resolve with the first truthy value of `cond()` (which may be async), checking every `interval` ms.
 * Rejects with `message` after `timeout` ms.
 */
async function waitFor(cond, { timeout = 10_000, interval = 5, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = { waitFor };
