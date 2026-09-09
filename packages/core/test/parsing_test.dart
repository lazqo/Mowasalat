import 'dart:convert';

import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

void main() {
  group('parsing real backend responses', () {
    test('a driver and his assigned lines load from /v1/driver/me', () {
      final json = fixture('driver_me');
      final driver = DriverProfile.fromJson(json['driver'] as Map<String, dynamic>);

      expect(driver.id, startsWith('drv-'));
      expect(driver.phoneMasked, startsWith('•••'));
      expect(driver.tier, 0);
      expect(driver.isBlocked, isFalse);
      expect(driver.routeIds, hasLength(2));

      final routes = (json['routes'] as List<dynamic>)
          .map((r) => Route.fromJson(r as Map<String, dynamic>))
          .toList();
      expect(routes.map((r) => r.nameAr), contains('إربد – ملكا'));
    });

    test('a line carries its corridor, zones and geometry', () {
      final route = Route.fromJson(malkaRoute());

      expect(route.id, 'jo-irbid-malka');
      expect(route.originNameAr, 'إربد');
      expect(route.destinationNameAr, 'ملكا');
      expect(route.bidirectional, isTrue);
      expect(route.corridor.widthM, greaterThan(0));
      expect(route.corridor.referencePaths, isNotEmpty);
      expect(route.corridor.referencePaths.first.length, greaterThanOrEqualTo(2));
      expect(route.corridor.zones.first.kind, ZoneKind.originHub);
      expect(route.corridor.zones.last.kind, ZoneKind.destination);
    });

    test('the line is labelled the way a driver reads it', () {
      final route = Route.fromJson(malkaRoute());
      expect(route.headingFor(0), 'ملكا');
      expect(route.headingFor(1), 'إربد');
      expect(route.labelFor(0), 'إربد ← ملكا');
      expect(route.labelFor(1), 'ملكا ← إربد');
    });

    test('an OTP challenge parses, and development exposes the code', () {
      final challenge = OtpChallenge.fromJson(fixture('otp_request'));
      expect(challenge.challengeId, isNotEmpty);
      expect(challenge.expiresInSeconds, 300);
      expect(challenge.channel, 'development');
      expect(challenge.devCode, isNotNull);
      expect(challenge.isManualDelivery, isFalse);
    });

    test('a manual-delivery channel is recognised, for markets without SMS', () {
      final challenge = OtpChallenge.fromJson({
        'challengeId': 'x',
        'channel': 'manual_vouch',
        'expiresInSeconds': 300,
      });
      expect(challenge.isManualDelivery, isTrue);
      expect(challenge.devCode, isNull);
    });

    test('trip credentials parse and keep the token out of toString', () {
      final credentials = TripCredentials.fromJson(fixture('trip_start'));
      expect(credentials.tripToken, isNotEmpty);
      expect(credentials.pseudonym, isNotEmpty);
      // A stray print must not hand someone else's bus away.
      expect(credentials.toString(), isNot(contains(credentials.tripToken)));
      expect(credentials.toString(), contains(credentials.pseudonym));
    });

    test('waiting pins parse from a real stream snapshot', () {
      final snapshot = fixture('stream_waiting');
      final pins = (snapshot['pins'] as List<dynamic>)
          .map((p) => WaitingPin.fromJson(p as Map<String, dynamic>))
          .toList();

      expect(pins, isNotEmpty);
      expect(pins.first.count, greaterThan(0));
      expect(pins.first.remainingM, greaterThan(0));
    });

    test('error shapes parse into a usable exception', () {
      final notAssigned = ApiException.fromResponse(400, jsonEncode(fixture('error_not_assigned')));
      expect(notAssigned.message, contains('not assigned'));

      final unbucketed = ApiException.fromResponse(400, jsonEncode(fixture('error_unbucketed')));
      expect(unbucketed.message, contains('more precise'));

      final badPhone = ApiException.fromResponse(400, jsonEncode(fixture('error_invalid_phone')));
      expect(badPhone.code, 'invalid_phone');

      final coordinate = ApiException.fromResponse(400, jsonEncode(fixture('error_coordinate')));
      expect(coordinate.message, contains('coordinates are never accepted'));
    });

    test('a body that is not JSON does not crash the client', () {
      final broken = ApiException.fromResponse(502, '<html>gateway</html>');
      expect(broken.status, 502);
      expect(broken.message, isNotEmpty);
    });
  });
}
