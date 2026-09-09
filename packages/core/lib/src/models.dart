import 'geo.dart';

/// 0 is origin to destination; 1 is the way back.
typedef Direction = int;

enum ZoneKind { originHub, intermediate, destination }

ZoneKind _zoneKind(String raw) => switch (raw) {
      'origin_hub' => ZoneKind.originHub,
      'destination' => ZoneKind.destination,
      _ => ZoneKind.intermediate,
    };

/// An ordered area along a corridor: the hub, a village, the destination.
class Zone {
  const Zone({
    required this.seq,
    required this.nameAr,
    required this.kind,
    required this.centre,
    required this.radiusM,
  });

  factory Zone.fromJson(Map<String, dynamic> json) => Zone(
        seq: (json['seq'] as num).toInt(),
        nameAr: json['nameAr'] as String,
        kind: _zoneKind(json['kind'] as String),
        centre: LatLng(
          (json['centre'] as Map<String, dynamic>)['lat'] as double,
          (json['centre'] as Map<String, dynamic>)['lng'] as double,
        ),
        radiusM: (json['radiusM'] as num).toDouble(),
      );

  final int seq;
  final String nameAr;
  final ZoneKind kind;
  final LatLng centre;
  final double radiusM;
}

/// A place people actually stand: a junction, a village entrance, a shop.
class WaitPoint {
  const WaitPoint({
    required this.id,
    required this.nameAr,
    required this.location,
    required this.zoneSeq,
  });

  factory WaitPoint.fromJson(Map<String, dynamic> json) => WaitPoint(
        id: json['id'] as String,
        nameAr: json['nameAr'] as String,
        location: LatLng(
          (json['location'] as Map<String, dynamic>)['lat'] as double,
          (json['location'] as Map<String, dynamic>)['lng'] as double,
        ),
        zoneSeq: (json['zoneSeq'] as num).toInt(),
      );

  final String id;
  final String nameAr;
  final LatLng location;
  final int zoneSeq;
}

/// The geography of a line. Internal: never shown to a driver or a passenger.
///
/// [widthM] comes from the country pack, not from a constant here, so Phase 0
/// can widen it from real Irbid traces without an app release.
class Corridor {
  const Corridor({
    required this.widthM,
    required this.referencePaths,
    required this.zones,
  });

  factory Corridor.fromJson(Map<String, dynamic> json) => Corridor(
        widthM: (json['widthM'] as num).toDouble(),
        referencePaths: (json['referencePaths'] as List<dynamic>)
            .map((path) => (path as List<dynamic>)
                .map((p) => LatLng(
                      (p as Map<String, dynamic>)['lat'] as double,
                      p['lng'] as double,
                    ))
                .toList(growable: false))
            .toList(growable: false),
        zones: (json['zones'] as List<dynamic>)
            .map((z) => Zone.fromJson(z as Map<String, dynamic>))
            .toList(growable: false),
      );

  final double widthM;
  final List<List<LatLng>> referencePaths;
  final List<Zone> zones;
}

class ServedDestination {
  const ServedDestination({required this.id, required this.nameAr, required this.zoneSeq});

  factory ServedDestination.fromJson(Map<String, dynamic> json) => ServedDestination(
        id: json['id'] as String,
        nameAr: json['nameAr'] as String,
        zoneSeq: (json['zoneSeq'] as num).toInt(),
      );

  final String id;
  final String nameAr;
  final int zoneSeq;
}

/// A named transport line: إربد – ملكا. An origin, a destination, two
/// directions. Not a street-by-street path.
class Route {
  const Route({
    required this.id,
    required this.nameAr,
    required this.originNameAr,
    required this.destinationNameAr,
    required this.bidirectional,
    required this.provisional,
    required this.corridor,
    required this.servedDestinations,
    required this.waitPoints,
  });

  factory Route.fromJson(Map<String, dynamic> json) => Route(
        id: json['id'] as String,
        nameAr: json['nameAr'] as String,
        originNameAr: json['originNameAr'] as String,
        destinationNameAr: json['destinationNameAr'] as String,
        bidirectional: json['bidirectional'] as bool? ?? true,
        provisional: json['provisional'] as bool? ?? false,
        corridor: Corridor.fromJson(json['corridor'] as Map<String, dynamic>),
        servedDestinations: (json['servedDestinations'] as List<dynamic>? ?? <dynamic>[])
            .map((d) => ServedDestination.fromJson(d as Map<String, dynamic>))
            .toList(growable: false),
        waitPoints: (json['waitPoints'] as List<dynamic>? ?? <dynamic>[])
            .map((w) => WaitPoint.fromJson(w as Map<String, dynamic>))
            .toList(growable: false),
      );

  final String id;
  final String nameAr;
  final String originNameAr;
  final String destinationNameAr;
  final bool bidirectional;
  final bool provisional;
  final Corridor corridor;
  final List<ServedDestination> servedDestinations;
  final List<WaitPoint> waitPoints;

  /// What the driver is asked: وين رايح؟ — the far end of the direction.
  String headingFor(Direction dir) => dir == 0 ? destinationNameAr : originNameAr;

  /// إربد ← ملكا, written the way it is read.
  String labelFor(Direction dir) =>
      dir == 0 ? '$originNameAr ← $destinationNameAr' : '$destinationNameAr ← $originNameAr';
}

/// What a driver's own app may know about him. Never his phone number.
class DriverProfile {
  const DriverProfile({
    required this.id,
    required this.phoneMasked,
    required this.tier,
    required this.status,
    required this.routeIds,
    this.vouchedBy,
  });

  factory DriverProfile.fromJson(Map<String, dynamic> json) => DriverProfile(
        id: json['id'] as String,
        phoneMasked: json['phoneMasked'] as String,
        tier: (json['tier'] as num).toInt(),
        status: json['status'] as String,
        routeIds: (json['routeIds'] as List<dynamic>).cast<String>(),
        vouchedBy: json['vouchedBy'] as String?,
      );

  final String id;
  final String phoneMasked;
  final int tier;
  final String status;
  final List<String> routeIds;
  final String? vouchedBy;

  bool get isBlocked => status == 'blocked';
}

/// A group of people waiting, never a person. No name, no identity, no count of
/// one that could single somebody out beyond what the backend already blurred.
class WaitingPin {
  const WaitingPin({required this.count, required this.remainingM, required this.zoneSeq});

  factory WaitingPin.fromJson(Map<String, dynamic> json) => WaitingPin(
        count: (json['count'] as num).toInt(),
        remainingM: (json['remainingM'] as num).toDouble(),
        zoneSeq: (json['zoneSeq'] as num).toInt(),
      );

  final int count;
  final double remainingM;
  final int zoneSeq;
}
