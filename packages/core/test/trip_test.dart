import 'dart:convert';

import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

/// A backend stand-in that records what the phone actually sent.
class _FakeBackend {
  final List<HttpRequest> sent = <HttpRequest>[];
  int failNextWith = 0;

  Future<HttpReply> call(HttpRequest request) async {
    sent.add(request);
    if (failNextWith != 0) {
      final status = failNextWith;
      failNextWith = 0;
      return HttpReply(status, jsonEncode({'error': 'refused'}));
    }
    return switch (request.path) {
      '/v1/trips' => HttpReply(200, jsonEncode(fixture('trip_start'))),
      '/v1/trips/progress' => HttpReply(200, jsonEncode({'ok': true})),
      '/v1/trips/end' => HttpReply(200, jsonEncode({'ok': true})),
      '/v1/auth/sign-out' => HttpReply(200, jsonEncode({'ok': true})),
      _ => HttpReply(404, jsonEncode({'error': 'not found'})),
    };
  }

  List<Map<String, dynamic>> get progressBodies => sent
      .where((r) => r.path == '/v1/trips/progress')
      .map((r) => r.body!)
      .toList(growable: false);
}

Route _route() => Route.fromJson(malkaRoute());

({TripController controller, _FakeBackend backend, MemoryTripStorage storage}) _harness({
  int Function()? now,
}) {
  final backend = _FakeBackend();
  final storage = MemoryTripStorage();
  final api = MowasalatApi(send: backend.call, driverToken: 'driver-token');
  return (
    controller: TripController(
      api: api,
      storage: storage,
      remainingBucketM: 250,
      now: now,
    ),
    backend: backend,
    storage: storage,
  );
}

