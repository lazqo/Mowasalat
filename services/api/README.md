# services/api

The backend. Its job is narrow: hold live scalars for sixty seconds, match
passengers to buses, and count aggregates — while never receiving, storing or
logging a coordinate.

```
npm run api      # starts on :3000
npm test         # 43 API tests
```

No dependencies and no build step; TypeScript runs through Node's type
stripping, as in `packages/corridor`.

## The property this service exists to protect

[docs/PLAN.md §6.1](../../docs/PLAN.md) promises that no coordinate reaches the
server. The corridor library guarantees the client *can* compute a position
without sending one. It guarantees nothing about what this server accepts or
writes down — a debug log, an error handler or a crash reporter reintroduces a
coordinate very easily, and that is the leak nobody notices until an audit.

So the property is enforced in three places and tested:

| Where | What it does |
|---|---|
| `wire.ts` | Strict allow-list schemas. Unknown keys are rejected, so a client that starts sending `lat` gets an error rather than a silently stored value. A coordinate key is reported as a leak, not a typo. |
| `guard.ts` | The only logger. Every payload is scanned before it can be written, so a careless `log(req.body)` fails loudly in tests. |
| `wire.assertBucketed` | Refuses a position finer than the country's band. Blurring happens on the device, but a modified client could skip it — this makes the policy enforceable against a client we do not control. |

`service.test.ts` runs a whole trip and asserts nothing logged carries a
coordinate; `http.test.ts` asserts the same of what goes out over the wire.

## Shape

| Module | Responsibility |
|---|---|
| `wire.ts` | The wire contract and its validation |
| `guard.ts` | Coordinate detection and the safe logger |
| `live.ts` | Expiring in-memory state — the Redis stand-in, same contract |
| `counters.ts` | Aggregates, with personal dimensions refused and thin cells suppressed |
| `service.ts` | The domain layer. No HTTP in sight |
| `http.ts` | Thin transport |

## Two notes on the choices

**The domain layer is framework-independent.** The plan names NestJS, and that
still holds for the transport; `http.ts` is deliberately thin so wrapping these
same services in NestJS or Fastify touches nothing else. Keeping the domain free
of a framework is also what lets `npm test` run with no install.

**Push will use Server-Sent Events, not WebSockets.** The stream is one-way,
which is all a bus position needs; SSE rides plain HTTP so it survives the
proxies and captive portals a cheap phone meets, and it reconnects on its own.
The client-to-server direction is ordinary POSTs. The endpoint is not built yet.

## Not built yet

- The SSE endpoints for the passenger and driver streams.
- Postgres. `live.ts` is in-memory; Redis replaces it behind the same contract.
- Driver accounts, OTP and the verification tiers (§5.2).
- Country packs are not yet loaded; policy is passed in.
