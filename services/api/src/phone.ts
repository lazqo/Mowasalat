/**
 * Turning what a person types into one canonical number.
 *
 * Drivers write their number the way they say it — 0790123456 — not in E.164.
 * They also paste it with spaces, dashes, a leading 00, or the Eastern Arabic
 * digits their keyboard produces. All of that has to arrive at the same hash, or
 * the same driver gets two accounts and loses his lines.
 *
 * The rules are per country, from the pack, because they differ: a Jordanian
 * mobile is 7XXXXXXXX after the prefix, a Syrian one is 9XXXXXXXX.
 */
export type PhoneRules = {
  /** E.164 country prefix, e.g. "+962". */
  prefix: string;
  /** The national significant number, without the trunk zero. */
  mobilePattern: RegExp;
};

export class InvalidPhone extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPhone";
  }
}

/** Eastern Arabic and Eastern Arabic-Indic digits, which Arabic keyboards produce. */
const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED = "۰۱۲۳۴۵۶۷۸۹";

export function toWesternDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (d) => {
    const eastern = EASTERN.indexOf(d);
    return String(eastern >= 0 ? eastern : EXTENDED.indexOf(d));
  });
}

export function rulesFor(config: { phone_prefix?: string; mobile_pattern?: string }): PhoneRules {
  if (!config.phone_prefix) throw new Error("the country pack has no phone_prefix");
  return {
    prefix: config.phone_prefix,
    // Permissive default: a national number of 8 to 12 digits. A country pack
    // should narrow it.
    mobilePattern: new RegExp(config.mobile_pattern ?? "^\\d{8,12}$"),
  };
}

/**
 * Returns the E.164 form, or throws. Accepts local, international and pasted
 * forms of the same number.
 */
export function normalizePhone(input: string, rules: PhoneRules): string {
  if (!input) throw new InvalidPhone("a phone number is required");

  const cleaned = toWesternDigits(input).replace(/[\s\-().]/g, "");
  const digitsOnly = cleaned.replace(/^\+/, "");
  if (!/^\d+$/.test(digitsOnly)) throw new InvalidPhone("a phone number may only contain digits");

  const country = rules.prefix.replace("+", "");
  let national: string;

  if (cleaned.startsWith("+")) {
    if (!digitsOnly.startsWith(country)) {
      throw new InvalidPhone(`this number is not a ${rules.prefix} number`);
    }
    national = digitsOnly.slice(country.length);
  } else if (digitsOnly.startsWith("00" + country)) {
    national = digitsOnly.slice(2 + country.length);
  } else if (digitsOnly.startsWith(country) && digitsOnly.length > country.length + 6) {
    national = digitsOnly.slice(country.length);
  } else {
    national = digitsOnly;
  }

  // The trunk zero people say out loud but E.164 does not carry.
  national = national.replace(/^0+/, "");

  if (!rules.mobilePattern.test(national)) {
    throw new InvalidPhone("that does not look like a mobile number");
  }
  return `${rules.prefix}${national}`;
}
