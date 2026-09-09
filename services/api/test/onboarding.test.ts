/**
 * The four-screen sign-up, and the ops path beside it.
 *
 *   مرحبا → رقم الهاتف → رمز التحقق → شو الخط اللي بتشتغل عليه؟ → الباص
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers/db.ts";
import { AdminError } from "../src/admin.ts";

const PHONE = "0790123456";
const MALKA = "jo-irbid-malka";
const ROUSAN = "jo-irbid-sama-alrousan";

async function withDb(fn: (db: Awaited<ReturnType<typeof freshDb>>) => Promise<void>, opts = {}) {
  const db = await freshDb(opts);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

test("sign-up asks for nothing but a number and a code", async () => {
  await withDb(async (db) => {
    const { driverId } = await db.signIn(PHONE);
    const driver = await db.admin.getDriver(driverId);

    // Nothing else was required, and nothing else is held.
    assert.deepEqual(Object.keys(driver).sort(), [
      "createdAt",
      "id",
      "phoneHash",
      "phoneMasked",
      "provenDays",
      "provenTrips",
      "routeIds",
      "status",
      "tier",
      "vouchedBy",
    ]);
    assert.equal(driver.tier, 0);
    assert.deepEqual(driver.routeIds, [], "his lines come next");
  });
});

test("a driver picks the lines he works, and may hold more than one", async () => {
  await withDb(async (db) => {
    const { driverId } = await db.signIn(PHONE);
    await db.admin.assignRoute(driverId, MALKA);
    await db.admin.assignRoute(driverId, ROUSAN);

    const offered = await db.admin.routesForDriver(driverId);
    assert.deepEqual(offered.map((r) => r.nameAr).sort(), ["إربد – سما الروسان", "إربد – ملكا"].sort());
  });
});

test("vehicle details are the last step, and the plate is opt-in", async () => {
  await withDb(async (db) => {
    const { driverId } = await db.signIn(PHONE);
    const vehicle = await db.admin.addVehicle({
      driverId,
      type: "coaster",
      colour: "أبيض",
      plate: "12-3456",
      showPlate: false,
    });

    assert.equal(vehicle.type, "coaster");
    const stored = await db.admin.vehiclesFor(driverId);
    assert.equal(stored[0].showPlate, false, "not shown unless he chooses");
    assert.equal(stored[0].colour, "أبيض");
  });
});

test("a vehicle with no optional details at all is fine", async () => {
  await withDb(async (db) => {
    const { driverId } = await db.signIn(PHONE);
    const vehicle = await db.admin.addVehicle({
      driverId,
      type: "service",
      colour: null,
      plate: null,
      showPlate: false,
    });
    assert.equal(vehicle.type, "service");
  });
});

test("an ops invitation puts a driver straight onto the right lines, vouched", async () => {
  await withDb(async (db) => {
    // What the field team hands him at the complex.
    const invitation = await db.onboarding.createInvitation({
      routeIds: [MALKA, ROUSAN],
      authority: "field_ops",
      note: "onboarded at the new complex",
    });
    assert.match(invitation.code, /^[A-Z2-9]{8}$/, "short enough to read aloud");

    const { driverId } = await db.signIn(PHONE);
    const driver = await db.onboarding.redeemInvitation(driverId, invitation.code);

    assert.equal(driver.tier, 1, "vouched by the person who onboarded him");
    assert.equal(driver.vouchedBy, "field_ops");
    assert.deepEqual(driver.routeIds.sort(), [MALKA, ROUSAN].sort());
  });
});

test("an invitation is single use", async () => {
  await withDb(async (db) => {
    const invitation = await db.onboarding.createInvitation({
      routeIds: [MALKA],
      authority: "drivers_committee",
    });
    const first = await db.signIn(PHONE);
    await db.onboarding.redeemInvitation(first.driverId, invitation.code);

    const second = await db.signIn("0790123457");
    await assert.rejects(
      () => db.onboarding.redeemInvitation(second.driverId, invitation.code),
      AdminError,
    );
  });
});

test("an invitation expires", async () => {
  let now = 1_700_000_000_000;
  await withDb(
    async (db) => {
      const invitation = await db.onboarding.createInvitation({
        routeIds: [MALKA],
        authority: "field_ops",
        ttlHours: 1,
      });
      const { driverId } = await db.signIn(PHONE);

      now += 3_600_001;
      await assert.rejects(
        () => db.onboarding.redeemInvitation(driverId, invitation.code),
        AdminError,
      );
    },
    { now: () => now },
  );
});

test("an unrecognised invitation is refused", async () => {
  await withDb(async (db) => {
    const { driverId } = await db.signIn(PHONE);
    await assert.rejects(() => db.onboarding.redeemInvitation(driverId, "AAAAAAAA"), AdminError);
  });
});

test("an invitation cannot name a line that does not exist", async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => db.onboarding.createInvitation({ routeIds: ["jo-invented"], authority: "field_ops" }),
      /not found/,
    );
  });
});

test("the invitation code is not stored in a readable form", async () => {
  await withDb(async (db) => {
    const invitation = await db.onboarding.createInvitation({
      routeIds: [MALKA],
      authority: "field_ops",
    });
    const { rows } = await db.sql.query("select code_hmac from invitation");
    assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(invitation.code));
  });
});

test("everything a driver sets up survives a restart", async () => {
  await withDb(async (db) => {
    const { driverId, driverToken } = await db.signIn(PHONE);
    await db.admin.assignRoute(driverId, MALKA);
    await db.admin.addVehicle({
      driverId,
      type: "minibus",
      colour: "أزرق",
      plate: null,
      showPlate: false,
    });

    const afterRestart = db.restart();
    const driver = await afterRestart.getDriver(driverId);
    assert.deepEqual(driver.routeIds, [MALKA]);
    assert.equal((await afterRestart.vehiclesFor(driverId))[0].colour, "أزرق");

    // And he is still signed in: no re-verification after a deploy.
    assert.equal((await db.onboarding.authenticate(driverToken)).id, driverId);
  });
});