void main() {
  group('starting a trip', () {
    test('exactly one line and one direction becomes active', () async {
      final h = _harness();
      final route = _route();

      expect(h.controller.phase, TripPhase.choosing);
      final credentials = await h.controller.start(route: route, dir: 0);

      expect(h.controller.phase, TripPhase.active);
      expect(h.controller.isTracking, isTrue);
      expect(credentials.pseudonym, isNotEmpty);
      expect(h.controller.trip!.routeId, 'jo-irbid-malka');
      expect(h.controller.trip!.dir, 0);
    });

    test('the trip is persisted immediately, before anything can kill the app', () async {
      final h = _harness();
      await h.controller.start(route: _route(), dir: 1);

      final saved = await h.storage.read();
      expect(saved, isNotNull);
      expect(saved!.dir, 1);
      expect(saved.routeId, 'jo-irbid-malka');
    });

    test('a refused start leaves the driver back at route selection', () async {
      final h = _harness();
      h.backend.failNextWith = 400;

      await expectLater(
        h.controller.start(route: _route(), dir: 0),
        throwsA(isA<ApiException>()),
      );
      expect(h.controller.phase, TripPhase.choosing);
      expect(h.controller.isTracking, isFalse);
      expect(await h.storage.read(), isNull);
    });

    test('a second trip cannot be started on top of a running one', () async {
      final h = _harness();
      await h.controller.start(route: _route(), dir: 0);
      await expectLater(
        h.controller.start(route: _route(), dir: 1),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('reporting progress', () {
    test('a GPS reading becomes three scalars, and the coordinate stays here', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);

      final report = await h.controller.onPosition(
        route.corridor.zones.first.centre,
        rawSpeedKph: 40,
      );

      expect(report, isNotNull);
      final body = h.backend.progressBodies.single;
      expect(body.keys.toSet(), {
        'tripToken',
        'routeId',
        'dir',
        'remainingM',
        'zoneSeq',
        'speedKph',
      });
      expect(jsonEncode(body), isNot(contains('lat')));
      expect(jsonEncode(body), isNot(contains('lng')));
    });

    test('the position sent is bucketed to the country band', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);
      await h.controller.onPosition(route.corridor.zones.first.centre, rawSpeedKph: 40);

      final remaining = h.backend.progressBodies.single['remainingM']! as double;
      expect(remaining % 250, 0, reason: 'the backend refuses anything finer');
    });

    test('off the corridor it sends nothing at all', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      await h.controller.start(route: _route(), dir: 0);

      // Far from any road on this line.
      final report = await h.controller.onPosition(const LatLng(31.9, 35.9), rawSpeedKph: 40);

      expect(report, isNull);
      expect(h.backend.progressBodies, isEmpty);
      expect(h.controller.lastFix!.inside, isFalse);
    });

    test('it holds its tongue between intervals', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);
      final where = route.corridor.zones.first.centre;

      await h.controller.onPosition(where, rawSpeedKph: 40);
      clock += 2000; // two seconds later, still moving
      await h.controller.onPosition(where, rawSpeedKph: 40);
      expect(h.backend.progressBodies, hasLength(1));

      clock += 4000; // now past five seconds
      await h.controller.onPosition(where, rawSpeedKph: 40);
      expect(h.backend.progressBodies, hasLength(2));
    });

    test('a stopped bus speaks every thirty seconds, not every five', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);
      final where = route.corridor.zones.first.centre;

      await h.controller.onPosition(where, rawSpeedKph: 0);
      clock += 10000;
      await h.controller.onPosition(where, rawSpeedKph: 0);
      expect(h.backend.progressBodies, hasLength(1), reason: 'ten seconds is not thirty');

      clock += 25000;
      await h.controller.onPosition(where, rawSpeedKph: 0);
      expect(h.backend.progressBodies, hasLength(2));
    });

    test('a dropped connection discards the reading rather than queueing it', () async {
      // There must never be a backlog of positions waiting to upload: that
      // backlog would be the trajectory the plan promises not to keep.
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);

      h.backend.failNextWith = 503;
      final report = await h.controller.onPosition(
        route.corridor.zones.first.centre,
        rawSpeedKph: 40,
      );

      expect(report, isNull);
      expect(h.controller.phase, TripPhase.active, reason: 'the trip carries on');

      // The next reading is a fresh one, not a replay of the lost one: two
      // attempts in total, the failed one and the new one, never three.
      clock += 6000;
      final next = await h.controller.onPosition(
        route.corridor.zones.last.centre,
        rawSpeedKph: 40,
      );
      expect(next, isNotNull);
      expect(h.backend.progressBodies, hasLength(2), reason: 'nothing was queued and replayed');
      expect(
        h.backend.progressBodies.last['remainingM'],
        isNot(h.backend.progressBodies.first['remainingM']),
        reason: 'the second report is the new position, not the lost one',
      );
    });

    test('a trip the server has forgotten tears down locally', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);

      h.backend.failNextWith = 400;
      await expectLater(
        h.controller.onPosition(route.corridor.zones.first.centre, rawSpeedKph: 40),
        throwsA(isA<ApiException>()),
      );

      expect(h.controller.phase, TripPhase.choosing);
      expect(h.controller.isTracking, isFalse);
      expect(await h.storage.read(), isNull);
    });

    test('nothing is reported before a trip starts', () async {
      final h = _harness();
      expect(await h.controller.onPosition(const LatLng(32.5, 35.8), rawSpeedKph: 40), isNull);
    });
  });

  group('waiting passengers', () {
    test('pins are described as counts and distances', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final route = _route();
      await h.controller.start(route: route, dir: 0);
      await h.controller.onPosition(route.corridor.zones.first.centre, rawSpeedKph: 40);

      final ahead = h.controller.lastFix!.remainingM - 2000;
      h.controller.onWaitingPins([
        WaitingPin(count: 2, remainingM: ahead, zoneSeq: 0),
      ]);

      expect(h.controller.waitingCount, 2);
      expect(h.controller.describePins().single, contains('2 ركاب'));
    });

    test('with no fix yet there is nothing to describe', () {
      final h = _harness();
      h.controller.onWaitingPins(const [WaitingPin(count: 2, remainingM: 1000, zoneSeq: 0)]);
      expect(h.controller.describePins(), isEmpty);
    });
  });

  group('ending a trip', () {
    test('everything is torn down and the driver returns to route selection', () async {
      final h = _harness();
      await h.controller.start(route: _route(), dir: 0);
      await h.controller.end();

      expect(h.controller.phase, TripPhase.choosing);
      expect(h.controller.isTracking, isFalse);
      expect(h.controller.trip, isNull);
      expect(h.controller.pins, isEmpty);
      expect(h.controller.speedKph, 0);
      expect(await h.storage.read(), isNull, reason: 'local trip credentials are gone');
      expect(h.backend.sent.map((r) => r.path), contains('/v1/trips/end'));
    });

    test('a server that has already forgotten the trip still ends it locally', () async {
      final h = _harness();
      await h.controller.start(route: _route(), dir: 0);
      h.backend.failNextWith = 400;

      await h.controller.end();
      expect(h.controller.phase, TripPhase.choosing);
      expect(await h.storage.read(), isNull);
    });

    test('signing out ends a running trip first, so no bus is left on the map', () async {
      final h = _harness();
      await h.controller.start(route: _route(), dir: 0);
      await h.controller.signOut();

      expect(h.backend.sent.map((r) => r.path), contains('/v1/trips/end'));
      expect(h.controller.trip, isNull);
      expect(await h.storage.read(), isNull);
    });
  });

  group('recovery after the app is killed', () {
    test('an interrupted trip is offered back, not silently resumed', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      await h.controller.start(route: _route(), dir: 0);

      // Android kills the app. A new controller starts over the same storage.
      final revived = TripController(
        api: MowasalatApi(send: h.backend.call, driverToken: 'driver-token'),
        storage: h.storage,
        remainingBucketM: 250,
        now: () => clock,
      );

      final found = await revived.recover([_route()]);
      expect(found, isNotNull);
      expect(revived.phase, TripPhase.recovering, reason: 'the driver is asked, not guessed at');
      expect(revived.isTracking, isFalse, reason: 'tracking waits for his answer');
    });

    test('استمرار الرحلة carries on without creating a second trip', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final started = await h.controller.start(route: _route(), dir: 0);

      final revived = TripController(
        api: MowasalatApi(send: h.backend.call, driverToken: 'driver-token'),
        storage: h.storage,
        remainingBucketM: 250,
        now: () => clock,
      );
      await revived.recover([_route()]);
      revived.resumeRecovered();

      expect(revived.phase, TripPhase.active);
      expect(revived.trip!.tripToken, started.tripToken, reason: 'the same trip, not a new one');
      expect(
        h.backend.sent.where((r) => r.path == '/v1/trips').length,
        1,
        reason: 'no second trip was created',
      );
    });

    test('إنهاء الرحلة on a recovered trip ends it cleanly', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      await h.controller.start(route: _route(), dir: 0);

      final revived = TripController(
        api: MowasalatApi(send: h.backend.call, driverToken: 'driver-token'),
        storage: h.storage,
        remainingBucketM: 250,
        now: () => clock,
      );
      await revived.recover([_route()]);
      await revived.end();

      expect(revived.phase, TripPhase.choosing);
      expect(await h.storage.read(), isNull);
    });

    test('a trip older than a shift is dropped rather than resumed', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      await h.controller.start(route: _route(), dir: 0);

      clock += const Duration(hours: 13).inMilliseconds;
      final revived = TripController(
        api: MowasalatApi(send: h.backend.call, driverToken: 'driver-token'),
        storage: h.storage,
        remainingBucketM: 250,
        now: () => clock,
      );

      expect(await revived.recover([_route()]), isNull);
      expect(revived.phase, TripPhase.choosing);
      expect(await h.storage.read(), isNull);
    });

    test('a trip on a line he no longer runs is dropped', () async {
      final h = _harness();
      await h.controller.start(route: _route(), dir: 0);

      final revived = TripController(
        api: MowasalatApi(send: h.backend.call, driverToken: 'driver-token'),
        storage: h.storage,
        remainingBucketM: 250,
      );

      expect(await revived.recover(const <Route>[]), isNull);
      expect(await h.storage.read(), isNull);
    });

    test('with nothing saved there is nothing to recover', () async {
      final h = _harness();
      expect(await h.controller.recover([_route()]), isNull);
      expect(h.controller.phase, TripPhase.choosing);
    });

    test('resuming when nothing was interrupted is a programming error', () {
      final h = _harness();
      expect(h.controller.resumeRecovered, throwsStateError);
    });
  });
}
