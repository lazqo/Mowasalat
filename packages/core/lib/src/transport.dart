/// The wire types.
///
/// Every payload the driver or passenger app sends is defined here, and none of
/// them has a field that could carry a latitude or a longitude. That is not an
/// accident of the current shape: `privacy_test.dart` reads this file and fails
/// if one appears.
///
/// Country-pack geography — routes, corridors, zones, waiting points — is
/// modelled in `models.dart` and is full of coordinates, because a bus line is
/// public infrastructure. A *person's* position is not.
library;

import 'dart:convert';

class ApiException implements Exception {
  ApiException(this.status, this.message, {this.code, this.retryAfterSeconds});

  factory ApiException.fromResponse(int status, String body) {
    try {
      final json = jsonDecode(body) as Map<String, dynamic>;
      return ApiException(
        status,
        json['error'] as String? ?? 'request failed',
        code: json['code'] as String?,
        retryAfterSeconds: (json['retryAfterSeconds'] as num?)?.toInt(),
      );
    } on FormatException {
      return ApiException(status, 'request failed');
    }
  }

  final int status;
  final String message;

  /// `invalid_code`, `expired`, `already_used`, `too_many_sends`,
  /// `too_many_attempts`, `resend_too_soon`, `invalid_phone`.
  final String? code;
  final int? retryAfterSeconds;

  bool get isUnauthorized => status == 401;
  bool get isRateLimited => status == 429;

  @override
  String toString() => 'ApiException($status${code == null ? '' : ' $code'}: $message)';
}

/// A code was sent. Never carries the code itself outside development.
class OtpChallenge {
  const OtpChallenge({
    required this.challengeId,
    required this.channel,
    required this.expiresInSeconds,
    this.devCode,
  });

  factory OtpChallenge.fromJson(Map<String, dynamic> json) => OtpChallenge(
        challengeId: json['challengeId'] as String,
        channel: json['channel'] as String,
        expiresInSeconds: (json['expiresInSeconds'] as num).toInt(),
        devCode: json['devCode'] as String?,
      );

  final String challengeId;

  /// `sms`, `manual_vouch`, or `development`.
  final String channel;
  final int expiresInSeconds;

  /// Present only when the backend runs the development provider, which
  /// refuses to exist in production.
  final String? devCode;

  /// Manual delivery means a person reads the code out; the screen should say
  /// so instead of promising a message that will never arrive.
  bool get isManualDelivery => channel == 'manual_vouch';
}

/// What the driver's phone sends while a trip is running.
///
/// Three numbers and two identifiers. No coordinate, and no way to add one
/// without the privacy test failing.
class ProgressReport {
  const ProgressReport({
    required this.tripToken,
    required this.routeId,
    required this.dir,
    required this.remainingM,
    required this.zoneSeq,
    required this.speedKph,
  });

  final String tripToken;
  final String routeId;
  final int dir;
  final double remainingM;
  final int zoneSeq;
  final double speedKph;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'tripToken': tripToken,
        'routeId': routeId,
        'dir': dir,
        'remainingM': remainingM,
        'zoneSeq': zoneSeq,
        'speedKph': speedKph,
      };
}

/// What a passenger sends when she says أنا مستني هون. Also coordinate-free.
class RideRequestPayload {
  const RideRequestPayload({
    required this.routeId,
    required this.dir,
    required this.destinationId,
    required this.remainingM,
    required this.zoneSeq,
  });

  final String routeId;
  final int dir;
  final String destinationId;
  final double remainingM;
  final int zoneSeq;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'routeId': routeId,
        'dir': dir,
        'destinationId': destinationId,
        'remainingM': remainingM,
        'zoneSeq': zoneSeq,
      };
}

/// An active trip's credentials. [pseudonym] is what passengers see and it
/// changes every trip; [tripToken] is secret and must never be logged.
class TripCredentials {
  const TripCredentials({required this.tripToken, required this.pseudonym});

  factory TripCredentials.fromJson(Map<String, dynamic> json) => TripCredentials(
        tripToken: json['tripToken'] as String,
        pseudonym: json['pseudonym'] as String,
      );

  final String tripToken;
  final String pseudonym;

  /// Deliberately hides the token: a stray print in a driver's console should
  /// not hand someone else's bus away.
  @override
  String toString() => 'TripCredentials(pseudonym: $pseudonym)';
}

class DriverSession {
  const DriverSession({required this.driverToken, required this.isNew});

  final String driverToken;
  final bool isNew;

  @override
  String toString() => 'DriverSession(isNew: $isNew)';
}
