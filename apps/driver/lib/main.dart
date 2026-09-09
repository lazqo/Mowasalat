import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

import 'src/home_screen.dart';
import 'src/location_service.dart';
import 'src/platform.dart';
import 'src/sign_in_screen.dart';
import 'src/strings.dart';
import 'src/theme.dart';
import 'src/trip_screen.dart';

/// Where the backend lives. Passed at build time so a pilot build points at the
/// pilot server without a code change:
///   flutter build apk --dart-define=API_BASE=https://…
const _apiBase = String.fromEnvironment('API_BASE', defaultValue: 'http://10.0.2.2:3000');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final storage = await DriverStorage.open();
  runApp(DriverApp(storage: storage));
}

class DriverApp extends StatelessWidget {
  const DriverApp({required this.storage, super.key});

  final DriverStorage storage;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: Ar.appName,
        theme: driverTheme(),
        // The whole app is Arabic and right-to-left; there is no other locale.
        locale: const Locale('ar', 'JO'),
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: DriverShell(storage: storage),
      );
}

/// Holds the one piece of state the app has: where the driver is in his shift.
class DriverShell extends StatefulWidget {
  const DriverShell({required this.storage, super.key});

  final DriverStorage storage;

  @override
  State<DriverShell> createState() => _DriverShellState();
}

class _DriverShellState extends State<DriverShell> {
  late final MowasalatApi _api = MowasalatApi(
    send: httpSend(_apiBase),
    driverToken: widget.storage.driverToken,
  );

  TripController? _trip;
  LocationService? _location;
  LiveStream<List<WaitingPin>>? _pins;
  StreamState _streamState = StreamState.idle;

  List<Route> _routes = const <Route>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    if (_api.isSignedIn) {
      unawaited(_load());
    } else {
      _loading = false;
    }
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final me = await _api.me();
      final country = await _api.country();

      final controller = TripController(
        api: _api,
        storage: widget.storage,
        remainingBucketM: (country['remainingBucketM'] as num?)?.toDouble() ?? 250,
      );
      controller.phaseChanges.listen((_) {
        if (mounted) setState(() {});
      });

      _trip = controller;
      _routes = me.routes;
      // If Android killed the app mid-trip, this finds it and asks.
      await controller.recover(me.routes);
    } on ApiException catch (e) {
      if (e.isUnauthorized) await _signOut();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _onSignedIn(String token) async {
    await widget.storage.saveDriverToken(token);
    _api.adoptToken(token);
    await _load();
  }

  Future<void> _startTrip(Route route, Direction dir) async {
    final controller = _trip!;
    await controller.start(route: route, dir: dir);

    _location = LocationService(controller);
    if (!await _location!.start()) {
      // Without location there is nothing to report, so the trip is not real.
      await _endTrip();
      return;
    }
    await _openPinStream(controller);
    if (mounted) setState(() {});
  }

  Future<void> _openPinStream(TripController controller) async {
    final stream = LiveStream<List<WaitingPin>>(
      open: sseOpener(_apiBase),
      decode: (json) => (json['pins'] as List<dynamic>)
          .map((p) => WaitingPin.fromJson(p as Map<String, dynamic>))
          .toList(growable: false),
    );
    _pins = stream;

    stream.states.listen((state) {
      if (mounted) setState(() => _streamState = state);
    });
    stream.events.listen((pins) {
      controller.onWaitingPins(pins);
      if (mounted) setState(() {});
    });

    await stream.connect('/v1/stream/waiting?tripToken=${controller.trip!.tripToken}');
  }

  /// Ending stops everything: the GPS, the reports, the subscription, and the
  /// local trip credentials.
  Future<void> _endTrip() async {
    await _location?.stop();
    _location = null;
    await _pins?.close();
    _pins = null;
    await _trip?.end();
    if (mounted) setState(() => _streamState = StreamState.idle);
  }

  Future<void> _signOut() async {
    await _location?.stop();
    await _pins?.close();
    await _trip?.signOut();
    await widget.storage.clearDriverToken();
    if (mounted) {
      setState(() {
        _trip = null;
        _routes = const <Route>[];
      });
    }
  }

  @override
  void dispose() {
    final stopping = _location?.stop();
    if (stopping != null) unawaited(stopping);
    final closing = _pins?.close();
    if (closing != null) unawaited(closing);
    final disposing = _trip?.dispose();
    if (disposing != null) unawaited(disposing);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!_api.isSignedIn || _trip == null) {
      return SignInScreen(api: _api, onSignedIn: _onSignedIn);
    }

    final controller = _trip!;
    return switch (controller.phase) {
      TripPhase.recovering => RecoveryScreen(
          route: controller.route!,
          dir: controller.trip!.dir,
          onContinue: () async {
            controller.resumeRecovered();
            _location = LocationService(controller);
            await _location!.start();
            await _openPinStream(controller);
            if (mounted) setState(() {});
          },
          onEnd: _endTrip,
        ),
      TripPhase.active || TripPhase.ending => TripScreen(
          controller: controller,
          streamState: _streamState,
          onEnd: _endTrip,
        ),
      _ => HomeScreen(
          routes: _routes,
          recentRouteId: controller.trip?.routeId,
          onChoose: _startTrip,
        ),
    };
  }
}
