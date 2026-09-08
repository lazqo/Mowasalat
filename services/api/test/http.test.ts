import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/http.ts";
import type { CountryPolicy } from "../src/service.ts";

const JO: CountryPolicy = { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 };
const ROUTE = "jo-irbid-malka";

async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { server } = createApi(JO);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a driver starts a trip, reports progress, and a passenger sees him", async () => {
  await withApi(async (base) => {
    const started = await (await post(base, "/trips", { routeId: ROUTE, dir: 0 })).json();
    assert.ok(started.tripToken && started.pseudonym);

    const progress = await post(base, "/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 8_000,
      zoneSeq: 2,
      speedKph: 40,
    });
    assert.equal(progress.status, 200, await progress.clone().text());

    const found = await (await post(base, "/buses", {
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
  await withApi(async (base) => {
    const started = await (await post(base, "/trips", { routeId: ROUTE, dir: 0 })).json();
    await post(base, "/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 8_000,
      zoneSeq: 2,
      speedKph: 40,
    });
    const body = await (await post(base, "/buses", {
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
  await withApi(async (base) => {
    const res = await post(base, "/trips", { routeId: ROUTE, dir: 0, lat: 32.5556, lng: 35.8497 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /coordinates are never accepted/);
    assert.equal(body.field, "body.lat");
  });
});

test("a position finer than policy is refused on the wire", async () => {
  await withApi(async (base) => {
    const res = await post(base, "/buses", { routeId: ROUTE, dir: 0, remainingM: 5_123, zoneSeq: 1 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /more precise than policy/);
  });
});

test("malformed and oversized bodies are refused, not crashed on", async () => {
  await withApi(async (base) => {
    const bad = await fetch(`${base}/trips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);

    const huge = await fetch(`${base}/trips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeId: "x".repeat(20_000), dir: 0 }),
    });
    assert.equal(huge.status, 400);
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
