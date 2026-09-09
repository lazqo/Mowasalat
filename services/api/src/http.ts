/**
 * HTTP transport. Deliberately thin: all behaviour lives in service.ts and
 * admin.ts, so moving to Fastify or NestJS later touches nothing else.
 *
 * Push will use Server-Sent Events rather than WebSockets: the stream is
 * one-way, which is all a bus position needs; it rides plain HTTP so it survives
 * the proxies and captive portals a cheap phone meets; and it reconnects on its
 * own. Not built yet.
 *
 * On the two kinds of endpoint here — the passenger and driver endpoints must
 * never receive a coordinate, because a coordinate there is a *person's*
 * position. The ops endpoints handle route geometry freely, because a bus line's
 * corridor is public infrastructure and not anybody's location. The rule was
 * always about people, and the split is deliberate rather than an oversight.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Admin, AdminError, NotFound } from "./admin.ts";
import { CoordinateLeak } from "./guard.ts";
import { InvalidRoute, Pack } from "./pack.ts";
import { Service, type CountryPolicy } from "./service.ts";
import {
  BadRequest,
  parseEndTrip,
  parseFindBuses,
  parseRideRequest,
  parseStartTrip,
  parseTripProgress,
} from "./wire.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_ADMIN_BODY_BYTES = 4 * 1024 * 1024; // traces are large

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function equalTokens(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Handler = (body: unknown, params: Record<string, string>) => unknown;
type Route = { method: string; pattern: string[]; handler: Handler; admin: boolean };

function compile(spec: string): string[] {
  return spec.split("/").filter(Boolean);
}

function match(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = decodeURIComponent(path[i]);
    else if (pattern[i] !== path[i]) return null;
  }
  return params;
}

export type ApiOptions = {
  service?: Service;
  admin?: Admin;
  /** Required for the ops endpoints. Without it they refuse to serve at all. */
  adminToken?: string;
  /** Basemap style for the corridor editor. Replace with the self-hosted stack. */
  mapTiles?: string;
};

