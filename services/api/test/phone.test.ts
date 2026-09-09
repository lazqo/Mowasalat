import test from "node:test";
import assert from "node:assert/strict";
import { InvalidPhone, normalizePhone, rulesFor, toWesternDigits } from "../src/phone.ts";

const JO = rulesFor({ phone_prefix: "+962", mobile_pattern: "^7\\d{8}$" });
const SY = rulesFor({ phone_prefix: "+963", mobile_pattern: "^9\\d{8}$" });

test("every way a Jordanian driver might write his number reaches one form", () => {
  // If these diverged he would end up with two accounts and lose his lines.
  for (const written of [
    "0790123456",
    "790123456",
    "+962790123456",
    "00962790123456",
    "+962 79 012 3456",
    "079-012-3456",
    "(079) 012 3456",
    "962790123456",
  ]) {
    assert.equal(normalizePhone(written, JO), "+962790123456", `failed on ${written}`);
  }
});

test("Eastern Arabic digits are accepted, because that is what the keyboard gives", () => {
  assert.equal(toWesternDigits("٠٧٩٠١٢٣٤٥٦"), "0790123456");
  assert.equal(normalizePhone("٠٧٩٠١٢٣٤٥٦", JO), "+962790123456");
  assert.equal(normalizePhone("۰۷۹۰۱۲۳۴۵۶", JO), "+962790123456");
});

test("normalizing is idempotent", () => {
  const once = normalizePhone("0790123456", JO);
  assert.equal(normalizePhone(once, JO), once);
});

test("Syrian numbers follow their own rule, from the country pack", () => {
  assert.equal(normalizePhone("0912345678", SY), "+963912345678");
  assert.equal(normalizePhone("+963912345678", SY), "+963912345678");
  // A Jordanian mobile is not a Syrian one.
  assert.throws(() => normalizePhone("+962790123456", SY), InvalidPhone);
});

test("a landline or a malformed number is refused", () => {
  assert.throws(() => normalizePhone("022345678", JO), InvalidPhone, "Jordanian landline");
  assert.throws(() => normalizePhone("79012345", JO), InvalidPhone, "too short");
  assert.throws(() => normalizePhone("7901234567", JO), InvalidPhone, "too long");
  assert.throws(() => normalizePhone("", JO), InvalidPhone);
  assert.throws(() => normalizePhone("not a number", JO), InvalidPhone);
});

test("a number from another country is refused rather than mangled", () => {
  assert.throws(() => normalizePhone("+447700900000", JO), InvalidPhone);
});

test("a country pack without a prefix is a configuration error", () => {
  assert.throws(() => rulesFor({}), /phone_prefix/);
});
