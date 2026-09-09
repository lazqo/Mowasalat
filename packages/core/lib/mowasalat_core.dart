/// Shared logic for the Mowasalat apps.
///
/// Pure Dart on purpose: everything that decides anything lives here, so it can
/// be analysed and tested without a device, and the apps stay a thin shell.
library;

export 'src/api.dart';
export 'src/corridor.dart';
export 'src/geo.dart';
export 'src/models.dart';
export 'src/stream.dart';
export 'src/transport.dart';
export 'src/trip.dart';
