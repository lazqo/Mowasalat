/**
 * Live state in Redis, for a pilot running behind more than one instance.
 *
 * Two things this file is careful about.
 *
 * **Nothing here may be durable.** Every key carries a TTL, and
 * `assertNoPersistence` refuses to start against a Redis that is writing to
 * disk. An RDB snapshot of this keyspace would be a movement trail — precisely
 * what the plan promises never to keep (docs/PLAN.md §6.2) — so the check is a
 * guard rail, not a preference.
 *
 * **Membership expires with its member.** A plain set of pseudonyms per line
 * would keep names of buses that stopped reporting an hour ago, because a set
 * cannot expire individual members. Membership is a sorted set scored by expiry
 * instead, pruned on every read.
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

/** The slice of a Redis client this file uses. Keeps the driver at the edge. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  del(keys: string | string[]): Promise<number>;
  zAdd(key: string, members: { score: number; value: string }[]): Promise<number>;
  zRem(key: string, members: string | string[]): Promise<number>;
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  configGet(parameter: string): Promise<Record<string, string>>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  duplicate(): RedisLike;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
}

const PREFIX = "mwsl";
const tripKey = (p: string) => `${PREFIX}:trip:${p}`;
const tokenKey = (t: string) => `${PREFIX}:token:${t}`;
const requestKey = (p: string) => `${PREFIX}:req:${p}`;
const ticketKey = (id: string) => `${PREFIX}:ticket:${id}`;
const tripsOnKey = (routeId: string, dir: Direction) => `${PREFIX}:line:${routeId}:${dir}:trips`;
const requestsOnKey = (routeId: string, dir: Direction) => `${PREFIX}:line:${routeId}:${dir}:reqs`;

export class PersistenceEnabled extends Error {
  constructor(detail: string) {
    super(
      `this Redis is configured to persist (${detail}). Live movement must never reach a disk — ` +
        `start it with --save '' --appendonly no, or point at an instance that does.`,
    );
    this.name = "PersistenceEnabled";
  }
}

/**
 * Refuses a Redis that would write this keyspace to disk. Called at startup, so
 * a misconfigured deployment fails loudly instead of quietly accumulating the
 * one thing we said we would not keep.
 */
export async function assertNoPersistence(redis: RedisLike): Promise<void> {
  const save = await redis.configGet("save");
  const aof = await redis.configGet("appendonly");

  if ((save.save ?? "").trim() !== "") throw new PersistenceEnabled(`save "${save.save}"`);
  if ((aof.appendonly ?? "no") !== "no") throw new PersistenceEnabled("appendonly yes");
}

export class RedisLiveStore implements LiveStore {
  private redis: RedisLike;
  private now: Clock;

  constructor(redis: RedisLike, now: Clock = () => Date.now()) {
    this.redis = redis;
    this.now = now;
  }

  async startTrip(token: string, pseudonym: string): Promise<void> {
    await this.redis.set(tokenKey(token), pseudonym, { PX: TRIP_TOKEN_TTL_MS });
  }

  async pseudonymFor(token: string): Promise<string | undefined> {
    return (await this.redis.get(tokenKey(token))) ?? undefined;
  }

  async updateTrip(token: string, trip: Omit<LiveTrip, "pseudonym">): Promise<LiveTrip | null> {
    const pseudonym = await this.pseudonymFor(token);
    if (!pseudonym) return null;

    const live: LiveTrip = { ...trip, pseudonym };
    const expiresAt = this.now() + TRIP_TTL_MS;

    const index = tripsOnKey(trip.routeId, trip.dir);
    await this.redis.set(tripKey(pseudonym), JSON.stringify(live), { PX: TRIP_TTL_MS });
    await this.redis.zAdd(index, [{ score: expiresAt, value: pseudonym }]);
    // The index itself expires too, so a line that goes quiet leaves nothing
    // behind at all. Members are pruned by score; without this the empty set
    // would outlive them.
    await this.redis.pExpire(index, TRIP_TTL_MS * 2);
    return live;
  }

  async endTrip(token: string): Promise<boolean> {
    const pseudonym = await this.pseudonymFor(token);
    if (!pseudonym) return false;

    const trip = await this.tripByPseudonym(pseudonym);
    await this.redis.del([tokenKey(token), tripKey(pseudonym)]);
    if (trip) await this.redis.zRem(tripsOnKey(trip.routeId, trip.dir), pseudonym);
    return true;
  }

  async tripByPseudonym(pseudonym: string): Promise<LiveTrip | undefined> {
    const raw = await this.redis.get(tripKey(pseudonym));
    return raw ? (JSON.parse(raw) as LiveTrip) : undefined;
  }

