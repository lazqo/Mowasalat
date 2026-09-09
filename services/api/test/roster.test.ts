import test from "node:test";
import assert from "node:assert/strict";
import { Admin, AdminError, NotFound } from "../src/admin.ts";
import { freshDb, JO_POLICY, withDb } from "./helpers/db.ts";

const ROUTE = "jo-irbid-malka";
const PHONE = "+962790000001";

function withAdmin(fn: (admin: Admin) => Promise<void>): Promise<void> {
  return withDb((db) => fn(db.admin));
}

test("a driver signs up with a phone and nothing else, and can drive at once", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    assert.equal(driver.tier, 0);
    assert.equal(driver.status, "active");
    assert.deepEqual(driver.routeIds, []);
  });
});

test("the phone number itself is never stored", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    const serialised = JSON.stringify(driver);
    assert.doesNotMatch(serialised, /790000001/, "the number does not appear anywhere");
    assert.equal(driver.phoneMasked, "••• 001");
    assert.match(driver.phoneHash, /^[0-9a-f]{64}$/);
  });
});

test("a driver can still be found by his number without it being stored", async () => {
  await withAdmin(async (admin) => {
    const created = await admin.createDriver(PHONE);
    assert.equal((await admin.findByPhone(PHONE))?.id, created.id);
    assert.equal(await admin.findByPhone("+962790000999"), null);
  });
});

test("the same number cannot open two accounts", async () => {
  await withAdmin(async (admin) => {
    await admin.createDriver(PHONE);
    await assert.rejects(() => admin.createDriver(PHONE), AdminError);
  });
});

test("different salts give different hashes for the same number", async () => {
  const db = await freshDb();
  try {
    const a = new Admin(db.sql, "JO", "salt-a", JO_POLICY);
    const b = new Admin(db.sql, "JO", "salt-b", JO_POLICY);
    const first = await a.createDriver(PHONE);
    const second = await b.createDriver(PHONE);
    assert.notEqual(first.phoneHash, second.phoneHash);
  } finally {
    await db.close();
  }
});

test("a salt is required rather than defaulted", async () => {
  const db = await freshDb();
  try {
    assert.throws(() => new Admin(db.sql, "JO", "", JO_POLICY), /salt is required/);
  } finally {
    await db.close();
  }
});

test("ops assigns a driver to the lines he runs", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await admin.assignRoute(driver.id, ROUTE);
    await admin.assignRoute(driver.id, "jo-irbid-sama-alrousan");

    const routes = await admin.routesForDriver(driver.id);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r) => r.nameAr === "إربد – ملكا"));
  });
});

test("assigning the same line twice does not duplicate it", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await admin.assignRoute(driver.id, ROUTE);
    await admin.assignRoute(driver.id, ROUTE);
    assert.equal((await admin.getDriver(driver.id)).routeIds.length, 1);
  });
});

test("a driver cannot be assigned to a line that does not exist", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await assert.rejects(() => admin.assignRoute(driver.id, "jo-invented"), NotFound);
  });
});

test("a line can be taken away again", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await admin.assignRoute(driver.id, ROUTE);
    await admin.unassignRoute(driver.id, ROUTE);
    assert.deepEqual(await admin.routesForDriver(driver.id), []);
  });
});

test("vouching lifts a driver to tier 1", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    const vouched = await admin.vouch(driver.id, "drivers_committee");
    assert.equal(vouched.tier, 1);
    assert.equal(vouched.vouchedBy, "drivers_committee");
  });
});

test("only an authority the country pack allows may vouch", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await assert.rejects(() => admin.vouch(driver.id, "some_guy"), AdminError);
    assert.equal((await admin.getDriver(driver.id)).tier, 0);
  });
});

test("tier 2 is earned by driving, against the country's thresholds", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    // Jordan's pack asks for 12 trips across 5 distinct days.
    await admin.recordProvenTrips(driver.id, 11, 5);
    assert.equal((await admin.getDriver(driver.id)).tier, 0, "not yet");

    await admin.recordProvenTrips(driver.id, 12, 4);
    assert.equal((await admin.getDriver(driver.id)).tier, 0, "trips alone are not enough");

    await admin.recordProvenTrips(driver.id, 12, 5);
    assert.equal((await admin.getDriver(driver.id)).tier, 2);
  });
});

test("earning tier 2 does not demote a vouched driver", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await admin.vouch(driver.id, "field_ops");
    await admin.recordProvenTrips(driver.id, 1, 1);
    assert.equal((await admin.getDriver(driver.id)).tier, 1);
  });
});

test("a blocked driver is offered no lines", async () => {
  await withAdmin(async (admin) => {
    const driver = await admin.createDriver(PHONE);
    await admin.assignRoute(driver.id, ROUTE);
    await admin.setStatus(driver.id, "blocked");
    assert.deepEqual(await admin.routesForDriver(driver.id), []);

    await admin.setStatus(driver.id, "active");
    assert.equal((await admin.routesForDriver(driver.id)).length, 1);
  });
});
