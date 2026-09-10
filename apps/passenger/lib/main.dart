import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

import 'src/platform.dart';
import 'src/screens.dart';
import 'src/strings.dart';

const _apiBase = String.fromEnvironment('API_BASE', defaultValue: 'http://10.0.2.2:3000');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(PassengerApp(cache: await NetworkCache.open()));
}

class PassengerApp extends StatelessWidget {
  const PassengerApp({required this.cache, super.key});

  final NetworkCache cache;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: Ar.appName,
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1F4FA3)),
          textTheme: const TextTheme(
            displaySmall: TextStyle(fontSize: 34, fontWeight: FontWeight.w700),
            headlineMedium: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
            bodyLarge: TextStyle(fontSize: 20),
          ),
          filledButtonTheme: FilledButtonThemeData(
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(72),
              textStyle: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
            ),
          ),
        ),
        locale: const Locale('ar', 'JO'),
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: PassengerShell(cache: cache),
      );
}

class PassengerShell extends StatefulWidget {
  const PassengerShell({required this.cache, super.key});

  final NetworkCache cache;

  @override
  State<PassengerShell> createState() => _PassengerShellState();
}

class _PassengerShellState extends State<PassengerShell> {
  final _api = MowasalatApi(send: httpSend(_apiBase));

  PassengerController? _passenger;
  DestinationOption? _destination;
  RideOption? _ride;
  List<BusSighting> _sightings = const <BusSighting>[];
  LiveStream<List<Map<String, dynamic>>>? _busStream;
  StreamState _streamState = StreamState.idle;
  Timer? _tick;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    // The cached network first, so the app opens instantly on a bad
    // connection; the refresh happens behind it.
    final cached = widget.cache.read();
    if (cached != null) _build(cached, 250);

    try {
      final country = await _api.country();
      final routes = await _api.network();
      _build(routes, (country['remainingBucketM'] as num?)?.toDouble() ?? 250);
    } on ApiException {
      // Offline with no cache: the destination list will simply be empty.
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _build(List<Route> routes, double bucketM) {
    _passenger = PassengerController(
      api: _api,
      network: routes,
      remainingBucketM: bucketM,
    );
    if (mounted) setState(() {});
  }

  Future<void> _chooseDestination(DestinationOption destination) async {
    setState(() {
      _destination = destination;
      _loading = true;
    });

    // Her position is asked for once, used locally, and never sent.
    final position = await currentPosition();
    if (position == null) {
      if (mounted) {
        setState(() => _loading = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text(Ar.needLocation)));
      }
      return;
    }

    final rides = _passenger!.ridesFor(destinationId: destination.id, position: position);
    _ride = rides.isEmpty ? null : rides.first;

    if (_ride != null) {
      try {
        final result = await _passenger!.busesFor(_ride!);
        _sightings = result.buses;
        await _watchBuses(result.streamTicket);
      } on ApiException {
        _sightings = const <BusSighting>[];
      }
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _watchBuses(String ticket) async {
    await _busStream?.close();

    final stream = LiveStream<List<Map<String, dynamic>>>(
      open: sseOpener(_apiBase),
      decode: (json) => (json['buses'] as List<dynamic>).cast<Map<String, dynamic>>(),
    );
    _busStream = stream;

    stream.states.listen((state) {
      if (mounted) setState(() => _streamState = state);
    });
    stream.events.listen((buses) {
      if (_ride == null) return;
      // The gap and the ETA are computed here, from bus scalars, which is why
      // watching costs her nothing in privacy.
      _sightings = _passenger!.sightingsFrom(buses, _ride!);
      if (mounted) setState(() {});
    });

    await stream.connect('/v1/stream/buses?ticket=$ticket');
  }

  Future<void> _wait() async {
    await _passenger!.requestRide(_ride!);
    // One timer, only while she is waiting, so the countdown and the expiry
    // are honest without any polling.
    _tick = Timer.periodic(const Duration(seconds: 10), (_) {
      if (!mounted) return;
      setState(() => _passenger!.refresh());
    });
    setState(() {});
  }

  Future<void> _finish(Future<void> Function() action) async {
    _tick?.cancel();
    _tick = null;
    await action();
    await _busStream?.close();
    _busStream = null;

    _passenger!.reset();
    if (mounted) {
      setState(() {
        _destination = null;
        _ride = null;
        _sightings = const <BusSighting>[];
        _streamState = StreamState.idle;
      });
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    final closing = _busStream?.close();
    if (closing != null) unawaited(closing);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final passenger = _passenger;
    if (_loading && passenger == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (passenger == null) {
      return const Scaffold(body: Center(child: Text(Ar.noPlace)));
    }

    if (passenger.state == WaitState.waiting || passenger.state == WaitState.expired) {
      return WaitingScreen(
        sightings: _sightings,
        minutesLeft: passenger.timeLeft.inMinutes,
        expired: passenger.state == WaitState.expired,
        onBoarded: () => _finish(passenger.boarded),
        onCancel: () => _finish(passenger.cancel),
      );
    }

    if (_destination != null) {
      return BusesScreen(
        destination: _destination!,
        ride: _ride,
        sightings: _sightings,
        streamState: _streamState,
        onWait: _wait,
        onBack: () => _finish(() async {}),
      );
    }

    return DestinationScreen(controller: passenger, onChosen: _chooseDestination);
  }
}
