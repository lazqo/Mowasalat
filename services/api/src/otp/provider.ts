/**
 * How a code reaches a driver.
 *
 * No SMS company is named anywhere in the product. Which channels a country may
 * use comes from its pack (`otp_channels`), because the answer differs: SMS is
 * routine in Jordan and unreliable or unavailable in parts of Syria, where the
 * honest fallback is a person confirming a driver face to face — which is also
 * exactly how the Irbid pilot onboards anyway (docs/PLAN.md §5.2).
 */
export type OtpChannel = "development" | "sms" | "manual_vouch";

export interface OtpProvider {
  readonly channel: OtpChannel;
  send(phone: string, code: string): Promise<void>;
}

/**
 * Development and test only. Keeps the last code so a developer can log in
 * without an SMS bill, and refuses to exist in production, because a provider
 * that hands out codes is an authentication bypass.
 */
export class DevelopmentOtpProvider implements OtpProvider {
  readonly channel = "development" as const;
  private codes = new Map<string, string>();

  constructor(environment: string | undefined = process.env.NODE_ENV) {
    if (environment === "production") {
      throw new Error("DevelopmentOtpProvider must never run in production");
    }
  }

  async send(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }

  /** The code last sent to a number. Exists only because this provider does. */
  peek(phone: string): string | undefined {
    return this.codes.get(phone);
  }
}

export type SmsGateway = (message: { to: string; text: string }) => Promise<void>;

/**
 * Sends over SMS through an injected gateway.
 *
 * The gateway is a function, so swapping vendors is a line of wiring rather
 * than a change in the product. Nothing here knows who carries the message.
 */
export class SmsOtpProvider implements OtpProvider {
  readonly channel = "sms" as const;
  private gateway: SmsGateway;
  private template: (code: string) => string;

  constructor(gateway: SmsGateway, template?: (code: string) => string) {
    this.gateway = gateway;
    this.template = template ?? ((code) => `رمز التحقق: ${code}`);
  }

  async send(phone: string, code: string): Promise<void> {
    await this.gateway({ to: phone, text: this.template(code) });
  }
}

/**
 * No automated delivery at all.
 *
 * The code is issued and waits; an operator who is with the driver, or on a
 * call to him, reads it out. This is the path for a market where SMS cannot be
 * relied on, and for the face-to-face onboarding the pilot is built around. The
 * provider deliberately does nothing — the ops tool reads the pending challenge.
 */
export class ManualOtpProvider implements OtpProvider {
  readonly channel = "manual_vouch" as const;

  async send(): Promise<void> {
    // Nothing is transmitted. Delivery is a person.
  }
}

/** Picks a provider the country actually permits. */
export function selectProvider(
  providers: OtpProvider[],
  allowedChannels: string[],
): OtpProvider {
  const permitted = providers.find((p) => allowedChannels.includes(p.channel));
  if (!permitted) {
    throw new Error(
      `no configured OTP provider is permitted here; the pack allows: ${allowedChannels.join(", ")}`,
    );
  }
  return permitted;
}
