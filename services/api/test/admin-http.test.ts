import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/http.ts";
import { freshDb } from "./helpers/db.ts";
import type { CountryPolicy } from "../src/service.ts";

const JO: CountryPolicy = { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 };
const TOKEN = "test-token-abcdefghijklmnop";
const ROUTE = "jo-irbid-malka";

async function withApi(
  fn: (base: string, auth: Record<string, string>) => Promise<void>,
  opts: { withAdmin?: boolean } = {},
): Promise<void> {
  const db = await freshDb();
  const enabled = opts.withAdmin !== false;
  const { server } = createApi(JO, {
    admin: enabled ? db.admin : undefined,
    onboarding: enabled ? db.onboarding : undefined,
    adminToken: enabled ? TOKEN : undefined,
  });

  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, { authorization: `Bearer ${TOKEN}` });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await db.close();
  }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("ops endpoints refuse everyone without a token", async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/v1/admin/routes`)).status, 401);
    assert.equal((await fetch(`${base}/v1/admin/drivers`)).status, 401);
    assert.equal((await post(base, `/v1/admin/routes/${ROUTE}/width`, { widthM: 900 })).status, 401);
  });
});

test("a wrong token is refused", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/v1/admin/routes`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(res.status, 401);
  });
});

test("a token of the right length but wrong content is refused", async () => {
  await withApi(async (base) => {
    const nearly = "x".repeat(TOKEN.length);
    const res = await fetch(`${base}/v1/admin/routes`, { headers: { authorization: `Bearer ${nearly}` } });
    assert.equal(res.status, 401);
  });
});

test("with no token configured the ops endpoints do not serve at all", async () => {
  // Fails closed: an unconfigured deployment exposes nothing rather than
  // exposing the driver roster to anyone who asks.
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/v1/admin/routes`)).status, 503);
    assert.equal((await fetch(`${base}/v1/admin`)).status, 503);
  }, { withAdmin: false });
});

test("passenger endpoints keep working when ops is disabled", async () => {
  await withApi(async (base) => {
    // A passenger needs no account and no ops, so her side stays up.
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const buses = await post(base, "/v1/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    });
    assert.equal(buses.status, 200);

    // The driver side needs sign-in, which needs ops, and says so rather than
    // letting an unassigned bus onto the network.
    assert.equal((await post(base, "/v1/trips", { routeId: ROUTE, dir: 0 })).status, 503);
  }, { withAdmin: false });
});

test("an authorised operator lists the five lines", async () => {
  await withApi(async (base, auth) => {
    const body = await (await fetch(`${base}/v1/admin/routes`, { headers: auth })).json();
    assert.equal(body.routes.length, 5);
    assert.ok(body.routes[0].corridor.referencePaths[0].length >= 2);
  });
});

test("an edit that would break a line is refused with the reasons", async () => {
  await withApi(async (base, auth) => {
    const res = await post(base, `/v1/admin/routes/${ROUTE}/width`, { widthM: 10 }, auth);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.problems[0].field, "corridor.widthM");
    assert.match(body.problems[0].message, /too tight/);
  });
});

test("a valid width edit is saved", async () => {
  await withApi(async (base, auth) => {
    const res = await post(base, `/v1/admin/routes/${ROUTE}/width`, { widthM: 1_100 }, auth);
    assert.equal(res.status, 200);
    const after = await (await fetch(`${base}/v1/admin/routes/${ROUTE}`, { headers: auth })).json();
    assert.equal(after.corridor.widthM, 1_100);
  });
});

test("an unknown line returns 404", async () => {
  await withApi(async (base, auth) => {
    assert.equal((await fetch(`${base}/v1/admin/routes/jo-nowhere`, { headers: auth })).status, 404);
  });
});

test("traces suggest a width without applying it, then apply on request", async () => {
  await withApi(async (base, auth) => {
    const drive = Array.from({ length: 40 }, (_, i) => ({
      lat: 32.5556 + (32.669 - 32.5556) * (i / 39),
      lng: 35.8497 + (35.744 - 35.8497) * (i / 39),
    }));

    const dry = await (await post(base, `/v1/admin/routes/${ROUTE}/traces`, { traces: [drive] }, auth)).json();
    assert.ok(dry.suggestion.widthM > 0);

    const before = await (await fetch(`${base}/v1/admin/routes/${ROUTE}`, { headers: auth })).json();
    assert.equal(before.provisional, true, "still untouched by the dry run");

    const applied = await (await post(base, `/v1/admin/routes/${ROUTE}/traces`, { traces: [drive], apply: true }, auth)).json();
    assert.equal(applied.route.provisional, false);
  });
});

test("the driver roster runs end to end over the wire", async () => {
  await withApi(async (base, auth) => {
    const driver = await (await post(base, "/v1/admin/drivers", { phone: "+962790000001" }, auth)).json();
    assert.equal(driver.tier, 0);
    assert.equal(driver.phoneMasked, "••• 001");

    await post(base, `/v1/admin/drivers/${driver.id}/routes`, { routeId: ROUTE }, auth);
    const vouched = await (await post(base, `/v1/admin/drivers/${driver.id}/vouch`, { authority: "drivers_committee" }, auth)).json();
    assert.equal(vouched.tier, 1);

    const listed = await (await fetch(`${base}/v1/admin/drivers`, { headers: auth })).json();
    assert.deepEqual(listed.drivers[0].routeIds, [ROUTE]);
  });
});

test("a phone number never comes back over the wire", async () => {
  await withApi(async (base, auth) => {
    await post(base, "/v1/admin/drivers", { phone: "+962790000001" }, auth);
    const body = await (await fetch(`${base}/v1/admin/drivers`, { headers: auth })).text();
    assert.doesNotMatch(body, /790000001/);
  });
});

test("an unrecognised vouching authority is refused", async () => {
  await withApi(async (base, auth) => {
    const driver = await (await post(base, "/v1/admin/drivers", { phone: "+962790000002" }, auth)).json();
    const res = await post(base, `/v1/admin/drivers/${driver.id}/vouch`, { authority: "some_guy" }, auth);
    assert.equal(res.status, 409);
  });
});

test("a driver id never appears in anything a passenger can see", async () => {
  // The roster is the one place holding something personal, and it stays out
  // of the realtime layer entirely (docs/PLAN.md §6.4).
  await withApi(async (base, auth) => {
    const driver = await (await post(base, "/v1/admin/drivers", { phone: "+962790000003" }, auth)).json();
    const started = await (await post(base, "/v1/trips", { routeId: ROUTE, dir: 0 })).json();
    await post(base, "/v1/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 8_000,
      zoneSeq: 1,
      speedKph: 40,
    });

    const seen = await (await post(base, "/v1/buses", { routeId: ROUTE, dir: 0, remainingM: 5_000, zoneSeq: 0 })).text();
    assert.doesNotMatch(seen, new RegExp(driver.id));
    assert.doesNotMatch(seen, /drv-/);
  });
});

test("the editor page is served to an operator", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/v1/admin`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>/);
    assert.doesNotMatch(html, /__MAP_TILES__/, "the tile placeholder was substituted");
  });
});
