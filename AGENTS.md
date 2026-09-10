# Base44 dev environment

Run everything with:

```
docker compose -f docker-compose.base44.yml up -d
```

- **api** — `node --watch services/api/src/http.ts` on host port 3000. TypeScript
  runs directly through Node 22 type stripping; there is no build step. The
  preview root `/` serves the ops corridor editor (`/v1/admin` equivalent).
- **db** — Postgres 17 with the network/roster schema, seeded from
  `countries/jo` by the one-shot **setup** service (`npm ci && npm run seed`).
  Seeding is idempotent; re-run it with
  `docker compose -f docker-compose.base44.yml run --rm setup`.
- **redis** — required. The API refuses a Redis instance with persistence, so
  compose starts it with `--save "" --appendonly no`; live state is
  deliberately volatile. If the api container exits with a persistence
  assertion, check the redis command.
- **Secrets** — `ADMIN_TOKEN` and `PHONE_SALT` come from the platform env file
  `/run/base44/app.env`. Without them the API boots but disables ops/driver
  sign-in. The editor authenticates with
  `/v1/admin?token=<ADMIN_TOKEN>`; the token is also accepted as a
  `Bearer` header. `PHONE_SALT` must stay stable or roster lookups break.
- **OTP** — in development (`NODE_ENV=development`) the code is returned in the
  API response, so no SMS gateway is needed. `SMS_GATEWAY_URL`/`SMS_GATEWAY_TOKEN`
  exist for a real gateway.
- **Editor map** — MapLibre and fonts load from CDNs; `MAP_TILES` overrides the
  basemap. Without internet the map pane is blank but the endpoints still work.
- **Tests** — `docker compose -f docker-compose.base44.yml exec -T api npm test`
  (208 tests). The passenger/driver apps are Flutter and cannot run in the
  browser preview; their logic is exercised via the Dart tests and the API
  suite.
- **End-to-end verification** — the project's own script drives a driver and a
  passenger through the live backend:
  ```
  docker compose -f docker-compose.base44.yml exec -d api sh -c 'PORT=3220 ADMIN_TOKEN=tok node services/api/src/http.ts'
  docker run --rm --network container:app-api-1 -v "$PWD":/app -w /tmp dart:stable \
    sh -c 'cp -r /app/packages/core core && cd core && dart pub get && dart run tool/e2e.dart'
  ```
  (kill the :3220 instance afterwards — find it by `PORT=3220` in `/proc/*/environ`).
  Driver `0790000111` is a real roster row with an assignment to
  `jo-irbid-malka`, created by the e2e; keep it for dev testing. OTP requests
  are rate-limited, so leave ~30s between e2e runs.
- **Known setup deviations from upstream** — the preview root `/` serves the
  editor (upstream only serves it at `/v1/admin`); the editor's map style
  includes a `glyphs` URL so zone labels render.
