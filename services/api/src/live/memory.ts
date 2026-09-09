/**
 * Live state in process. Correct and fast for a single instance, which is what
 * development and the early pilot run on. Nothing is written to disk, and
 * nothing survives a restart, which is the intended behaviour.
 */
import { randomUUID } from "node:crypto";
import type { Direction } from "../wire.ts";
import {
  REQUEST_TTL_MS,
  TRIP_TOKEN_TTL_MS,
  TRIP_TTL_MS,
  type Clock,
  type Hub,
  type LiveRequest,
  type LiveStore,
  type LiveTrip,
  type Ticket,
  type TicketStore,
} from "./store.ts";

type Expiring<T> = { value: T; expiresAt: number };

class ExpiringMap<T> {
  private items = new Map<string, Expiring<T>>();
  private now: Clock;

  constructor(now: Clock) {
    this.now = now;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.items.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  get(key: string): T | undefined {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.items.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): boolean {
    return this.items.delete(key);
  }

  live(): T[] {
    const t = this.now();
    const out: T[] = [];
    for (const [key, entry] of this.items) {
      if (entry.expiresAt <= t) this.items.delete(key);
      else out.push(entry.value);
    }
    return out;
  }
}

export class MemoryLiveStore implements LiveStore {
  private trips: ExpiringMap<LiveTrip>;
  private requests: ExpiringMap<LiveRequest>;
  /**
   * Trip token to pseudonym, held only for the life of the trip. This is the
   * only place the two are associated, and it never leaves memory — which is
   * what keeps an account id out of the realtime layer entirely (§6.4).
   */
  private tokens: ExpiringMap<string>;

  constructor(now: Clock = () => Date.now()) {
    this.trips = new ExpiringMap<LiveTrip>(now);
    this.requests = new ExpiringMap<LiveRequest>(now);
    this.tokens = new ExpiringMap<string>(now);
  }

  async startTrip(token: string, pseudonym: string): Promise<void> {
    this.tokens.set(token, pseudonym, TRIP_TOKEN_TTL_MS);
  }

  async pseudonymFor(token: string): Promise<string | undefined> {
    return this.tokens.get(token);
  }

  async updateTrip(token: string, trip: Omit<LiveTrip, "pseudonym">): Promise<LiveTrip | null> {
    const pseudonym = this.tokens.get(token);
    if (!pseudonym) return null;
    const live: LiveTrip = { ...trip, pseudonym };
    this.trips.set(pseudonym, live, TRIP_TTL_MS);
    return live;
  }

  async endTrip(token: string): Promise<boolean> {
    const pseudonym = this.tokens.get(token);
    if (!pseudonym) return false;
    this.tokens.delete(token);
    this.trips.delete(pseudonym);
    return true;
  }

  async tripByPseudonym(pseudonym: string): Promise<LiveTrip | undefined> {
    return this.trips.get(pseudonym);
  }

  async tripsOn(routeId: string, dir: Direction): Promise<LiveTrip[]> {
    return this.trips.live().filter((t) => t.routeId === routeId && t.dir === dir);
  }

  async addRequest(request: LiveRequest): Promise<LiveRequest> {
    this.requests.set(request.pseudonym, request, REQUEST_TTL_MS);
    return request;
  }

  async cancelRequest(pseudonym: string): Promise<boolean> {
    return this.requests.delete(pseudonym);
  }

  async requestsOn(routeId: string, dir: Direction): Promise<LiveRequest[]> {
    return this.requests.live().filter((r) => r.routeId === routeId && r.dir === dir);
  }

  async counts(): Promise<{ trips: number; requests: number }> {
    return { trips: this.trips.live().length, requests: this.requests.live().length };
  }
}

export class MemoryHub implements Hub {
  private subscribers = new Map<string, Set<() => void>>();

  async subscribe(topic: string, notify: () => void): Promise<() => void> {
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

  async publish(topic: string): Promise<void> {
    for (const notify of this.subscribers.get(topic) ?? []) {
      try {
        notify();
      } catch {
        // A failing subscriber must not stop the others being told.
      }
    }
  }

  subscriberCount(topic?: string): number {
    if (topic) return this.subscribers.get(topic)?.size ?? 0;
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }
}

export const TICKET_TTL_MS = 30 * 60_000;

export class MemoryTicketStore implements TicketStore {
  private issued: ExpiringMap<Ticket>;
  private mint: () => string;

  constructor(now: Clock = () => Date.now(), mint: () => string = () => randomUUID()) {
    this.issued = new ExpiringMap<Ticket>(now);
    this.mint = mint;
  }

  async issue(routeId: string, dir: Direction): Promise<string> {
    const id = this.mint();
    this.issued.set(id, { routeId, dir }, TICKET_TTL_MS);
    return id;
  }

  async redeem(id: string): Promise<Ticket | null> {
    return this.issued.get(id) ?? null;
  }
}
