/**
 * The ops admin: editing lines and corridors, and running the driver roster.
 *
 * Two things this service is careful about.
 *
 * A corridor is widened, never tightened, on the evidence of real driving
 * (docs/PLAN.md §9.3): a driver falling outside the corridor means the corridor
 * is drawn wrong, so `suggestWidthFromTraces` reports what the drives imply and
 * an operator decides.
 *
 * The driver roster is the one place in the system that holds anything personal,
 * and it is kept strictly apart from the realtime layer: nothing here is ever
 * handed to `Service`, and a driver id must never appear in a live response
 * (§6.4).
 */
import { createHash, randomUUID } from "node:crypto";
import { corridorFromTraces, suggestCorridorWidthM } from "../../../packages/corridor/src/trace.ts";
import type { LatLng, Route, WaitPoint, Zone } from "../../../packages/corridor/src/types.ts";
import { InvalidRoute, Pack } from "./pack.ts";

export type DriverTier = 0 | 1 | 2 | 3;

export type Driver = {
  id: string;
  /** Never the number itself. Lookup is by hash; display is the masked tail. */
  phoneHash: string;
  phoneMasked: string;
  tier: DriverTier;
  status: "active" | "blocked";
  routeIds: string[];
  vouchedBy?: string;
  createdAt: number;
};

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFound";
  }
}

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

