# Getting this onto two phones

Everything in the repository except the Flutter UI has been run and tested. This
is the path from here to a driver's phone and a passenger's phone seeing each
other for real.

Budget **half a day** for the first run, most of it waiting for Flutter and
Android to install. After that a rebuild is a couple of minutes.

> **Nothing in this file has been executed.** Flutter, Android and a phone were
> not available where the code was written. Commands are written from the
> project's own structure, not from a successful run. Expect to fix one or two
> things; the troubleshooting section covers the failures I can anticipate.

---

## What you need

| | |
|---|---|
| A computer | macOS, Linux or Windows. 15 GB free. |
| Two Android phones | Any two. Cheap is better — that is the target. Enable Developer options and USB debugging on both. |
| A backend somewhere both phones can reach | Your laptop on the same WiFi is fine to start. |
| A USB cable | Or `adb connect` over WiFi. |

You do **not** need a Google Play account, an Apple anything, a signing
certificate, or a domain name. This is a debug build going onto phones you hold.

---

## Step 1 — Get the backend running and reachable

The apps talk to `/v1`. It must be reachable from the phones, which means not
`localhost`.

```bash
# Postgres and Redis. Redis must not persist — the server refuses one that does.
docker run -d --name mwsl-pg  -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
docker run -d --name mwsl-redis -p 6379:6379 redis:7 redis-server --save '' --appendonly no

cd Mowasalat
export DATABASE_URL="postgresql://postgres:dev@localhost:5432/postgres"
export REDIS_URL="redis://localhost:6379"
export ADMIN_TOKEN="$(openssl rand -hex 16)"
export PHONE_SALT="$(openssl rand -hex 16)"
export OTP_SECRET="$(openssl rand -hex 16)"
export NODE_ENV=development     # so the OTP comes back in the response

npm run seed                    # loads the five Bani Kinana lines
npm run api
```

You should see:

```
api listening on :3000 (JO, live state redis, ops enabled)
```

Now find your machine's address on the WiFi — this is what the phones will use:

```bash
# macOS / Linux
ipconfig getifaddr en0 2>/dev/null || hostname -I | awk '{print $1}'
```

Check it from your phone's browser before going further: open
`http://<that-address>:3000/health`. If you do not see `{"ok":true,...}`, stop
and fix that first — a firewall or client isolation on the WiFi is the usual
cause, and no amount of app debugging will get past it.

Keep that address. Everything below calls it `$API`.

---

## Step 2 — Install Flutter

Follow <https://docs.flutter.dev/get-started/install> for your platform, then:

```bash
flutter doctor
```

Fix everything it flags **for Android**. You can ignore anything about Xcode,
iOS, Chrome or Visual Studio — this pilot is Android only. The one that catches
people is the licences:

```bash
flutter doctor --android-licenses
```

---

## Step 3 — Generate the Android scaffolding

The repository has the Dart code but no `android/` folder, because that is
generated. One script does it and adds the permissions the apps use:

```bash
./tools/setup_apps.sh
```

Then read its closing notes — there are two things it asks you to check by hand,
including cleartext HTTP, which you will need for a laptop backend.

**Why the permissions are what they are.** The driver app asks for foreground
location and a foreground service, so a trip keeps reporting with a permanent
visible notification. It deliberately does **not** ask for
`ACCESS_BACKGROUND_LOCATION`: the app has no business knowing where a driver is
when he is not driving. The passenger app asks for foreground location only, and
takes exactly one fix.

---

## Step 4 — The verification gate

This is the step that has never been run, and the reason the apps are described
as implemented rather than verified. Run all of it before putting anything on a
phone.

```bash
# The logic. This part already passes — it should stay passing.
cd packages/core
dart pub get && dart analyze && dart test          # expect: 103 tests, no issues

# The apps. This is the new ground.
cd ../../apps/driver
flutter pub get && flutter analyze && flutter test

cd ../passenger
flutter pub get && flutter analyze && flutter test
```

`flutter analyze` on the two apps has never run. **Expect it to find things.**
Most likely: an unused import, a `const` the linter wants, a `BuildContext` used
across an `await`. Fix them before building — an analyzer complaint on a
`BuildContext` after an await is a real bug, not a style note.

If something looks wrong rather than untidy, that is worth telling me about
rather than working around.

---

## Step 5 — Build and install

```bash
adb devices          # both phones should be listed and authorised
```

Install the driver app on one phone and the passenger app on the other:

```bash
cd apps/driver
flutter build apk --debug --dart-define=API_BASE=http://$API:3000
adb -s <DRIVER_PHONE_ID> install -r build/app/outputs/flutter-apk/app-debug.apk

cd ../passenger
flutter build apk --debug --dart-define=API_BASE=http://$API:3000
adb -s <PASSENGER_PHONE_ID> install -r build/app/outputs/flutter-apk/app-debug.apk
```

`API_BASE` is compiled in, so a build for a different backend is a different
build. There is no settings screen to point it somewhere else, on purpose.

---

## Step 6 — Put a driver on a line

The driver signs himself in, but only ops can assign him a line — which is the
rule, not a limitation. Two ways:

**An invitation code**, which is how it will work at the complex:

```bash
curl -s -X POST http://localhost:3000/v1/admin/invitations \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"routeIds":["jo-irbid-malka"],"authority":"field_ops"}'
```