  async tripsOn(routeId: string, dir: Direction): Promise<LiveTrip[]> {
    const key = tripsOnKey(routeId, dir);
    await this.redis.zRemRangeByScore(key, 0, this.now());

    const pseudonyms = await this.redis.zRangeByScore(key, this.now(), Number.POSITIVE_INFINITY);
    const trips: LiveTrip[] = [];
    for (const p of pseudonyms) {
      const trip = await this.tripByPseudonym(p);
      // The key may already have expired between the index and the read.
      if (trip) trips.push(trip);
      else await this.redis.zRem(key, p);
    }
    return trips;
  }

  async addRequest(request: LiveRequest): Promise<LiveRequest> {
    const index = requestsOnKey(request.routeId, request.dir);
    await this.redis.set(requestKey(request.pseudonym), JSON.stringify(request), {
      PX: REQUEST_TTL_MS,
    });
    await this.redis.zAdd(index, [
      { score: this.now() + REQUEST_TTL_MS, value: request.pseudonym },
    ]);
    await this.redis.pExpire(index, REQUEST_TTL_MS * 2);
    return request;
  }

  async cancelRequest(pseudonym: string): Promise<boolean> {
    const raw = await this.redis.get(requestKey(pseudonym));
    if (!raw) return false;
    const request = JSON.parse(raw) as LiveRequest;

    await this.redis.del(requestKey(pseudonym));
    await this.redis.zRem(requestsOnKey(request.routeId, request.dir), pseudonym);
    return true;
  }

  async requestsOn(routeId: string, dir: Direction): Promise<LiveRequest[]> {
    const key = requestsOnKey(routeId, dir);
    await this.redis.zRemRangeByScore(key, 0, this.now());

    const pseudonyms = await this.redis.zRangeByScore(key, this.now(), Number.POSITIVE_INFINITY);
    const requests: LiveRequest[] = [];
    for (const p of pseudonyms) {
      const raw = await this.redis.get(requestKey(p));
      if (raw) requests.push(JSON.parse(raw) as LiveRequest);
      else await this.redis.zRem(key, p);
    }
    return requests;
  }

  async counts(): Promise<{ trips: number; requests: number }> {
    const [trips, requests] = await Promise.all([
      this.redis.keys(`${PREFIX}:trip:*`),
      this.redis.keys(`${PREFIX}:req:*`),
    ]);
    return { trips: trips.length, requests: requests.length };
  }
}

/**
 * Fan-out across instances. A driver's progress may land on one server while the
 * passengers watching that line are streaming from another, so the notification
 * travels through Redis rather than staying in one process.
 */
export class RedisHub implements Hub {
  private publisher: RedisLike;
  private subscriber: RedisLike;
  private local = new Map<string, Set<() => void>>();
  private ready: Promise<unknown> | null = null;

  constructor(redis: RedisLike) {
    this.publisher = redis;
    // A connection in subscribe mode cannot issue ordinary commands.
    this.subscriber = redis.duplicate();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.ready) this.ready = this.subscriber.connect();
    await this.ready;
  }

  async subscribe(topic: string, notify: () => void): Promise<() => void> {
    await this.ensureConnected();

    let set = this.local.get(topic);
    if (!set) {
      set = new Set();
      this.local.set(topic, set);
      await this.subscriber.subscribe(`${PREFIX}:${topic}`, () => {
        for (const listener of this.local.get(topic) ?? []) {
          try {
            listener();
          } catch {
            // One broken subscriber must not stop the others being told.
          }
        }
      });
    }
    set.add(notify);

    return () => {
      const current = this.local.get(topic);
      if (!current) return;
      current.delete(notify);
      if (current.size === 0) {
        this.local.delete(topic);
        void this.subscriber.unsubscribe(`${PREFIX}:${topic}`).catch(() => {});
      }
    };
  }

  async publish(topic: string): Promise<void> {
    await this.publisher.publish(`${PREFIX}:${topic}`, "1");
  }

  subscriberCount(topic?: string): number {
    if (topic) return this.local.get(topic)?.size ?? 0;
    let total = 0;
    for (const set of this.local.values()) total += set.size;
    return total;
  }

  async close(): Promise<void> {
    if (this.ready) await this.subscriber.quit().catch(() => {});
  }
}

export const TICKET_TTL_MS = 30 * 60_000;

export class RedisTicketStore implements TicketStore {
  private redis: RedisLike;
  private mint: () => string;

  constructor(redis: RedisLike, mint: () => string = () => randomUUID()) {
    this.redis = redis;
    this.mint = mint;
  }

  async issue(routeId: string, dir: Direction): Promise<string> {
    const id = this.mint();
    await this.redis.set(ticketKey(id), `${dir}:${routeId}`, { PX: TICKET_TTL_MS });
    return id;
  }

  async redeem(id: string): Promise<Ticket | null> {
    const raw = await this.redis.get(ticketKey(id));
    if (!raw) return null;
    const separator = raw.indexOf(":");
    return {
      dir: Number(raw.slice(0, separator)) as Direction,
      routeId: raw.slice(separator + 1),
    };
  }
}
