// The e2e run starts at this instant in every process (server, test runner, browser),
// so time-of-day rules (bedtime, schedules) and weekday limits are deterministic.
export const E2E_NOW = "2026-06-10T12:00:00-05:00"; // a Wednesday, noon in America/Chicago

/**
 * Moves `Date` by a constant offset; timers and monotonic clocks are untouched.
 * Self-contained, because Playwright also serializes it into the browser.
 * @param {number} offset milliseconds
 */
export function shiftClock(offset) {
  if (!offset || globalThis.__e2eClockOffset !== undefined) return;
  globalThis.__e2eClockOffset = offset;
  const RealDate = Date;
  const realNow = Date.now.bind(Date);
  RealDate.now = () => realNow() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(
        target,
        args.length ? args : [RealDate.now()],
        newTarget,
      ),
    apply: () => new RealDate(RealDate.now()).toString(),
  });
}

// Preloaded into the e2e server with `node --import`.
shiftClock(Number(globalThis.process?.env.E2E_CLOCK_OFFSET_MS));
