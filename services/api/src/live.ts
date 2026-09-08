/**
 * Live state. Stands in for Redis with the same contract: an expiring, in-memory
 * store with no disk persistence, holding scalars only (docs/PLAN.md §6.2).
 *
 * The interface is deliberately narrow so swapping in Redis is a transport
 * change, not a redesign. Nothing here is ever written to disk, and there is no
 * history: an entry is either live or gone.
 */
import type { Direction } from "./wire.ts";

export type Clock = () => number;

/** What the realtime layer holds about a bus. Note the absence of a driver id. */
export type LiveTrip = {
  pseudonym: string;
  routeId: string;
  dir: Direction;
  remainingM: number;
  zoneSeq: number;
  speedKph: number;
  expiresAt: number;
};

export type LiveRequest = {
  pseudonym: string;
  routeId: string;
  dir: Direction;
  destinationId: string;
  remainingM: number;
  zoneSeq: number;
  expiresAt: number;
};

export const TRIP_TTL_MS = 60_000;
export const REQUEST_TTL_MS = 20 * 60_000;

class ExpiringStore<T extends { expiresAt: number }> {
  private items = new Map<string, T>();
  private now: Clock;

  constructor(now: Clock) {
    this.now = now;
  }

  set(key: string, value: T): void {
    this.items.set(key, value);
  }

  get(key: string): T | undefined {
    const v = this.items.get(key);
    if (!v) return undefined;
    if (v.expiresAt <= this.now()) {
      this.items.delete(key);
      return undefined;
    }
    return v;
  }

  delete(key: string): boolean {
    return this.items.delete(key);
  }

  /** Drops expired entries and returns what is still live. */
  live(): T[] {
    const t = this.now();
    const out: T[] = [];
    for (const [key, v] of this.items) {
      if (v.expiresAt <= t) this.items.delete(key);
      else out.push(v);
    }
    return out;
  }

  get size(): number {
    return this.live().length;
  }
}

export class LiveState {
  private trips: ExpiringStore<LiveTrip>;
  private requests: ExpiringStore<LiveRequest>;
  /**
   * Trip token to pseudonym, held only for the life of the trip. This is the
   * only place the two are associated, and it never leaves memory — which is
   * what keeps an account id out of the realtime layer entirely (§6.4).
   */
  private tokenToPseudonym = new Map<string, string>();
  private now: Clock;

  constructor(now: Clock = () => Date.now()) {
    this.now = now;
    this.trips = new ExpiringStore<LiveTrip>(now);
    this.requests = new ExpiringStore<LiveRequest>(now);
  }

  startTrip(token: string, pseudonym: string): void {
    this.tokenToPseudonym.set(token, pseudonym);
  }

  pseudonymFor(token: string): string | undefined {
    return this.tokenToPseudonym.get(token);
  }

  updateTrip(token: string, trip: Omit<LiveTrip, "pseudonym" | "expiresAt">): LiveTrip | null {
    const pseudonym = this.tokenToPseudonym.get(token);
    if (!pseudonym) return null;
    const live: LiveTrip = { ...trip, pseudonym, expiresAt: this.now() + TRIP_TTL_MS };
    this.trips.set(pseudonym, live);
    return live;
  }

  endTrip(token: string): boolean {
    const pseudonym = this.tokenToPseudonym.get(token);
    if (!pseudonym) return false;
    this.tokenToPseudonym.delete(token);
    this.trips.delete(pseudonym);
    return true;
  }

  tripByPseudonym(pseudonym: string): LiveTrip | undefined {
    return this.trips.get(pseudonym);
  }

  tripsOn(routeId: string, dir: Direction): LiveTrip[] {
    return this.trips.live().filter((t) => t.routeId === routeId && t.dir === dir);
  }

  addRequest(req: Omit<LiveRequest, "expiresAt">): LiveRequest {
    const live: LiveRequest = { ...req, expiresAt: this.now() + REQUEST_TTL_MS };
    this.requests.set(req.pseudonym, live);
    return live;
  }

  cancelRequest(pseudonym: string): boolean {
    return this.requests.delete(pseudonym);
  }

  requestsOn(routeId: string, dir: Direction): LiveRequest[] {
    return this.requests.live().filter((r) => r.routeId === routeId && r.dir === dir);
  }

  counts(): { trips: number; requests: number } {
    return { trips: this.trips.size, requests: this.requests.size };
  }
}
