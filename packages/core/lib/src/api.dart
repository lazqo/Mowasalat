import 'dart:convert';

import 'models.dart';
import 'transport.dart';

/// One HTTP round trip. Injected so every test runs against captured backend
/// responses rather than a live server.
typedef HttpSend = Future<HttpReply> Function(HttpRequest request);

class HttpRequest {
  const HttpRequest({
    required this.method,
    required this.path,
    this.body,
    this.bearer,
  });

  final String method;
  final String path;
  final Map<String, dynamic>? body;
  final String? bearer;
}

class HttpReply {
  const HttpReply(this.status, this.body);
  final int status;
  final String body;
}

/// The client for the frozen `/v1` contract (see docs/API.md).
///
/// It holds the driver's bearer token and nothing else. It has no idea what a
/// coordinate is, which is the point.
class MowasalatApi {
  MowasalatApi({required HttpSend send, String? driverToken})
      : _send = send,
        _driverToken = driverToken;

  final HttpSend _send;
  String? _driverToken;

  String? get driverToken => _driverToken;
  bool get isSignedIn => _driverToken != null;

  Future<Map<String, dynamic>> _call(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = false,
  }) async {
    final reply = await _send(HttpRequest(
      method: method,
      path: path,
      body: body,
      bearer: authenticated ? _driverToken : null,
    ));

    if (reply.status >= 400) {
      throw ApiException.fromResponse(reply.status, reply.body);
    }
    if (reply.body.isEmpty) return <String, dynamic>{};
    return jsonDecode(reply.body) as Map<String, dynamic>;
  }

  // --- sign in -------------------------------------------------------------

  /// رقم الهاتف. The number is sent exactly as typed; the backend normalises
  /// it, so `0790123456` and `٠٧٩٠١٢٣٤٥٦` reach the same driver.
  Future<OtpChallenge> requestCode(String phone) async =>
      OtpChallenge.fromJson(await _call('POST', '/v1/auth/otp/request', body: {'phone': phone}));

  /// أدخل رمز التحقق. A first correct code creates the account.
  Future<DriverSession> verifyCode({
    required String challengeId,
    required String code,
    required String phone,
  }) async {
    final json = await _call('POST', '/v1/auth/otp/verify', body: {
      'challengeId': challengeId,
      'code': code,
      'phone': phone,
    });
    _driverToken = json['driverToken'] as String;
    return DriverSession(
      driverToken: _driverToken!,
      isNew: json['isNew'] as bool? ?? false,
    );
  }

  Future<void> signOut() async {
    if (_driverToken == null) return;
    try {
      await _call('POST', '/v1/auth/sign-out', authenticated: true);
    } on ApiException {
      // A revoked or expired token is already signed out; the local state is
      // cleared either way.
    }
    _driverToken = null;
  }

  void adoptToken(String? token) => _driverToken = token;

  // --- the driver ----------------------------------------------------------

  Future<({DriverProfile driver, List<Route> routes})> me() async {
    final json = await _call('GET', '/v1/driver/me', authenticated: true);
    return (
      driver: DriverProfile.fromJson(json['driver'] as Map<String, dynamic>),
      routes: (json['routes'] as List<dynamic>)
          .map((r) => Route.fromJson(r as Map<String, dynamic>))
          .toList(growable: false),
    );
  }

  Future<List<Route>> assignedRoutes() async {
    final json = await _call('GET', '/v1/driver/routes', authenticated: true);
    return (json['routes'] as List<dynamic>)
        .map((r) => Route.fromJson(r as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<void> setVehicle({
    required String type,
    String? colour,
    String? plate,
    bool showPlate = false,
  }) =>
      _call('POST', '/v1/driver/vehicle', authenticated: true, body: {
        'type': type,
        if (colour != null) 'colour': colour,
        if (plate != null) 'plate': plate,
        'showPlate': showPlate,
      });

  Future<DriverProfile> redeemInvitation(String code) async {
    final json =
        await _call('POST', '/v1/driver/invitation', authenticated: true, body: {'code': code});
    return DriverProfile.fromJson(json['driver'] as Map<String, dynamic>);
  }

  // --- the trip ------------------------------------------------------------

  /// ابدأ. Exactly one line and one direction becomes active.
  Future<TripCredentials> startTrip({required String routeId, required int dir}) async =>
      TripCredentials.fromJson(await _call('POST', '/v1/trips',
          authenticated: true, body: {'routeId': routeId, 'dir': dir}));

  Future<void> reportProgress(ProgressReport report) =>
      _call('POST', '/v1/trips/progress', authenticated: true, body: report.toJson());

  Future<void> endTrip(String tripToken) =>
      _call('POST', '/v1/trips/end', authenticated: true, body: {'tripToken': tripToken});

  // --- the passenger -------------------------------------------------------

  Future<({List<Map<String, dynamic>> buses, String streamTicket})> findBuses({
    required String routeId,
    required int dir,
    required double remainingM,
    required int zoneSeq,
  }) async {
    final json = await _call('POST', '/v1/buses', body: {
      'routeId': routeId,
      'dir': dir,
      'remainingM': remainingM,
      'zoneSeq': zoneSeq,
    });
    return (
      buses: (json['buses'] as List<dynamic>).cast<Map<String, dynamic>>(),
      streamTicket: json['streamTicket'] as String,
    );
  }

  Future<String> requestRide(RideRequestPayload payload) async {
    final json = await _call('POST', '/v1/requests', body: payload.toJson());
    return json['pseudonym'] as String;
  }

  Future<void> cancelRequest(String pseudonym) =>
      _call('POST', '/v1/requests/cancel', body: {'pseudonym': pseudonym});

  Future<void> boarded({
    required String pseudonym,
    required String routeId,
    required int dir,
  }) =>
      _call('POST', '/v1/requests/boarded',
          body: {'pseudonym': pseudonym, 'routeId': routeId, 'dir': dir});

  // --- the network ---------------------------------------------------------

  Future<Map<String, dynamic>> country() => _call('GET', '/v1/country');

  Future<List<Route>> network() async {
    final json = await _call('GET', '/v1/routes');
    return (json['routes'] as List<dynamic>)
        .map((r) => Route.fromJson(r as Map<String, dynamic>))
        .toList(growable: false);
  }
}
