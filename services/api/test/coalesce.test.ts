import test from "node:test";
import assert from "node:assert/strict";
import { coalesce } from "../src/live/coalesce.ts";

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
