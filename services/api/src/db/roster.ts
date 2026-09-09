/**
 * The roster: drivers, vehicles, line assignments and verification state.
 *
 * A restart must not lose any of it — a pilot that forgets which lines its
 * drivers run, or demotes everyone the drivers' committee vouched for, is worse
 * than useless. None of it ever reaches the realtime layer (docs/PLAN.md §6.4).
 */
import { randomUUID } from "node:crypto";
import { transaction, type Sql } from "./sql.ts";

export type DriverTier = 0 | 1 | 2 | 3;

export type DriverRecord = {
  id: string;
  phoneHash: string;
  phoneMasked: string;
  tier: DriverTier;
  status: "active" | "blocked";
  routeIds: string[];
  vouchedBy?: string;
  provenTrips: number;
  provenDays: number;
  createdAt: number;
};

export type VehicleRecord = {
  id: string;
  driverId: string;
  type: "coaster" | "minibus" | "service";
  colour?: string | null;
  plate?: string | null;
  showPlate: boolean;
};

function toDriver(r: Record<string, unknown>, routeIds: string[]): DriverRecord {
  return {
    id: r.id as string,
    phoneHash: r.phone_hash as string,
    phoneMasked: r.phone_masked as string,
    tier: Number(r.tier) as DriverTier,
    status: r.status as "active" | "blocked",
    routeIds,
    vouchedBy: (r.vouched_by as string) ?? undefined,
    provenTrips: Number(r.proven_trips ?? 0),
    provenDays: Number(r.proven_days ?? 0),
    createdAt: new Date(r.created_at as string).getTime(),
  };
}

export class RosterStore {
  private sql: Sql;
  private countryCode: string;

  constructor(sql: Sql, countryCode: string) {
    this.sql = sql;
    this.countryCode = countryCode;
  }

  private async routeIdsFor(driverId: string): Promise<string[]> {
    const { rows } = await this.sql.query<{ route_id: string }>(
      `select route_id from driver_route where driver_id = $1 order by assigned_at, route_id`,
      [driverId],
    );
    return rows.map((r) => r.route_id);
  }

  async create(phoneHash: string, phoneMasked: string): Promise<DriverRecord> {
    const id = `drv-${randomUUID().slice(0, 8)}`;
    const { rows } = await this.sql.query(
      `insert into driver (id, country_code, phone_hash, phone_masked)
       values ($1, $2, $3, $4)
       returning id, phone_hash, phone_masked, tier, status, vouched_by,
                 proven_trips, proven_days, created_at`,
      [id, this.countryCode, phoneHash, phoneMasked],
    );
    return toDriver(rows[0], []);
  }

  async get(driverId: string): Promise<DriverRecord | null> {
    const { rows } = await this.sql.query(
      `select id, phone_hash, phone_masked, tier, status, vouched_by,
              proven_trips, proven_days, created_at
         from driver where id = $1 and country_code = $2`,
      [driverId, this.countryCode],
    );
    if (!rows[0]) return null;
    return toDriver(rows[0], await this.routeIdsFor(driverId));
  }

  async findByPhoneHash(phoneHash: string): Promise<DriverRecord | null> {
    const { rows } = await this.sql.query<{ id: string }>(
      `select id from driver where phone_hash = $1 and country_code = $2`,
      [phoneHash, this.countryCode],
    );
    return rows[0] ? this.get(rows[0].id) : null;
  }

  async list(): Promise<DriverRecord[]> {
    const { rows } = await this.sql.query(
      `select d.id, d.phone_hash, d.phone_masked, d.tier, d.status, d.vouched_by,
              d.proven_trips, d.proven_days, d.created_at,
              coalesce(
                array_agg(dr.route_id order by dr.assigned_at, dr.route_id)
                  filter (where dr.route_id is not null),
                '{}'
              ) as route_ids
         from driver d
         left join driver_route dr on dr.driver_id = d.id
        where d.country_code = $1
        group by d.id
        order by d.created_at, d.id`,
      [this.countryCode],
    );
    return rows.map((r) => toDriver(r, (r.route_ids ?? []) as string[]));
  }

  /** Idempotent: assigning a line a driver already runs changes nothing. */
  async assignRoute(driverId: string, routeId: string): Promise<void> {
    await this.sql.query(
      `insert into driver_route (driver_id, route_id) values ($1, $2)
       on conflict (driver_id, route_id) do nothing`,
      [driverId, routeId],
    );
  }

  async unassignRoute(driverId: string, routeId: string): Promise<void> {
    await this.sql.query(`delete from driver_route where driver_id = $1 and route_id = $2`, [
      driverId,
      routeId,
    ]);
  }

  /** Never lowers a tier: a driver vouched for in person does not lose it to a counter. */
  async raiseTier(driverId: string, tier: DriverTier, vouchedBy?: string): Promise<void> {
    await this.sql.query(
      `update driver set tier = greatest(tier, $2), vouched_by = coalesce($3, vouched_by)
        where id = $1`,
      [driverId, tier, vouchedBy ?? null],
    );
  }

  async recordProven(driverId: string, trips: number, days: number): Promise<void> {
    await this.sql.query(
      `update driver set proven_trips = greatest(proven_trips, $2),
                         proven_days  = greatest(proven_days, $3)
        where id = $1`,
      [driverId, trips, days],
    );
  }

  async setStatus(driverId: string, status: "active" | "blocked"): Promise<void> {
    await this.sql.query(`update driver set status = $2 where id = $1`, [driverId, status]);
  }

  // --- vehicles ------------------------------------------------------------

  async addVehicle(v: Omit<VehicleRecord, "id">): Promise<VehicleRecord> {
    const id = `veh-${randomUUID().slice(0, 8)}`;
    await this.sql.query(
      `insert into vehicle (id, driver_id, type, colour, plate, show_plate)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, v.driverId, v.type, v.colour ?? null, v.plate ?? null, v.showPlate],
    );
    return { ...v, id };
  }

  async vehiclesFor(driverId: string): Promise<VehicleRecord[]> {
    const { rows } = await this.sql.query(
      `select id, driver_id, type, colour, plate, show_plate from vehicle
        where driver_id = $1 order by id`,
      [driverId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      driverId: r.driver_id as string,
      type: r.type as VehicleRecord["type"],
      colour: r.colour as string | null,
      plate: r.plate as string | null,
      showPlate: r.show_plate as boolean,
    }));
  }

  /** Used by tests and by the seeder; never exposed over HTTP. */
  async clear(): Promise<void> {
    await transaction(this.sql, async (tx) => {
      await tx.query(`delete from driver_route`);
      await tx.query(`delete from vehicle`);
      await tx.query(`delete from driver`);
    });
  }
}
