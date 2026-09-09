import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The thin layer between the pure-Dart core and the device.
///
/// Everything that decides anything lives in `mowasalat_core`, which is tested
/// without a device. What is here is only plumbing: sockets, preferences, and
/// the platform channels.
library;

/// Sends a request over HTTP. The only place the app knows a network exists.
HttpSend httpSend(String baseUrl, {http.Client? client}) {
  final c = client ?? http.Client();

  return (HttpRequest request) async {
    final uri = Uri.parse('$baseUrl${request.path}');
    final headers = <String, String>{
      'content-type': 'application/json',
      if (request.bearer != null) 'authorization': 'Bearer ${request.bearer}',
    };

    final response = switch (request.method) {
      'GET' => await c.get(uri, headers: headers),
      _ => await c.post(uri, headers: headers, body: jsonEncode(request.body ?? const {})),
    };
    return HttpReply(response.statusCode, response.body);
  };
}

/// Opens an SSE connection. Kept separate from [httpSend] because it is a long
/// read, not a round trip.
StreamOpener sseOpener(String baseUrl, {http.Client? client}) {
  final c = client ?? http.Client();

  return (String path) async {
    final request = http.Request('GET', Uri.parse('$baseUrl$path'))
      ..headers['accept'] = 'text/event-stream';
    final response = await c.send(request);

    if (response.statusCode >= 400) {
      throw ApiException(response.statusCode, 'stream refused');
    }
    return response.stream;
  };
}

/// The driver's session and any interrupted trip.
///
/// Two small values. No position, no history: there is nothing here that could
/// become a trail.
class DriverStorage implements TripStorage {
  DriverStorage(this._prefs);

  static const _tripKey = 'active_trip';
  static const _tokenKey = 'driver_token';

  final SharedPreferences _prefs;

  static Future<DriverStorage> open() async => DriverStorage(await SharedPreferences.getInstance());

  String? get driverToken => _prefs.getString(_tokenKey);

  Future<void> saveDriverToken(String token) => _prefs.setString(_tokenKey, token);

  Future<void> clearDriverToken() => _prefs.remove(_tokenKey);

  @override
  Future<PersistedTrip?> read() async {
    final raw = _prefs.getString(_tripKey);
    if (raw == null) return null;
    try {
      return PersistedTrip.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on Object {
      await clear();
      return null;
    }
  }

  @override
  Future<void> write(PersistedTrip trip) => _prefs.setString(_tripKey, jsonEncode(trip.toJson()));

  @override
  Future<void> clear() => _prefs.remove(_tripKey);
}
