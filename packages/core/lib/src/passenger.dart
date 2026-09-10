import 'dart:math' as math;

import 'api.dart';
import 'arabic.dart';
import 'corridor.dart';
import 'geo.dart';
import 'models.dart';
import 'transport.dart';

/// A place she can ask for, and every line that would take her there.
class DestinationOption {
  const DestinationOption({
    required this.id,
    required this.nameAr,
    required this.routeIds,
  });

  final String id;
  final String nameAr;
  final List<String> routeIds;
}

/// A bus she could catch, with the arithmetic done on her phone.
class BusSighting {
  const BusSighting({
    required this.pseudonym,
    required this.routeId,
    required this.dir,
    required this.gapM,
    required this.etaSeconds,
  });

  final String pseudonym;
  final String routeId;
  final int dir;

  /// How far the bus still has to travel before it reaches her.
  final double gapM;

  /// Null when the bus is stopped, because a number would be a guess.
  final double? etaSeconds;

  /// "بعد ٦ دقايق"
  String get etaText {
    if (etaSeconds == null) return 'الباص واقف';
    final minutes = (etaSeconds! / 60).round();
    if (minutes <= 1) return 'وصل تقريباً';
    return 'بعد $minutes دقايق';
  }
}

/// Which line, and which way, would take her where she is going.
class RideOption {
  const RideOption({
    required this.route,
    required this.dir,
    required this.remainingM,
    required this.zoneSeq,
    required this.destinationId,
  });

  final Route route;
  final Direction dir;

  /// Her own distance from that direction's endpoint, computed locally.
  final double remainingM;
  final int zoneSeq;
  final String destinationId;
}

/// Where a waiting passenger is in the one interaction she has.
enum WaitState { idle, waiting, boarded, cancelled, expired }

/// A passenger's whole journey through the app.
///
/// She has no account and sends no coordinate: her phone holds the network,
/// works out which lines pass her and how far along she stands, and sends only
/// that.
class PassengerController {
  PassengerController({
    required MowasalatApi api,
    required List<Route> network,
    required double remainingBucketM,
    int Function()? now,
  })  : _api = api,
        _network = network,
        _bucketM = remainingBucketM,
        _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  static const requestLifetime = Duration(minutes: 20);

  final MowasalatApi _api;
  final List<Route> _network;
  final double _bucketM;
  final int Function() _now;

  final Map<String, CorridorMatcher> _matchers = <String, CorridorMatcher>{};

  WaitState _state = WaitState.idle;
  String? _pseudonym;
  RideOption? _riding;
  int _requestedAtMs = 0;

  WaitState get state => _state;
  String? get requestPseudonym => _pseudonym;
  RideOption? get chosenRide => _riding;

  CorridorMatcher _matcherFor(Route route) =>
      _matchers.putIfAbsent(route.id, () => CorridorMatcher(route));

  /// Everywhere the network can take her, for the وين رايح؟ tiles and search.
  List<DestinationOption> destinations({String? query}) {
    final byId = <String, List<String>>{};
    final names = <String, String>{};

    for (final route in _network) {
      for (final served in route.servedDestinations) {
        names[served.id] = served.nameAr;
        byId.putIfAbsent(served.id, () => <String>[]).add(route.id);
      }
    }

    final options = byId.entries
        .map((e) => DestinationOption(id: e.key, nameAr: names[e.key]!, routeIds: e.value))
        .toList()
      ..sort((a, b) => a.nameAr.compareTo(b.nameAr));

    if (query == null || query.trim().isEmpty) return options;
    return options.where((o) => matchesPlace(query, o.nameAr)).toList(growable: false);
  }

  /// Which lines would actually pick her up, given where she is standing.
  ///
  /// A line only counts when her destination is still *ahead* of her on it —
  /// standing past the village she wants is not a ride, it is a walk back.
  List<RideOption> ridesFor({required String destinationId, required LatLng position}) {
    final options = <RideOption>[];

    for (final route in _network) {
      final serves = route.servedDestinations.where((d) => d.id == destinationId);
      if (serves.isEmpty) continue;

      final matcher = _matcherFor(route);
      final destinationZone = serves.first.zoneSeq;
      final destinationCentre = _zoneCentre(route, destinationZone);
      if (destinationCentre == null) continue;

      for (final dir in <Direction>[0, 1]) {
        final mine = matcher.match(position, dir);
        if (!mine.inside) continue;

        // Her destination is ahead when it has less left to run than she does.
        final theirs = matcher.match(destinationCentre, dir);
        if (theirs.remainingM >= mine.remainingM) continue;

        options.add(RideOption(
          route: route,
          dir: dir,
          remainingM: mine.remainingM,
          zoneSeq: mine.zoneSeq,
          destinationId: destinationId,
        ));
      }
    }

    // The shortest ride first: the line whose endpoint she is nearest.
    options.sort((a, b) => a.remainingM.compareTo(b.remainingM));
    return options;
  }

