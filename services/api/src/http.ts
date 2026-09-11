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
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Admin, AdminError, InvalidRoute, NotFound } from "./admin.ts";
import { corsHeaders, corsPolicy, type CorsPolicy } from "./cors.ts";
import { CoordinateLeak, SecretLeak } from "./guard.ts";
import { Onboarding, Unauthorized } from "./onboarding.ts";
import { OtpError } from "./otp/service.ts";
import { InvalidPhone } from "./phone.ts";
import { Pack } from "./pack.ts";
import { Service, type CountryPolicy } from "./service.ts";
import { coalesce } from "./live/coalesce.ts";
import { MemoryTicketStore } from "./live/memory.ts";
import { topicFor, type TicketStore } from "./live/store.ts";
import {
  BadRequest,
  parseEndTrip,
  parseFindBuses,
  parseRideRequest,
  parseStartTrip,
  parseTripProgress,
} from "./wire.ts";

const MAX_BODY_BYTES = 8 * 1024;

/**
 * The caller's address, hashed, only ever used to rate-limit code requests. The
 * address itself is not kept.
 */
function hashIp(req: IncomingMessage): string | undefined {
  const raw = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress;
  if (!raw) return undefined;
  return createHash("sha256").update(raw).digest("hex");
}
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

/**
 * What a driver's own app may see about him. Never the phone number, never the
 * hash, and nothing the realtime layer is given.
 */
function publicDriver(d: {
  id: string;
  phoneMasked: string;
  tier: number;
  status: string;
  routeIds: string[];
  vouchedBy?: string;
}) {
  return {
    id: d.id,
    phoneMasked: d.phoneMasked,
    tier: d.tier,
    status: d.status,
    routeIds: d.routeIds,
    vouchedBy: d.vouchedBy ?? null,
  };
}

function equalTokens(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Ctx = {
  /** The signed-in driver, present only on routes marked `driver`. */
  driverId: string;
  ipHash?: string;
};

type Handler = (
  body: unknown,
  params: Record<string, string>,
  ctx: Ctx,
) => unknown | Promise<unknown>;

type Route = {
  method: string;
  pattern: string[];
  handler: Handler;
  admin: boolean;
  /** Requires a driver bearer token from OTP sign-in. */
  driver?: boolean;
};

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
  /** Driver sign-in. Without it the driver endpoints refuse to serve. */
  onboarding?: Onboarding;
  /** What a client needs to know about this country, served at /v1/country. */
  countryInfo?: Record<string, unknown>;
  /** Required for the ops endpoints. Without it they refuse to serve at all. */
  adminToken?: string;
  /** Basemap style for the corridor editor. Replace with the self-hosted stack. */
  mapTiles?: string;
  /** How often at most a stream may push. Buses report every 5 s. */
  streamIntervalMs?: number;
  /** Keeps idle connections alive through proxies that cut them. */
  heartbeatMs?: number;
  /** Where stream tickets live. In process by default; Redis behind more than one instance. */
  tickets?: TicketStore;
  /**
   * Which web origins may call this API. Unset means none, so a deployment
   * that has not thought about it stays closed to browsers.
   */
  webOrigins?: string;
};

