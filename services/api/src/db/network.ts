/**
 * The network: countries, hubs, destinations, lines and their corridors.
 *
 * Persisting the route model as decided (docs/PLAN.md §9.1): a route row is the
 * named line a person recognises, and the corridor lives in its own tables
 * because it is a geographic representation used on-device for matching, not a
 * path the driver is required to follow.
 */
import type { Route, WaitPoint, Zone } from "../../../../packages/corridor/src/types.ts";
import { transaction, type Sql } from "./sql.ts";

export type CountryRecord = {
  code: string;
  nameAr: string;
  locale: string;
  digits: string;
  phonePrefix: string;
  bounds?: unknown;
  policy: Record<string, unknown>;
};

export type HubRecord = {
  id: string;
  countryCode: string;
  nameAr: string;
  lat?: number | null;
  lng?: number | null;
  aliasesAr?: string[];
};

export type DestinationRecord = {
  id: string;
  countryCode: string;
  nameAr: string;
  lat?: number | null;
  lng?: number | null;
  aliasesAr?: string[];
};

export class NetworkStore {
  private sql: Sql;
  private countryCode: string;

  constructor(sql: Sql, countryCode: string) {
    this.sql = sql;
    this.countryCode = countryCode;
  }

  // --- country, hubs, destinations ---------------------------------------

  async upsertCountry(c: CountryRecord): Promise<void> {
    await this.sql.query(
      `insert into country (code, name_ar, locale, digits, phone_prefix, bounds, policy)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (code) do update set
         name_ar = excluded.name_ar, locale = excluded.locale, digits = excluded.digits,
         phone_prefix = excluded.phone_prefix, bounds = excluded.bounds, policy = excluded.policy`,
      [c.code, c.nameAr, c.locale, c.digits, c.phonePrefix, JSON.stringify(c.bounds ?? null), JSON.stringify(c.policy)],
    );
  }

