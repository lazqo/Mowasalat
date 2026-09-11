# Transport API — v1

The contract the client apps consume. **Frozen for the MVP screens**: the
driver and passenger vertical slices below can be built against this without any
backend change. Anything added later goes in additively, or in `/v2`.

Base path `/v1`. JSON in, JSON out. Times in seconds, distances in metres.

## The one rule that shapes everything

**No coordinate is ever sent to the server.** The phone caches the corridors, does
its own geometry, and transmits a line, a direction, a *remaining distance* and a
zone. A body containing `lat`, `lng` or similar is rejected outright, and a
position finer than the country's band (`remainingBucketM`) is refused. See
[PLAN.md §6.1](PLAN.md).

A driver's phone number never leaves the backend. Neither a phone number nor a
driver id appears anywhere in the realtime or streaming layer.

## Browsers

A native app is not an origin; a web page is. `WEB_ORIGINS` names the pages
allowed to call this API — a comma-separated list, or `*` in development.
**Unset means no browser may call it at all**, which is what every deployment
made before the web client existed already does.

```
WEB_ORIGINS=https://your-page.example
```

`OPTIONS` preflights are answered for a named origin and refused with 405 for
anything else. No credential mode is offered: nothing here uses cookies, so a
page cannot be made to act as a signed-in driver just by being visited. The
stream endpoints carry the same headers, or `EventSource` never opens.

## Errors

| Status | Meaning |
|---|---|
| 400 | Bad request. `{error, code?}`; `code` is `invalid_phone`, `invalid_code`, `expired`, `already_used`, or absent |
| 401 | Not signed in, token revoked, or a stream ticket is missing |
| 404 | No such line or driver |
| 409 | Refused for a stated reason (already assigned, invitation used) |
| 422 | A route edit would be invalid; `{error, problems:[{field,message}]}` |
| 429 | Rate limited; `{error, code, retryAfterSeconds}` |

## Country and network

```http
GET /v1/country
→ { code, locale, digits, phonePrefix, remainingBucketM, kAnonymityMin, strings: {...} }

GET /v1/routes
→ { routes: [Route] }
```

`Route` is the line and its corridor — enough for the phone to do all matching
offline:

```jsonc
{
  "id": "jo-irbid-malka",
  "nameAr": "إربد – ملكا",
  "originNameAr": "إربد",
  "destinationNameAr": "ملكا",
  "bidirectional": true,
  "provisional": true,              // geometry still awaiting field work
  "corridor": {
    "widthM": 750,
    "referencePaths": [[{ "lat": 32.5556, "lng": 35.8497 }, …]],
    "zones": [{ "seq": 0, "nameAr": "إربد", "kind": "origin_hub",
                "centre": { "lat": …, "lng": … }, "radiusM": 800 }]
  },
  "servedDestinations": [{ "id": "jo-malka", "nameAr": "ملكا", "zoneSeq": 1 }],
  "waitPoints": [{ "id": "wp-…", "nameAr": "الدوار", "location": {…}, "zoneSeq": 1 }]
}
```

## Driver sign-in

Four screens, no paperwork: مرحبا → رقم الهاتف → رمز التحقق → شو الخط اللي بتشتغل عليه؟

```http
POST /v1/auth/otp/request   { phone }
→ { challengeId, channel, expiresInSeconds }
```

`phone` is whatever the driver typed — `0790123456`, `+962 79 012 3456`, or
Eastern Arabic digits. The server normalises it. `channel` is `sms`,
`manual_vouch` or `development`, decided by the country pack.

```http
POST /v1/auth/otp/verify    { challengeId, code, phone }
→ { driverToken, isNew, driver: { id, phoneMasked, tier, status, routeIds, vouchedBy } }
```

A first correct code creates the account, so there is no separate sign-up to
fail at. Send `driverToken` as `Authorization: Bearer …` on every driver call.
Codes expire in five minutes, work once, allow five attempts, and are rate
limited per number and per caller.

```http
POST /v1/auth/sign-out      (driver)  → { ok: true }
```

## The driver's account

