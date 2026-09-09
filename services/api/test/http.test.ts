import test from "node:test";
import assert from "node:assert/strict";
import { freshApi } from "./helpers/db.ts";

const ROUTE = "jo-irbid-malka";

async function withApi(
  fn: (base: string, api: Awaited<ReturnType<typeof freshApi>>) => Promise<void>,
): Promise<void> {
  const api = await freshApi();
  try {
    await fn(api.base, api);
  } finally {
    await api.close();
  }
}

const post = (base: string, path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

test("a driver starts a trip, reports progress, and a passenger sees him", async () => {
  await withApi(async (base, api) => {
    const { driverToken } = await api.driverOn(ROUTE);
    const started = await (await post(base, "/v1/trips", { routeId: ROUTE, dir: 0 }, driverToken)).json();
    assert.ok(started.tripToken && started.pseudonym);

    const progress = await post(
      base,
      "/v1/trips/progress",
      { tripToken: started.tripToken, routeId: ROUTE, dir: 0, remainingM: 8_000, zoneSeq: 2, speedKph: 40 },
      driverToken,
    );
    assert.equal(progress.status, 200, await progress.clone().text());

    const found = await (await post(base, "/v1/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();

    assert.equal(found.buses.length, 1);
    assert.equal(found.buses[0].gapM, 3_000);
    assert.equal(found.buses[0].pseudonym, started.pseudonym);
  });
});

test("nothing a bus sighting returns can locate anyone", async () => {
  await withApi(async (base, api) => {
    const { driverToken } = await api.driverOn(ROUTE);
    const started = await (await post(base, "/v1/trips", { routeId: ROUTE, dir: 0 }, driverToken)).json();
    await post(base, "/v1/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 8_000,
      zoneSeq: 2,
      speedKph: 40,
    });
    const body = await (await post(base, "/v1/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).text();

    assert.doesNotMatch(body, /lat|lng|longitude|latitude/i);
    assert.doesNotMatch(body, /3[0-9]\.\d{4}/, "no WGS84-looking number in the response");
  });
});

test("a coordinate on the wire is refused with a named field", async () => {
  await withApi(async (base, api) => {
    const { driverToken } = await api.driverOn(ROUTE);
    const res = await post(base, "/v1/trips", { routeId: ROUTE, dir: 0, lat: 32.5556, lng: 35.8497 }, driverToken);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /coordinates are never accepted/);
    assert.equal(body.field, "body.lat");
  });
});

test("a position finer than policy is refused on the wire", async () => {
  await withApi(async (base) => {
    const res = await post(base, "/v1/buses", { routeId: ROUTE, dir: 0, remainingM: 5_123, zoneSeq: 1 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /more precise than policy/);
  });
});

test("malformed and oversized bodies are refused, not crashed on", async () => {
  await withApi(async (base, api) => {
    const { driverToken } = await api.driverOn(ROUTE);
    const auth = { "content-type": "application/json", authorization: `Bearer ${driverToken}` };

    const bad = await fetch(`${base}/v1/trips`, { method: "POST", headers: auth, body: "{not json" });
    assert.equal(bad.status, 400);

    const huge = await fetch(`${base}/v1/trips`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeId: "x".repeat(20_000), dir: 0 }),
    });
    assert.equal(huge.status, 400);
  });
});

test("a trip cannot be started without signing in, or on someone else's line", async () => {
  await withApi(async (base, api) => {
    // Assigned lines are not just a convenience: they are what a driver may run.
    assert.equal((await post(base, "/v1/trips", { routeId: ROUTE, dir: 0 })).status, 401);

    const { driverToken } = await api.driverOn(ROUTE);
    const wrongLine = await post(
      base,
      "/v1/trips",
      { routeId: "jo-irbid-umm-qais", dir: 0 },
      driverToken,
    );
    assert.equal(wrongLine.status, 400);
    assert.match((await wrongLine.json()).error, /not assigned/);
  });
});

test("an unknown route returns 404", async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test("health reports live counts", async () => {
  await withApi(async (base) => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(health, { ok: true, trips: 0, requests: 0 });
  });
});
