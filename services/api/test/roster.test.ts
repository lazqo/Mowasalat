import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Admin, AdminError, NotFound } from "../src/admin.ts";
import { Pack } from "../src/pack.ts";

const ROUTE = "jo-irbid-malka";
const PHONE = "+962790000001";

function withAdmin(fn: (admin: Admin) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  cpSync("countries/jo", dir, { recursive: true });
  try {
    fn(new Admin(new Pack(dir), "test-salt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a driver signs up with a phone and nothing else, and can drive at once", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    assert.equal(driver.tier, 0);
    assert.equal(driver.status, "active");
    assert.deepEqual(driver.routeIds, []);
  });
});

test("the phone number itself is never stored", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    const serialised = JSON.stringify(driver);
    assert.doesNotMatch(serialised, /790000001/, "the number does not appear anywhere");
    assert.equal(driver.phoneMasked, "••• 001");
    assert.match(driver.phoneHash, /^[0-9a-f]{64}$/);
  });
});

test("a driver can still be found by his number without it being stored", () => {
  withAdmin((admin) => {
    const created = admin.createDriver(PHONE);
    assert.equal(admin.findByPhone(PHONE)?.id, created.id);
    assert.equal(admin.findByPhone("+962790000999"), null);
  });
});

test("the same number cannot open two accounts", () => {
  withAdmin((admin) => {
    admin.createDriver(PHONE);
    assert.throws(() => admin.createDriver(PHONE), AdminError);
  });
});

test("different salts give different hashes for the same number", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  cpSync("countries/jo", dir, { recursive: true });
  try {
    const a = new Admin(new Pack(dir), "salt-a").createDriver(PHONE);
    const b = new Admin(new Pack(dir), "salt-b").createDriver(PHONE);
    assert.notEqual(a.phoneHash, b.phoneHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a salt is required rather than defaulted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  cpSync("countries/jo", dir, { recursive: true });
  try {
    assert.throws(() => new Admin(new Pack(dir), ""), /salt is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ops assigns a driver to the lines he runs", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    admin.assignRoute(driver.id, ROUTE);
    admin.assignRoute(driver.id, "jo-irbid-sama-alrousan");

    const routes = admin.routesForDriver(driver.id);
    assert.equal(routes.length, 2);
    assert.ok(routes.some((r) => r.nameAr === "إربد – ملكا"));
  });
});

test("assigning the same line twice does not duplicate it", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    admin.assignRoute(driver.id, ROUTE);
    admin.assignRoute(driver.id, ROUTE);
    assert.equal(admin.getDriver(driver.id).routeIds.length, 1);
  });
});

test("a driver cannot be assigned to a line that does not exist", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    assert.throws(() => admin.assignRoute(driver.id, "jo-invented"), NotFound);
  });
});

test("a line can be taken away again", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    admin.assignRoute(driver.id, ROUTE);
    admin.unassignRoute(driver.id, ROUTE);
    assert.deepEqual(admin.routesForDriver(driver.id), []);
  });
});

test("vouching lifts a driver to tier 1", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    const vouched = admin.vouch(driver.id, "drivers_committee");
    assert.equal(vouched.tier, 1);
    assert.equal(vouched.vouchedBy, "drivers_committee");
  });
});

test("only an authority the country pack allows may vouch", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    assert.throws(() => admin.vouch(driver.id, "some_guy"), AdminError);
    assert.equal(admin.getDriver(driver.id).tier, 0);
  });
});

test("tier 2 is earned by driving, against the country's thresholds", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    // Jordan's pack asks for 12 trips across 5 distinct days.
    admin.recordProvenTrips(driver.id, 11, 5);
    assert.equal(admin.getDriver(driver.id).tier, 0, "not yet");

    admin.recordProvenTrips(driver.id, 12, 4);
    assert.equal(admin.getDriver(driver.id).tier, 0, "trips alone are not enough");

    admin.recordProvenTrips(driver.id, 12, 5);
    assert.equal(admin.getDriver(driver.id).tier, 2);
  });
});

test("earning tier 2 does not demote a vouched driver", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    admin.vouch(driver.id, "field_ops");
    admin.recordProvenTrips(driver.id, 1, 1);
    assert.equal(admin.getDriver(driver.id).tier, 1);
  });
});

test("a blocked driver is offered no lines", () => {
  withAdmin((admin) => {
    const driver = admin.createDriver(PHONE);
    admin.assignRoute(driver.id, ROUTE);
    admin.setStatus(driver.id, "blocked");
    assert.deepEqual(admin.routesForDriver(driver.id), []);

    admin.setStatus(driver.id, "active");
    assert.equal(admin.routesForDriver(driver.id).length, 1);
  });
});