```http
GET  /v1/driver/me       (driver) → { driver, routes: [Route], vehicles: [Vehicle] }
GET  /v1/driver/routes   (driver) → { routes: [Route] }
POST /v1/driver/vehicle  (driver) { type: "coaster"|"minibus"|"service",
                                    colour?, plate?, showPlate? } → Vehicle
POST /v1/driver/invitation (driver) { code } → { driver }
```

`showPlate` defaults to false: a plate is shown to passengers only if the driver
opts in. An invitation is the code the field team hands a driver at the complex;
redeeming it assigns his lines and vouches him to tier 1.

## Running a trip

**Assigned lines are not the active line.** A driver may hold several; starting a
trip picks exactly one, and one direction.

```http
POST /v1/trips           (driver) { routeId, dir: 0|1 }
→ { tripToken, pseudonym }

POST /v1/trips/progress  (driver) { tripToken, routeId, dir, remainingM, zoneSeq, speedKph }
→ { ok: true }

POST /v1/trips/end       (driver) { tripToken } → { ok: true }
```

`dir` is 0 for origin → destination. `remainingM` is road distance still to cover
to that direction's endpoint, computed on the phone, and **must be a multiple of
`remainingBucketM`**. Starting a trip on a line he is not assigned to is refused.
`tripToken` is secret and short-lived; `pseudonym` is what passengers see, and it
changes every trip.

Send progress every 5 s while moving, every 30 s when stopped, and **nothing at
all when outside the corridor** — that silence is what keeps a detour private.

```http
GET /v1/stream/waiting?tripToken=…   (SSE)
→ data: { "pins": [{ "count": 3, "remainingM": 6000, "zoneSeq": 1 }] }
```

## The passenger

No account, no login, nothing stored about her.

```http
POST /v1/buses     { routeId, dir, remainingM, zoneSeq }
→ { buses: [{ pseudonym, remainingM, zoneSeq, gapM, etaSeconds }], streamTicket }

GET /v1/stream/buses?ticket=…   (SSE)
→ data: { "buses": [{ "pseudonym", "remainingM", "zoneSeq", "speedKph" }] }
```

The stream sends bus scalars, not answers: the phone computes gap and ETA itself
from the corridor it already has. The ticket binds the stream to that one line
and direction, so the network cannot be enumerated.

```http
POST /v1/requests          { routeId, dir, destinationId, remainingM, zoneSeq }
→ { pseudonym }

POST /v1/requests/cancel   { pseudonym }                  → { cancelled: bool }
POST /v1/requests/boarded  { pseudonym, routeId, dir }    → { ok: true }
```

A request expires by itself after 20 minutes. Cancelling removes it at once.

## Ops (internal)

`Authorization: Bearer $ADMIN_TOKEN`. Refuses to serve at all when unconfigured.

```http
GET  /v1/admin/routes                     POST /v1/admin/routes/:id/width
GET  /v1/admin/routes/:id                 POST /v1/admin/routes/:id/zones
POST /v1/admin/routes/:id/check           POST /v1/admin/routes/:id/paths
POST /v1/admin/routes/:id/waitpoints      POST /v1/admin/routes/:id/destinations
POST /v1/admin/routes/:id/traces          { traces, apply? }
GET  /v1/admin/drivers                    POST /v1/admin/drivers        { phone }
POST /v1/admin/drivers/:id/routes         { routeId, remove? }
POST /v1/admin/drivers/:id/vouch          { authority }
POST /v1/admin/drivers/:id/status         { status }
POST /v1/admin/invitations                { routeIds, authority, note?, ttlHours? }
GET  /v1/admin                            the corridor editor
```

## The two vertical slices this contract must carry

**Driver.** sign in → pick a line and direction → start → snap GPS to the
corridor locally → post progress → stream waiting pins → end.

**Passenger.** open → pick a destination → `POST /v1/buses` → "أنا مستني هون" →
stream the approaching bus → boarded or cancel.

Everything both slices need is above. If a screen needs something that is not,
that is a contract change to agree before the app works around it.
