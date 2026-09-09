/**
 * The ops admin: editing lines and corridors, and running the driver roster.
 *
 * Everything here is durable. A restart must not lose a line, a corridor, a
 * driver, which lines he runs, or the tier someone vouched him into — a pilot
 * that forgets any of that is worse than useless. Live movement is deliberately
 * not its business and stays in memory with a 60-second expiry.
 *
 * Two things this service is careful about.
 *
 * A corridor is widened, never tightened, on the evidence of real driving
 * (docs/PLAN.md §9.3): a driver falling outside the corridor means the corridor
 * is drawn wrong, so `suggestWidthFromTraces` reports what the drives imply and
 * an operator decides.
 *
 * The roster is the one place in the system that holds anything personal, and
 * it is kept strictly apart from the realtime layer: nothing here is ever handed
 * to `Service`, and a driver id must never appear in a live response (§6.4).
 */
import { createHash, randomUUID } from "node:crypto";
import { corridorFromTraces, suggestCorridorWidthM } from "../../../packages/corridor/src/trace.ts";
import { validateRoute, type Problem } from "../../../packages/corridor/src/validate.ts";
import type { LatLng, Route, WaitPoint, Zone } from "../../../packages/corridor/src/types.ts";
import { NetworkStore } from "./db/network.ts";
import { RosterStore, type DriverRecord, type DriverTier } from "./db/roster.ts";
import type { Sql } from "./db/sql.ts";

export type { DriverRecord as Driver, DriverTier };

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

export class InvalidRoute extends Error {
  problems: Problem[];
  constructor(problems: Problem[]) {
    super(`route is invalid: ${problems.map((p) => `${p.field} ${p.message}`).join("; ")}`);
    this.name = "InvalidRoute";
    this.problems = problems;
  }
}

export type AdminPolicy = {
  vouchingAuthorities: string[];
  tier2Thresholds: { trips: number; distinct_days: number };
};