  async getCountry(): Promise<CountryRecord | null> {
    const { rows } = await this.sql.query<Record<string, never>>(
      `select code, name_ar, locale, digits, phone_prefix, bounds, policy
         from country where code = $1`,
      [this.countryCode],
    );
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      code: r.code as string,
      nameAr: r.name_ar as string,
      locale: r.locale as string,
      digits: r.digits as string,
      phonePrefix: r.phone_prefix as string,
      bounds: r.bounds,
      policy: (r.policy ?? {}) as Record<string, unknown>,
    };
  }

  async upsertHub(h: HubRecord): Promise<void> {
    await this.sql.query(
      `insert into hub (id, country_code, name_ar, lat, lng, aliases_ar)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set
         name_ar = excluded.name_ar, lat = excluded.lat, lng = excluded.lng,
         aliases_ar = excluded.aliases_ar`,
      [h.id, h.countryCode, h.nameAr, h.lat ?? null, h.lng ?? null, h.aliasesAr ?? []],
    );
  }

  async listHubs(): Promise<HubRecord[]> {
    const { rows } = await this.sql.query(
      `select id, country_code, name_ar, lat, lng, aliases_ar from hub
        where country_code = $1 order by id`,
      [this.countryCode],
    );
    return rows.map((r) => ({
      id: r.id as string,
      countryCode: r.country_code as string,
      nameAr: r.name_ar as string,
      lat: r.lat as number | null,
      lng: r.lng as number | null,
      aliasesAr: (r.aliases_ar ?? []) as string[],
    }));
  }

  async upsertDestination(d: DestinationRecord): Promise<void> {
    await this.sql.query(
      `insert into destination (id, country_code, name_ar, lat, lng, aliases_ar)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set
         name_ar = excluded.name_ar, lat = coalesce(excluded.lat, destination.lat),
         lng = coalesce(excluded.lng, destination.lng), aliases_ar = excluded.aliases_ar`,
      [d.id, d.countryCode, d.nameAr, d.lat ?? null, d.lng ?? null, d.aliasesAr ?? []],
    );
  }

  async listDestinations(): Promise<DestinationRecord[]> {
    const { rows } = await this.sql.query(
      `select id, country_code, name_ar, lat, lng, aliases_ar from destination
        where country_code = $1 order by id`,
      [this.countryCode],
    );
    return rows.map((r) => ({
      id: r.id as string,
      countryCode: r.country_code as string,
      nameAr: r.name_ar as string,
      lat: r.lat as number | null,
      lng: r.lng as number | null,
      aliasesAr: (r.aliases_ar ?? []) as string[],
    }));
  }

  // --- routes and corridors ------------------------------------------------

  async listRoutes(): Promise<Route[]> {
    const { rows } = await this.sql.query<{ id: string }>(
      `select id from route where country_code = $1 order by id`,
      [this.countryCode],
    );
    const routes: Route[] = [];
    for (const r of rows) {
      const route = await this.getRoute(r.id);
      if (route) routes.push(route);
    }
    return routes;
  }

  async getRoute(routeId: string): Promise<Route | null> {
    const { rows } = await this.sql.query(
      `select r.id, r.name_ar, r.origin_name_ar, r.destination_name_ar,
              r.bidirectional, r.provisional, r.typical_headway_min,
              c.width_m, c.reference_paths
         from route r
         left join route_corridor c on c.route_id = r.id
        where r.id = $1 and r.country_code = $2`,
      [routeId, this.countryCode],
    );
    const r = rows[0];
    if (!r) return null;

    const [{ rows: zoneRows }, { rows: destRows }, { rows: wpRows }] = await Promise.all([
      this.sql.query(
        `select seq, name_ar, kind, centre_lat, centre_lng, radius_m
           from route_zone where route_id = $1 order by seq`,
        [routeId],
      ),
      this.sql.query(
        `select rd.destination_id, rd.zone_seq, d.name_ar
           from route_destination rd
           join destination d on d.id = rd.destination_id
          where rd.route_id = $1 order by rd.zone_seq, rd.destination_id`,
        [routeId],
      ),
      this.sql.query(
        `select id, zone_seq, name_ar, lat, lng from wait_point
          where route_id = $1 order by id`,
        [routeId],
      ),
    ]);

    const zones: Zone[] = zoneRows.map((z) => ({
      seq: z.seq as number,
      nameAr: z.name_ar as string,
      kind: z.kind as Zone["kind"],
      centre: { lat: z.centre_lat as number, lng: z.centre_lng as number },
      radiusM: z.radius_m as number,
    }));

    const waitPoints: WaitPoint[] = wpRows.map((w) => ({
      id: w.id as string,
      nameAr: w.name_ar as string,
      location: { lat: w.lat as number, lng: w.lng as number },
      zoneSeq: w.zone_seq as number,
    }));

    return {
      id: r.id as string,
      nameAr: r.name_ar as string,
      originNameAr: r.origin_name_ar as string,
      destinationNameAr: r.destination_name_ar as string,
      bidirectional: r.bidirectional as boolean,
      provisional: r.provisional as boolean,
      corridor: {
        widthM: (r.width_m ?? 0) as number,
        referencePaths: (r.reference_paths ?? []) as Route["corridor"]["referencePaths"],
        zones,
      },
      servedDestinations: destRows.map((d) => ({
        id: d.destination_id as string,
        nameAr: d.name_ar as string,
        zoneSeq: d.zone_seq as number,
      })),
      waitPoints,
    };
  }

  /**
   * Writes a whole line in one transaction. Zones, served destinations and wait
   * points are replaced wholesale because they are meaningful only as an ordered
   * set — a partially applied reordering would be a corrupt line.
   */
  async saveRoute(route: Route): Promise<void> {
    await transaction(this.sql, async (tx) => {
      await tx.query(
        `insert into route (id, country_code, name_ar, origin_name_ar, destination_name_ar,
                            bidirectional, provisional, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (id) do update set
           name_ar = excluded.name_ar, origin_name_ar = excluded.origin_name_ar,
           destination_name_ar = excluded.destination_name_ar,
           bidirectional = excluded.bidirectional, provisional = excluded.provisional,
           updated_at = now()`,
        [
          route.id,
          this.countryCode,
          route.nameAr,
          route.originNameAr,
          route.destinationNameAr,
          route.bidirectional,
          route.provisional,
        ],
      );

      await tx.query(
        `insert into route_corridor (route_id, width_m, reference_paths)
         values ($1, $2, $3)
         on conflict (route_id) do update set
           width_m = excluded.width_m, reference_paths = excluded.reference_paths`,
        [route.id, route.corridor.widthM, JSON.stringify(route.corridor.referencePaths)],
      );

      await tx.query(`delete from route_zone where route_id = $1`, [route.id]);
      for (const z of route.corridor.zones) {
        await tx.query(
          `insert into route_zone (route_id, seq, name_ar, kind, centre_lat, centre_lng, radius_m)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [route.id, z.seq, z.nameAr, z.kind, z.centre.lat, z.centre.lng, z.radiusM],
        );
      }

      await tx.query(`delete from route_destination where route_id = $1`, [route.id]);
      for (const d of route.servedDestinations) {
        await tx.query(
          `insert into destination (id, country_code, name_ar) values ($1, $2, $3)
           on conflict (id) do update set name_ar = excluded.name_ar`,
          [d.id, this.countryCode, d.nameAr],
        );
        await tx.query(
          `insert into route_destination (route_id, destination_id, zone_seq, kind)
           values ($1, $2, $3, $4)`,
          [route.id, d.id, d.zoneSeq, d.zoneSeq === route.corridor.zones.length - 1 ? "terminus" : "intermediate"],
        );
      }

      await tx.query(`delete from wait_point where route_id = $1`, [route.id]);
      for (const w of route.waitPoints) {
        await tx.query(
          `insert into wait_point (id, route_id, zone_seq, name_ar, lat, lng)
           values ($1, $2, $3, $4, $5, $6)`,
          [w.id, route.id, w.zoneSeq, w.nameAr, w.location.lat, w.location.lng],
        );
      }
    });
  }
}
