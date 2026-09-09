import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

/// A straight line north, standing in for a road, so the arithmetic is
/// checkable by hand. The real Irbid geometry is exercised separately below.
Route _straightLine({double widthM = 750}) => Route.fromJson({
      'id': 'test-line',
      'nameAr': 'خط تجريبي',
      'originNameAr': 'البداية',
      'destinationNameAr': 'النهاية',
      'bidirectional': true,
      'provisional': false,
      'corridor': {
        'widthM': widthM,
        'referencePaths': [
          [
            {'lat': 32.5, 'lng': 35.8},
            {'lat': 32.7, 'lng': 35.8},
          ]
        ],
        'zones': [
          {
            'seq': 0,
            'nameAr': 'البداية',
            'kind': 'origin_hub',
            'centre': {'lat': 32.5, 'lng': 35.8},
            'radiusM': 800,
          },
          {
            'seq': 1,
            'nameAr': 'الوسط',
            'kind': 'intermediate',
            'centre': {'lat': 32.6, 'lng': 35.8},
            'radiusM': 500,
          },
          {
            'seq': 2,
            'nameAr': 'النهاية',
            'kind': 'destination',
            'centre': {'lat': 32.7, 'lng': 35.8},
            'radiusM': 800,
          },
        ],
      },
      'servedDestinations': <dynamic>[],
      'waitPoints': <dynamic>[],
    });

