/**
 * The security of the roster.
 *
 * Sign-up is a phone number and a six-digit code and nothing else, which makes
 * this the only door into a driver account.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, JO_RULES } from "./helpers/db.ts";
import { DevelopmentOtpProvider, ManualOtpProvider, selectProvider, SmsOtpProvider } from "../src/otp/provider.ts";
import { OtpError } from "../src/otp/service.ts";
import { InvalidPhone, normalizePhone } from "../src/phone.ts";
import { Unauthorized } from "../src/onboarding.ts";

const PHONE = "0790123456";

async function withDb(fn: (db: Awaited<ReturnType<typeof freshDb>>) => Promise<void>, opts = {}) {
  const db = await freshDb(opts);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

const codeFor = (db: Awaited<ReturnType<typeof freshDb>>, phone = PHONE) =>
  db.otp.peek(normalizePhone(phone, JO_RULES))!;

test("a correct code signs a new driver in and creates the account", async () => {
  await withDb(async (db) => {
    const challenge = await db.onboarding.requestCode(PHONE);
    assert.equal(challenge.channel, "development");
    assert.ok(challenge.expiresInSeconds > 0);

    const session = await db.onboarding.verify(challenge.challengeId, codeFor(db), PHONE);
    assert.equal(session.isNew, true);
    assert.equal(session.driver.tier, 0, "he can drive at once, unverified");
    assert.equal(session.driver.phoneMasked, "••• 456");
    assert.ok(session.driverToken.length >= 40);
  });
});

test("signing in again finds the same account, not a second one", async () => {
  let now = 1_700_000_000_000;
  await withDb(
    async (db) => {
      const first = await db.signIn(PHONE);
      now += 61_000; // past the resend gap, as a real second sign-in would be

      // The same number written the way a different person might type it.
      const second = await db.signIn("+962 79 012 3456");
      assert.equal(second.driverId, first.driverId);
      assert.notEqual(second.driverToken, first.driverToken, "but a fresh session");
      assert.equal((await db.admin.listDrivers()).length, 1);
    },
    { now: () => now },
  );
});

test("a wrong code is refused", async () => {
  await withDb(async (db) => {
    const challenge = await db.onboarding.requestCode(PHONE);
    await assert.rejects(
      () => db.onboarding.verify(challenge.challengeId, "000000", PHONE),
      (err: OtpError) => err.code === "invalid_code",
    );
  });
});

test("an expired code is refused", async () => {
  let now = 1_700_000_000_000;
  await withDb(
    async (db) => {
      const challenge = await db.onboarding.requestCode(PHONE);
      const code = codeFor(db);

      now += 301_000; // the code lives five minutes
      await assert.rejects(
        () => db.onboarding.verify(challenge.challengeId, code, PHONE),
        (err: OtpError) => err.code === "expired",
      );
    },
    { now: () => now },
  );
});

test("a code works once and never again", async () => {
  await withDb(async (db) => {
    const challenge = await db.onboarding.requestCode(PHONE);
    const code = codeFor(db);

    await db.onboarding.verify(challenge.challengeId, code, PHONE);
    await assert.rejects(
      () => db.onboarding.verify(challenge.challengeId, code, PHONE),
      (err: OtpError) => err.code === "already_used",
    );
  });
});

test("guessing is cut off after a few attempts", async () => {
  await withDb(async (db) => {
    const challenge = await db.onboarding.requestCode(PHONE);
    const real = codeFor(db);

    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        () => db.onboarding.verify(challenge.challengeId, "111111", PHONE),
        (err: OtpError) => err.code === "invalid_code",
      );
    }
    // The fifth wrong answer exhausts the challenge.
    await assert.rejects(
      () => db.onboarding.verify(challenge.challengeId, "111111", PHONE),
      (err: OtpError) => err.code === "too_many_attempts",
    );
    // And the real code no longer helps.
    await assert.rejects(
      () => db.onboarding.verify(challenge.challengeId, real, PHONE),
      (err: OtpError) => err.code === "too_many_attempts",
    );
  });
});

test("codes cannot be requested over and over for one number", async () => {
  let now = 1_700_000_000_000;
  await withDb(
    async (db) => {
      await db.onboarding.requestCode(PHONE);

      // Immediately again is refused, with how long to wait.
      await assert.rejects(
        () => db.onboarding.requestCode(PHONE),
        (err: OtpError) => err.code === "resend_too_soon" && (err.retryAfterSeconds ?? 0) > 0,
      );

      // Even spaced out, only so many within the window.
      for (let i = 1; i < 5; i++) {
        now += 61_000;
        await db.onboarding.requestCode(PHONE);
      }
      now += 61_000;
      await assert.rejects(
        () => db.onboarding.requestCode(PHONE),
        (err: OtpError) => err.code === "too_many_sends",
      );
    },
    { now: () => now },
  );
});

test("one caller cannot flood many numbers", async () => {
  let now = 1_700_000_000_000;
  await withDb(
    async (db) => {
      const ip = "one-caller";
      for (let i = 0; i < 20; i++) {
        await db.onboarding.requestCode(`079012${String(i).padStart(4, "0")}`, ip);
      }
      await assert.rejects(
        () => db.onboarding.requestCode("0799999999", ip),
        (err: OtpError) => err.code === "too_many_sends",
      );
      // A different caller is unaffected.
      now += 1;
      await db.onboarding.requestCode("0799999999", "another-caller");
    },
    { now: () => now },
  );
});

test("a challenge cannot be redeemed against a different number", async () => {
  await withDb(async (db) => {
    const challenge = await db.onboarding.requestCode(PHONE);
    const code = codeFor(db);
    await assert.rejects(
      () => db.onboarding.verify(challenge.challengeId, code, "0790000000"),
      (err: OtpError) => err.code === "invalid_code",
    );
  });
});

test("an unrecognised phone number is refused before any code is sent", async () => {
  await withDb(async (db) => {
    await assert.rejects(() => db.onboarding.requestCode("12345"), InvalidPhone);
    const { rows } = await db.sql.query("select count(*)::int n from otp_send_log");
    assert.equal((rows[0] as { n: number }).n, 0);
  });
});

test("neither the number nor the code is stored in a readable form", async () => {
  await withDb(async (db) => {
    const challenge = await db.onboarding.requestCode(PHONE);
    const code = codeFor(db);

    const { rows } = await db.sql.query(
      "select id, phone_hash, code_hmac, channel from otp_challenge where id = $1",
      [challenge.challengeId],
    );
    const stored = JSON.stringify(rows[0]);

    assert.doesNotMatch(stored, /790123456/, "the number is not in the row");
    assert.doesNotMatch(stored, new RegExp(code), "nor is the code");
    assert.match((rows[0] as { code_hmac: string }).code_hmac, /^[0-9a-f]{64}$/);
  });
});

test("a blocked driver cannot sign in", async () => {
  let now = 1_700_000_000_000;
  await withDb(
    async (db) => {
      const { driverId, driverToken } = await db.signIn(PHONE);
      await db.admin.setStatus(driverId, "blocked");

      // Neither with a fresh code,
      now += 61_000;
      await assert.rejects(() => db.signIn(PHONE), Unauthorized);
      // nor with the token he already held.
      await assert.rejects(() => db.onboarding.authenticate(driverToken), Unauthorized);
    },
    { now: () => now },
  );
});

test("a revoked token stops working", async () => {
  await withDb(async (db) => {
    const { driverToken } = await db.signIn(PHONE);
    assert.ok(await db.onboarding.authenticate(driverToken));

    await db.onboarding.signOut(driverToken);
    await assert.rejects(() => db.onboarding.authenticate(driverToken), Unauthorized);
  });
});

test("a made-up or missing token is refused", async () => {
  await withDb(async (db) => {
    await assert.rejects(() => db.onboarding.authenticate("nonsense"), Unauthorized);
    await assert.rejects(() => db.onboarding.authenticate(undefined), Unauthorized);
  });
});

// --- providers -------------------------------------------------------------

test("the development provider refuses to exist in production", () => {
  // A provider that hands out codes is an authentication bypass.
  assert.throws(() => new DevelopmentOtpProvider("production"), /never run in production/);
  assert.doesNotThrow(() => new DevelopmentOtpProvider("development"));
});

test("the SMS provider knows nothing about any particular vendor", async () => {
  const sent: { to: string; text: string }[] = [];
  const provider = new SmsOtpProvider(async (m) => void sent.push(m));

  await provider.send("+962790123456", "123456");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "+962790123456");
  assert.match(sent[0].text, /123456/);
  assert.match(sent[0].text, /رمز التحقق/);
});

test("the manual provider transmits nothing at all", async () => {
  // For a market where SMS cannot be relied on, delivery is a person.
  const provider = new ManualOtpProvider();
  await provider.send();
  assert.equal(provider.channel, "manual_vouch");
});

test("the country pack decides which channels are allowed", async () => {
  const sms = new SmsOtpProvider(async () => {});
  const manual = new ManualOtpProvider();

  assert.equal(selectProvider([sms, manual], ["sms", "manual_vouch"]).channel, "sms");
  assert.equal(selectProvider([sms, manual], ["manual_vouch"]).channel, "manual_vouch");
  assert.throws(() => selectProvider([sms], ["manual_vouch"]), /no configured OTP provider is permitted/);
});