Give the driver that code; he enters it after signing in and lands on the line,
already vouched.

**Or assign him directly** after he has signed in once:

```bash
curl -s http://localhost:3000/v1/admin/drivers -H "authorization: Bearer $ADMIN_TOKEN"
# take his id, then:
curl -s -X POST http://localhost:3000/v1/admin/drivers/<DRIVER_ID>/routes \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"routeId":"jo-irbid-malka"}'
```

**The OTP code.** With `NODE_ENV=development` the code comes back in the
response to the request, so a tester can read it off the server log rather than
waiting for an SMS. In production the development provider refuses to exist.

---

## Step 7 — The real test

Do this in a car if you can, on the Irbid–Malka road. A walk works for
everything except speed and ETA.

Watch the server while you go:

```bash
# Live state, and proof of what is not in it
watch -n2 'curl -s http://localhost:3000/health'
redis-cli --scan --pattern "mwsl:*"
```

| # | Do this | Expect |
|---|---|---|
| 1 | Driver: open, enter his number, enter the code | Signed in. No username, password or email asked for anywhere. |
| 2 | Driver: look at the home screen | Only the lines he is assigned to. Nothing he can type into. |
| 3 | Driver: tap `إربد – ملكا`, choose a direction | Two destinations offered, not arrows. |
| 4 | Driver: tap `ابدأ` | A permanent notification appears: `مواصلات — الرحلة شغالة`. |
| 5 | Driver: drive or walk along the line | `/health` shows `trips: 1`. `redis-cli get mwsl:trip:<pseudonym>` shows a remaining distance and a speed, and **no coordinate**. |
| 6 | Passenger: open, search `ملكة` | Finds `ملكا`. The typo tolerance is deliberate. |
| 7 | Passenger: choose it | The line, and the driver's bus with a time. |
| 8 | Passenger: tap `أنا مستني هون` | Within a couple of seconds, the driver's screen reads `١ راكب بعد …`. **This is the moment the product either works or does not.** |
| 9 | Passenger: tap `ركبت` | Her request disappears from the driver's screen. |
| 10 | Driver: tap `إنهاء الرحلة`, confirm | Notification gone. `/health` shows `trips: 0`. |
| 11 | Driver: kill the app mid-trip from Recents, reopen | He is asked `استمرار الرحلة` or `إنهاء الرحلة`. Continuing does not create a second bus. |
| 12 | Walk 2 km off the road, keep watching | The bus stops updating. Nothing is reported at all — that silence is the design. |
| 13 | Turn the phone's data off for a minute, then on | It reconnects. **No burst of backdated positions.** |

Then the check that matters most:

```bash
grep -iE '\blat\b|\blng\b|latitude|longitude|3[0-9]\.[0-9]{4}' /path/to/server.log
psql "$DATABASE_URL" -c "\dt"     # no trip, ride_request or position table
```

Both should come back empty. If either does not, stop and tell me — that is the
one promise the whole design is built on.

---

## What to write down

Not much, and none of it in a spreadsheet nobody reads:

- **Did step 8 work, and how long did it take?** One number.
- **Battery**: driver's phone percentage at the start and end of an hour.
- **Data**: Android's per-app usage figure after that hour.
- **Anything a driver had to be told twice.** That is a UI bug, recorded in his words.
- **Every time a bus vanished while genuinely on the road.** That is the corridor drawn too tight, and it is fixed in data, not code — see below.

---

## Troubleshooting

**`{"error":"you are not assigned to that line"}`** — Step 6 was skipped, or he
signed in with a different number than the one you assigned. Numbers are
normalised, so `0790…` and `+96279…` are the same driver; a different number is
a different account.

**Nothing loads, the phone browser cannot reach `/health`** — WiFi client
isolation or a firewall. Try a phone hotspot with the laptop joined to it.

**It loads but every request fails on the phone only** — cleartext HTTP. See the
note at the end of `setup_apps.sh`.

**`{"error":"position is more precise than policy allows"}`** — the app sent an
unbucketed distance. That is a real bug in the client; tell me.

**The bus disappears while genuinely on the road** — the corridor is too tight
for that stretch. This is expected on placeholder geometry, and it is a data
fix, not a code fix:

```bash
curl -s -X POST http://localhost:3000/v1/admin/routes/jo-irbid-malka/width \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"widthM":1500}'
```

Better still, record the drive and let the corridor be built from it — that is
what `npm run trace` and the editor at `/v1/admin` are for.

**The driver's screen never shows the waiting passenger** — check `/health`
shows both a trip and a request, then check the stream directly:

```bash
curl -N "http://localhost:3000/v1/stream/waiting?tripToken=<TOKEN>"
```

If the server is pushing and the app is not drawing, it is the app. If the
server is silent, the request and the trip are probably on different directions
of the line.

---

## What this is really testing

Not the code — that has tests. It is testing three things no test can answer:

1. **Whether a driver will switch it on.** If step 8 works but he forgets to tap
   `ابدأ`, the product fails for reasons no amount of engineering fixes.
2. **Whether the corridors match the real roads.** The geometry is a placeholder
   until someone drives it.
3. **Whether the words are right.** `وين رايح؟` and `ابدأ` were chosen from how
   people speak, not from a dictionary. A driver hesitating at a screen is worth
   more than any of the metrics above.
