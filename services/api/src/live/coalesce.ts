/**
 * Calls `fn` at most once per `intervalMs`, running a trailing call when
 * notifications arrive during the quiet period.
 *
 * Buses report every five seconds, so a line with several buses would otherwise
 * push a snapshot to every passenger several times a second. Coalescing keeps
 * the phone's radio quiet without making the display stale.
 */
export function coalesce(fn: () => void, intervalMs: number, now: () => number = () => Date.now()) {
  let lastRun = 0;
  let timer: NodeJS.Timeout | null = null;

  const run = () => {
    lastRun = now();
    timer = null;
    fn();
  };

  const trigger = () => {
    if (timer) return;
    const wait = intervalMs - (now() - lastRun);
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };

  trigger.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return trigger;
}