function hashPhone(phone: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${phone}`).digest("hex");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 3 ? "***" : `••• ${digits.slice(-3)}`;
}

export class Admin {
  private pack: Pack;
  private drivers = new Map<string, Driver>();
  private byPhoneHash = new Map<string, string>();
  private salt: string;
  private now: () => number;

  constructor(pack: Pack, salt: string, now: () => number = () => Date.now()) {
    if (!salt) throw new Error("a phone salt is required");
    this.pack = pack;
    this.salt = salt;
    this.now = now;
  }

  // --- lines and corridors -----------------------------------------------

  listRoutes(): Route[] {
    return this.pack.listRoutes();
  }

  getRoute(routeId: string): Route {
    const route = this.pack.getRoute(routeId);
    if (!route) throw new NotFound(`route ${routeId}`);
    return route;
  }

  /** Checks an edit without saving it, so the editor can show problems live. */
  check(route: Route) {
    return this.pack.check(route);
  }

  setReferencePaths(routeId: string, paths: LatLng[][]): Route {
    const route = this.getRoute(routeId);
    return this.pack.saveRoute({
      ...route,
      corridor: { ...route.corridor, referencePaths: paths },
    });
  }

  setWidth(routeId: string, widthM: number): Route {
    const route = this.getRoute(routeId);
    return this.pack.saveRoute({ ...route, corridor: { ...route.corridor, widthM } });
  }

  /**
   * Replaces the zone list, renumbering `seq` from the given order. Ordering is
   * the whole point of a zone, so it comes from the operator's arrangement
   * rather than from geometry.
   */
  setZones(routeId: string, zones: Omit<Zone, "seq">[]): Route {
    const route = this.getRoute(routeId);
    const renumbered: Zone[] = zones.map((z, i) => ({ ...z, seq: i }));

    // Served destinations and wait points point at zones by seq, so they move
    // with them rather than being silently orphaned.
    const oldSeqToName = new Map(route.corridor.zones.map((z) => [z.seq, z.nameAr]));
    const nameToNewSeq = new Map(renumbered.map((z) => [z.nameAr, z.seq]));
    const remap = (seq: number) => {
      const name = oldSeqToName.get(seq);
      const next = name === undefined ? undefined : nameToNewSeq.get(name);
      return next ?? 0;
    };

    return this.pack.saveRoute({
      ...route,
      corridor: { ...route.corridor, zones: renumbered },
      servedDestinations: route.servedDestinations.map((d) => ({ ...d, zoneSeq: remap(d.zoneSeq) })),
      waitPoints: route.waitPoints.map((w) => ({ ...w, zoneSeq: remap(w.zoneSeq) })),
    });
  }

  addWaitPoint(routeId: string, point: Omit<WaitPoint, "id">): Route {
    const route = this.getRoute(routeId);
    const wp: WaitPoint = { ...point, id: `wp-${randomUUID().slice(0, 8)}` };
    return this.pack.saveRoute({ ...route, waitPoints: [...route.waitPoints, wp] });
  }

  removeWaitPoint(routeId: string, waitPointId: string): Route {
    const route = this.getRoute(routeId);
    return this.pack.saveRoute({
      ...route,
      waitPoints: route.waitPoints.filter((w) => w.id !== waitPointId),
    });
  }

  addServedDestination(routeId: string, dest: { id: string; nameAr: string; zoneSeq: number }): Route {
    const route = this.getRoute(routeId);
    if (route.servedDestinations.some((d) => d.id === dest.id)) {
      throw new AdminError(`${dest.id} is already served by this line`);
    }
    return this.pack.saveRoute({
      ...route,
      servedDestinations: [...route.servedDestinations, dest],
    });
  }

  /** Builds a corridor from recorded drives and saves it, clearing `provisional`. */
  importTraces(routeId: string, traces: LatLng[][]): { route: Route; widthM: number } {
    const route = this.getRoute(routeId);
    const { corridor, width } = corridorFromTraces(traces, {
      originNameAr: route.originNameAr,
      destinationNameAr: route.destinationNameAr,
    });

    // Intermediate zones are named by people, not derived from a trace, so any
    // the field team has already recorded survive the import.
    const named = route.corridor.zones.filter((z) => z.kind === "intermediate");
    const zones: Zone[] = [corridor.zones[0], ...named, corridor.zones[corridor.zones.length - 1]]
      .map((z, i) => ({ ...z, seq: i }));

    const saved = this.pack.saveRoute({
      ...route,
      corridor: { ...corridor, zones },
      provisional: false,
    });
    return { route: saved, widthM: width.widthM };
  }

  /**
   * What the observed drives imply the width should be. Reports rather than
   * applies: widening a corridor is an operator's decision, informed by the
   * corridor-fit counters.
   */
  suggestWidthFromTraces(routeId: string, traces: LatLng[][]) {
    const route = this.getRoute(routeId);
    return suggestCorridorWidthM(route.corridor.referencePaths[0], traces);
  }

  // --- driver roster -------------------------------------------------------

  /** Tier 0: a phone number and nothing else, able to run trips at once (§5.2). */
  createDriver(phone: string): Driver {
    const phoneHash = hashPhone(phone, this.salt);
    const existing = this.byPhoneHash.get(phoneHash);
    if (existing) throw new AdminError("a driver with this number already exists");

    const driver: Driver = {
      id: `drv-${randomUUID().slice(0, 8)}`,
      phoneHash,
      phoneMasked: maskPhone(phone),
      tier: 0,
      status: "active",
      routeIds: [],
      createdAt: this.now(),
    };
    this.drivers.set(driver.id, driver);
    this.byPhoneHash.set(phoneHash, driver.id);
    return driver;
  }

  getDriver(driverId: string): Driver {
    const d = this.drivers.get(driverId);
    if (!d) throw new NotFound(`driver ${driverId}`);
    return d;
  }

  findByPhone(phone: string): Driver | null {
    const id = this.byPhoneHash.get(hashPhone(phone, this.salt));
    return id ? this.drivers.get(id) ?? null : null;
  }

  listDrivers(): Driver[] {
    return [...this.drivers.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Attaches a driver to a line he actually runs (§5.4). Ops does this, never the driver. */
  assignRoute(driverId: string, routeId: string): Driver {
    const driver = this.getDriver(driverId);
    this.getRoute(routeId); // throws if the line does not exist
    if (!driver.routeIds.includes(routeId)) driver.routeIds.push(routeId);
    return driver;
  }

  unassignRoute(driverId: string, routeId: string): Driver {
    const driver = this.getDriver(driverId);
    driver.routeIds = driver.routeIds.filter((r) => r !== routeId);
    return driver;
  }

  /** Tier 1: someone confirmed him in person. The authority must be one the country pack allows. */
  vouch(driverId: string, authority: string): Driver {
    const driver = this.getDriver(driverId);
    if (!this.pack.config.vouching_authorities.includes(authority)) {
      throw new AdminError(
        `"${authority}" is not a vouching authority in ${this.pack.config.code}; allowed: ${this.pack.config.vouching_authorities.join(", ")}`,
      );
    }
    if (driver.tier < 1) driver.tier = 1;
    driver.vouchedBy = authority;
    return driver;
  }

  /** Tier 2, earned automatically by driving the line, not granted by anyone. */
  recordProvenTrips(driverId: string, trips: number, distinctDays: number): Driver {
    const driver = this.getDriver(driverId);
    const t = this.pack.config.tier2_thresholds;
    if (trips >= t.trips && distinctDays >= t.distinct_days && driver.tier < 2) {
      driver.tier = 2;
    }
    return driver;
  }

  setStatus(driverId: string, status: "active" | "blocked"): Driver {
    const driver = this.getDriver(driverId);
    driver.status = status;
    return driver;
  }

  /** What a driver's app may show him: his lines, and nothing about anyone else. */
  routesForDriver(driverId: string): Route[] {
    const driver = this.getDriver(driverId);
    if (driver.status === "blocked") return [];
    return driver.routeIds.map((id) => this.getRoute(id));
  }
}

export { InvalidRoute };
