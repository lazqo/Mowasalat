import 'dart:convert';
import 'dart:io';

/// Real responses, captured from a running `/v1` backend rather than invented.
///
/// If the contract changes shape, these stop matching and the tests say so —
/// which is the point of capturing them instead of writing them by hand.
Map<String, dynamic> fixture(String name) =>
    jsonDecode(File('test/fixtures/$name.json').readAsStringSync()) as Map<String, dynamic>;

/// A line with real geometry, taken from the seeded Jordan pack.
Map<String, dynamic> malkaRoute() {
  final me = fixture('driver_me');
  final routes = me['routes'] as List<dynamic>;
  return routes.firstWhere(
    (r) => (r as Map<String, dynamic>)['id'] == 'jo-irbid-malka',
  ) as Map<String, dynamic>;
}
