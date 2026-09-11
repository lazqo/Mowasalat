/**
 * A passenger's whole journey through the app.
 *
 * She has no account and sends no coordinate: the page holds the network,
 * works out which lines pass her and how far along she stands, and sends only
 * that. A port of packages/core/lib/src/passenger.dart — the two clients must
 * agree, so the arithmetic is the same arithmetic.
 */

import {
  indexCorridor,
  place,
  remainingM as remainingAlong,
  bucketRemaining,
  type IndexedCorridor,
} from "../../../packages/corridor/src/index.ts";
import type { Direction, LatLng, Route } from "../../../packages/corridor/src/types.ts";
import { matchesPlace } from "./arabic.ts";
import type { Api, BusScalar } from "./api.ts";

/** A place she can ask for, and every line that would take her there. */
export type DestinationOption = {
  id: string;
  nameAr: string;
  routeIds: string[];
};

/** Which line, and which way, would take her where she is going. */
export type RideOption = {
  route: Route;
  dir: Direction;
  /** Her own distance from that direction's endpoint, computed locally. */
  remainingM: number;
  zoneSeq: number;
  destinationId: string;
};

/** A bus she could catch, with the arithmetic done on her phone. */
export type BusSighting = {
  pseudonym: string;
  routeId: string;
  dir: Direction;
  /** How far the bus still has to travel before it reaches her. */
  gapM: number;
  /** Null when the bus is stopped, because a number would be a guess. */
  etaSeconds: number | null;
};

export type WaitState = "idle" | "waiting" | "boarded" | "cancelled" | "expired";

export const REQUEST_LIFETIME_MS = 20 * 60 * 1000;

/** Below this a bus is stopped and an ETA would be invented. */
const MIN_SPEED_KPH = 3;

/** Buses further back than this are not a ride she is waiting for. */
const WINDOW_M = 15_000;

export function etaText(sighting: BusSighting): string {
  if (sighting.etaSeconds === null) return "الباص واقف";
  const minutes = Math.round(sighting.etaSeconds / 60);
  if (minutes <= 1) return "وصل تقريباً";
  return `بعد ${minutes} دقايق`;
}

export class PassengerController {
  private readonly matchers = new Map<string, IndexedCorridor>();

  private _state: WaitState = "idle";
  private _pseudonym: string | null = null;
  private _riding: RideOption | null = null;
  private requestedAtMs = 0;

  private readonly api: Api;
  private readonly network: Route[];
  private readonly bucketM: number;
  private readonly now: () => number;

  constructor(
    api: Api,
    network: Route[],
    bucketM: number,
    now: () => number = () => Date.now(),
  ) {
    // Without a band there is nothing to blur her position to. Failing here
    // means a misconfigured server shows an error rather than an app that
    // looks like it is protecting her and is not.
    if (!Number.isFinite(bucketM) || bucketM <= 0) {
      throw new Error("the country's remainingBucketM is missing or invalid");
    }

    this.api = api;
    this.network = network;
    this.bucketM = bucketM;
    this.now = now;
  }

  get state(): WaitState {
    return this._state;
  }
  get requestPseudonym(): string | null {
    return this._pseudonym;
  }
  get chosenRide(): RideOption | null {
    return this._riding;
  }

  private indexed(route: Route): IndexedCorridor {
    let ic = this.matchers.get(route.id);
    if (!ic) {
      ic = indexCorridor(route.corridor);
      this.matchers.set(route.id, ic);
    }
    return ic;
  }

  private fix(route: Route, p: LatLng, dir: Direction) {
    const ic = this.indexed(route);
    const placement = place(p, ic);
    return {
      inside: placement.inside,
      zoneSeq: placement.zoneSeq,
      remainingM: remainingAlong(placement, ic, dir),
    };
  }

  /** Everywhere the network can take her, for the وين رايح؟ tiles and search. */
  destinations(query?: string): DestinationOption[] {
    const byId = new Map<string, string[]>();
    const names = new Map<string, string>();

    for (const route of this.network) {
      for (const served of route.servedDestinations) {
        names.set(served.id, served.nameAr);
        const list = byId.get(served.id) ?? [];
        list.push(route.id);
        byId.set(served.id, list);
      }
    }

    const options = [...byId.entries()]
      .map(([id, routeIds]) => ({ id, nameAr: names.get(id)!, routeIds }))
      .sort((a, b) => a.nameAr.localeCompare(b.nameAr, "ar"));

    if (!query || !query.trim()) return options;
    return options.filter((o) => matchesPlace(query, o.nameAr));
  }

