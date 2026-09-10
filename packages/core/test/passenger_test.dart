import 'dart:convert';

import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

/// The real network, as a passenger's phone caches it.
List<Route> _network() => (fixture('routes')['routes'] as List<dynamic>)
    .map((r) => Route.fromJson(r as Map<String, dynamic>))
    .toList(growable: false);

Route _malka() => _network().firstWhere((r) => r.id == 'jo-irbid-malka');

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
      '/v1/buses' => HttpReply(200, jsonEncode(fixture('buses'))),
      '/v1/requests' => HttpReply(200, jsonEncode(fixture('ride_request'))),
      '/v1/requests/cancel' => HttpReply(200, jsonEncode({'cancelled': true})),
      '/v1/requests/boarded' => HttpReply(200, jsonEncode({'ok': true})),
      _ => HttpReply(404, jsonEncode({'error': 'not found'})),
    };
  }
}

({PassengerController controller, _FakeBackend backend}) _harness({int Function()? now}) {
  final backend = _FakeBackend();
  return (
    controller: PassengerController(
      api: MowasalatApi(send: backend.call),
      network: _network(),
      remainingBucketM: 250,
      now: now,
    ),
    backend: backend,
  );
}

void main() {
  group('finding a place by what she typed', () {
    test('spelling differences that are not meaning differences still match', () {
      // Each of these is how a real person might type ملكا.
      for (final typed in ['ملكا', 'ملكة', 'مَلكا', 'الملكا', 'ملكـا']) {
        expect(matchesPlace(typed, 'ملكا'), isTrue, reason: 'failed on "$typed"');
      }
    });

    test('a different village does not match', () {
      expect(matchesPlace('أم قيس', 'ملكا'), isFalse);
      expect(matchesPlace('حبراص', 'كفرسوم'), isFalse);
      expect(matchesPlace('سما الروسان', 'كفرسوم'), isFalse);
    });

    test('the typo tolerance does not confuse two real pilot villages', () {
      // Every pair of destinations in the pilot network must stay distinct.
      const villages = ['ملكا', 'سما الروسان', 'كفرسوم', 'حبراص', 'أم قيس'];
      for (final a in villages) {
        for (final b in villages) {
          if (a == b) continue;
          expect(matchesPlace(a, b), isFalse, reason: '"$a" matched "$b"');
        }
      }
    });

    test('folding is idempotent and strips the article', () {
      expect(foldArabic('الملكا'), foldArabic('ملكا'));
      expect(foldArabic(foldArabic('أُمّ قيس')), foldArabic('أُمّ قيس'));
    });

    test('an empty query matches nothing rather than everything', () {
      expect(matchesPlace('', 'ملكا'), isFalse);
      expect(matchesPlace('   ', 'ملكا'), isFalse);
    });

    test('the destination list covers the pilot network', () {
      final destinations = _harness().controller.destinations();
      expect(destinations, hasLength(5));
      expect(destinations.map((d) => d.nameAr), contains('ملكا'));
      expect(destinations.map((d) => d.nameAr), contains('أم قيس'));
    });

    test('search narrows the list', () {
      final found = _harness().controller.destinations(query: 'ملكة');
      expect(found, hasLength(1));
      expect(found.single.id, 'jo-malka');
      expect(found.single.routeIds, contains('jo-irbid-malka'));
    });
  });

  group('which line would take her there', () {
    test('standing at the Irbid end, the line towards Malka is offered', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;

      final rides = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid);
      expect(rides, isNotEmpty);
      expect(rides.first.route.id, 'jo-irbid-malka');
      expect(rides.first.dir, 0, reason: 'towards Malka');
    });

    test('standing past her destination is not a ride', () {
      // At Malka itself, going to Malka: nothing is ahead of her.
      final h = _harness();
      final malka = _malka().corridor.zones.last.centre;

      expect(h.controller.ridesFor(destinationId: 'jo-malka', position: malka), isEmpty);
    });

    test('somewhere off every corridor offers nothing', () {
      final h = _harness();
      expect(
        h.controller.ridesFor(destinationId: 'jo-malka', position: const LatLng(31.9, 36.5)),
        isEmpty,
      );
    });

    test('a destination no line serves offers nothing', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      expect(h.controller.ridesFor(destinationId: 'jo-nowhere', position: irbid), isEmpty);
    });

    test('her own distance is computed locally, never asked for', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      expect(ride.remainingM, greaterThan(5000), reason: 'the line is kilometres long');
      expect(h.backend.sent, isEmpty, reason: 'no request was made to work this out');
    });
  });

  group('seeing the buses', () {
    test('a lookup returns sightings and a stream ticket', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final result = await h.controller.busesFor(ride);
      expect(result.streamTicket, isNotEmpty);
      expect(result.buses, isNotEmpty);
      expect(result.buses.first.pseudonym, isNotEmpty);
    });

    test('the position sent is bucketed', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;
      await h.controller.busesFor(ride);

      final body = h.backend.sent.single.body!;
      expect((body['remainingM']! as double) % 250, 0);
      expect(jsonEncode(body), isNot(contains('lat')));
    });

    test('the gap and the ETA are worked out on the phone', () {
      // Which is why a passenger watching a stream never sends her position.
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final sightings = h.controller.sightingsFrom([
        {'pseudonym': 'a', 'remainingM': ride.remainingM + 3000, 'speedKph': 40.0},
      ], ride);

      expect(sightings, hasLength(1));
      expect(sightings.single.gapM, closeTo(3000, 1));
      expect(sightings.single.etaSeconds, closeTo(270, 1));
      expect(sightings.single.etaText, 'بعد 5 دقايق');
    });

    test('a bus that has already passed her is not shown', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final sightings = h.controller.sightingsFrom([
        {'pseudonym': 'gone', 'remainingM': ride.remainingM - 1000, 'speedKph': 40.0},
      ], ride);
      expect(sightings, isEmpty);
    });

    test('a bus far beyond the window is not shown', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final sightings = h.controller.sightingsFrom([
        {'pseudonym': 'far', 'remainingM': ride.remainingM + 40000, 'speedKph': 40.0},
      ], ride);
      expect(sightings, isEmpty);
    });

    test('a stopped bus is shown without a made-up arrival time', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final sightings = h.controller.sightingsFrom([
        {'pseudonym': 'stopped', 'remainingM': ride.remainingM + 2000, 'speedKph': 0.0},
      ], ride);

      expect(sightings.single.etaSeconds, isNull);
      expect(sightings.single.etaText, 'الباص واقف');
    });

    test('the nearest bus is listed first', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final sightings = h.controller.sightingsFrom([
        {'pseudonym': 'far', 'remainingM': ride.remainingM + 8000, 'speedKph': 40.0},
        {'pseudonym': 'near', 'remainingM': ride.remainingM + 1000, 'speedKph': 40.0},
      ], ride);

      expect(sightings.map((s) => s.pseudonym), ['near', 'far']);
    });

    test('a real stream snapshot parses into sightings', () {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final buses = (fixture('stream_buses')['buses'] as List<dynamic>)
          .cast<Map<String, dynamic>>();
      // Whether it is ahead of her depends on where she stands; what matters is
      // that a captured payload feeds straight through without reshaping.
      expect(() => h.controller.sightingsFrom(buses, ride), returnsNormally);
    });
  });

  group('waiting', () {
    test('أنا مستني هون records a request and nothing about her', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      final pseudonym = await h.controller.requestRide(ride);
      expect(pseudonym, isNotEmpty);
      expect(h.controller.state, WaitState.waiting);

      final body = h.backend.sent.last.body!;
      expect(body.keys.toSet(), {'routeId', 'dir', 'destinationId', 'remainingM', 'zoneSeq'});
      expect(h.backend.sent.last.bearer, isNull, reason: 'she has no account at all');
    });

    test('she cannot be waiting twice', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      await h.controller.requestRide(ride);
      await expectLater(h.controller.requestRide(ride), throwsStateError);
    });

    test('the request expires on its own, as the backend drops it', () async {
      var clock = 1000;
      final h = _harness(now: () => clock);
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      await h.controller.requestRide(ride);
      expect(h.controller.timeLeft.inMinutes, 20);

      clock += PassengerController.requestLifetime.inMilliseconds + 1;
      expect(h.controller.hasExpired, isTrue);
      expect(h.controller.refresh(), WaitState.expired);
      expect(h.controller.timeLeft, Duration.zero);
    });

    test('إلغاء clears it here and there', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      await h.controller.requestRide(ride);
      await h.controller.cancel();

      expect(h.controller.state, WaitState.cancelled);
      expect(h.controller.requestPseudonym, isNull);
      expect(h.backend.sent.map((r) => r.path), contains('/v1/requests/cancel'));
    });

    test('ركبت closes the request', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      await h.controller.requestRide(ride);
      await h.controller.boarded();

      expect(h.controller.state, WaitState.boarded);
      expect(h.controller.chosenRide, isNull);
      expect(h.backend.sent.map((r) => r.path), contains('/v1/requests/boarded'));
    });

    test('a backend that has already forgotten her still clears locally', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      await h.controller.requestRide(ride);
      h.backend.failNextWith = 400;
      await h.controller.cancel();

      expect(h.controller.state, WaitState.cancelled);
      expect(h.controller.requestPseudonym, isNull);
    });

    test('cancelling when she never asked is harmless', () async {
      final h = _harness();
      await h.controller.cancel();
      expect(h.controller.state, WaitState.idle);
    });

    test('reset returns her to وين رايح؟', () async {
      final h = _harness();
      final irbid = _malka().corridor.zones.first.centre;
      final ride = h.controller.ridesFor(destinationId: 'jo-malka', position: irbid).first;

      await h.controller.requestRide(ride);
      await h.controller.boarded();
      h.controller.reset();

      expect(h.controller.state, WaitState.idle);
    });
  });
}