function hashPhone(phone: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${phone}`).digest("hex");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 3 ? "***" : `••• ${digits.slice(-3)}`;
}

export class Admin {
  private network: NetworkStore;
  private roster: RosterStore;
  private salt: string;
  private policy: AdminPolicy;

  constructor(sql: Sql, countryCode: string, salt: string, policy: AdminPolicy) {
    if (!salt) throw new Error("a phone salt is required");
    this.network = new NetworkStore(sql, countryCode);
    this.roster = new RosterStore(sql, countryCode);
    this.salt = salt;
    this.policy = policy;
  }

  // --- lines and corridors -----------------------------------------------

  listRoutes(): Promise<Route[]> {
    return this.network.listRoutes();
  }

  async getRoute(routeId: string): Promise<Route> {
    const route = await this.network.getRoute(routeId);
    if (!route) throw new NotFound(`route ${routeId}`);
    return route;
  }

  /** Checks an edit without saving it, so the editor can show problems live. */
  check(route: Route): Problem[] {
    return validateRoute(route);
  }

  /** The single door every write goes through. A line that fails is never stored. */
  private async save(route: Route): Promise<Route> {
    const problems = validateRoute(route);
    if (problems.length > 0) throw new InvalidRoute(problems);
    await this.network.saveRoute(route);
    return route;
  }

  async setReferencePaths(routeId: string, paths: LatLng[][]): Promise<Route> {
    const route = await this.getRoute(routeId);
    return this.save({ ...route, corridor: { ...route.corridor, referencePaths: paths } });
  }

  async setWidth(routeId: string, widthM: number): Promise<Route> {
    const route = await this.getRoute(routeId);
    return this.save({ ...route, corridor: { ...route.corridor, widthM } });
  }

  /**
   * Replaces the zone list, renumbering `seq` from the given order. Ordering is
   * the whole point of a zone, so it comes from the operator's arrangement
   * rather than from geometry.
   */
  async setZones(routeId: string, zones: Omit<Zone, "seq">[]): Promise<Route> {
    const route = await this.getRoute(routeId);
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

    return this.save({
      ...route,
      corridor: { ...route.corridor, zones: renumbered },
      servedDestinations: route.servedDestinations.map((d) => ({ ...d, zoneSeq: remap(d.zoneSeq) })),
      waitPoints: route.waitPoints.map((w) => ({ ...w, zoneSeq: remap(w.zoneSeq) })),
    });
  }

  async addWaitPoint(routeId: string, point: Omit<WaitPoint, "id">): Promise<Route> {
    const route = await this.getRoute(routeId);
    const wp: WaitPoint = { ...point, id: `wp-${randomUUID().slice(0, 8)}` };
    return this.save({ ...route, waitPoints: [...route.waitPoints, wp] });
  }

  async removeWaitPoint(routeId: string, waitPointId: string): Promise<Route> {
    const route = await this.getRoute(routeId);
    return this.save({ ...route, waitPoints: route.waitPoints.filter((w) => w.id !== waitPointId) });
  }

  async addServedDestination(
    routeId: string,
    dest: { id: string; nameAr: string; zoneSeq: number },
  ): Promise<Route> {
    const route = await this.getRoute(routeId);
    if (route.servedDestinations.some((d) => d.id === dest.id)) {
      throw new AdminError(`${dest.id} is already served by this line`);
    }
    return this.save({ ...route, servedDestinations: [...route.servedDestinations, dest] });
  }

  /** Builds a corridor from recorded drives and saves it, clearing `provisional`. */
  async importTraces(routeId: string, traces: LatLng[][]): Promise<{ route: Route; widthM: number }> {
    const route = await this.getRoute(routeId);
    const { corridor, width } = corridorFromTraces(traces, {
      originNameAr: route.originNameAr,
      destinationNameAr: route.destinationNameAr,
    });

    // Intermediate zones are named by people, not derived from a trace, so any
    // the field team has already recorded survive the import.
    const named = route.corridor.zones.filter((z) => z.kind === "intermediate");
    const zones: Zone[] = [corridor.zones[0], ...named, corridor.zones[corridor.zones.length - 1]].map(
      (z, i) => ({ ...z, seq: i }),
    );

    const saved = await this.save({ ...route, corridor: { ...corridor, zones }, provisional: false });
    return { route: saved, widthM: width.widthM };
  }

  /**
   * What the observed drives imply the width should be. Reports rather than
   * applies: widening a corridor is an operator's decision.
   */
  async suggestWidthFromTraces(routeId: string, traces: LatLng[][]) {
    const route = await this.getRoute(routeId);
    return suggestCorridorWidthM(route.corridor.referencePaths[0], traces);
  }

  // --- driver roster -------------------------------------------------------

  /** Tier 0: a phone number and nothing else, able to run trips at once (§5.2). */
  async createDriver(phone: string): Promise<DriverRecord> {
    const phoneHash = hashPhone(phone, this.salt);
    if (await this.roster.findByPhoneHash(phoneHash)) {
      throw new AdminError("a driver with this number already exists");
    }
    return this.roster.create(phoneHash, maskPhone(phone));
  }

  async getDriver(driverId: string): Promise<DriverRecord> {
    const d = await this.roster.get(driverId);
    if (!d) throw new NotFound(`driver ${driverId}`);
    return d;
  }

  findByPhone(phone: string): Promise<DriverRecord | null> {
    return this.roster.findByPhoneHash(hashPhone(phone, this.salt));
  }

  listDrivers(): Promise<DriverRecord[]> {
    return this.roster.list();
  }

  /** Attaches a driver to a line he actually runs (§5.4). Ops does this, never the driver. */
  async assignRoute(driverId: string, routeId: string): Promise<DriverRecord> {
    await this.getDriver(driverId);
    await this.getRoute(routeId); // throws if the line does not exist
    await this.roster.assignRoute(driverId, routeId);
    return this.getDriver(driverId);
  }

  async unassignRoute(driverId: string, routeId: string): Promise<DriverRecord> {
    await this.getDriver(driverId);
    await this.roster.unassignRoute(driverId, routeId);
    return this.getDriver(driverId);
  }

  /** Tier 1: someone confirmed him in person, and only an authority the pack allows. */
  async vouch(driverId: string, authority: string): Promise<DriverRecord> {
    await this.getDriver(driverId);
    if (!this.policy.vouchingAuthorities.includes(authority)) {
      throw new AdminError(
        `"${authority}" is not a vouching authority here; allowed: ${this.policy.vouchingAuthorities.join(", ")}`,
      );
    }
    await this.roster.raiseTier(driverId, 1, authority);
    return this.getDriver(driverId);
  }

  /** Tier 2, earned automatically by driving the line, not granted by anyone. */
  async recordProvenTrips(driverId: string, trips: number, distinctDays: number): Promise<DriverRecord> {
    await this.getDriver(driverId);
    await this.roster.recordProven(driverId, trips, distinctDays);
    const t = this.policy.tier2Thresholds;
    if (trips >= t.trips && distinctDays >= t.distinct_days) {
      await this.roster.raiseTier(driverId, 2);
    }
    return this.getDriver(driverId);
  }

  async setStatus(driverId: string, status: "active" | "blocked"): Promise<DriverRecord> {
    await this.getDriver(driverId);
    await this.roster.setStatus(driverId, status);
    return this.getDriver(driverId);
  }

  /** What a driver's app may show him: his lines, and nothing about anyone else. */
  async routesForDriver(driverId: string): Promise<Route[]> {
    const driver = await this.getDriver(driverId);
    if (driver.status === "blocked") return [];
    const routes: Route[] = [];
    for (const id of driver.routeIds) {
      const route = await this.network.getRoute(id);
      if (route) routes.push(route);
    }
    return routes;
  }

  addVehicle(v: Parameters<RosterStore["addVehicle"]>[0]) {
    return this.roster.addVehicle(v);
  }

  vehiclesFor(driverId: string) {
    return this.roster.vehiclesFor(driverId);
  }
}
