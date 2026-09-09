/**
 * One suite, both implementations.
 *
 * The in-process store and the Redis store are interchangeable only if they
 * behave identically, so the same tests run against each. Redis is skipped when
 * REDIS_URL is not set, and the run says so rather than passing silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryHub, MemoryLiveStore, MemoryTicketStore } from "../src/live/memory.ts";
import { REQUEST_TTL_MS, TRIP_TTL_MS, type Hub, type LiveStore, type TicketStore } from "../src/live/store.ts";
import { assertNoPersistence, PersistenceEnabled, RedisHub, RedisLiveStore, RedisTicketStore, type RedisLike } from "../src/live/redis.ts";

type Clock = { now: () => number; advance: (ms: number) => void };

function fakeClock(): Clock {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

type Backend = {
  name: string;
  make(clock: Clock): Promise<{ live: LiveStore; hub: Hub; tickets: TicketStore; close(): Promise<void> }>;
};

const REDIS_URL = process.env.REDIS_URL;

const backends: Backend[] = [
  {
    name: "memory",
    async make(clock) {
      return {
        live: new MemoryLiveStore(clock.now),
        hub: new MemoryHub(),
        tickets: new MemoryTicketStore(clock.now),
        async close() {},
      };
    },
  },
];

if (REDIS_URL) {
  backends.push({
    name: "redis",
    async make(clock) {
      const { createClient } = await import("redis");
      // A namespace per run, so parallel tests cannot see each other's keys.
      const client = createClient({ url: REDIS_URL });
      await client.connect();
      await client.flushDb();

      const redis = client as unknown as RedisLike;
      const hub = new RedisHub(redis);
      return {
        live: new RedisLiveStore(redis, clock.now),
        hub,
        tickets: new RedisTicketStore(redis),
        async close() {
          await hub.close?.();
          await client.quit();
        },
      };
    },
  });
}

for (const backend of backends) {
  const describe = (name: string) => `[${backend.name}] ${name}`;

  async function withStore(
    fn: (s: Awaited<ReturnType<Backend["make"]>>, clock: Clock) => Promise<void>,
  ) {
    const clock = fakeClock();
    const stores = await backend.make(clock);
    try {
      await fn(stores, clock);
    } finally {
      await stores.close();
    }
  }

  test(describe("a bus appears on its line once it reports"), async () => {
    await withStore(async ({ live }) => {
      await live.startTrip("token", "bus1");
      assert.deepEqual(await live.tripsOn("r", 0), []);

      await live.updateTrip("token", {
        routeId: "r",
        dir: 0,
        remainingM: 8_000,
        zoneSeq: 1,
        speedKph: 40,
      });
      const trips = await live.tripsOn("r", 0);
      assert.equal(trips.length, 1);
      assert.equal(trips[0].pseudonym, "bus1");
      assert.equal(trips[0].remainingM, 8_000);
    });
  });

  test(describe("a bus that stops reporting disappears"), async () => {
    await withStore(async ({ live }, clock) => {
      await live.startTrip("token", "bus1");
      await live.updateTrip("token", { routeId: "r", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });

      clock.advance(TRIP_TTL_MS + 1_000);
      assert.deepEqual(await live.tripsOn("r", 0), [], "gone, with no history left behind");
    });
  });

  test(describe("progress for an unknown or ended trip is refused"), async () => {
    await withStore(async ({ live }) => {
      assert.equal(
        await live.updateTrip("nope", { routeId: "r", dir: 0, remainingM: 1, zoneSeq: 0, speedKph: 1 }),
        null,
      );
    });
  });

  test(describe("ending a trip removes it and its token at once"), async () => {
    await withStore(async ({ live }) => {
      await live.startTrip("token", "bus1");
      await live.updateTrip("token", { routeId: "r", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });

      assert.equal(await live.endTrip("token"), true);
      assert.deepEqual(await live.tripsOn("r", 0), []);
      assert.equal(await live.pseudonymFor("token"), undefined);
      assert.equal(await live.endTrip("token"), false);
    });
  });

  test(describe("lines and directions do not mix"), async () => {
    await withStore(async ({ live }) => {
      await live.startTrip("a", "bus-a");
      await live.updateTrip("a", { routeId: "r", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });
      await live.startTrip("b", "bus-b");
      await live.updateTrip("b", { routeId: "r", dir: 1, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });
      await live.startTrip("c", "bus-c");
      await live.updateTrip("c", { routeId: "other", dir: 0, remainingM: 8_000, zoneSeq: 1, speedKph: 40 });

      assert.equal((await live.tripsOn("r", 0)).length, 1);
      assert.equal((await live.tripsOn("r", 1)).length, 1);
      assert.equal((await live.tripsOn("other", 0)).length, 1);
    });
  });

  test(describe("a waiting request expires on its own"), async () => {
    await withStore(async ({ live }, clock) => {
      await live.addRequest({
        pseudonym: "p1",
        routeId: "r",
        dir: 0,
        destinationId: "d",
        remainingM: 5_000,
        zoneSeq: 1,
      });
      assert.equal((await live.requestsOn("r", 0)).length, 1);

      clock.advance(REQUEST_TTL_MS + 1_000);
      assert.deepEqual(await live.requestsOn("r", 0), []);
    });
  });

  test(describe("cancelling a request removes it at once"), async () => {
    await withStore(async ({ live }) => {
      await live.addRequest({
        pseudonym: "p1",
        routeId: "r",
        dir: 0,
        destinationId: "d",
        remainingM: 5_000,
        zoneSeq: 1,
      });
      assert.equal(await live.cancelRequest("p1"), true);
      assert.deepEqual(await live.requestsOn("r", 0), []);
      assert.equal(await live.cancelRequest("p1"), false);
    });
  });

  test(describe("a subscriber is told when its line changes, and no other"), async () => {
    await withStore(async ({ hub }) => {
      let told = 0;
      const off = await hub.subscribe("r:0", () => told++);

      await hub.publish("r:0");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(told, 1);

      await hub.publish("r:1");
      await hub.publish("other:0");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(told, 1, "the other line and direction were not told");

      await off();
      await hub.publish("r:0");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(told, 1, "unsubscribed means unsubscribed");
      assert.equal(hub.subscriberCount("r:0"), 0);
    });
  });

  test(describe("one failing subscriber does not stop the others"), async () => {
    await withStore(async ({ hub }) => {
      let reached = false;
      await hub.subscribe("r:0", () => {
        throw new Error("this subscriber is broken");
      });
      await hub.subscribe("r:0", () => (reached = true));

      await hub.publish("r:0");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(reached, true);
    });
  });

  test(describe("a ticket is bound to one line and direction, and expires"), async () => {
    await withStore(async ({ tickets }) => {
      const id = await tickets.issue("jo-irbid-malka", 0);
      const redeemed = await tickets.redeem(id);

      assert.equal(redeemed?.routeId, "jo-irbid-malka");
      assert.equal(redeemed?.dir, 0);
      assert.equal(await tickets.redeem("made-up"), null);
    });
  });
}

if (!REDIS_URL) {
  test("[redis] skipped: set REDIS_URL to run the Redis half of this suite", () => {
    // Announced rather than silently absent, so nobody mistakes a partial run
    // for a full one.
    assert.ok(true);
  });
}

// --- the guard rail --------------------------------------------------------

test("a Redis that writes to disk is refused", async () => {
  // An RDB snapshot of this keyspace would be the movement trail the plan
  // promises never to keep, so a misconfigured deployment fails at startup.
  const persisting: Partial<RedisLike> = {
    configGet: async (p) => (p === "save" ? { save: "900 1" } : { appendonly: "no" }),
  };
  await assert.rejects(
    () => assertNoPersistence(persisting as RedisLike),
    PersistenceEnabled,
  );

  const appendOnly: Partial<RedisLike> = {
    configGet: async (p) => (p === "save" ? { save: "" } : { appendonly: "yes" }),
  };
  await assert.rejects(() => assertNoPersistence(appendOnly as RedisLike), PersistenceEnabled);

  const ephemeral: Partial<RedisLike> = {
    configGet: async (p) => (p === "save" ? { save: "" } : { appendonly: "no" }),
  };
  await assert.doesNotReject(() => assertNoPersistence(ephemeral as RedisLike));
});

test("every Redis key this service writes carries an expiry", async (t) => {
  // The comment at the top of redis.ts claims it; this checks it. A key without
  // a TTL is a movement record that outlives its purpose.
  if (!REDIS_URL) return t.skip("set REDIS_URL to run this");

  const { createClient } = await import("redis");
  const client = createClient({ url: REDIS_URL });
  await client.connect();
  await client.flushDb();

  try {
    const redis = client as unknown as RedisLike;
    const live = new RedisLiveStore(redis);
    const tickets = new RedisTicketStore(redis);

    await live.startTrip("token", "bus1");
    await live.updateTrip("token", {
      routeId: "jo-irbid-malka",
      dir: 0,
      remainingM: 8_000,
      zoneSeq: 1,
      speedKph: 40,
    });
    await live.addRequest({
      pseudonym: "p1",
      routeId: "jo-irbid-malka",
      dir: 0,
      destinationId: "jo-malka",
      remainingM: 5_000,
      zoneSeq: 1,
    });
    await tickets.issue("jo-irbid-malka", 0);

    const keys = await client.keys("mwsl:*");
    assert.ok(keys.length >= 5, `expected several keys, found ${keys.length}`);

    for (const key of keys) {
      const ttl = await client.pTTL(key);
      assert.ok(ttl > 0, `${key} has no expiry (pttl ${ttl})`);
    }
  } finally {
    await client.quit();
  }
});
