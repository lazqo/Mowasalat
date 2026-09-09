/**
 * The domain layer: everything the API does, with no HTTP in sight.
 *
 * Kept framework-independent on purpose. The transport in http.ts is a thin
 * shell, so wrapping these same services in Fastify or NestJS later is a
 * transport change and touches nothing here.
 */
import { randomUUID } from "node:crypto";
import { rankCandidates, type LiveTrip as MatchTrip, type PassengerFix } from "../../../packages/corridor/src/matching.ts";
import { Counters, hourBucket } from "./counters.ts";
import { createLogger } from "./guard.ts";
import { MemoryHub, MemoryLiveStore } from "./live/memory.ts";
import { topicFor, type Clock, type Hub, type LiveStore } from "./live/store.ts";
import { assertBucketed, BadRequest, type Direction } from "./wire.ts";

export type CountryPolicy = {
  code: string;
  remainingBucketM: number;
  kAnonymityMin: number;
};

export type BusSighting = {
  pseudonym: string;
  remainingM: number;
  zoneSeq: number;
  gapM: number;
  etaSeconds: number | null;
};

export type WaitingPin = {
  /** How many requests this pin represents, never who they are. */
  count: number;
  remainingM: number;
  zoneSeq: number;
};

/** What a stream sends about a bus. The subscriber computes gap and ETA itself. */
export type BusPosition = {
  pseudonym: string;
  remainingM: number;
  zoneSeq: number;
  speedKph: number;
};

export class Service {
  private live: LiveStore;
  private counters: Counters;
  private policy: CountryPolicy;
  private now: Clock;
  private log: ReturnType<typeof createLogger>;
  readonly hub: Hub;

  constructor(
    policy: CountryPolicy,
    now: Clock = () => Date.now(),
    sink?: (l: string) => void,
    stores: { live?: LiveStore; hub?: Hub } = {},
  ) {
    this.policy = policy;
    this.now = now;
    // In process by default, which is right for one instance; Redis is passed
    // in when a pilot runs behind more than one.
    this.live = stores.live ?? new MemoryLiveStore(now);
    this.hub = stores.hub ?? new MemoryHub();
    this.counters = new Counters();
    this.log = createLogger(sink);
  }

  // --- driver ------------------------------------------------------------

  /**
   * Starts a trip. Returns a secret token the driver's phone keeps, and a
   * public pseudonym that rotates with every trip, so a bus cannot be followed
   * from one day to the next (§6.4).
   */
  async startTrip(routeId: string, dir: Direction): Promise<{ tripToken: string; pseudonym: string }> {
    const tripToken = randomUUID();
    const pseudonym = randomUUID().slice(0, 8);
    await this.live.startTrip(tripToken, pseudonym);
    this.counters.increment("line_health", {
      routeId,
      dir,
      hourBucket: hourBucket(this.now()),
      outcome: "started",
    });
    this.log("trip started", { routeId, dir });
    return { tripToken, pseudonym };
  }

  async updateProgress(
    tripToken: string,
    routeId: string,
    dir: Direction,
    remainingM: number,
    zoneSeq: number,
    speedKph: number,
  ): Promise<void> {
    assertBucketed(remainingM, this.policy.remainingBucketM);
    const updated = await this.live.updateTrip(tripToken, {
      routeId,
      dir,
      remainingM,
      zoneSeq,
      speedKph,
    });
    if (!updated) throw new BadRequest("unknown or ended trip");
    this.counters.increment("demand", { routeId, dir, zoneSeq, hourBucket: hourBucket(this.now()) }, 0);
    await this.hub.publish(topicFor(routeId, dir));
  }

  /**
   * Recorded when a driver's phone finds itself outside the corridor. This is
   * the signal that a corridor is drawn too tight, and it is why deviation is
   * treated as our modelling error rather than the driver's fault (§9.3).
   */
  reportOffCorridor(routeId: string, zoneSeq: number): void {
    this.counters.increment("corridor_fit", {
      routeId,
      zoneSeq,
      hourBucket: hourBucket(this.now()),
      outcome: "off_corridor",
    });
  }

  async endTrip(tripToken: string, routeId?: string, dir?: Direction): Promise<void> {
    const ending = await this.live.pseudonymFor(tripToken);
    const wasOn = ending ? await this.live.tripByPseudonym(ending) : undefined;
    if (!(await this.live.endTrip(tripToken))) throw new BadRequest("unknown or ended trip");
    if (wasOn) await this.hub.publish(topicFor(wasOn.routeId, wasOn.dir));
    if (routeId !== undefined && dir !== undefined) {
      this.counters.increment("line_health", {
        routeId,
        dir,
        hourBucket: hourBucket(this.now()),
        outcome: "completed",
      });
    }
  }

  /** What a driver sees: waiting passengers ahead of him, as counts, never identities. */
  async waitingAhead(tripToken: string, windowM = 15_000): Promise<WaitingPin[]> {
    const pseudonym = await this.live.pseudonymFor(tripToken);
    if (!pseudonym) throw new BadRequest("unknown or ended trip");

    // A trip that has not reported progress yet has no position, so there is
    // nothing ahead of it to show.
    const mine = await this.live.tripByPseudonym(pseudonym);
    if (!mine) return [];

    return this.pinsFor(mine.routeId, mine.dir, mine.remainingM, windowM);
  }

