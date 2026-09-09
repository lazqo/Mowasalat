/**
 * Driver sign-up, start to finish.
 *
 * The whole flow is four screens and no paperwork (docs/PLAN.md §5.1):
 *
 *   مرحبا → رقم الهاتف → رمز التحقق → شو الخط اللي بتشتغل عليه؟ → الباص → done
 *
 * No identity document, no licence photo, no permit, no email, no password, no
 * profile picture. A phone number and a code, then which lines he runs.
 *
 * The number itself is never stored and never leaves this layer: the roster
 * holds an HMAC and a masked tail, and the realtime layer is handed neither the
 * number nor the driver id — a trip carries its own short-lived token instead
 * (§6.4).
 */
import { createHmac, randomBytes } from "node:crypto";
import { Admin, AdminError, hashPhone, NotFound } from "./admin.ts";
import type { DriverRecord } from "./db/roster.ts";
import type { Sql } from "./db/sql.ts";
import { normalizePhone, type PhoneRules } from "./phone.ts";
import type { OtpProvider } from "./otp/provider.ts";
import { OtpError, OtpService, type OtpLimits } from "./otp/service.ts";

export type Session = { driverToken: string; driver: DriverRecord; isNew: boolean };

export class Unauthorized extends Error {
  constructor(message = "not signed in") {
    super(message);
    this.name = "Unauthorized";
  }
}

export class Onboarding {
  private sql: Sql;
  private admin: Admin;
  private otp: OtpService;
  private provider: OtpProvider;
  private secret: string;
  private rules: PhoneRules;
  private countryCode: string;
  private now: () => number;

  constructor(opts: {
    sql: Sql;
    admin: Admin;
    provider: OtpProvider;
    secret: string;
    rules: PhoneRules;
    countryCode: string;
    limits?: OtpLimits;
    now?: () => number;
  }) {
    if (!opts.secret) throw new Error("a server secret is required");
    this.sql = opts.sql;
    this.admin = opts.admin;
    this.secret = opts.secret;
    this.rules = opts.rules;
    this.countryCode = opts.countryCode;
    this.now = opts.now ?? (() => Date.now());
    this.provider = opts.provider;
    this.otp = new OtpService(opts.sql, opts.provider, opts.secret, opts.limits, this.now);
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }

  /** Screen two: رقم الهاتف → send code. */
  async requestCode(phoneInput: string, ipHash?: string) {
    const phone = normalizePhone(phoneInput, this.rules);
    const challenge = await this.otp.request(phone, ipHash);

    // Only the development provider can do this, and it refuses to be
    // constructed in production, so an app developer can complete the flow
    // locally without an SMS bill and no deployed environment can leak a code.
    const peek = (this.provider as { peek?: (p: string) => string | undefined }).peek;
    const devCode = peek ? peek.call(this.provider, phone) : undefined;

    return devCode ? { ...challenge, devCode } : challenge;
  }

  /**
   * Screen three: أدخل رمز التحقق. A first correct code creates the account, so
   * there is no separate sign-up step for the driver to fail at.
   */
  async verify(challengeId: string, code: string, phoneInput: string): Promise<Session> {
    const phone = normalizePhone(phoneInput, this.rules);
    await this.otp.verify(challengeId, code, phone);

    let driver = await this.admin.findByPhone(phone);
    let isNew = false;
    if (!driver) {
      driver = await this.admin.createDriver(phone);
      isNew = true;
    }
    if (driver.status === "blocked") throw new Unauthorized("this account is blocked");

    return { driverToken: await this.issueToken(driver.id), driver, isNew };
  }

  private async issueToken(driverId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.sql.query(
      `insert into driver_token (token_hmac, driver_id, created_at) values ($1, $2, $3)`,
      [this.hmac(token), driverId, new Date(this.now()).toISOString()],
    );
    return token;
  }

  /** Resolves the bearer token a driver's app holds. Never returns his number. */
  async authenticate(token: string | undefined): Promise<DriverRecord> {
    if (!token) throw new Unauthorized();
    const { rows } = await this.sql.query<{ driver_id: string }>(
      `update driver_token set last_seen_at = $2
        where token_hmac = $1 and revoked_at is null
        returning driver_id`,
      [this.hmac(token), new Date(this.now()).toISOString()],
    );
    if (!rows[0]) throw new Unauthorized();

    const driver = await this.admin.getDriver(rows[0].driver_id).catch(() => null);
    if (!driver) throw new Unauthorized();
    if (driver.status === "blocked") throw new Unauthorized("this account is blocked");
    return driver;
  }

  async signOut(token: string): Promise<void> {
    await this.sql.query(
      `update driver_token set revoked_at = $2 where token_hmac = $1 and revoked_at is null`,
      [this.hmac(token), new Date(this.now()).toISOString()],
    );
  }

  // --- ops invitations -----------------------------------------------------

  /**
   * What the field team hands a driver at the complex: a short code that puts
   * him straight onto the right lines, already vouched. This is the face-to-face
   * onboarding the Irbid pilot is built around (§5.2 tier 1).
   */
  async createInvitation(opts: {
    routeIds: string[];
    authority: string;
    note?: string;
    ttlHours?: number;
  }): Promise<{ code: string; expiresAt: string }> {
    for (const routeId of opts.routeIds) await this.admin.getRoute(routeId);

    // Short enough to read aloud, from an alphabet without look-alike glyphs.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(randomBytes(8))
      .map((b) => alphabet[b % alphabet.length])
      .join("")
      .slice(0, 8);

    const expiresAt = new Date(this.now() + (opts.ttlHours ?? 72) * 3_600_000).toISOString();
    await this.sql.query(
      `insert into invitation (code_hmac, country_code, route_ids, authority, note, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.hmac(code),
        this.countryCode,
        opts.routeIds,
        opts.authority,
        opts.note ?? null,
        new Date(this.now()).toISOString(),
        expiresAt,
      ],
    );
    return { code, expiresAt };
  }

  /** Redeemed by a signed-in driver. Single use, and it expires. */
  async redeemInvitation(driverId: string, code: string): Promise<DriverRecord> {
    const { rows } = await this.sql.query<{
      route_ids: string[];
      authority: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `select route_ids, authority, expires_at, used_at from invitation where code_hmac = $1`,
      [this.hmac(code.trim().toUpperCase())],
    );
    const invitation = rows[0];
    if (!invitation) throw new AdminError("that code is not recognised");
    if (invitation.used_at) throw new AdminError("that code has already been used");
    if (new Date(invitation.expires_at).getTime() <= this.now()) {
      throw new AdminError("that code has expired");
    }

    const { rows: claimed } = await this.sql.query<{ code_hmac: string }>(
      `update invitation set used_at = $2, used_by = $3
        where code_hmac = $1 and used_at is null returning code_hmac`,
      [this.hmac(code.trim().toUpperCase()), new Date(this.now()).toISOString(), driverId],
    );
    if (claimed.length === 0) throw new AdminError("that code has already been used");

    for (const routeId of invitation.route_ids) {
      await this.admin.assignRoute(driverId, routeId).catch((err) => {
        if (!(err instanceof NotFound)) throw err;
      });
    }
    return this.admin.vouch(driverId, invitation.authority);
  }
}

export { OtpError, hashPhone };
