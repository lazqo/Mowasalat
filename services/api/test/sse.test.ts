import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/http.ts";
import type { CountryPolicy } from "../src/service.ts";

const JO: CountryPolicy = { code: "JO", remainingBucketM: 250, kAnonymityMin: 4 };
const ROUTE = "jo-irbid-malka";

async function withApi(
  fn: (base: string, api: ReturnType<typeof createApi>) => Promise<void>,
): Promise<void> {
  // A short push interval keeps the tests quick without changing the behaviour.
  const api = createApi(JO, { streamIntervalMs: 20, heartbeatMs: 50 });
  await new Promise<void>((r) => api.server.listen(0, r));
  const port = (api.server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, api);
  } finally {
    await new Promise((r) => api.server.close(r));
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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
    const refused = await fetch(`${base}/stream/buses?ticket=made-up`);
    assert.equal(refused.status, 401);
    await refused.body?.cancel();

    const lookup = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();
    assert.ok(lookup.streamTicket, "the lookup handed back a ticket");

    const stream = await fetch(`${base}/stream/buses?ticket=${lookup.streamTicket}`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    await stream.body?.cancel();
  });
});

test("a subscriber gets the current picture at once, then updates as the bus moves", async () => {
  await withApi(async (base) => {
    const started = await (await post(base, "/trips", { routeId: ROUTE, dir: 0 })).json();
    await post(base, "/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 9_000,
      zoneSeq: 2,
      speedKph: 40,
    });

    const { streamTicket } = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();

    const stream = await fetch(`${base}/stream/buses?ticket=${streamTicket}`);
    const events = readEvents(stream, 2);

    // Let the first snapshot land, then move the bus.
    await new Promise((r) => setTimeout(r, 60));
    await post(base, "/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 7_000,
      zoneSeq: 2,
      speedKph: 40,
    });

    const received = (await events) as { buses: { remainingM: number }[] }[];
    assert.ok(received.length >= 2, `expected two snapshots, got ${received.length}`);
    assert.equal(received[0].buses[0].remainingM, 9_000, "the picture on connecting");
    assert.equal(received[received.length - 1].buses[0].remainingM, 7_000, "then the bus moved");
  });
});

test("a stream carries no coordinate and no driver identity", async () => {
  await withApi(async (base) => {
    const started = await (await post(base, "/trips", { routeId: ROUTE, dir: 0 })).json();
    await post(base, "/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 9_000,
      zoneSeq: 2,
      speedKph: 40,
    });

    const { streamTicket } = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();

    const stream = await fetch(`${base}/stream/buses?ticket=${streamTicket}`);
    const [first] = (await readEvents(stream, 1)) as Record<string, unknown>[];
    const text = JSON.stringify(first);

    assert.doesNotMatch(text, /lat|lng|latitude|longitude/i);
    assert.doesNotMatch(text, /3[0-9]\.\d{4}/);
    assert.doesNotMatch(text, /drv-/);
  });
});

test("a ticket for one line does not stream another", async () => {
  await withApi(async (base) => {
    const { streamTicket } = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();

    // A bus on a different line must not appear on this ticket's stream.
    const other = await (await post(base, "/trips", { routeId: "jo-irbid-umm-qais", dir: 0 })).json();
    await post(base, "/trips/progress", {
      tripToken: other.tripToken,
      routeId: "jo-irbid-umm-qais",
      dir: 0,
      remainingM: 4_000,
      zoneSeq: 1,
      speedKph: 40,
    });

    const stream = await fetch(`${base}/stream/buses?ticket=${streamTicket}`);
    const [snapshot] = (await readEvents(stream, 1)) as { buses: unknown[] }[];
    assert.deepEqual(snapshot.buses, []);
  });
});

test("a driver's stream is bound to his own trip", async () => {
  await withApi(async (base) => {
    const refused = await fetch(`${base}/stream/waiting?tripToken=made-up`);
    assert.equal(refused.status, 401);
    await refused.body?.cancel();

    const started = await (await post(base, "/trips", { routeId: ROUTE, dir: 0 })).json();
    await post(base, "/trips/progress", {
      tripToken: started.tripToken,
      routeId: ROUTE,
      dir: 0,
      remainingM: 10_000,
      zoneSeq: 2,
      speedKph: 40,
    });

    const stream = await fetch(`${base}/stream/waiting?tripToken=${started.tripToken}`);
    const events = readEvents(stream, 2);

    await new Promise((r) => setTimeout(r, 60));
    await post(base, "/requests", {
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
  await withApi(async (base) => {
    const started = await (await post(base, "/trips", { routeId: ROUTE, dir: 0 })).json();
    const { streamTicket } = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 1_000,
      zoneSeq: 1,
    })).json();

    const stream = await fetch(`${base}/stream/buses?ticket=${streamTicket}`);
    const collected = readEvents(stream, 20, 400);

    // Ten updates inside one coalescing window.
    for (let i = 0; i < 10; i++) {
      await post(base, "/trips/progress", {
        tripToken: started.tripToken,
        routeId: ROUTE,
        dir: 0,
        remainingM: 9_000 - i * 250,
        zoneSeq: 2,
        speedKph: 40,
      });
    }

    const received = await collected;
    assert.ok(received.length < 10, `pushed ${received.length} times for ten updates`);
  });
});

test("subscribers are released when they disconnect", async () => {
  await withApi(async (base, api) => {
    const { streamTicket } = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();

    // Aborting the request is how a phone leaving the app actually disconnects.
    const controller = new AbortController();
    const stream = await fetch(`${base}/stream/buses?ticket=${streamTicket}`, {
      signal: controller.signal,
    });

    const reader = stream.body!.getReader();
    await reader.read(); // the first snapshot has landed, so we are subscribed
    assert.equal(api.service.hub.subscriberCount(), 1);

    controller.abort();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(api.service.hub.subscriberCount(), 0, "the subscription was not leaked");
  });
});

test("many subscribers on one line are all served and all released", async () => {
  await withApi(async (base, api) => {
    const { streamTicket } = await (await post(base, "/buses", {
      routeId: ROUTE,
      dir: 0,
      remainingM: 5_000,
      zoneSeq: 1,
    })).json();

    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const readers = await Promise.all(
      controllers.map(async (c) => {
        const res = await fetch(`${base}/stream/buses?ticket=${streamTicket}`, { signal: c.signal });
        const reader = res.body!.getReader();
        await reader.read();
        return reader;
      }),
    );

    assert.equal(readers.length, 5);
    assert.equal(api.service.hub.subscriberCount(), 5);

    for (const c of controllers) c.abort();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(api.service.hub.subscriberCount(), 0);
  });
});
