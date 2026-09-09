import 'dart:math' as math;

import 'geo.dart';
import 'models.dart';

/// Where the phone has decided it is, relative to the line being driven.
///
/// This is the only positional thing that ever leaves the device, and it is
/// three numbers: how far is left, which zone, how fast.
class CorridorFix {
  const CorridorFix({
    required this.inside,
    required this.remainingM,
    required this.zoneSeq,
    required this.offsetM,
    required this.pathIndex,
  });

  /// False when the device is further than the corridor's width from every
  /// reference path. A driver outside it reports nothing at all, so a detour is
  /// invisible by construction rather than by policy.
  final bool inside;

  /// Road distance still to cover to this direction's endpoint.
  ///
  /// This replaces "progress along a fixed line", which the corridor makes
  /// unworkable: two drivers taking different roads share no line to measure
  /// along, but they share the distance left, and that is monotonic whichever
  /// road is taken.
  final double remainingM;

  final int zoneSeq;

  /// How far from the nearest reference path. Diagnostic only; never sent.
  final double offsetM;

  /// Which reference path was nearest — a line may have known alternatives.
  final int pathIndex;
}

/// A line's geometry, indexed once so matching is cheap enough to run on every
/// GPS sample on a slow phone.
class CorridorMatcher {
  CorridorMatcher(this.route)
      : _paths = route.corridor.referencePaths.map(PathIndex.new).toList(growable: false) {
    _zoneAlong = _paths
        .map((path) => route.corridor.zones
            .map((z) => path.nearest(z.centre).alongM)
            .toList(growable: false))
        .toList(growable: false);
  }

  final Route route;
  final List<PathIndex> _paths;
  late final List<List<double>> _zoneAlong;

  double get widthM => route.corridor.widthM;

  /// Places a raw GPS reading against the line. Runs entirely on the device.
  CorridorFix match(LatLng position, Direction dir) {
    var pathIndex = 0;
    var alongM = 0.0;
    var offsetM = double.infinity;

    for (var i = 0; i < _paths.length; i++) {
      final fix = _paths[i].nearest(position);
      if (fix.offsetM < offsetM) {
        offsetM = fix.offsetM;
        alongM = fix.alongM;
        pathIndex = i;
      }
    }

    final total = _paths[pathIndex].totalM;
    final remaining = dir == 0 ? total - alongM : alongM;

    return CorridorFix(
      inside: offsetM <= widthM,
      remainingM: remaining,
      zoneSeq: _zoneSeqAt(alongM, pathIndex, position),
      offsetM: offsetM,
      pathIndex: pathIndex,
    );
  }

  /// A point inside a zone's own radius takes that zone; otherwise it takes the
  /// last zone it has passed.
  int _zoneSeqAt(double alongM, int pathIndex, LatLng position) {
    final zones = route.corridor.zones;
    if (zones.isEmpty) return 0;

    for (final z in zones) {
      if (haversineM(position, z.centre) <= z.radiusM) return z.seq;
    }

    final alongs = _zoneAlong[pathIndex];
    var seq = zones.first.seq;
    for (var i = 0; i < zones.length; i++) {
      if (alongs[i] <= alongM) seq = zones[i].seq;
    }
    return seq;
  }

  /// The name of the zone a fix falls in, for the driver's screen.
  String? zoneName(int seq) {
    for (final z in route.corridor.zones) {
      if (z.seq == seq) return z.nameAr;
    }
    return null;
  }

  /// The nearest recognised waiting point to a remaining-distance, so a pin can
  /// be shown as "٢ ركاب عند مفرق ملكا" rather than a bare number.
  WaitPoint? waitPointNear(double remainingM, Direction dir, {double toleranceM = 400}) {
    WaitPoint? best;
    var bestDelta = double.infinity;

    for (final w in route.waitPoints) {
      final fix = match(w.location, dir);
      final delta = (fix.remainingM - remainingM).abs();
      if (delta < bestDelta) {
        bestDelta = delta;
        best = w;
      }
    }
    return bestDelta <= toleranceM ? best : null;
  }
}

/// Smooths speed so one bad GPS sample does not swing the ETA a passenger sees.
///
/// An exponential moving average rather than a window, because it costs one
/// number instead of a list — which matters on the hardware this targets.
class SpeedSmoother {
  SpeedSmoother({this.alpha = 0.3, this.maxPlausibleKph = 140});

  final double alpha;
  final double maxPlausibleKph;
  double? _value;

  double get current => _value ?? 0;

  double add(double sampleKph) {
    if (sampleKph.isNaN || sampleKph < 0 || sampleKph > maxPlausibleKph) {
      // Implausible readings are discarded rather than smoothed in; a bus does
      // not do 300 km/h to Malka.
      return current;
    }
    _value = _value == null ? sampleKph : alpha * sampleKph + (1 - alpha) * _value!;
    return _value!;
  }

  void reset() => _value = null;
}

/// Rounds a remaining-distance down to the country's band before it is sent.
/// The backend refuses anything finer, so this is not decoration.
double bucketRemaining(double remainingM, double bucketM) {
  if (bucketM <= 0) throw ArgumentError.value(bucketM, 'bucketM', 'must be positive');
  return (remainingM / bucketM).floor() * bucketM;
}

/// Whether the phone is moving, which decides how often it speaks.
bool isMoving(double speedKph, {double thresholdKph = 3}) => speedKph >= thresholdKph;

/// How long to wait before the next report.
///
/// Every five seconds while moving, every thirty when stopped. Nothing at all
/// off-corridor — silence is what keeps a detour private, and it also spares
/// the radio.
Duration reportingInterval({required bool inside, required double speedKph}) {
  if (!inside) return Duration.zero;
  return isMoving(speedKph) ? const Duration(seconds: 5) : const Duration(seconds: 30);
}

/// Distances as a driver would say them: ٢ كم, not 2000 m.
String humaniseDistance(double metres) {
  if (metres < 950) {
    final rounded = (metres / 100).round() * 100;
    return '$rounded م';
  }
  final km = metres / 1000;
  final text = km >= 10 ? km.round().toString() : km.toStringAsFixed(1);
  return '$text كم';
}

/// "٣ ركاب بعد ٢ كم" — how many, how far, and nothing else.
String describePin(WaitingPin pin, double driverRemainingM, {String? waitPointName}) {
  final ahead = math.max(0.0, driverRemainingM - pin.remainingM);
  final who = pin.count == 1 ? 'راكب' : 'ركاب';
  return waitPointName == null
      ? '${pin.count} $who بعد ${humaniseDistance(ahead)}'
      : '${pin.count} $who عند $waitPointName';
}
