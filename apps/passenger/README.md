# apps/passenger — تطبيق الراكب

One journey:

```
open → وين رايح؟ → the buses coming → أنا مستني هون → the bus approaching → ركبت / إلغاء
```

No account, no sign-in, nothing stored about her at all.

## Not verified

**Flutter and Android are not installed in the environment this was written in,
so none of this has been analysed, built, or run.** Before any pilot build:

```
cd packages/core   && dart analyze && dart test    # passing here
cd apps/passenger  && flutter pub get && flutter analyze && flutter test
                      flutter build apk --debug --dart-define=API_BASE=http://…
```

## Where the logic lives

In [`packages/core`](../../packages/core) — pure Dart, analysed and tested here.
`PassengerController` does the searching, the ride resolution, the ETA
arithmetic and the request state machine; this package only draws.

## Choices worth knowing

**Her position is asked for once and never sent.** One fix, used locally to work
out which lines pass her and how far along she stands. No background permission
is requested and no location stream is opened — a passenger is never tracked.

**Watching a bus costs her nothing in privacy.** The stream sends bus scalars;
the gap and the ETA are computed on her phone from the corridor it already has.

**A line only counts if her destination is still ahead of her.** Standing past
the village she wants is a walk back, not a ride, so it is not offered.

**Search forgives spelling.** Folding handles hamza, ta marbuta, diacritics, the
definite article and Eastern digits; one further edit is allowed on longer
names, which catches ملكة for ملكا. A test asserts no two pilot villages
collide under that tolerance.

**Useful with nothing running.** When no bus is out, the screen still says which
hub the line leaves from — the directory value that keeps the app worth opening
in the first weeks.

**The network is cached**, so the app opens instantly and works on a bad
connection. Public geography only.