  LatLng? _zoneCentre(Route route, int seq) {
    for (final z in route.corridor.zones) {
      if (z.seq == seq) return z.centre;
    }
    return null;
  }

  /// Asks which buses are running, and keeps the ticket that lets her watch.
  Future<({List<BusSighting> buses, String streamTicket})> busesFor(RideOption ride) async {
    final result = await _api.findBuses(
      routeId: ride.route.id,
      dir: ride.dir,
      remainingM: bucketRemaining(ride.remainingM, _bucketM),
      zoneSeq: ride.zoneSeq,
    );

    return (
      buses: result.buses
          .map((b) => BusSighting(
                pseudonym: b['pseudonym'] as String,
                routeId: ride.route.id,
                dir: ride.dir,
                gapM: (b['gapM'] as num).toDouble(),
                etaSeconds: (b['etaSeconds'] as num?)?.toDouble(),
              ))
          .toList(growable: false),
      streamTicket: result.streamTicket,
    );
  }

  /// Turns a stream snapshot into sightings.
  ///
  /// The stream sends bus scalars, not answers: the gap and the ETA are worked
  /// out here, which is also why she never has to send her position to watch.
  List<BusSighting> sightingsFrom(
    List<Map<String, dynamic>> buses,
    RideOption ride, {
    double windowM = 15000,
  }) {
    final sightings = <BusSighting>[];

    for (final bus in buses) {
      final busRemaining = (bus['remainingM'] as num).toDouble();
      final speedKph = (bus['speedKph'] as num?)?.toDouble() ?? 0;

      // A bus passes her only if it still has further to go than she does.
      final gap = busRemaining - ride.remainingM;
      if (gap <= 0 || gap > windowM) continue;

      sightings.add(BusSighting(
        pseudonym: bus['pseudonym'] as String,
        routeId: ride.route.id,
        dir: ride.dir,
        gapM: gap,
        etaSeconds: speedKph < 3 ? null : (gap / (speedKph * 1000)) * 3600,
      ));
    }

    sightings.sort((a, b) => a.gapM.compareTo(b.gapM));
    return sightings;
  }

  /// أنا مستني هون.
  Future<String> requestRide(RideOption ride) async {
    if (_state == WaitState.waiting) throw StateError('already waiting');

    final pseudonym = await _api.requestRide(RideRequestPayload(
      routeId: ride.route.id,
      dir: ride.dir,
      destinationId: ride.destinationId,
      remainingM: bucketRemaining(ride.remainingM, _bucketM),
      zoneSeq: ride.zoneSeq,
    ));

    _pseudonym = pseudonym;
    _riding = ride;
    _requestedAtMs = _now();
    _state = WaitState.waiting;
    return pseudonym;
  }

  /// True once the backend would have dropped it anyway.
  bool get hasExpired =>
      _state == WaitState.waiting &&
      _now() - _requestedAtMs >= requestLifetime.inMilliseconds;

  Duration get timeLeft {
    if (_state != WaitState.waiting) return Duration.zero;
    final left = requestLifetime.inMilliseconds - (_now() - _requestedAtMs);
    return Duration(milliseconds: math.max(0, left));
  }

  /// Moves to expired once the window has passed, so the screen stops
  /// promising a bus that will never be told about her.
  WaitState refresh() {
    if (hasExpired) _state = WaitState.expired;
    return _state;
  }

  /// إلغاء — removed at once, everywhere.
  Future<void> cancel() async {
    final pseudonym = _pseudonym;
    if (pseudonym == null) return;
    try {
      await _api.cancelRequest(pseudonym);
    } on ApiException {
      // Already gone server-side; the local state still has to be cleared.
    }
    _clear(WaitState.cancelled);
  }

  /// ركبت.
  Future<void> boarded() async {
    final pseudonym = _pseudonym;
    final ride = _riding;
    if (pseudonym == null || ride == null) return;
    try {
      await _api.boarded(pseudonym: pseudonym, routeId: ride.route.id, dir: ride.dir);
    } on ApiException {
      // The ride happened either way.
    }
    _clear(WaitState.boarded);
  }

  void _clear(WaitState finalState) {
    _pseudonym = null;
    _riding = null;
    _requestedAtMs = 0;
    _state = finalState;
  }

  /// Back to وين رايح؟ for the next journey.
  void reset() => _clear(WaitState.idle);
}
