/**
 * Push, as Server-Sent Events.
 *
 * SSE rather than WebSockets because the stream is one-way, which is all a bus
 * position needs; it rides plain HTTP so it survives the proxies and captive
 * portals a cheap phone meets; and the browser and OS reconnect it without any
 * code from us. Polling was the alternative, and polling every few seconds from
 * every passenger is exactly what drains the battery and data budget the plan
 * says we must respect (docs/PLAN.md §2.6).
 *
 * A topic is a line and a direction. Publishers say only "something on this
 * line changed"; each subscriber then gets the current snapshot. At pilot scale
 * that is far simpler than diffing, and it is self-healing — a subscriber that
 * misses a notification is corrected by the next one.
 */
export type Topic = string;
export type Notify = () => void;

export function topicFor(routeId: string, dir: 0 | 1): Topic {
  return `${routeId}:${dir}`;
}

export class Hub {
  private subscribers = new Map<Topic, Set<Notify>>();

  subscribe(topic: Topic, notify: Notify): () => void {
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(notify);

    return () => {
      const current = this.subscribers.get(topic);
      if (!current) return;
      current.delete(notify);
      if (current.size === 0) this.subscribers.delete(topic);
    };
  }

  publish(topic: Topic): void {
    for (const notify of this.subscribers.get(topic) ?? []) {
      try {
        notify();
      } catch {
        // A failing subscriber must not stop the others being told.
      }
    }
  }

  subscriberCount(topic?: Topic): number {
    if (topic) return this.subscribers.get(topic)?.size ?? 0;
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }
}

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

/**
 * Short-lived permission to stream one line and direction.
 *
 * The plan requires reads to be bound rather than open, so the national live
 * picture cannot be enumerated by a script (§6.6). A passenger cannot hold a
 * request token before she has asked for anything, so the binding comes from
 * the lookup she already makes: asking which buses are running returns a ticket
 * for that line, and only that line.
 */
export type Ticket = { routeId: string; dir: 0 | 1; expiresAt: number };

export const TICKET_TTL_MS = 30 * 60_000;

export class Tickets {
  private issued = new Map<string, Ticket>();
  private now: () => number;
  private mint: () => string;

  constructor(now: () => number = () => Date.now(), mint: () => string = () => crypto.randomUUID()) {
    this.now = now;
    this.mint = mint;
  }

  issue(routeId: string, dir: 0 | 1): string {
    const id = this.mint();
    this.issued.set(id, { routeId, dir, expiresAt: this.now() + TICKET_TTL_MS });
    return id;
  }

  redeem(id: string): Ticket | null {
    const ticket = this.issued.get(id);
    if (!ticket) return null;
    if (ticket.expiresAt <= this.now()) {
      this.issued.delete(id);
      return null;
    }
    return ticket;
  }

  /** Drops expired tickets. Called opportunistically; nothing depends on it running. */
  prune(): void {
    const t = this.now();
    for (const [id, ticket] of this.issued) {
      if (ticket.expiresAt <= t) this.issued.delete(id);
    }
  }

  get size(): number {
    return this.issued.size;
  }
}
