import 'dart:convert';

import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Plumbing only. Everything that decides anything is in `mowasalat_core`.
library;

HttpSend httpSend(String baseUrl, {http.Client? client}) {
  final c = client ?? http.Client();

  return (HttpRequest request) async {
    final uri = Uri.parse('$baseUrl${request.path}');
    const headers = <String, String>{'content-type': 'application/json'};

    final response = switch (request.method) {
      'GET' => await c.get(uri, headers: headers),
      _ => await c.post(uri, headers: headers, body: jsonEncode(request.body ?? const {})),
    };
    return HttpReply(response.statusCode, response.body);
  };
}

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

/// One position, asked for once, when she opens the app.
///
/// No background permission is requested and no stream is opened: a passenger
/// is never tracked. The fix reaches the corridor matcher and stops there.
Future<LatLng?> currentPosition() async {
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) {
    permission = await Geolocator.requestPermission();
  }
  if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
    return null;
  }

  final position = await Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium),
  );
  return LatLng(position.latitude, position.longitude);
}

/// The cached network, so the app opens instantly and works on a bad
/// connection. Public geography only — nothing about her is stored at all.
class NetworkCache {
  NetworkCache(this._prefs);

  static const _key = 'network_routes';

  final SharedPreferences _prefs;

  static Future<NetworkCache> open() async => NetworkCache(await SharedPreferences.getInstance());

  List<Route>? read() {
    final raw = _prefs.getString(_key);
    if (raw == null) return null;
    try {
      return (jsonDecode(raw) as List<dynamic>)
          .map((r) => Route.fromJson(r as Map<String, dynamic>))
          .toList(growable: false);
    } on Object {
      return null;
    }
  }

  Future<void> write(String rawRoutesJson) => _prefs.setString(_key, rawRoutesJson);
}
