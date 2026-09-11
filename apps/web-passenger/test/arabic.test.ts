import { test } from "node:test";
import assert from "node:assert/strict";
import { foldArabic, matchesPlace } from "../src/arabic.ts";

/**
 * These are the cases packages/core/lib/src/arabic.dart is tested against.
 * Two clients that disagree about whether ملكة names ملكا is two clients
 * where the same person finds her village on one phone and not the other.
 */

test("folding removes the differences that are spelling", () => {
  assert.equal(foldArabic("مَلكا"), foldArabic("ملكا"));
  assert.equal(foldArabic("إربد"), foldArabic("اربد"));
  assert.equal(foldArabic("الملكا"), "ملكا");
  assert.equal(foldArabic("  ملكا  "), "ملكا");
  assert.equal(foldArabic("ملــكا"), "ملكا");
});

test("eastern arabic digits fold to western ones", () => {
  assert.equal(foldArabic("٠١٢٣٤٥٦٧٨٩"), "0123456789");
});

test("the definite article is optional, but only when a name survives it", () => {
  assert.equal(foldArabic("الا"), "الا", "too short to strip: that is the whole name");
  assert.equal(foldArabic("الحصن"), "حصن");
});

test("ملكة finds ملكا", () => {
  // Folding alone cannot do this: mapping ة to ا would be wrong Arabic. One
  // edit of tolerance is what catches the autocorrect.
  assert.ok(matchesPlace("ملكة", "ملكا"));
});

test("a partial name finds the place", () => {
  assert.ok(matchesPlace("ملك", "ملكا"));
  assert.ok(matchesPlace("حرث", "حرثا"));
});

test("an empty query finds nothing", () => {
  assert.ok(!matchesPlace("", "ملكا"));
  assert.ok(!matchesPlace("   ", "ملكا"));
});

test("the pilot villages do not match each other", () => {
  // The tolerance is only safe while real names stay far enough apart. If a
  // later line adds a name one edit from an existing one, this fails and the
  // rule needs revisiting rather than the test relaxing.
  const villages = ["ملكا", "حرثا", "سما الروسان", "الشجرة", "دير أبي سعيد", "إربد"];

  for (const a of villages) {
    for (const b of villages) {
      if (a === b) continue;
      assert.ok(!matchesPlace(a, b), `${a} should not match ${b}`);
    }
  }
});
