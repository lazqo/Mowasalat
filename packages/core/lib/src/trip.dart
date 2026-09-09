import 'dart:async';

import 'api.dart';
import 'corridor.dart';
import 'geo.dart';
import 'models.dart';
import 'transport.dart';

/// Where a driver is in his shift.
enum TripPhase {
  /// وين رايح؟ — choosing a line.
  choosing,
  starting,

  /// Running, and reporting.
  active,

  /// The app came back after being killed and found a trip it did not finish.
  /// The driver is asked استمرار الرحلة or إنهاء الرحلة rather than guessed at.
  recovering,
  ending,
}

/// What survives the app being killed.
///
/// Android will kill a backgrounded app on a cheap phone without warning. The
/// trip is still running on the server, so the app must find it again rather
/// than start a second one — two buses on one line from one driver would be
/// worse than none.
class PersistedTrip {
  const PersistedTrip({
    required this.tripToken,
    required this.pseudonym,
    required this.routeId,
    required this.dir,
    required this.startedAtMs,
  });

  factory PersistedTrip.fromJson(Map<String, dynamic> json) => PersistedTrip(
        tripToken: json['tripToken'] as String,
        pseudonym: json['pseudonym'] as String,
        routeId: json['routeId'] as String,
        dir: (json['dir'] as num).toInt(),
        startedAtMs: (json['startedAtMs'] as num).toInt(),
      );

  final String tripToken;
  final String pseudonym;
  final String routeId;
  final int dir;
  final int startedAtMs;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'tripToken': tripToken,
        'pseudonym': pseudonym,
        'routeId': routeId,
        'dir': dir,
        'startedAtMs': startedAtMs,
      };

  /// A trip older than a shift is almost certainly abandoned rather than live.
  bool isStale(int nowMs, {Duration limit = const Duration(hours: 12)}) =>
      nowMs - startedAtMs > limit.inMilliseconds;
}

/// Somewhere to keep the active trip across a restart. Deliberately tiny: a
/// trip and a session token, never a position and never a history.
abstract class TripStorage {
  Future<PersistedTrip?> read();
  Future<void> write(PersistedTrip trip);
  Future<void> clear();
}

/// An in-memory store, used by tests and as a safe default.
class MemoryTripStorage implements TripStorage {
  PersistedTrip? _trip;

  @override
  Future<PersistedTrip?> read() async => _trip;

  @override
  Future<void> write(PersistedTrip trip) async => _trip = trip;

  @override
  Future<void> clear() async => _trip = null;
}

/// One driver's shift: start, report, watch, end.
///
/// Deliberately free of Flutter, so the state machine can be tested on its own.
/// The UI observes [phase] and [pins] and does nothing else.
class TripController {
  TripController({
    required MowasalatApi api,
    required TripStorage storage,
    required double remainingBucketM,
    int Function()? now,
  })  : _api = api,
        _storage = storage,
        _bucketM = remainingBucketM,
        _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  final MowasalatApi _api;
  final TripStorage _storage;
  final double _bucketM;
  final int Function() _now;

  final _speed = SpeedSmoother();
  final _phaseChanges = StreamController<TripPhase>.broadcast();

  TripPhase _phase = TripPhase.choosing;
  CorridorMatcher? _matcher;
  PersistedTrip? _trip;
  CorridorFix? _lastFix;
  int _lastReportAtMs = 0;
  List<WaitingPin> _pins = const <WaitingPin>[];

  TripPhase get phase => _phase;
  Stream<TripPhase> get phaseChanges => _phaseChanges.stream;
  PersistedTrip? get trip => _trip;
  Route? get route => _matcher?.route;
  CorridorFix? get lastFix => _lastFix;
  List<WaitingPin> get pins => _pins;
  double get speedKph => _speed.current;

  /// True while the phone should be reporting. The foreground service is
  /// started and stopped from exactly this.
  bool get isTracking => _phase == TripPhase.active;

  void _setPhase(TripPhase next) {
    if (_phase == next) return;
    _phase = next;
    if (!_phaseChanges.isClosed) _phaseChanges.add(next);
  }

  /// Called at launch. If a trip was interrupted, the driver is asked what to
  /// do with it rather than having it silently resumed or silently dropped.
  Future<PersistedTrip?> recover(List<Route> assignedRoutes) async {
    final saved = await _storage.read();
    if (saved == null) return null;

    if (saved.isStale(_now())) {
      await _storage.clear();
      return null;
    }

    Route? route;
    for (final r in assignedRoutes) {
      if (r.id == saved.routeId) route = r;
    }
    if (route == null) {
      // He is no longer assigned to that line, so the trip cannot be his.
      await _storage.clear();
      return null;
    }

    _trip = saved;
    _matcher = CorridorMatcher(route);
    _setPhase(TripPhase.recovering);
    return saved;
  }

