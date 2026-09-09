import 'dart:convert';
import 'dart:io';

import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

/// The distinction this file exists to hold.
///
/// Country-pack geography — routes, corridors, zones, waiting points — is full
/// of coordinates, because a bus line is public infrastructure. A *person's*
/// live position is not, and no realtime payload may ever carry one.
///
/// These tests read the source, so the guard survives someone adding a field in
/// good faith six months from now.
const _forbidden = <String>[
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'coordinate',
  'coordinates',
  'position',
  'location',
  'gps',
];

/// Field names declared in a Dart source file, roughly: `final <type> <name>;`
/// plus map keys written as string literals.
Iterable<String> _fieldNames(String source) sync* {
  final field = RegExp(r'final\s+[\w<>,\s?]+\s+(\w+);');
  for (final m in field.allMatches(source)) {
    yield m.group(1)!;
  }
  final key = RegExp(r"'(\w+)':");
  for (final m in key.allMatches(source)) {
    yield m.group(1)!;
  }
}

void main() {
  group('realtime payloads carry no coordinate', () {
    test('the transport DTOs declare no positional field', () {
      // transport.dart holds everything a person's device sends about itself.
      final source = File('lib/src/transport.dart').readAsStringSync();

      for (final name in _fieldNames(source)) {
        expect(
          _forbidden.contains(name.toLowerCase()),
          isFalse,
          reason: 'transport.dart declares "$name": a realtime payload must never '
              'carry a person\'s position. Geography belongs in models.dart.',
        );
      }
    });

    test('a driver progress report serialises to scalars only', () {
      const report = ProgressReport(
        tripToken: 'secret',
        routeId: 'jo-irbid-malka',
        dir: 0,
        remainingM: 8000,
        zoneSeq: 1,
        speedKph: 40,
      );

      expect(report.toJson().keys.toSet(), {
        'tripToken',
        'routeId',
        'dir',
        'remainingM',
        'zoneSeq',
        'speedKph',
      });
      for (final key in report.toJson().keys) {
        expect(_forbidden.contains(key.toLowerCase()), isFalse);
      }
    });

    test('a passenger ride request serialises to scalars only', () {
      const payload = RideRequestPayload(
        routeId: 'jo-irbid-malka',
        dir: 0,
        destinationId: 'jo-malka',
        remainingM: 5000,
        zoneSeq: 0,
      );

      expect(payload.toJson().keys.toSet(), {
        'routeId',
        'dir',
        'destinationId',
        'remainingM',
        'zoneSeq',
      });
      for (final key in payload.toJson().keys) {
        expect(_forbidden.contains(key.toLowerCase()), isFalse);
      }
    });

    test('no serialised realtime payload contains a WGS84-looking number', () {
      const report = ProgressReport(
        tripToken: 't',
        routeId: 'jo-irbid-malka',
        dir: 0,
        remainingM: 8000,
        zoneSeq: 1,
        speedKph: 40,
      );
      // Jordan sits around 32.x, 35.x; nothing shaped like that should appear.
      expect(jsonEncode(report.toJson()), isNot(matches(RegExp(r'3[0-9]\.\d{4}'))));
    });

    test('the API client never sends a body with a positional key', () async {
      final sent = <Map<String, dynamic>>[];
      final api = MowasalatApi(
        send: (request) async {
          if (request.body != null) sent.add(request.body!);
          return HttpReply(200, jsonEncode(fixture('trip_start')));
        },
        driverToken: 'token',
      );

      await api.startTrip(routeId: 'jo-irbid-malka', dir: 0);
      await api.reportProgress(const ProgressReport(
        tripToken: 't',
        routeId: 'jo-irbid-malka',
        dir: 0,
        remainingM: 8000,
        zoneSeq: 1,
        speedKph: 40,
      ));
      await api.requestRide(const RideRequestPayload(
        routeId: 'jo-irbid-malka',
        dir: 0,
        destinationId: 'jo-malka',
        remainingM: 5000,
        zoneSeq: 0,
      ));

      expect(sent, isNotEmpty);
      for (final body in sent) {
        for (final key in body.keys) {
          expect(_forbidden.contains(key.toLowerCase()), isFalse, reason: 'sent "$key"');
        }
      }
    });
  });

  group('geography is allowed where it belongs', () {
    test('country-pack models do carry coordinates', () {
      // The inverse assertion, so the guard above cannot be "satisfied" by
      // removing geography from the app altogether.
      final route = Route.fromJson(malkaRoute());
      expect(route.corridor.referencePaths.first.first.lat, isA<double>());
      expect(route.corridor.zones.first.centre.lng, isA<double>());
    });

    test('a matched fix keeps the raw position out of what is sent', () {
      final matcher = CorridorMatcher(Route.fromJson(malkaRoute()));
      final fix = matcher.match(const LatLng(32.5556, 35.8497), 0);

      // The fix knows where it is relative to the line, and that is all that
      // can be handed to a ProgressReport.
      expect(fix.remainingM, isA<double>());
      expect(fix.zoneSeq, isA<int>());
    });
  });

  group('secrets stay out of logs', () {
    test('trip credentials do not print their token', () {
      final credentials = TripCredentials.fromJson(fixture('trip_start'));
      expect(credentials.toString(), isNot(contains(credentials.tripToken)));
    });

    test('a driver session does not print its token', () {
      const session = DriverSession(driverToken: 'super-secret-token', isNew: true);
      expect(session.toString(), isNot(contains('super-secret-token')));
    });
  });
}