  /**
   * Which lines would actually pick her up, given where she is standing.
   *
   * A line only counts when her destination is still *ahead* of her on it —
   * standing past the village she wants is not a ride, it is a walk back.
   */
  ridesFor(destinationId: string, position: LatLng): RideOption[] {
    const options: RideOption[] = [];

    for (const route of this.network) {
      const served = route.servedDestinations.find((d) => d.id === destinationId);
      if (!served) continue;

      const destinationCentre = route.corridor.zones.find((z) => z.seq === served.zoneSeq)?.centre;
      if (!destinationCentre) continue;

      for (const dir of [0, 1] as Direction[]) {
        const mine = this.fix(route, position, dir);
        if (!mine.inside) continue;

        // Her destination is ahead when it has less left to run than she does.
        const theirs = this.fix(route, destinationCentre, dir);
        if (theirs.remainingM >= mine.remainingM) continue;

        options.push({
          route,
          dir,
          remainingM: mine.remainingM,
          zoneSeq: mine.zoneSeq,
          destinationId,
        });
      }
    }

    // The shortest ride first: the line whose endpoint she is nearest.
    return options.sort((a, b) => a.remainingM - b.remainingM);
  }

  /** Asks which buses are running, and keeps the ticket that lets her watch. */
  async busesFor(ride: RideOption): Promise<{ buses: BusSighting[]; streamTicket: string }> {
    const result = await this.api.findBuses({
      routeId: ride.route.id,
      dir: ride.dir,
      remainingM: bucketRemaining(ride.remainingM, this.bucketM),
      zoneSeq: ride.zoneSeq,
    });

    return {
      buses: result.buses.map((b) => ({
        pseudonym: b.pseudonym,
        routeId: ride.route.id,
        dir: ride.dir,
        gapM: b.gapM ?? 0,
        etaSeconds: b.etaSeconds ?? null,
      })),
      streamTicket: result.streamTicket,
    };
  }

  /**
   * Turns a stream snapshot into sightings.
   *
   * The stream sends bus scalars, not answers: the gap and the ETA are worked
   * out here, which is also why she never has to send her position to watch.
   */
  sightingsFrom(buses: BusScalar[], ride: RideOption, windowM = WINDOW_M): BusSighting[] {
    const sightings: BusSighting[] = [];

    for (const bus of buses) {
      const speedKph = bus.speedKph ?? 0;

      // A bus passes her only if it still has further to go than she does.
      const gap = bus.remainingM - ride.remainingM;
      if (gap <= 0 || gap > windowM) continue;

      sightings.push({
        pseudonym: bus.pseudonym,
        routeId: ride.route.id,
        dir: ride.dir,
        gapM: gap,
        etaSeconds: speedKph < MIN_SPEED_KPH ? null : (gap / (speedKph * 1000)) * 3600,
      });
    }

    return sightings.sort((a, b) => a.gapM - b.gapM);
  }

  /** أنا مستني هون. */
  async requestRide(ride: RideOption): Promise<string> {
    if (this._state === "waiting") throw new Error("already waiting");

    const { pseudonym } = await this.api.requestRide({
      routeId: ride.route.id,
      dir: ride.dir,
      destinationId: ride.destinationId,
      remainingM: bucketRemaining(ride.remainingM, this.bucketM),
      zoneSeq: ride.zoneSeq,
    });

    this._pseudonym = pseudonym;
    this._riding = ride;
    this.requestedAtMs = this.now();
    this._state = "waiting";
    return pseudonym;
  }

  /** True once the backend would have dropped it anyway. */
  get hasExpired(): boolean {
    return this._state === "waiting" && this.now() - this.requestedAtMs >= REQUEST_LIFETIME_MS;
  }

  get timeLeftMs(): number {
    if (this._state !== "waiting") return 0;
    return Math.max(0, REQUEST_LIFETIME_MS - (this.now() - this.requestedAtMs));
  }

  /**
   * Moves to expired once the window has passed, so the screen stops promising
   * a bus that will never be told about her.
   */
  refresh(): WaitState {
    if (this.hasExpired) this._state = "expired";
    return this._state;
  }

  /** إلغاء — removed at once, everywhere. */
  async cancel(): Promise<void> {
    const pseudonym = this._pseudonym;
    if (!pseudonym) return;
    try {
      await this.api.cancelRequest(pseudonym);
    } catch {
      // Already gone server-side; the local state still has to be cleared.
    }
    this.clear("cancelled");
  }

  /** ركبت. */
  async boarded(): Promise<void> {
    const pseudonym = this._pseudonym;
    const ride = this._riding;
    if (!pseudonym || !ride) return;
    try {
      await this.api.boarded({ pseudonym, routeId: ride.route.id, dir: ride.dir });
    } catch {
      // The ride happened either way.
    }
    this.clear("boarded");
  }

  /** Back to وين رايح؟ for the next journey. */
  reset(): void {
    this.clear("idle");
  }

  private clear(finalState: WaitState): void {
    this._pseudonym = null;
    this._riding = null;
    this.requestedAtMs = 0;
    this._state = finalState;
  }
}
