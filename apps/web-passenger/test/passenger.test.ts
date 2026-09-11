import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PassengerController, etaText, REQUEST_LIFETIME_MS } from "../src/passenger.ts";
import type { Api, BusScalar } from "../src/api.ts";
import type { Direction, LatLng, Route } from "../../../packages/corridor/src/types.ts";

/**
 * The same recordings the Dart client is tested against, captured from a live
 * /v1 backend. Testing both clients on one set of responses is what keeps them
 * from drifting into two different ideas of the same journey.
 */
const fixtures = join(import.meta.dirname, "../../../packages/core/test/fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
}

const network = load<{ routes: Route[] }>("routes.json").routes;
const BUCKET_M = load<{ remainingBucketM: number }>("country.json").remainingBucketM;

const IRBID: LatLng = { lat: 32.5556, lng: 35.8497 };
const MALKA: LatLng = { lat: 32.669, lng: 35.744 };

/** Records what was sent, so a test can assert on the wire and not just the result. */
function recorder(overrides: Partial<Api> = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const api = {
    async findBuses(args: Record<string, unknown>) {
      sent.push({ path: "/v1/buses", body: args });
      return { buses: [] as BusScalar[], streamTicket: "t-1" };
    },
    async requestRide(args: Record<string, unknown>) {
      sent.push({ path: "/v1/requests", body: args });
      return { pseudonym: "p-1" };
    },
    async cancelRequest(pseudonym: string) {
      sent.push({ path: "/v1/requests/cancel", body: { pseudonym } });
      return { cancelled: true };
    },
    async boarded(args: Record<string, unknown>) {
      sent.push({ path: "/v1/requests/boarded", body: args });
      return { ok: true as const };
    },
    ...overrides,
  } as unknown as Api;
  return { api, sent };
}

function controllerAt(now = () => 0) {
  const { api, sent } = recorder();
  return { c: new PassengerController(api, network, BUCKET_M, now), sent };
}

// --- where can she go -------------------------------------------------------

test("every served place is offered once, whichever lines reach it", () => {
  const { c } = controllerAt();
  const options = c.destinations();

  assert.equal(options.length, new Set(options.map((o) => o.id)).size);
  assert.ok(options.some((o) => o.id === "jo-malka"));
  for (const o of options) assert.ok(o.routeIds.length > 0);
});

test("search finds a village through a misspelling", () => {
  const { c } = controllerAt();
  assert.deepEqual(
    c.destinations("ملكة").map((o) => o.id),
    ["jo-malka"],
  );
});

// --- which line would pick her up -------------------------------------------

test("standing at the hub, the line towards her destination is offered", () => {
  const { c } = controllerAt();
  const rides = c.ridesFor("jo-malka", IRBID);

  assert.equal(rides.length, 1);
  assert.equal(rides[0].route.id, "jo-irbid-malka");
  assert.equal(rides[0].dir, 0, "origin → destination");
  assert.ok(rides[0].remainingM > 0);
});

test("standing at the destination is not a ride, it is a walk back", () => {
  const { c } = controllerAt();
  // She is already in ملكا and asks for ملكا. Direction 0 has nothing left to
  // cover, and direction 1 runs away from it.
  assert.deepEqual(c.ridesFor("jo-malka", MALKA), []);
});

test("a position nowhere near any corridor offers nothing", () => {
  const { c } = controllerAt();
  assert.deepEqual(c.ridesFor("jo-malka", { lat: 31.95, lng: 35.93 }), []); // Amman
});

// --- the wire ---------------------------------------------------------------

test("what is sent is bucketed, and carries no coordinate", () => {
  const { c, sent } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  return c.busesFor(ride).then(async () => {
    await c.requestRide(ride);

    assert.equal(sent.length, 2);
    for (const { body } of sent) {
      assert.equal(
        (body.remainingM as number) % BUCKET_M,
        0,
        "a position finer than the country's band would be refused by the server",
      );
      for (const key of Object.keys(body)) {
        assert.ok(
          !/(^|_)(lat|latitude|lng|lon|longitude|coords?|position|location)(_|$)/i.test(key),
          `${key} must never be sent`,
        );
      }
    }
  });
});

// --- watching the bus -------------------------------------------------------