  async pinsFor(
    routeId: string,
    dir: Direction,
    driverRemainingM: number,
    windowM: number,
  ): Promise<WaitingPin[]> {
    const ahead = (await this.live.requestsOn(routeId, dir)).filter(
      (r) => r.remainingM < driverRemainingM && driverRemainingM - r.remainingM <= windowM,
    );

    const byCell = new Map<string, WaitingPin>();
    for (const r of ahead) {
      const key = `${r.zoneSeq}|${r.remainingM}`;
      const pin = byCell.get(key);
      if (pin) pin.count += 1;
      else byCell.set(key, { count: 1, remainingM: r.remainingM, zoneSeq: r.zoneSeq });
    }
    return [...byCell.values()].sort((a, b) => b.remainingM - a.remainingM);
  }

  // --- passenger ---------------------------------------------------------

  /** Buses that will pass this passenger, soonest first. */
  async findBuses(
    routeId: string,
    dir: Direction,
    remainingM: number,
    zoneSeq: number,
  ): Promise<BusSighting[]> {
    assertBucketed(remainingM, this.policy.remainingBucketM);

    const pax: PassengerFix = { routeId, dir, remainingM, zoneSeq };
    const trips: MatchTrip[] = (await this.live.tripsOn(routeId, dir)).map((t) => ({
      pseudonym: t.pseudonym,
      routeId: t.routeId,
      dir: t.dir,
      remainingM: t.remainingM,
      zoneSeq: t.zoneSeq,
      speedKph: t.speedKph,
    }));

    const ranked = rankCandidates(trips, pax);
    if (ranked.length === 0) {
      this.counters.increment("coverage_gap", {
        routeId,
        dir,
        zoneSeq,
        hourBucket: hourBucket(this.now()),
        outcome: "empty",
      });
    }

    return ranked.map((c) => ({
      pseudonym: c.trip.pseudonym,
      remainingM: c.trip.remainingM,
      zoneSeq: c.trip.zoneSeq,
      gapM: c.gapM,
      etaSeconds: c.etaSeconds,
    }));
  }

  /**
   * Bus positions on a line, for a stream subscriber.
   *
   * Unlike findBuses this takes no passenger position, because a streaming
   * passenger never has to send one: her phone already holds the corridor, so
   * it computes the gap and the ETA itself from these scalars.
   */
  async busesOn(routeId: string, dir: Direction): Promise<BusPosition[]> {
    return (await this.live.tripsOn(routeId, dir))
      .map((t) => ({
        pseudonym: t.pseudonym,
        remainingM: t.remainingM,
        zoneSeq: t.zoneSeq,
        speedKph: t.speedKph,
      }))
      .sort((a, b) => a.remainingM - b.remainingM);
  }

  /** Which line and direction a trip token is currently running, if any. */
  async tripRoute(tripToken: string): Promise<{ routeId: string; dir: Direction } | null> {
    const pseudonym = await this.live.pseudonymFor(tripToken);
    if (!pseudonym) return null;
    const mine = await this.live.tripByPseudonym(pseudonym);
    return mine ? { routeId: mine.routeId, dir: mine.dir } : null;
  }

  /** The pins for a driver's own active trip, for a stream subscriber. */
  async pinsForTrip(tripToken: string, windowM = 15_000): Promise<WaitingPin[] | null> {
    const pseudonym = await this.live.pseudonymFor(tripToken);
    if (!pseudonym) return null;
    const mine = await this.live.tripByPseudonym(pseudonym);
    if (!mine) return [];
    return this.pinsFor(mine.routeId, mine.dir, mine.remainingM, windowM);
  }

  /** Records that nobody serves a destination someone searched for. The expansion signal (§6.3). */
  recordUnservedSearch(area: string, destinationId: string): void {
    this.counters.increment("unserved", {
      area,
      destinationId,
      hourBucket: hourBucket(this.now()),
    });
  }

  async createRequest(
    routeId: string,
    dir: Direction,
    destinationId: string,
    remainingM: number,
    zoneSeq: number,
  ): Promise<{ pseudonym: string }> {
    assertBucketed(remainingM, this.policy.remainingBucketM);
    // A fresh pseudonym per request, not per device: two requests by the same
    // person on consecutive days are not linkable here (§6.4).
    const pseudonym = randomUUID().slice(0, 8);
    await this.live.addRequest({ pseudonym, routeId, dir, destinationId, remainingM, zoneSeq });
    this.counters.increment("demand", { routeId, dir, zoneSeq, hourBucket: hourBucket(this.now()) });
    await this.hub.publish(topicFor(routeId, dir));
    return { pseudonym };
  }

  cancelRequest(pseudonym: string): Promise<boolean> {
    return this.live.cancelRequest(pseudonym);
  }

  async boarded(pseudonym: string, routeId: string, dir: Direction): Promise<void> {
    await this.live.cancelRequest(pseudonym);
    await this.hub.publish(topicFor(routeId, dir));
    this.counters.increment("match_quality", {
      routeId,
      dir,
      hourBucket: hourBucket(this.now()),
      outcome: "matched",
    });
  }

  // --- ops ---------------------------------------------------------------

  /** Aggregates, with thin cells suppressed. */
  report(): { cell: string; count: number }[] {
    return this.counters.report(this.policy.kAnonymityMin);
  }

  liveCounts(): Promise<{ trips: number; requests: number }> {
    return this.live.counts();
  }
}