  /// استمرار الرحلة — carry on with the trip that was already running.
  void resumeRecovered() {
    if (_phase != TripPhase.recovering) {
      throw StateError('there is no interrupted trip to resume');
    }
    _speed.reset();
    _setPhase(TripPhase.active);
  }

  /// ابدأ. Exactly one line and one direction.
  Future<TripCredentials> start({required Route route, required Direction dir}) async {
    if (_phase == TripPhase.active) {
      throw StateError('a trip is already running');
    }
    _setPhase(TripPhase.starting);

    try {
      final credentials = await _api.startTrip(routeId: route.id, dir: dir);
      _trip = PersistedTrip(
        tripToken: credentials.tripToken,
        pseudonym: credentials.pseudonym,
        routeId: route.id,
        dir: dir,
        startedAtMs: _now(),
      );
      await _storage.write(_trip!);

      _matcher = CorridorMatcher(route);
      _speed.reset();
      _lastReportAtMs = 0;
      _pins = const <WaitingPin>[];
      _setPhase(TripPhase.active);
      return credentials;
    } on Object {
      _setPhase(TripPhase.choosing);
      rethrow;
    }
  }

  /// Feeds a raw GPS reading in. The coordinate stops here: what leaves is a
  /// remaining distance, a zone and a speed.
  ///
  /// Returns the report that was sent, or null when nothing was due — because
  /// it is too soon, or because the bus is off the corridor and should say
  /// nothing at all.
  Future<ProgressReport?> onPosition(LatLng position, {double? rawSpeedKph}) async {
    final matcher = _matcher;
    final trip = _trip;
    if (matcher == null || trip == null || _phase != TripPhase.active) return null;

    final fix = matcher.match(position, trip.dir);
    _lastFix = fix;

    final smoothed = rawSpeedKph == null ? _speed.current : _speed.add(rawSpeedKph);

    if (!fix.inside) {
      // Off the corridor: silence. The corridor is drawn wide enough that this
      // means a genuine deviation, and a deviation is nobody's business.
      return null;
    }

    final interval = reportingInterval(inside: true, speedKph: smoothed);
    final elapsed = _now() - _lastReportAtMs;
    if (_lastReportAtMs != 0 && elapsed < interval.inMilliseconds) return null;

    final report = ProgressReport(
      tripToken: trip.tripToken,
      routeId: trip.routeId,
      dir: trip.dir,
      remainingM: bucketRemaining(fix.remainingM, _bucketM),
      zoneSeq: fix.zoneSeq,
      speedKph: double.parse(smoothed.toStringAsFixed(1)),
    );

    try {
      await _api.reportProgress(report);
      _lastReportAtMs = _now();
      return report;
    } on ApiException catch (e) {
      if (e.status == 400 || e.isUnauthorized) {
        // The server has forgotten this trip; there is nothing to report to.
        await _forget();
        rethrow;
      }
      // A dropped connection is normal on 3G. The reading is discarded rather
      // than queued: there must never be a backlog of positions waiting to be
      // uploaded, because that backlog would be the trail we do not keep.
      return null;
    }
  }

  /// Snapshots from the driver's stream, already deduplicated upstream.
  void onWaitingPins(List<WaitingPin> pins) => _pins = pins;

  /// What the screen says: ٢ ركاب بعد ٢ كم, or عند مفرق ملكا when the privacy
  /// layer has snapped them to a known waiting point.
  List<String> describePins() {
    final fix = _lastFix;
    final matcher = _matcher;
    final trip = _trip;
    if (fix == null || matcher == null || trip == null) return const <String>[];

    return _pins
        .map((pin) => describePin(
              pin,
              fix.remainingM,
              waitPointName: matcher.waitPointNear(pin.remainingM, trip.dir)?.nameAr,
            ))
        .toList(growable: false);
  }

  int get waitingCount => _pins.fold(0, (sum, pin) => sum + pin.count);

  /// إنهاء الرحلة, after متأكد إنك خلصت الرحلة؟
  Future<void> end() async {
    final trip = _trip;
    if (trip == null) {
      await _forget();
      return;
    }
    _setPhase(TripPhase.ending);
    try {
      await _api.endTrip(trip.tripToken);
    } on ApiException {
      // Already gone server-side; the local teardown still has to happen.
    }
    await _forget();
  }

  /// Everything an ended trip must leave behind: nothing.
  Future<void> _forget() async {
    await _storage.clear();
    _trip = null;
    _matcher = null;
    _lastFix = null;
    _pins = const <WaitingPin>[];
    _lastReportAtMs = 0;
    _speed.reset();
    _setPhase(TripPhase.choosing);
  }

  /// Signing out ends any running trip first, so no bus is left on the map.
  Future<void> signOut() async {
    if (_trip != null) await end();
    await _api.signOut();
  }

  Future<void> dispose() async {
    await _phaseChanges.close();
  }
}
