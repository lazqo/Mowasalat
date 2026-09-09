import 'dart:math' as math;

/// A WGS84 coordinate.
///
/// These exist only on this side of the wire. Nothing in [transport] carries
/// one: the phone does its own geometry and sends how far along a line it is.
class LatLng {
  const LatLng(this.lat, this.lng);

  final double lat;
  final double lng;

  @override
  String toString() => 'LatLng($lat, $lng)';
}

const double _earthRadiusM = 6371008.8;
const double _deg = math.pi / 180;

double haversineM(LatLng a, LatLng b) {
  final dLat = (b.lat - a.lat) * _deg;
  final dLng = (b.lng - a.lng) * _deg;
  final s = math.pow(math.sin(dLat / 2), 2) +
      math.cos(a.lat * _deg) * math.cos(b.lat * _deg) * math.pow(math.sin(dLng / 2), 2);
  return 2 * _earthRadiusM * math.asin(math.min(1, math.sqrt(s.toDouble())));
}

class _Local {
  const _Local(this.x, this.y);
  final double x;
  final double y;
}

/// Equirectangular projection about [origin]. Over a corridor tens of
/// kilometres across at Jordanian latitudes the error is well under a metre,
/// far finer than any distance this system reports.
_Local _toLocal(LatLng p, LatLng origin) {
  final cosLat = math.cos(origin.lat * _deg);
  return _Local(
    (p.lng - origin.lng) * _deg * _earthRadiusM * cosLat,
    (p.lat - origin.lat) * _deg * _earthRadiusM,
  );
}

/// Where a point falls relative to a path.
class PathFix {
  const PathFix({required this.alongM, required this.offsetM});

  /// Distance from the path start to the projected point.
  final double alongM;

  /// Perpendicular distance from the query point to the path.
  final double offsetM;
}

/// A reference path with cumulative distances precomputed once.
class PathIndex {
  PathIndex(this.points)
      : assert(points.length >= 2, 'a path needs at least two points'),
        _origin = points.first,
        _local = <_Local>[],
        cumulativeM = <double>[0] {
    for (final p in points) {
      _local.add(_toLocal(p, _origin));
    }
    for (var i = 1; i < points.length; i++) {
      cumulativeM.add(cumulativeM[i - 1] + haversineM(points[i - 1], points[i]));
    }
  }

  final List<LatLng> points;
  final LatLng _origin;
  final List<_Local> _local;
  final List<double> cumulativeM;

  double get totalM => cumulativeM.last;

  /// Projects a point onto the nearest segment of this path.
  PathFix nearest(LatLng p) {
    final q = _toLocal(p, _origin);
    var bestAlong = 0.0;
    var bestOffset = double.infinity;

    for (var i = 0; i < _local.length - 1; i++) {
      final a = _local[i];
      final b = _local[i + 1];
      final dx = b.x - a.x;
      final dy = b.y - a.y;
      final len2 = dx * dx + dy * dy;

      // Clamped position along the segment: 0 at a, 1 at b.
      final t = len2 == 0
          ? 0.0
          : math.max(0.0, math.min(1.0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));

      final px = a.x + t * dx;
      final py = a.y + t * dy;
      final offset = math.sqrt(math.pow(q.x - px, 2) + math.pow(q.y - py, 2));

      if (offset < bestOffset) {
        bestOffset = offset;
        bestAlong = cumulativeM[i] + t * (cumulativeM[i + 1] - cumulativeM[i]);
      }
    }
    return PathFix(alongM: bestAlong, offsetM: bestOffset);
  }
}
