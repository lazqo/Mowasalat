/**
 * The contract for live operational state.
 *
 * Everything here is ephemeral by design (docs/PLAN.md §6.2): trip progress,
 * waiting requests and the token-to-pseudonym mapping expire on their own and
 * are expected to be lost on restart. None of it may ever be written to
 * Postgres — that would be the movement trail the plan promises not to build.
 *
 * Two implementations satisfy this: one in process, correct for a single
 * instance, and one in Redis for a pilot behind more than one. The same
 * behavioural test suite runs against both, so they are proven to agree rather
 * than assumed to.
 */
import type { Direction } from "../wire.ts";

export type Clock = () => number;

/** What the realtime layer holds about a bus. Note the absence of a driver id. */
export type LiveTrip = {
  pseudonym: string;
  routeId: string;
  dir: Direction;
  remainingM: number;
  zoneSeq: number;
  speedKph: number;
};

export type LiveRequest = {
  pseudonym: string;
  routeId: string;
  dir: Direction;
  destinationId: string;
  remainingM: number;
  zoneSeq: number;
};

export const TRIP_TTL_MS = 60_000;
export const REQUEST_TTL_MS = 20 * 60_000;
/** A trip token outlives a single progress report; a shift does not last a day. */
export const TRIP_TOKEN_TTL_MS = 12 * 3_600_000;

export interface LiveStore {
  startTrip(token: string, pseudonym: string): Promise<void>;
  pseudonymFor(token: string): Promise<string | undefined>;
  updateTrip(token: string, trip: Omit<LiveTrip, "pseudonym">): Promise<LiveTrip | null>;
  endTrip(token: string): Promise<boolean>;
  tripByPseudonym(pseudonym: string): Promise<LiveTrip | undefined>;
  tripsOn(routeId: string, dir: Direction): Promise<LiveTrip[]>;

  addRequest(request: LiveRequest): Promise<LiveRequest>;
  cancelRequest(pseudonym: string): Promise<boolean>;
  requestsOn(routeId: string, dir: Direction): Promise<LiveRequest[]>;

  counts(): Promise<{ trips: number; requests: number }>;
  close?(): Promise<void>;
}

/** Fan-out of "something on this line changed". */
export interface Hub {
  subscribe(topic: string, notify: () => void): Promise<() => void>;
  publish(topic: string): Promise<void>;
  /** Local subscribers only; with Redis, other instances have their own. */
  subscriberCount(topic?: string): number;
  close?(): Promise<void>;
}

/** Short-lived permission to stream one line and direction. */
export type Ticket = { routeId: string; dir: Direction };

export interface TicketStore {
  issue(routeId: string, dir: Direction): Promise<string>;
  redeem(id: string): Promise<Ticket | null>;
  close?(): Promise<void>;
}

export function topicFor(routeId: string, dir: Direction): string {
  return `${routeId}:${dir}`;
}
