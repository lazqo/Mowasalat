import test from "node:test";
import assert from "node:assert/strict";
import { coalesce, Hub, Tickets, TICKET_TTL_MS, topicFor } from "../src/stream.ts";

function fakeClock() {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("a subscriber is told when its line changes", () => {
  const hub = new Hub();
  let told = 0;
  hub.subscribe(topicFor("jo-irbid-malka", 0), () => told++);

  hub.publish(topicFor("jo-irbid-malka", 0));
  assert.equal(told, 1);
});

test("other lines and the other direction are not told", () => {
  const hub = new Hub();
  let told = 0;
  hub.subscribe(topicFor("jo-irbid-malka", 0), () => told++);

  hub.publish(topicFor("jo-irbid-malka", 1));
  hub.publish(topicFor("jo-irbid-umm-qais", 0));
  assert.equal(told, 0);
});

test("unsubscribing stops the notifications and frees the topic", () => {
  const hub = new Hub();
  const topic = topicFor("jo-irbid-malka", 0);
  let told = 0;
  const off = hub.subscribe(topic, () => told++);

  hub.publish(topic);
  off();
  hub.publish(topic);

  assert.equal(told, 1);
  assert.equal(hub.subscriberCount(topic), 0);
});

test("one failing subscriber does not stop the others being told", () => {
  const hub = new Hub();
  const topic = topicFor("jo-irbid-malka", 0);
  let reached = false;
  hub.subscribe(topic, () => {
    throw new Error("this subscriber is broken");
  });
  hub.subscribe(topic, () => (reached = true));

  hub.publish(topic);
  assert.equal(reached, true);
});

test("publishing to nobody is harmless", () => {
  assert.doesNotThrow(() => new Hub().publish("nobody:0"));
});

test("bursts of notifications collapse into one push", async () => {
  let pushes = 0;
  const trigger = coalesce(() => pushes++, 50);

  trigger(); // runs at once
  trigger();
  trigger();
  assert.equal(pushes, 1, "the burst did not push three times");

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pushes, 2, "the trailing notification was not lost");
  trigger.cancel();
});

test("a cancelled trigger does not fire afterwards", async () => {
  let pushes = 0;
  const trigger = coalesce(() => pushes++, 30);
  trigger();
  trigger();
  trigger.cancel();

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(pushes, 1, "only the immediate push ran");
});

test("a ticket is bound to one line and direction", () => {
  const tickets = new Tickets();
  const id = tickets.issue("jo-irbid-malka", 0);
  const redeemed = tickets.redeem(id);

  assert.equal(redeemed?.routeId, "jo-irbid-malka");
  assert.equal(redeemed?.dir, 0);
});

test("an unknown ticket is refused", () => {
  assert.equal(new Tickets().redeem("made-up"), null);
});

test("a ticket expires", () => {
  const clock = fakeClock();
  const tickets = new Tickets(clock.now);
  const id = tickets.issue("jo-irbid-malka", 0);

  clock.advance(TICKET_TTL_MS - 1);
  assert.ok(tickets.redeem(id));

  clock.advance(2);
  assert.equal(tickets.redeem(id), null);
});

test("expired tickets are pruned", () => {
  const clock = fakeClock();
  const tickets = new Tickets(clock.now);
  tickets.issue("jo-irbid-malka", 0);
  tickets.issue("jo-irbid-umm-qais", 1);
  assert.equal(tickets.size, 2);

  clock.advance(TICKET_TTL_MS + 1);
  tickets.prune();
  assert.equal(tickets.size, 0);
});
