/**
 * Issuing and checking one-time codes.
 *
 * The whole of driver sign-up is a phone number and a six-digit code — no
 * documents, no email, no password, no photo (docs/PLAN.md §5.1). That makes
 * this the only door into a driver account, so the rules below are the security
 * of the roster: codes expire quickly, work once, are limited per phone and per
 * caller, and are never stored or logged in a form anyone can read.
 */
import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { Sql } from "../db/sql.ts";
import type { OtpProvider } from "./provider.ts";

export type OtpLimits = {
  codeLength: number;
  ttlSeconds: number;
  maxAttempts: number;
  /** Shortest gap between two codes to the same number. */
  minResendSeconds: number;
  /** Codes per number, and per caller address, within the window. */
  maxSendsPerWindow: number;
  maxSendsPerIpWindow: number;
  windowSeconds: number;
};

export const DEFAULT_LIMITS: OtpLimits = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  minResendSeconds: 60,
  maxSendsPerWindow: 5,
  maxSendsPerIpWindow: 20,
  windowSeconds: 900,
};

export class OtpError extends Error {
  code: string;
  retryAfterSeconds?: number;
  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "OtpError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type Challenge = {
  challengeId: string;
  channel: string;
  expiresInSeconds: number;
};

export class OtpService {
  private sql: Sql;
  private provider: OtpProvider;
  private secret: string;
  private limits: OtpLimits;
  private now: () => number;

  constructor(
    sql: Sql,
    provider: OtpProvider,
    secret: string,
    limits: OtpLimits = DEFAULT_LIMITS,
    now: () => number = () => Date.now(),
  ) {
    if (!secret) throw new Error("an OTP secret is required");
    this.sql = sql;
    this.provider = provider;
    this.secret = secret;
    this.limits = limits;
    this.now = now;
  }

  /** Codes and phone numbers are only ever held as an HMAC under the server secret. */
  private hmac(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }

  private generateCode(): string {
    const max = 10 ** this.limits.codeLength;
    return String(randomInt(0, max)).padStart(this.limits.codeLength, "0");
  }

  /**
   * Issues a code for a number, subject to the rate limits.
   *
   * `phone` must already be normalized: two spellings of one number must not be
   * two rate-limit buckets.
   */
  async request(phone: string, ipHash?: string): Promise<Challenge> {
    const phoneHash = this.hmac(phone);
    const nowMs = this.now();
    const windowStart = new Date(nowMs - this.limits.windowSeconds * 1000).toISOString();

    const { rows: recent } = await this.sql.query<{ sent_at: string }>(
      `select sent_at from otp_send_log
        where phone_hash = $1 and sent_at > $2
        order by sent_at desc`,
      [phoneHash, windowStart],
    );

    if (recent.length > 0) {
      const sinceLast = (nowMs - new Date(recent[0].sent_at).getTime()) / 1000;
      if (sinceLast < this.limits.minResendSeconds) {
        throw new OtpError(
          "resend_too_soon",
          "a code was just sent; wait a moment before asking for another",
          Math.ceil(this.limits.minResendSeconds - sinceLast),
        );
      }
    }
    if (recent.length >= this.limits.maxSendsPerWindow) {
      throw new OtpError("too_many_sends", "too many codes requested for this number", this.limits.windowSeconds);
    }

    if (ipHash) {
      const { rows: fromIp } = await this.sql.query<{ n: string }>(
        `select count(*)::text n from otp_send_log where ip_hash = $1 and sent_at > $2`,
        [ipHash, windowStart],
      );
      if (Number(fromIp[0]?.n ?? 0) >= this.limits.maxSendsPerIpWindow) {
        throw new OtpError("too_many_sends", "too many codes requested from here", this.limits.windowSeconds);
      }
    }

    const code = this.generateCode();
    const challengeId = randomUUID();
    const expiresAt = new Date(nowMs + this.limits.ttlSeconds * 1000).toISOString();

    await this.sql.query(
      `insert into otp_challenge (id, phone_hash, code_hmac, channel, max_attempts, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        challengeId,
        phoneHash,
        this.hmac(code),
        this.provider.channel,
        this.limits.maxAttempts,
        new Date(nowMs).toISOString(),
        expiresAt,
      ],
    );
    await this.sql.query(
      `insert into otp_send_log (phone_hash, ip_hash, sent_at) values ($1, $2, $3)`,
      [phoneHash, ipHash ?? null, new Date(nowMs).toISOString()],
    );

    await this.provider.send(phone, code);

    return {
      challengeId,
      channel: this.provider.channel,
      expiresInSeconds: this.limits.ttlSeconds,
    };
  }

  /**
   * Checks a code and consumes the challenge. Returns the normalized phone's
   * hash, which is the only form of the number the roster ever holds.
   */
  async verify(challengeId: string, code: string, phone: string): Promise<{ phoneHash: string }> {
    const { rows } = await this.sql.query<{
      id: string;
      phone_hash: string;
      code_hmac: string;
      attempts: number;
      max_attempts: number;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `select id, phone_hash, code_hmac, attempts, max_attempts, expires_at, consumed_at
         from otp_challenge where id = $1`,
      [challengeId],
    );

    const challenge = rows[0];
    // The same answer whether the challenge never existed or belongs to someone
    // else, so this cannot be used to probe.
    if (!challenge || challenge.phone_hash !== this.hmac(phone)) {
      throw new OtpError("invalid_code", "that code is not right");
    }
    if (challenge.consumed_at) {
      throw new OtpError("already_used", "that code has already been used");
    }
    if (new Date(challenge.expires_at).getTime() <= this.now()) {
      throw new OtpError("expired", "that code has expired; ask for a new one");
    }
    if (challenge.attempts >= challenge.max_attempts) {
      throw new OtpError("too_many_attempts", "too many attempts; ask for a new code");
    }

    if (challenge.code_hmac !== this.hmac(code)) {
      await this.sql.query(`update otp_challenge set attempts = attempts + 1 where id = $1`, [
        challengeId,
      ]);
      const left = challenge.max_attempts - (challenge.attempts + 1);
      throw new OtpError(
        left <= 0 ? "too_many_attempts" : "invalid_code",
        left <= 0 ? "too many attempts; ask for a new code" : "that code is not right",
      );
    }

    // Single use: consuming and checking in one statement, so two requests
    // racing cannot both win.
    const { rows: consumed } = await this.sql.query<{ id: string }>(
      `update otp_challenge set consumed_at = $2 where id = $1 and consumed_at is null returning id`,
      [challengeId, new Date(this.now()).toISOString()],
    );
    if (consumed.length === 0) throw new OtpError("already_used", "that code has already been used");

    return { phoneHash: challenge.phone_hash };
  }

  /** Clears challenges and send records that are past any use. */
  async prune(): Promise<void> {
    const cutoff = new Date(this.now() - this.limits.windowSeconds * 1000).toISOString();
    await this.sql.query(`delete from otp_challenge where expires_at < $1`, [cutoff]);
    await this.sql.query(`delete from otp_send_log where sent_at < $1`, [cutoff]);
  }

  hashPhone(phone: string): string {
    return this.hmac(phone);
  }
}
