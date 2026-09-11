import test from "node:test";
import assert from "node:assert/strict";
import { freshApi } from "./helpers/db.ts";
import { corsHeaders, corsPolicy } from "../src/cors.ts";

/**
 * The Flutter apps never needed cross-origin access: a native app is not an
 * origin. The web passenger page is, so these pin down when the API answers a
 * browser and when it does not.
 */

const WEB = "https://mowasalat.example";

test("unset means closed, which is what every existing deployment already is", () => {
  assert.equal(corsPolicy(undefined), null);
  assert.equal(corsPolicy(""), null);
  assert.equal(corsPolicy("  "), null);
  assert.deepEqual(corsHeaders(WEB, corsPolicy(undefined)), {});
});

test("an allow-list admits its own origins and nobody else", () => {
  const policy = corsPolicy(`${WEB}, https://staging.example`);

  assert.equal(corsHeaders(WEB, policy)["access-control-allow-origin"], WEB);
  assert.equal(corsHeaders("https://staging.example", policy)["access-control-allow-origin"], "https://staging.example");
  assert.deepEqual(corsHeaders("https://elsewhere.example", policy), {});

  // A near miss is a miss: a prefix match would admit mowasalat.example.evil.
  assert.deepEqual(corsHeaders(`${WEB}.evil`, policy), {});
});

test("an allow-list varies on origin, so a cache cannot cross-serve", () => {
  assert.equal(corsHeaders(WEB, corsPolicy(WEB)).vary, "origin");
  assert.equal(corsHeaders(WEB, corsPolicy("*")).vary, undefined, "one answer for everyone needs no vary");
});

test("a trailing slash is not a different origin", () => {
  assert.equal(corsHeaders(WEB, corsPolicy(`${WEB}/`))["access-control-allow-origin"], WEB);
});

test("a request with no origin gets no headers", () => {
  // curl, a native app, a health check. Nothing to grant, nothing to leak.
  assert.deepEqual(corsHeaders(undefined, corsPolicy("*")), {});
});

test("no credential mode is ever offered", () => {
  // Cookies would make a visit to any page enough to act as a signed-in
  // driver. A bearer token cannot be sent by a page that does not hold one.
  for (const raw of ["*", WEB]) {
    assert.equal(corsHeaders(WEB, corsPolicy(raw))["access-control-allow-credentials"], undefined);
  }
});

// --- against a running server -----------------------------------------------

test("a browser is refused when the API has not been told about it", async () => {
  const api = await freshApi();
  try {
    const res = await fetch(`${api.base}/v1/country`, { headers: { origin: WEB } });
    assert.equal(res.status, 200, "the API still answers; the browser is what refuses");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await api.close();
  }
});

test("a configured origin gets its preflight and its answer", async () => {
  const api = await freshApi({ webOrigins: WEB });
  try {
    const preflight = await fetch(`${api.base}/v1/buses`, {
      method: "OPTIONS",
      headers: {
        origin: WEB,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), WEB);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/);

    const res = await fetch(`${api.base}/v1/routes`, { headers: { origin: WEB } });
    assert.equal(res.headers.get("access-control-allow-origin"), WEB);
  } finally {
    await api.close();
  }
});

test("the stream carries the headers too, or EventSource never opens", async () => {
  const api = await freshApi({ webOrigins: WEB });
  try {
    const buses = await fetch(`${api.base}/v1/buses`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({ routeId: "jo-irbid-malka", dir: 0, remainingM: 8000, zoneSeq: 0 }),
    });
    const { streamTicket } = (await buses.json()) as { streamTicket: string };

    const controller = new AbortController();
    const stream = await fetch(`${api.base}/v1/stream/buses?ticket=${streamTicket}`, {
      headers: { origin: WEB, accept: "text/event-stream" },
      signal: controller.signal,
    });

    assert.equal(stream.headers.get("access-control-allow-origin"), WEB);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    controller.abort();
  } finally {
    await api.close();
  }
});

test("an unconfigured origin's preflight is refused outright", async () => {
  const api = await freshApi({ webOrigins: WEB });
  try {
    const res = await fetch(`${api.base}/v1/buses`, {
      method: "OPTIONS",
      headers: { origin: "https://elsewhere.example", "access-control-request-method": "POST" },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await api.close();
  }
});
