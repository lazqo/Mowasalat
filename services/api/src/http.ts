/**
 * HTTP transport. Deliberately thin: all behaviour lives in service.ts, so
 * moving to Fastify or NestJS later is a transport change and touches nothing
 * else.
 *
 * Push uses Server-Sent Events rather than WebSockets. It is one-way, which is
 * all a bus position stream needs; it rides plain HTTP so it survives the
 * proxies and captive portals a cheap phone meets; and it reconnects on its own.
 * The client-to-server direction is ordinary POSTs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Service, type CountryPolicy } from "./service.ts";
import {
  BadRequest,
  parseEndTrip,
  parseFindBuses,
  parseRideRequest,
  parseStartTrip,
  parseTripProgress,
} from "./wire.ts";
import { CoordinateLeak } from "./guard.ts";

const MAX_BODY_BYTES = 8 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("body too large");
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
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function createApi(policy: CountryPolicy, service = new Service(policy)) {
  const routes: Record<string, (body: unknown) => unknown> = {
    "POST /trips": (body) => {
      const b = parseStartTrip(body);
      return service.startTrip(b.routeId, b.dir);
    },
    "POST /trips/progress": (body) => {
      // The client repeats routeId and dir on every update so a restarted
      // server recovers without holding a session for each bus.
      const b = parseTripProgress(body);
      service.updateProgress(b.tripToken, b.routeId, b.dir, b.remainingM, b.zoneSeq, b.speedKph);
      return { ok: true };
    },
    "POST /trips/end": (body) => {
      const b = parseEndTrip(body);
      service.endTrip(b.tripToken);
      return { ok: true };
    },
    "POST /buses": (body) => {
      const b = parseFindBuses(body);
      return { buses: service.findBuses(b.routeId, b.dir, b.remainingM, b.zoneSeq) };
    },
    "POST /requests": (body) => {
      const b = parseRideRequest(body);
      return service.createRequest(b.routeId, b.dir, b.destinationId, b.remainingM, b.zoneSeq);
    },
  };

  const server = createServer(async (req, res) => {
    const key = `${req.method} ${(req.url ?? "").split("?")[0]}`;

    if (key === "GET /health") return send(res, 200, { ok: true, ...service.liveCounts() });
    if (key === "GET /ops/report") return send(res, 200, { cells: service.report() });

    const handler = routes[key];
    if (!handler) return send(res, 404, { error: "not found" });

    try {
      send(res, 200, handler(await readJson(req)));
    } catch (err) {
      if (err instanceof CoordinateLeak) {
        // Loud on purpose: a client sending a coordinate is a bug worth fixing
        // at once, not a request to tolerate.
        return send(res, 400, { error: "coordinates are never accepted", field: err.path });
      }
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      return send(res, 500, { error: "internal error" });
    }
  });

  return { server, service };
}

// Started directly rather than imported.
if (process.argv[1]?.endsWith("http.ts")) {
  const policy: CountryPolicy = { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 };
  const port = Number(process.env.PORT ?? 3000);
  createApi(policy).server.listen(port, () => console.log(`api listening on :${port}`));
}
