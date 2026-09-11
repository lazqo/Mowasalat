import test from "node:test";
import assert from "node:assert/strict";
import { freshApi } from "../../../services/api/test/helpers/db.ts";
import { Api } from "../src/api.ts";
import { PassengerController } from "../src/passenger.ts";
import type { LatLng } from "../../../packages/corridor/src/types.ts";

/**
 * The web client against a real server: real Postgres, the real /v1 handlers,
 * the real corridor validation. Fixtures prove the arithmetic; this proves the
 * two halves still fit together — that what the page computes is what the
 * server will accept, which is the thing a recording cannot tell you.
 */

const ROUTE = "jo-irbid-malka";
const IRBID: LatLng = { lat: 32.5556, lng: 35.8497 };

async function withApi(fn: (ctx: Awaited<ReturnType<typeof freshApi>>) => Promise<void>) {
  const api = await freshApi({ webOrigins: "*" });
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

test("she finds a bus that is actually running, and the server accepts every word of it", async () => {
  await withApi(async (server) => {
    const api = new Api(server.base);
    const [country, routes] = await Promise.all([api.country(), api.routes()]);
    const passenger = new PassengerController(api, routes, country.remainingBucketM);

    // A driver sets out from the hub towards ملكا.
    const { driverToken } = await server.driverOn(ROUTE);
    const trip = await (
      await fetch(`${server.base}/v1/trips`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${driverToken}` },
        body: JSON.stringify({ routeId: ROUTE, dir: 0 }),
      })
    ).json();

    // She is at the hub, going to ملكا.
    const destination = passenger.destinations("ملكا")[0];
    assert.equal(destination.id, "jo-malka");

    const ride = passenger.ridesFor(destination.id, IRBID)[0];
    assert.ok(ride, "the line from إربد to ملكا should pick her up at إربد");
    assert.equal(ride.route.id, ROUTE);

    // The driver is further from the endpoint than she is, so he has yet to
    // pass her.
    const behindHer = Math.ceil((ride.remainingM + 3000) / country.remainingBucketM) * country.remainingBucketM;
    const progress = await fetch(`${server.base}/v1/trips/progress`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${driverToken}` },
      body: JSON.stringify({
        tripToken: trip.tripToken,
        routeId: ROUTE,
        dir: 0,
        remainingM: behindHer,
        zoneSeq: ride.zoneSeq,
        speedKph: 40,
      }),
    });
    assert.equal(progress.status, 200, await progress.clone().text());

    const { buses, streamTicket } = await passenger.busesFor(ride);
    assert.ok(streamTicket, "a ticket she can watch the line with");
    assert.equal(buses.length, 1, "the bus behind her is the bus she can catch");
    assert.equal(buses[0].pseudonym, trip.pseudonym);

    // أنا مستني هون — and the driver sees a pin without ever learning who she is.
    const pseudonym = await passenger.requestRide(ride);
    assert.ok(pseudonym);
    assert.notEqual(pseudonym, trip.pseudonym);

    const waiting = await (
      await fetch(`${server.base}/v1/stream/waiting?tripToken=${trip.tripToken}`, {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.timeout(2000),
      }).then((r) => ({ json: async () => readFirstEvent(r) }))
    ).json();
    assert.ok(waiting.pins.length >= 1, "the driver is told someone is waiting ahead");
    for (const pin of waiting.pins) {
      assert.equal(Object.keys(pin).sort().join(","), "count,remainingM,zoneSeq");
    }

    await passenger.boarded();
    assert.equal(passenger.state, "boarded");
  });
});

test("the server refuses a position finer than the country's band", async () => {
  await withApi(async (server) => {
    const api = new Api(server.base);
    // Deliberately unbucketed. The controller cannot produce this — it buckets
    // everything it sends — so this checks the floor under the client, not the
    // client. If the client ever regressed, this is the error it would meet.
    const res = await fetch(`${server.base}/v1/buses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeId: ROUTE, dir: 0, remainingM: 8_123, zoneSeq: 0 }),
    });
    assert.equal(res.status, 400);
    void api;
  });
});

test("a coordinate is refused even if a client somehow sent one", async () => {
  await withApi(async (server) => {
    const res = await fetch(`${server.base}/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routeId: ROUTE,
        dir: 0,
        destinationId: "jo-malka",
        remainingM: 8_000,
        zoneSeq: 0,
        lat: 32.5556,
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /coordinates are never accepted/);
  });
});

/** Reads one SSE frame and lets go of the connection. */
async function readFirstEvent(res: Response): Promise<{ pins: Record<string, unknown>[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended with no event");
      buffer += decoder.decode(value, { stream: true });

      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
      }
    }
  } finally {
    await reader.cancel();
  }
}