void main() {
  group('corridor matching', () {
    test('a bus on the road is inside the corridor', () {
      final matcher = CorridorMatcher(_straightLine());
      final fix = matcher.match(const LatLng(32.62, 35.8), 0);

      expect(fix.inside, isTrue);
      expect(fix.offsetM, lessThan(5));
    });

    test('a driver on a parallel side road stays online', () {
      // About 470 m off the reference path: the case the old fixed 150 m
      // tolerance would have wrongly dropped.
      final matcher = CorridorMatcher(_straightLine());
      expect(matcher.match(const LatLng(32.6, 35.805), 0).inside, isTrue);
    });

    test('tolerance comes from the route data, not a constant in the app', () {
      // So Phase 0 can widen it from real Irbid traces without an app release.
      final tight = CorridorMatcher(_straightLine(widthM: 200));
      final generous = CorridorMatcher(_straightLine(widthM: 1500));
      const besideTheRoad = LatLng(32.6, 35.805);

      expect(tight.match(besideTheRoad, 0).inside, isFalse);
      expect(generous.match(besideTheRoad, 0).inside, isTrue);
    });

    test('a genuine deviation falls outside', () {
      final matcher = CorridorMatcher(_straightLine());
      expect(matcher.match(const LatLng(32.6, 35.83), 0).inside, isFalse);
    });

    test('remaining distance falls to zero at the destination and is monotonic', () {
      final matcher = CorridorMatcher(_straightLine());
      final atStart = matcher.match(const LatLng(32.5, 35.8), 0).remainingM;
      final atMiddle = matcher.match(const LatLng(32.6, 35.8), 0).remainingM;
      final atEnd = matcher.match(const LatLng(32.7, 35.8), 0).remainingM;

      expect(atStart, greaterThan(atMiddle));
      expect(atMiddle, greaterThan(atEnd));
      expect(atEnd, lessThan(1));
    });

    test('the reverse direction mirrors the forward one', () {
      final matcher = CorridorMatcher(_straightLine());
      const somewhere = LatLng(32.65, 35.8);
      final forward = matcher.match(somewhere, 0).remainingM;
      final reverse = matcher.match(somewhere, 1).remainingM;

      final total = matcher.match(const LatLng(32.5, 35.8), 0).remainingM;
      expect(forward + reverse, closeTo(total, 1));
    });

    test('zones resolve in order along the line', () {
      final matcher = CorridorMatcher(_straightLine());
      expect(matcher.match(const LatLng(32.5, 35.8), 0).zoneSeq, 0);
      expect(matcher.match(const LatLng(32.6, 35.8), 0).zoneSeq, 1);
      expect(matcher.match(const LatLng(32.7, 35.8), 0).zoneSeq, 2);
      // Past the middle zone's radius but short of the destination.
      expect(matcher.match(const LatLng(32.65, 35.8), 0).zoneSeq, 1);
      expect(matcher.zoneName(1), 'الوسط');
    });

    test('it works on the real Irbid–Malka geometry', () {
      final route = Route.fromJson(malkaRoute());
      final matcher = CorridorMatcher(route);
      final origin = route.corridor.zones.first.centre;
      final destination = route.corridor.zones.last.centre;

      final atOrigin = matcher.match(origin, 0);
      final atDestination = matcher.match(destination, 0);

      expect(atOrigin.inside, isTrue);
      expect(atDestination.inside, isTrue);
      expect(atOrigin.remainingM, greaterThan(5000), reason: 'the line is kilometres long');
      expect(atDestination.remainingM, lessThan(100));
    });
  });

  group('speed smoothing', () {
    test('one wild sample does not swing the reading', () {
      final smoother = SpeedSmoother();
      for (var i = 0; i < 5; i++) {
        smoother.add(40);
      }
      final before = smoother.current;
      smoother.add(300); // an implausible GPS spike
      expect(smoother.current, before, reason: 'discarded, not smoothed in');
    });

    test('it converges on a steady speed', () {
      final smoother = SpeedSmoother();
      for (var i = 0; i < 30; i++) {
        smoother.add(50);
      }
      expect(smoother.current, closeTo(50, 1));
    });

    test('negative and NaN readings are ignored', () {
      final smoother = SpeedSmoother();
      smoother.add(40);
      final before = smoother.current;
      smoother.add(-5);
      smoother.add(double.nan);
      expect(smoother.current, before);
    });

    test('it resets between trips', () {
      final smoother = SpeedSmoother()..add(60);
      smoother.reset();
      expect(smoother.current, 0);
    });
  });

  group('reporting policy', () {
    test('moving speaks every five seconds, stopped every thirty', () {
      expect(reportingInterval(inside: true, speedKph: 40), const Duration(seconds: 5));
      expect(reportingInterval(inside: true, speedKph: 0), const Duration(seconds: 30));
    });

    test('off the corridor it says nothing at all', () {
      // Silence is what keeps a detour private, and it spares the radio.
      expect(reportingInterval(inside: false, speedKph: 40), Duration.zero);
      expect(reportingInterval(inside: false, speedKph: 0), Duration.zero);
    });

    test('crawling counts as stopped', () {
      expect(isMoving(2), isFalse);
      expect(isMoving(4), isTrue);
    });
  });

  group('what the driver reads', () {
    test('positions are bucketed before they leave', () {
      expect(bucketRemaining(5123, 250), 5000);
      expect(bucketRemaining(5250, 250), 5250);
      expect(() => bucketRemaining(100, 0), throwsArgumentError);
    });

    test('distances are said the way a driver would say them', () {
      expect(humaniseDistance(180), '200 م');
      expect(humaniseDistance(2000), '2.0 كم');
      expect(humaniseDistance(12400), '12 كم');
    });

    test('a pin reads as a count and a distance, never a location', () {
      const pin = WaitingPin(count: 3, remainingM: 6000, zoneSeq: 1);
      expect(describePin(pin, 8000), '3 ركاب بعد 2.0 كم');

      const one = WaitingPin(count: 1, remainingM: 7000, zoneSeq: 1);
      expect(describePin(one, 8000), startsWith('1 راكب'));
    });

    test('a known waiting point is named instead of a distance', () {
      const pin = WaitingPin(count: 2, remainingM: 6000, zoneSeq: 1);
      expect(describePin(pin, 8000, waitPointName: 'مفرق ملكا'), '2 ركاب عند مفرق ملكا');
    });

    test('a pin behind the driver never reads as a negative distance', () {
      const behind = WaitingPin(count: 1, remainingM: 9000, zoneSeq: 1);
      expect(describePin(behind, 8000), isNot(contains('-')));
    });
  });
}
