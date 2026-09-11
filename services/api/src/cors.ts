/**
 * Cross-origin access for the web clients.
 *
 * The Flutter apps never needed this: a native app is not an origin. A browser
 * one is, so a passenger page served from anywhere other than the API's own
 * host is refused by the browser unless the API says otherwise.
 *
 * Unset means off, which is exactly today's behaviour — a deployment that has
 * not thought about this does not silently open. `WEB_ORIGINS` names the pages
 * allowed to call the API; the literal `*` is for development, where the page
 * is served from whatever address the laptop happens to have.
 */

export type CorsPolicy = { any: true } | { any: false; origins: Set<string> } | null;

export function corsPolicy(raw: string | undefined): CorsPolicy {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value === "*") return { any: true };

  const origins = value
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return origins.length > 0 ? { any: false, origins: new Set(origins) } : null;
}

/**
 * The headers a response needs so a browser will hand it to the page.
 *
 * `authorization` is allowed because a driver signing in from a browser sends
 * a bearer token. No credential mode is offered: nothing here uses cookies, so
 * a page cannot be made to act as a signed-in driver just by being visited.
 */
export function corsHeaders(
  origin: string | undefined,
  policy: CorsPolicy,
): Record<string, string> {
  if (!policy || !origin) return {};

  const allowed = policy.any ? "*" : policy.origins.has(origin.replace(/\/$/, "")) ? origin : "";
  if (!allowed) return {};

  const headers: Record<string, string> = {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
  };
  // Without this a shared cache could serve one origin's answer to another.
  if (!policy.any) headers.vary = "origin";
  return headers;
}