export function createApi(policy: CountryPolicy, options: ApiOptions = {}) {
  const service = options.service ?? new Service(policy);
  const admin = options.admin;
  const onboarding = options.onboarding;
  const adminToken = options.adminToken;
  const tickets = options.tickets ?? new MemoryTicketStore();
  const streamIntervalMs = options.streamIntervalMs ?? 2_000;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const cors: CorsPolicy = corsPolicy(options.webOrigins);

  const routes: Route[] = [
    // --- passenger and driver: no coordinate may cross this boundary ---
    {
      method: "POST",
      pattern: compile("/v1/trips"),
      admin: false,
      driver: true,
      handler: async (body, _p, ctx) => {
        const b = parseStartTrip(body);
        // Assigned lines are not the active line. A driver may hold several;
        // starting a trip picks exactly one of them, and only one of his own
        // (docs/PLAN.md §5.4).
        const assigned = await admin!.routesForDriver(ctx.driverId);
        if (!assigned.some((r) => r.id === b.routeId)) {
          throw new BadRequest("you are not assigned to that line");
        }
        return service.startTrip(b.routeId, b.dir);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/trips/progress"),
      admin: false,
      driver: true,
      handler: async (body) => {
        // The client repeats routeId and dir on every update so a restarted
        // server recovers without holding a session for each bus.
        const b = parseTripProgress(body);
        await service.updateProgress(b.tripToken, b.routeId, b.dir, b.remainingM, b.zoneSeq, b.speedKph);
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/trips/end"),
      admin: false,
      driver: true,
      handler: async (body) => {
        await service.endTrip(parseEndTrip(body).tripToken);
        return { ok: true };
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/buses"),
      admin: false,
      handler: async (body) => {
        const b = parseFindBuses(body);
        // The ticket binds a stream to this line and direction, so streaming
        // cannot be used to enumerate the whole network (§6.6).
        return {
          buses: await service.findBuses(b.routeId, b.dir, b.remainingM, b.zoneSeq),
          streamTicket: await tickets.issue(b.routeId, b.dir),
        };
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/requests"),
      admin: false,
      handler: (body) => {
        const b = parseRideRequest(body);
        return service.createRequest(b.routeId, b.dir, b.destinationId, b.remainingM, b.zoneSeq);
      },
    },

    {
      method: "POST",
      pattern: compile("/v1/requests/cancel"),
      admin: false,
      handler: async (body) => {
        const { pseudonym } = body as { pseudonym?: string };
        if (!pseudonym) throw new BadRequest("pseudonym is required");
        return { cancelled: await service.cancelRequest(pseudonym) };
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/requests/boarded"),
      admin: false,
      handler: async (body) => {
        const { pseudonym, routeId, dir } = body as {
          pseudonym?: string;
          routeId?: string;
          dir?: 0 | 1;
        };
        if (!pseudonym || !routeId || (dir !== 0 && dir !== 1)) {
          throw new BadRequest("pseudonym, routeId and dir are required");
        }
        await service.boarded(pseudonym, routeId, dir);
        return { ok: true };
      },
    },

    // --- driver sign-in: a phone number and a code, nothing else ---
    {
      method: "POST",
      pattern: compile("/v1/auth/otp/request"),
      admin: false,
      handler: async (body, _p, ctx) => {
        const { phone } = body as { phone?: string };
        if (!phone) throw new BadRequest("phone is required");
        return onboarding!.requestCode(phone, ctx.ipHash);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/auth/otp/verify"),
      admin: false,
      handler: async (body) => {
        const { challengeId, code, phone } = body as {
          challengeId?: string;
          code?: string;
          phone?: string;
        };
        if (!challengeId || !code || !phone) {
          throw new BadRequest("challengeId, code and phone are required");
        }
        const session = await onboarding!.verify(challengeId, code, phone);
        return {
          driverToken: session.driverToken,
          isNew: session.isNew,
          driver: publicDriver(session.driver),
        };
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/auth/sign-out"),
      admin: false,
      driver: true,
      handler: async (_b, _p, ctx) => {
        void ctx;
        return { ok: true };
      },
    },

    // --- the driver's own account ---
    {
      method: "GET",
      pattern: compile("/v1/driver/me"),
      admin: false,
      driver: true,
      handler: async (_b, _p, ctx) => ({
        driver: publicDriver(await admin!.getDriver(ctx.driverId)),
        routes: await admin!.routesForDriver(ctx.driverId),
        vehicles: await admin!.vehiclesFor(ctx.driverId),
      }),
    },
    {
      method: "GET",
      pattern: compile("/v1/driver/routes"),
      admin: false,
      driver: true,
      handler: async (_b, _p, ctx) => ({ routes: await admin!.routesForDriver(ctx.driverId) }),
    },
    {
      method: "POST",
      pattern: compile("/v1/driver/vehicle"),
      admin: false,
      driver: true,
      handler: async (body, _p, ctx) => {
        const { type, colour, plate, showPlate } = body as {
          type?: string;
          colour?: string;
          plate?: string;
          showPlate?: boolean;
        };
        if (type !== "coaster" && type !== "minibus" && type !== "service") {
          throw new BadRequest('type must be "coaster", "minibus" or "service"');
        }
        return admin!.addVehicle({
          driverId: ctx.driverId,
          type,
          colour: colour ?? null,
          plate: plate ?? null,
          // A plate is shown only if the driver chooses to (§16, opt-in).
          showPlate: showPlate === true,
        });
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/driver/invitation"),
      admin: false,
      driver: true,
      handler: async (body, _p, ctx) => {
        const { code } = body as { code?: string };
        if (!code) throw new BadRequest("code is required");
        return { driver: publicDriver(await onboarding!.redeemInvitation(ctx.driverId, code)) };
      },
    },

    // --- ops: route geometry is public infrastructure, not a person's position ---
    {
      method: "GET",
      pattern: compile("/v1/admin/routes"),
      admin: true,
      handler: async () => ({ routes: await admin!.listRoutes() }),
    },
    {
      method: "GET",
      pattern: compile("/v1/admin/routes/:id"),
      admin: true,
      handler: (_b, p) => admin!.getRoute(p.id),
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/check"),
      admin: true,
      handler: async (body, p) => ({
        problems: admin!.check({ ...(await admin!.getRoute(p.id)), ...(body as object) }),
      }),
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/width"),
      admin: true,
      handler: (body, p) => {
        const { widthM } = body as { widthM?: number };
        if (typeof widthM !== "number") throw new BadRequest("widthM must be a number");
        return admin!.setWidth(p.id, widthM);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/paths"),
      admin: true,
      handler: (body, p) => {
        const { referencePaths } = body as { referencePaths?: unknown };
        if (!Array.isArray(referencePaths)) throw new BadRequest("referencePaths must be an array");
        return admin!.setReferencePaths(p.id, referencePaths as never);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/zones"),
      admin: true,
      handler: (body, p) => {
        const { zones } = body as { zones?: unknown };
        if (!Array.isArray(zones)) throw new BadRequest("zones must be an array");
        return admin!.setZones(p.id, zones as never);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/waitpoints"),
      admin: true,
      handler: (body, p) => admin!.addWaitPoint(p.id, body as never),
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/destinations"),
      admin: true,
      handler: (body, p) => admin!.addServedDestination(p.id, body as never),
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/routes/:id/traces"),
      admin: true,
      handler: async (body, p) => {
        const { traces, apply } = body as { traces?: unknown; apply?: boolean };
        if (!Array.isArray(traces)) throw new BadRequest("traces must be an array of point arrays");
        if (apply) return admin!.importTraces(p.id, traces as never);
        return { suggestion: await admin!.suggestWidthFromTraces(p.id, traces as never) };
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/invitations"),
      admin: true,
      handler: async (body) => {
        const { routeIds, authority, note, ttlHours } = body as {
          routeIds?: string[];
          authority?: string;
          note?: string;
          ttlHours?: number;
        };
        if (!Array.isArray(routeIds) || routeIds.length === 0) {
          throw new BadRequest("routeIds is required");
        }
        if (!authority) throw new BadRequest("authority is required");
        return onboarding!.createInvitation({ routeIds, authority, note, ttlHours });
      },
    },
    {
      method: "GET",
      pattern: compile("/v1/admin/drivers"),
      admin: true,
      handler: async () => ({ drivers: await admin!.listDrivers() }),
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/drivers"),
      admin: true,
      handler: (body) => {
        const { phone } = body as { phone?: string };
        if (!phone) throw new BadRequest("phone is required");
        return admin!.createDriver(phone);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/drivers/:id/routes"),
      admin: true,
      handler: (body, p) => {
        const { routeId, remove } = body as { routeId?: string; remove?: boolean };
        if (!routeId) throw new BadRequest("routeId is required");
        return remove ? admin!.unassignRoute(p.id, routeId) : admin!.assignRoute(p.id, routeId);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/drivers/:id/vouch"),
      admin: true,
      handler: (body, p) => {
        const { authority } = body as { authority?: string };
        if (!authority) throw new BadRequest("authority is required");
        return admin!.vouch(p.id, authority);
      },
    },
    {
      method: "POST",
      pattern: compile("/v1/admin/drivers/:id/status"),
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

  /**
   * Opens a Server-Sent Events response that resends a snapshot whenever the
   * line changes, and a comment heartbeat while it does not.
   */
  async function openStream(
    req: IncomingMessage,
    res: ServerResponse,
    topic: string,
    snapshot: () => Promise<unknown>,
  ): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Some reverse proxies buffer responses, which would hold events back
      // until the connection closed.
      "x-accel-buffering": "no",
    });

    // Tells the client how long to wait before reconnecting after a drop.
    res.write("retry: 5000\n\n");

    const push = () => {
      if (res.writableEnded) return;
      void snapshot()
        .then((data) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
        })
        .catch(() => {
          // A failed snapshot must not tear the stream down; the next
          // notification produces a fresh one.
        });
    };

    const trigger = coalesce(push, streamIntervalMs);
    const unsubscribe = await service.hub.subscribe(topic, trigger);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, heartbeatMs);

    const close = () => {
      clearInterval(heartbeat);
      trigger.cancel();
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.on("close", close);
    req.on("error", close);

    push(); // the current picture, before anything changes
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const segments = path.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    // Set before any writeHead so every answer carries them: the JSON replies,
    // the SSE streams, and the ops editor alike.
    for (const [k, v] of Object.entries(corsHeaders(req.headers.origin, cors))) {
      res.setHeader(k, v);
    }
    if (method === "OPTIONS") {
      res.writeHead(res.getHeader("access-control-allow-origin") ? 204 : 405);
      return res.end();
    }

    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, ...(await service.liveCounts()) });
    }
    if (method === "GET" && path === "/ops/report") {
      return send(res, 200, { cells: service.report() });
    }

    // --- push -------------------------------------------------------------

    if (method === "GET" && path === "/v1/country") {
      return send(res, 200, options.countryInfo ?? { code: policy.code });
    }

    if (method === "GET" && path === "/v1/routes") {
      // The network a passenger's phone caches so it can do its own corridor
      // matching offline. Public infrastructure, no identities.
      if (!admin) return send(res, 503, { error: "the network is not configured" });
      return send(res, 200, { routes: await admin.listRoutes() });
    }

    if (method === "GET" && path === "/v1/stream/buses") {
      const ticket = await tickets.redeem(url.searchParams.get("ticket") ?? "");
      if (!ticket) {
        return send(res, 401, {
          error: "a stream ticket is required; ask which buses are running first",
        });
      }
      return openStream(req, res, topicFor(ticket.routeId, ticket.dir), async () => ({
        buses: await service.busesOn(ticket.routeId, ticket.dir),
      }));
    }

    if (method === "GET" && path === "/v1/stream/waiting") {
      const tripToken = url.searchParams.get("tripToken") ?? "";

      // A driver's stream is bound to his own trip, so he sees what is ahead of
      // him on his own line and nothing else, at any tier.
      const mine = await service.tripRoute(tripToken);
      if (!mine) return send(res, 401, { error: "unknown or ended trip" });
      return openStream(req, res, topicFor(mine.routeId, mine.dir), async () => ({
        pins: (await service.pinsForTrip(tripToken)) ?? [],
      }));
    }

    if (method === "GET" && (path === "/v1/admin" || path === "/v1/admin/")) {
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

      const ctx: Ctx = { driverId: "", ipHash: hashIp(req) };

      if (route.driver) {
        if (!onboarding || !admin) {
          return send(res, 503, { error: "driver sign-in is not configured" });
        }
        try {
          const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
          ctx.driverId = (await onboarding.authenticate(bearer)).id;
        } catch {
          return send(res, 401, { error: "sign in again" });
        }
      }

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
        return send(res, 200, await route.handler(body, params, ctx));
      } catch (err) {
        if (err instanceof CoordinateLeak) {
          // Loud on purpose: a passenger or driver client sending a coordinate
          // is a bug to fix at once, not a request to tolerate.
          return send(res, 400, { error: "coordinates are never accepted", field: err.path });
        }
        if (err instanceof SecretLeak) {
          return send(res, 400, { error: "secrets are never accepted here", field: err.path });
        }
        if (err instanceof OtpError) {
          const status = err.code === "too_many_sends" || err.code === "too_many_attempts" ? 429 : 400;
          return send(res, status, {
            error: err.message,
            code: err.code,
            retryAfterSeconds: err.retryAfterSeconds,
          });
        }
        if (err instanceof InvalidPhone) {
          return send(res, 400, { error: err.message, code: "invalid_phone" });
        }
        if (err instanceof Unauthorized) return send(res, 401, { error: err.message });
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
  const databaseUrl = process.env.DATABASE_URL;

  let admin: Admin | undefined;
  let onboarding: Onboarding | undefined;

  if (adminToken && phoneSalt && databaseUrl) {
    const { createPool } = await import("./db/pool.ts");
    const { migrate } = await import("./db/migrate.ts");
    const { DevelopmentOtpProvider, ManualOtpProvider, selectProvider, SmsOtpProvider } =
      await import("./otp/provider.ts");
    const { rulesFor } = await import("./phone.ts");

    const pool = createPool(databaseUrl);
    await migrate(pool);

    admin = new Admin(pool, pack.config.code, phoneSalt, {
      vouchingAuthorities: pack.config.vouching_authorities,
      tier2Thresholds: pack.config.tier2_thresholds,
    });

    // Which channels exist here is the country's decision, not the code's. In
    // development the code is handed straight back so nobody needs an SMS bill;
    // that provider refuses to be constructed in production.
    const available = [];
    if (process.env.NODE_ENV !== "production") available.push(new DevelopmentOtpProvider());
    if (process.env.SMS_GATEWAY_URL) {
      available.push(
        new SmsOtpProvider(async ({ to, text }) => {
          const res = await fetch(process.env.SMS_GATEWAY_URL!, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(process.env.SMS_GATEWAY_TOKEN
                ? { authorization: `Bearer ${process.env.SMS_GATEWAY_TOKEN}` }
                : {}),
            },
            body: JSON.stringify({ to, text }),
          });
          if (!res.ok) throw new Error(`sms gateway returned ${res.status}`);
        }),
      );
    }
    available.push(new ManualOtpProvider());

    onboarding = new Onboarding({
      sql: pool,
      admin,
      // The pack decides which channels a country may use. Outside production
      // the development channel is permitted as well, so a local run can read
      // its own code without an SMS bill; the provider itself refuses to be
      // constructed in production, so this cannot widen anything there.
      provider: selectProvider(
        available,
        process.env.NODE_ENV === "production"
          ? (pack.config.otp_channels ?? ["manual_vouch"])
          : ["development", ...(pack.config.otp_channels ?? [])],
      ),
      secret: process.env.OTP_SECRET ?? phoneSalt,
      rules: rulesFor(pack.config),
      countryCode: pack.config.code,
    });
  } else {
    console.warn(
      "driver sign-in and ops disabled: set DATABASE_URL, ADMIN_TOKEN and PHONE_SALT",
    );
  }

  // Live operational state. In process by default, which is correct for a
  // single instance; Redis when a pilot runs behind more than one, so a driver
  // reporting to one server is seen by passengers streaming from another.
  let live, hub, tickets, redisNote = "in process";
  if (process.env.REDIS_URL) {
    const { createClient } = await import("redis");
    const { assertNoPersistence, RedisHub, RedisLiveStore, RedisTicketStore } = await import(
      "./live/redis.ts"
    );
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    // Fails loudly rather than quietly accumulating a movement trail on disk.
    await assertNoPersistence(client as never);

    live = new RedisLiveStore(client as never);
    hub = new RedisHub(client as never);
    tickets = new RedisTicketStore(client as never);
    redisNote = "redis";
  }

  const port = Number(process.env.PORT ?? 3000);
  createApi(policy, {
    service: new Service(policy, undefined, undefined, { live, hub }),
    tickets,
    admin,
    onboarding,
    adminToken,
    mapTiles: process.env.MAP_TILES,
    webOrigins: process.env.WEB_ORIGINS,
    countryInfo: {
      code: pack.config.code,
      locale: pack.config.locale,
      digits: pack.config.digits,
      phonePrefix: pack.config.phone_prefix,
      remainingBucketM: pack.config.remaining_bucket_m,
      kAnonymityMin: pack.config.k_anonymity_min,
      strings: pack.config.strings,
    },
  }).server.listen(port, () =>
    console.log(
      `api listening on :${port} (${pack.config.code}, live state ${redisNote}${admin ? ", ops enabled" : ""})`,
    ),
  );
}