export function createApi(policy: CountryPolicy, options: ApiOptions = {}) {
  const service = options.service ?? new Service(policy);
  const admin = options.admin;
  const adminToken = options.adminToken;

  const routes: Route[] = [
    // --- passenger and driver: no coordinate may cross this boundary ---
    {
      method: "POST",
      pattern: compile("/trips"),
      admin: false,
      handler: (body) => {
        const b = parseStartTrip(body);
        return service.startTrip(b.routeId, b.dir);
      },
    },
    {
      method: "POST",
      pattern: compile("/trips/progress"),
      admin: false,
      handler: (body) => {
        // The client repeats routeId and dir on every update so a restarted
        // server recovers without holding a session for each bus.
        const b = parseTripProgress(body);
        service.updateProgress(b.tripToken, b.routeId, b.dir, b.remainingM, b.zoneSeq, b.speedKph);
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: compile("/trips/end"),
      admin: false,
      handler: (body) => {
        service.endTrip(parseEndTrip(body).tripToken);
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: compile("/buses"),
      admin: false,
      handler: (body) => {
        const b = parseFindBuses(body);
        return { buses: service.findBuses(b.routeId, b.dir, b.remainingM, b.zoneSeq) };
      },
    },
    {
      method: "POST",
      pattern: compile("/requests"),
      admin: false,
      handler: (body) => {
        const b = parseRideRequest(body);
        return service.createRequest(b.routeId, b.dir, b.destinationId, b.remainingM, b.zoneSeq);
      },
    },

    // --- ops: route geometry is public infrastructure, not a person's position ---
    {
      method: "GET",
      pattern: compile("/admin/routes"),
      admin: true,
      handler: () => ({ routes: admin!.listRoutes() }),
    },
    {
      method: "GET",
      pattern: compile("/admin/routes/:id"),
      admin: true,
      handler: (_b, p) => admin!.getRoute(p.id),
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/check"),
      admin: true,
      handler: (body, p) => ({
        problems: admin!.check({ ...admin!.getRoute(p.id), ...(body as object) }),
      }),
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/width"),
      admin: true,
      handler: (body, p) => {
        const { widthM } = body as { widthM?: number };
        if (typeof widthM !== "number") throw new BadRequest("widthM must be a number");
        return admin!.setWidth(p.id, widthM);
      },
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/paths"),
      admin: true,
      handler: (body, p) => {
        const { referencePaths } = body as { referencePaths?: unknown };
        if (!Array.isArray(referencePaths)) throw new BadRequest("referencePaths must be an array");
        return admin!.setReferencePaths(p.id, referencePaths as never);
      },
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/zones"),
      admin: true,
      handler: (body, p) => {
        const { zones } = body as { zones?: unknown };
        if (!Array.isArray(zones)) throw new BadRequest("zones must be an array");
        return admin!.setZones(p.id, zones as never);
      },
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/waitpoints"),
      admin: true,
      handler: (body, p) => admin!.addWaitPoint(p.id, body as never),
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/destinations"),
      admin: true,
      handler: (body, p) => admin!.addServedDestination(p.id, body as never),
    },
    {
      method: "POST",
      pattern: compile("/admin/routes/:id/traces"),
      admin: true,
      handler: (body, p) => {
        const { traces, apply } = body as { traces?: unknown; apply?: boolean };
        if (!Array.isArray(traces)) throw new BadRequest("traces must be an array of point arrays");
        return apply
          ? admin!.importTraces(p.id, traces as never)
          : { suggestion: admin!.suggestWidthFromTraces(p.id, traces as never) };
      },
    },
    {
      method: "GET",
      pattern: compile("/admin/drivers"),
      admin: true,
      handler: () => ({ drivers: admin!.listDrivers() }),
    },
    {
      method: "POST",
      pattern: compile("/admin/drivers"),
      admin: true,
      handler: (body) => {
        const { phone } = body as { phone?: string };
        if (!phone) throw new BadRequest("phone is required");
        return admin!.createDriver(phone);
      },
    },
    {
      method: "POST",
      pattern: compile("/admin/drivers/:id/routes"),
      admin: true,
      handler: (body, p) => {
        const { routeId, remove } = body as { routeId?: string; remove?: boolean };
        if (!routeId) throw new BadRequest("routeId is required");
        return remove ? admin!.unassignRoute(p.id, routeId) : admin!.assignRoute(p.id, routeId);
      },
    },
    {
      method: "POST",
      pattern: compile("/admin/drivers/:id/vouch"),
      admin: true,
      handler: (body, p) => {
        const { authority } = body as { authority?: string };
        if (!authority) throw new BadRequest("authority is required");
        return admin!.vouch(p.id, authority);
      },
    },
    {
      method: "POST",
      pattern: compile("/admin/drivers/:id/status"),
      admin: true,
      handler: (body, p) => {
        const { status } = body as { status?: string };
        if (status !== "active" && status !== "blocked") {
          throw new BadRequest('status must be "active" or "blocked"');
        }
        return admin!.setStatus(p.id, status);
      },
    },
  ];

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const segments = path.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, ...service.liveCounts() });
    }
    if (method === "GET" && path === "/ops/report") {
      return send(res, 200, { cells: service.report() });
    }

    if (method === "GET" && (path === "/admin" || path === "/admin/")) {
      if (!admin || !adminToken) {
        return send(res, 503, { error: "ops endpoints are not configured" });
      }
      const html = readFileSync(join(import.meta.dirname, "editor.html"), "utf8").replace(
        "__MAP_TILES__",
        options.mapTiles ?? "",
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }

    for (const route of routes) {
      if (route.method !== method) continue;
      const params = match(route.pattern, segments);
      if (!params) continue;

      if (route.admin) {
        // Fails closed: without a configured token the ops endpoints do not
        // serve at all, rather than serving the driver roster to anyone.
        if (!admin || !adminToken) {
          return send(res, 503, { error: "ops endpoints are not configured" });
        }
        const supplied = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!supplied || !equalTokens(supplied, adminToken)) {
          return send(res, 401, { error: "unauthorised" });
        }
      }

      try {
        const body = await readJson(req, route.admin ? MAX_ADMIN_BODY_BYTES : MAX_BODY_BYTES);
        return send(res, 200, route.handler(body, params));
      } catch (err) {
        if (err instanceof CoordinateLeak) {
          // Loud on purpose: a passenger or driver client sending a coordinate
          // is a bug to fix at once, not a request to tolerate.
          return send(res, 400, { error: "coordinates are never accepted", field: err.path });
        }
        if (err instanceof InvalidRoute) {
          return send(res, 422, { error: "route would be invalid", problems: err.problems });
        }
        if (err instanceof NotFound) return send(res, 404, { error: err.message });
        if (err instanceof AdminError) return send(res, 409, { error: err.message });
        if (err instanceof BadRequest) return send(res, 400, { error: err.message });
        return send(res, 500, { error: "internal error" });
      }
    }

    return send(res, 404, { error: "not found" });
  });

  return { server, service, admin };
}

if (process.argv[1]?.endsWith("http.ts")) {
  const packDir = process.env.PACK ?? "countries/jo";
  const pack = new Pack(packDir);
  const policy: CountryPolicy = {
    code: pack.config.code,
    remainingBucketM: pack.config.remaining_bucket_m,
    kAnonymityMin: pack.config.k_anonymity_min,
  };

  const adminToken = process.env.ADMIN_TOKEN;
  const phoneSalt = process.env.PHONE_SALT;
  const admin = adminToken && phoneSalt ? new Admin(pack, phoneSalt) : undefined;

  if (!admin) {
    console.warn("ops endpoints disabled: set ADMIN_TOKEN and PHONE_SALT to enable them");
  }

  const port = Number(process.env.PORT ?? 3000);
  createApi(policy, { admin, adminToken, mapTiles: process.env.MAP_TILES }).server.listen(port, () =>
    console.log(`api listening on :${port} (${pack.config.code}, ${pack.listRoutes().length} lines)`),
  );
}