test("only buses still behind her, and only within the window", () => {
  const { c } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  const sightings = c.sightingsFrom(
    [
      { pseudonym: "ahead", remainingM: ride.remainingM - 1000, zoneSeq: 0, speedKph: 40 },
      { pseudonym: "behind", remainingM: ride.remainingM + 2000, zoneSeq: 0, speedKph: 40 },
      { pseudonym: "far", remainingM: ride.remainingM + 40_000, zoneSeq: 0, speedKph: 40 },
    ],
    ride,
  );

  assert.deepEqual(
    sightings.map((s) => s.pseudonym),
    ["behind"],
  );
  assert.equal(sightings[0].gapM, 2000);
});

test("the nearest bus is listed first", () => {
  const { c } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  const sightings = c.sightingsFrom(
    [
      { pseudonym: "further", remainingM: ride.remainingM + 5000, zoneSeq: 0, speedKph: 40 },
      { pseudonym: "nearer", remainingM: ride.remainingM + 1000, zoneSeq: 0, speedKph: 40 },
    ],
    ride,
  );

  assert.deepEqual(
    sightings.map((s) => s.pseudonym),
    ["nearer", "further"],
  );
});

test("a stopped bus gets no ETA, because a number would be a guess", () => {
  const { c } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  const [stopped] = c.sightingsFrom(
    [{ pseudonym: "x", remainingM: ride.remainingM + 3000, zoneSeq: 0, speedKph: 0 }],
    ride,
  );

  assert.equal(stopped.etaSeconds, null);
  assert.equal(etaText(stopped), "الباص واقف");
});

test("an ETA is distance over speed, read as minutes", () => {
  const { c } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  // 6 km at 36 km/h is ten minutes.
  const [bus] = c.sightingsFrom(
    [{ pseudonym: "x", remainingM: ride.remainingM + 6000, zoneSeq: 0, speedKph: 36 }],
    ride,
  );

  assert.equal(Math.round(bus.etaSeconds!), 600);
  assert.equal(etaText(bus), "بعد 10 دقايق");
});

// --- the one interaction she has --------------------------------------------

test("waiting, then boarding, leaves nothing behind", async () => {
  const { c, sent } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  assert.equal(c.state, "idle");
  await c.requestRide(ride);
  assert.equal(c.state, "waiting");
  assert.equal(c.requestPseudonym, "p-1");

  await c.boarded();
  assert.equal(c.state, "boarded");
  assert.equal(c.requestPseudonym, null);
  assert.equal(c.chosenRide, null);
  assert.ok(sent.some((s) => s.path === "/v1/requests/boarded"));
});

test("cancelling clears the local state even when the server has already forgotten", async () => {
  const { api } = recorder({
    async cancelRequest() {
      throw new Error("gone");
    },
  } as Partial<Api>);
  const c = new PassengerController(api, network, BUCKET_M, () => 0);
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  await c.requestRide(ride);
  await c.cancel();

  assert.equal(c.state, "cancelled");
  assert.equal(c.requestPseudonym, null);
});

test("the request expires on its own, exactly when the server drops it", async () => {
  let now = 0;
  const { c } = controllerAt(() => now);
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  await c.requestRide(ride);
  assert.equal(c.timeLeftMs, REQUEST_LIFETIME_MS);

  now = REQUEST_LIFETIME_MS - 1000;
  assert.equal(c.refresh(), "waiting");
  assert.equal(c.timeLeftMs, 1000);

  now = REQUEST_LIFETIME_MS;
  assert.equal(c.refresh(), "expired");
  assert.equal(c.timeLeftMs, 0);
});

test("she cannot be waiting for two buses at once", async () => {
  const { c } = controllerAt();
  const ride = c.ridesFor("jo-malka", IRBID)[0];

  await c.requestRide(ride);
  await assert.rejects(() => c.requestRide(ride));
});

test("a server that did not say how coarse positions must be is refused", () => {
  // She is only protected because everything is rounded to the country's band.
  // A missing band is a misconfiguration, not a default to invent.
  const { api } = recorder();
  for (const bad of [undefined, 0, -250, Number.NaN]) {
    assert.throws(
      () => new PassengerController(api, network, bad as unknown as number),
      /remainingBucketM/,
    );
  }
});
