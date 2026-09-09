import test from "node:test";
import assert from "node:assert/strict";
import { freshApi } from "./helpers/db.ts";

const ROUTE = "jo-irbid-malka";
const OTHER = "jo-irbid-umm-qais";

async function withApi(
  fn: (base: string, api: Awaited<ReturnType<typeof freshApi>>) => Promise<void>,
): Promise<void> {
  // A short push interval keeps the tests quick without changing the behaviour.
  const api = await freshApi({ streamIntervalMs: 20, heartbeatMs: 50 });
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

/** Starts a bus on a line, as a signed-in driver assigned to it. */
async function runBus(
  base: string,
  api: Awaited<ReturnType<typeof freshApi>>,
  routeId: string,
  remainingM: number,
  phone = "0790123456",
) {
  const { driverToken } = await api.driverOn(routeId, phone);
  const started = await (await post(base, "/v1/trips", { routeId, dir: 0 }, driverToken)).json();
  const move = (m: number) =>
    post(
      base,
      "/v1/trips/progress",
      { tripToken: started.tripToken, routeId, dir: 0, remainingM: m, zoneSeq: 2, speedKph: 40 },
      driverToken,
    );
  await move(remainingM);
  return { ...started, driverToken, move };
}

const ticketFor = async (base: string, routeId = ROUTE, remainingM = 5_000) =>
  (
    await (await post(base, "/v1/buses", { routeId, dir: 0, remainingM, zoneSeq: 1 })).json()
  ).streamTicket as string;

/** Reads SSE `data:` payloads off a live response until `want` have arrived. */
async function readEvents(res: Response, want: number, timeoutMs = 3_000): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (events.length < want && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

test("a stream needs a ticket, and asking which buses run issues one", async () => {
  await withApi(async (base) => {
    // The binding that stops the whole network being enumerated by a script.
    const refused = await fetch(`${base}/v1/stream/buses?ticket=made-up`);
    assert.equal(refused.status, 401);
    await refused.body?.cancel();

    const ticket = await ticketFor(base);
    assert.ok(ticket);

    const stream = await fetch(`${base}/v1/stream/buses?ticket=${ticket}`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    await stream.body?.cancel();
  });
});

test("a subscriber gets the current picture at once, then updates as the bus moves", async () => {
  await withApi(async (base, api) => {
    const bus = await runBus(base, api, ROUTE, 9_000);
    const ticket = await ticketFor(base);

    const stream = await fetch(`${base}/v1/stream/buses?ticket=${ticket}`);
    const events = readEvents(stream, 2);

    await new Promise((r) => setTimeout(r, 60));
    await bus.move(7_000);

    const received = (await events) as { buses: { remainingM: number }[] }[];
    assert.ok(received.length >= 2, `expected two snapshots, got ${received.length}`);
    assert.equal(received[0].buses[0].remainingM, 9_000, "the picture on connecting");
    assert.equal(received[received.length - 1].buses[0].remainingM, 7_000, "then the bus moved");
  });
});

test("a stream carries no coordinate and no driver identity", async () => {
  await withApi(async (base, api) => {
    await runBus(base, api, ROUTE, 9_000);
    const stream = await fetch(`${base}/v1/stream/buses?ticket=${await ticketFor(base)}`);
    const [first] = (await readEvents(stream, 1)) as Record<string, unknown>[];
    const text = JSON.stringify(first);

    assert.doesNotMatch(text, /lat|lng|latitude|longitude/i);
    assert.doesNotMatch(text, /3[0-9]\.\d{4}/);
    assert.doesNotMatch(text, /drv-/);
    assert.doesNotMatch(text, /\+962/, "and no phone number");
  });
});

test("a ticket for one line does not stream another", async () => {
  await withApi(async (base, api) => {
    const ticket = await ticketFor(base);
    // A bus on a different line must not appear on this ticket's stream.
    await runBus(base, api, OTHER, 4_000, "0790123499");

    const stream = await fetch(`${base}/v1/stream/buses?ticket=${ticket}`);
    const [snapshot] = (await readEvents(stream, 1)) as { buses: unknown[] }[];
    assert.deepEqual(snapshot.buses, []);
  });
});

test("a driver's stream is bound to his own trip", async () => {
  await withApi(async (base, api) => {
    const refused = await fetch(`${base}/v1/stream/waiting?tripToken=made-up`);
    assert.equal(refused.status, 401);
    await refused.body?.cancel();

    const bus = await runBus(base, api, ROUTE, 10_000);
    const stream = await fetch(`${base}/v1/stream/waiting?tripToken=${bus.tripToken}`);
    const events = readEvents(stream, 2);

    await new Promise((r) => setTimeout(r, 60));
    await post(base, "/v1/requests", {
      routeId: ROUTE,
      dir: 0,
      destinationId: "jo-malka",
      remainingM: 6_000,
      zoneSeq: 1,
    });

    const received = (await events) as { pins: { count: number; remainingM: number }[] }[];
    assert.deepEqual(received[0].pins, [], "nobody waiting yet");

    const last = received[received.length - 1];
    assert.equal(last.pins.length, 1);
    assert.equal(last.pins[0].count, 1);
    assert.equal(last.pins[0].remainingM, 6_000);
  });
});

test("a burst of movement does not become a burst of pushes", async () => {
  await withApi(async (base, api) => {
    const bus = await runBus(base, api, ROUTE, 9_000);
    const stream = await fetch(`${base}/v1/stream/buses?ticket=${await ticketFor(base, ROUTE, 1_000)}`);
    const collected = readEvents(stream, 20, 400);

    // Ten updates inside one coalescing window.
    for (let i = 0; i < 10; i++) await bus.move(9_000 - i * 250);

    const received = await collected;
    assert.ok(received.length < 10, `pushed ${received.length} times for ten updates`);
  });
});

test("subscribers are released when they disconnect", async () => {
  await withApi(async (base, api) => {
    const ticket = await ticketFor(base);

    // Aborting the request is how a phone leaving the app actually disconnects.
    const controller = new AbortController();
    const stream = await fetch(`${base}/v1/stream/buses?ticket=${ticket}`, {
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    await reader.read();
    assert.equal(api.api.service.hub.subscriberCount(), 1);

    controller.abort();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(api.api.service.hub.subscriberCount(), 0, "the subscription was not leaked");
  });
});

test("many subscribers on one line are all served and all released", async () => {
  await withApi(async (base, api) => {
    const ticket = await ticketFor(base);
    const controllers = Array.from({ length: 5 }, () => new AbortController());

    for (const c of controllers) {
      const res = await fetch(`${base}/v1/stream/buses?ticket=${ticket}`, { signal: c.signal });
      await res.body!.getReader().read();
    }
    assert.equal(api.api.service.hub.subscriberCount(), 5);

    for (const c of controllers) c.abort();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(api.api.service.hub.subscriberCount(), 0);
  });
});

test("push still works once a persistent roster is loaded", async () => {
  // The restart case end to end: the API comes back with the roster read from
  // the database, and a driver on one of his assigned lines still streams.
  await withApi(async (base, api) => {
    const { driverId, driverToken } = await api.driverOn(ROUTE, "0790000042");

    // A fresh Admin over the same database is what a restart leaves.
    const afterRestart = api.restart();
    const lines = await afterRestart.routesForDriver(driverId);
    assert.equal(lines.length, 1);

    // He picks exactly one of his lines and one direction.
    const started = await (
      await post(base, "/v1/trips", { routeId: lines[0].id, dir: 0 }, driverToken)
    ).json();
    await post(
      base,
      "/v1/trips/progress",
      { tripToken: started.tripToken, routeId: lines[0].id, dir: 0, remainingM: 9_000, zoneSeq: 1, speedKph: 40 },
      driverToken,
    );

    const stream = await fetch(`${base}/v1/stream/buses?ticket=${await ticketFor(base, lines[0].id)}`);
    const [snapshot] = (await readEvents(stream, 1)) as { buses: { remainingM: number }[] }[];

    assert.equal(snapshot.buses.length, 1);
    assert.equal(snapshot.buses[0].remainingM, 9_000);
    assert.doesNotMatch(JSON.stringify(snapshot), /drv-/, "no driver identity on the stream");
  });
});
