// A driver and a passenger, both driven by the real core logic, against the
// real backend. Not a test — evidence that the two slices meet.
import 'dart:convert';
import 'dart:io';

import 'package:mowasalat_core/mowasalat_core.dart';

const base = 'http://127.0.0.1:3220';

Future<HttpReply> send(HttpRequest r) async {
  final client = HttpClient();
  final req = await client.openUrl(r.method, Uri.parse('$base${r.path}'));
  req.headers.set('content-type', 'application/json');
  if (r.bearer != null) req.headers.set('authorization', 'Bearer ${r.bearer}');
  if (r.body != null) req.write(jsonEncode(r.body));
  final res = await req.close();
  final body = await res.transform(utf8.decoder).join();
  client.close();
  return HttpReply(res.statusCode, body);
}

Future<void> main() async {
  // --- the driver signs in and starts a trip ---
  final driverApi = MowasalatApi(send: send);
  final challenge = await driverApi.requestCode('0790000111');
  final session = await driverApi.verifyCode(
    challengeId: challenge.challengeId,
    code: challenge.devCode!,
    phone: '0790000111',
  );
  print('driver signed in, new=${session.isNew}');

  final me = await driverApi.me();
  // Ops assigns his line (done here directly against the admin API).
  final admin = HttpClient();
  final req = await admin.postUrl(
      Uri.parse('$base/v1/admin/drivers/${me.driver.id}/routes'));
  req.headers..set('content-type', 'application/json')..set('authorization', 'Bearer tok');
  req.write(jsonEncode({'routeId': 'jo-irbid-malka'}));
  await (await req.close()).drain<void>();
  admin.close();

  final routes = await driverApi.assignedRoutes();
  final line = routes.single;
  print('assigned: ${line.nameAr}');

  final storage = MemoryTripStorage();
  final trip = TripController(api: driverApi, storage: storage, remainingBucketM: 250);
  await trip.start(route: line, dir: 0);
  print('trip started, heading ${line.headingFor(0)}');

  // Real geometry: the driver is at the Irbid end of the line.
  final atIrbid = line.corridor.zones.first.centre;
  final report = await trip.onPosition(atIrbid, rawSpeedKph: 40);
  print('reported: remaining=${report!.remainingM}m zone=${report.zoneSeq} '
      'speed=${report.speedKph}  (no coordinate in ${report.toJson().keys.join(",")})');

  // --- the passenger, standing a little along the line ---
  final passengerApi = MowasalatApi(send: send);
  final network = await passengerApi.network();
  final passenger = PassengerController(
      api: passengerApi, network: network, remainingBucketM: 250);

  final malka = passenger.destinations(query: 'ملكة').single;
  print('she searched "ملكة" and found ${malka.nameAr}');

  // A point on the corridor between Irbid and Malka.
  final path = line.corridor.referencePaths.first;
  final middle = path[1];
  final ride = passenger.ridesFor(destinationId: malka.id, position: middle).first;
  print('her line: ${ride.route.nameAr}, direction ${ride.dir}, '
      'remaining=${ride.remainingM.round()}m');

  final buses = await passenger.busesFor(ride);
  print('buses she can see: ${buses.buses.length}'
      '${buses.buses.isEmpty ? "" : " — ${buses.buses.first.etaText}"}');

  final pseudonym = await passenger.requestRide(ride);
  print('she is waiting (pseudonym $pseudonym)');

  // --- the driver sees her ---
  await Future<void>.delayed(const Duration(milliseconds: 200));
  final client = HttpClient();
  final pinReq = await client.getUrl(
      Uri.parse('$base/v1/stream/waiting?tripToken=${trip.trip!.tripToken}'));
  final pinRes = await pinReq.close();
  final first = await pinRes
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .firstWhere((l) => l.startsWith('data: '));
  client.close();
  print('driver sees: ${first.substring(6)}');
  trip.onWaitingPins((jsonDecode(first.substring(6))['pins'] as List<dynamic>)
      .map((p) => WaitingPin.fromJson(p as Map<String, dynamic>))
      .toList());
  print('driver screen reads: ${trip.describePins().join(" / ")}');

  // --- she boards, he ends ---
  await passenger.boarded();
  print('she boarded, state=${passenger.state}');
  await trip.end();
  print('trip ended, phase=${trip.phase}, stored=${await storage.read()}');
}
