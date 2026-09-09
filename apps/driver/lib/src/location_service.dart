import 'dart:async';

import 'package:geolocator/geolocator.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

/// Turns the device's GPS into progress reports, and nothing else.
///
/// The coordinate reaches [TripController.onPosition] and stops there. It is
/// never logged, never queued, and never attached to an error report — there is
/// no code path from a fix to anything but the corridor matcher.
class LocationService {
  LocationService(this._controller);

  final TripController _controller;
  StreamSubscription<Position>? _subscription;

  bool get isRunning => _subscription != null;

  /// Asks for permission, then starts the foreground stream.
  ///
  /// Android's foreground service keeps a permanent visible notification, which
  /// is the honest deal: the app tracks the bus while the driver can see that
  /// it does, and stops the moment he ends the trip.
  Future<bool> start() async {
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return false;
    }

    _subscription = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        // The controller decides when to speak; this only decides when to
        // look. Ten metres keeps the radio quiet in traffic.
        distanceFilter: 10,
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'مواصلات',
          notificationText: 'الرحلة شغالة',
          enableWakeLock: true,
        ),
      ),
    ).listen(_onPosition);

    return true;
  }

  Future<void> _onPosition(Position position) async {
    try {
      await _controller.onPosition(
        LatLng(position.latitude, position.longitude),
        rawSpeedKph: position.speed * 3.6,
      );
    } on ApiException {
      // The controller has already torn the trip down if the server refused
      // it. A dropped connection is nothing to report.
    }
  }

  /// Ending a trip must leave nothing collecting.
  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
  }
}
