import 'dart:async';
import 'dart:convert';

import 'package:mowasalat_core/mowasalat_core.dart';
import 'package:test/test.dart';

Stream<List<int>> _bytes(List<String> frames) =>
    Stream<List<int>>.fromIterable(frames.map(utf8.encode));

void main() {
  group('parsing the wire format', () {
    test('data frames come through, keep-alives and retry do not', () async {
      final payloads = await parseSse(_bytes([
        'retry: 5000\n\n',
        ': keep-alive\n\n',
        'data: {"pins":[]}\n\n',
      ])).toList();

      expect(payloads, ['{"pins":[]}']);
    });

    test('a frame split across chunks is reassembled', () async {
      // Exactly what a 3G connection does to a payload.
      final payloads = await parseSse(_bytes([
        'data: {"bus',
        'es":[{"remainingM":8000}]}',
        '\n\n',
      ])).toList();

      expect(payloads, ['{"buses":[{"remainingM":8000}]}']);
    });

    test('several frames in one chunk all arrive', () async {
      final payloads =
          await parseSse(_bytes(['data: {"a":1}\n\ndata: {"a":2}\n\n'])).toList();
      expect(payloads, ['{"a":1}', '{"a":2}']);
    });

    test('an unterminated tail is not delivered half-formed', () async {
      final payloads = await parseSse(_bytes(['data: {"a":1}\n\ndata: {"b":'])).toList();
      expect(payloads, ['{"a":1}']);
    });
  });

  group('the live subscription', () {
    /// A source the test drives by hand, so reconnection can be forced.
    late List<StreamController<List<int>>> sources;
    late int opens;

    setUp(() {
      sources = <StreamController<List<int>>>[];
      opens = 0;
    });

    Future<Stream<List<int>>> open(String url) async {
      opens++;
      final controller = StreamController<List<int>>();
      sources.add(controller);
      return controller.stream;
    }

    LiveStream<Map<String, dynamic>> build() => LiveStream<Map<String, dynamic>>(
          open: open,
          decode: (json) => json,
          firstBackoff: const Duration(milliseconds: 1),
          delay: (_) async {},
        );

    test('it reports its state as it connects', () async {
      final stream = build();
      expect(stream.state, StreamState.idle);

      await stream.connect('/v1/stream/waiting?tripToken=x');
      expect(stream.state, StreamState.open);

      await stream.close();
      expect(stream.state, StreamState.closed);
    });

    test('snapshots are delivered decoded', () async {
      final stream = build();
      await stream.connect('/x');

      final received = <Map<String, dynamic>>[];
      stream.events.listen(received.add);

      sources.first.add(utf8.encode('data: {"pins":[{"count":2}]}\n\n'));
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect((received.first['pins']! as List<dynamic>).length, 1);
      await stream.close();
    });

    test('an identical repeated snapshot is not delivered twice', () async {
      // The backend resends the whole picture rather than diffing, so a slow
      // phone must not redraw for news that has not changed.
      final stream = build();
      await stream.connect('/x');

      final received = <Map<String, dynamic>>[];
      stream.events.listen(received.add);

      sources.first
        ..add(utf8.encode('data: {"pins":[]}\n\n'))
        ..add(utf8.encode('data: {"pins":[]}\n\n'))
        ..add(utf8.encode('data: {"pins":[{"count":1}]}\n\n'));
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(2), reason: 'the duplicate was dropped');
      await stream.close();
    });

    test('a malformed frame is skipped rather than killing the stream', () async {
      final stream = build();
      await stream.connect('/x');

      final received = <Map<String, dynamic>>[];
      stream.events.listen(received.add);

      sources.first
        ..add(utf8.encode('data: not json at all\n\n'))
        ..add(utf8.encode('data: {"pins":[]}\n\n'));
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect(stream.state, StreamState.open);
      await stream.close();
    });

    test('a dropped connection reconnects', () async {
      final stream = build();
      await stream.connect('/x');
      expect(opens, 1);

      // The network goes away, as it does.
      await sources.first.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(opens, greaterThan(1), reason: 'it came back on its own');
      expect(stream.state, StreamState.open);
      await stream.close();
    });

    test('the snapshot replayed after a reconnect is delivered, not deduplicated away', () async {
      final stream = build();
      await stream.connect('/x');

      final received = <Map<String, dynamic>>[];
      stream.events.listen(received.add);

      sources.first.add(utf8.encode('data: {"pins":[{"count":3}]}\n\n'));
      await Future<void>.delayed(Duration.zero);
      expect(received, hasLength(1));

      await sources.first.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // After a network switch the state may be unchanged, but the screen has
      // to be told it is current again.
      sources.last.add(utf8.encode('data: {"pins":[{"count":3}]}\n\n'));
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(2));
      await stream.close();
    });

    test('closing stops everything and stops reconnecting', () async {
      final stream = build();
      await stream.connect('/x');
      await stream.close();

      final opensAtClose = opens;
      await sources.first.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(opens, opensAtClose, reason: 'a closed stream does not come back');
      expect(stream.isClosed, isTrue);
    });

    test('a closed stream refuses to be reconnected', () async {
      final stream = build();
      await stream.connect('/x');
      await stream.close();

      await expectLater(stream.connect('/x'), throwsStateError);
    });

    test('closing twice is harmless', () async {
      final stream = build();
      await stream.connect('/x');
      await stream.close();
      await stream.close();
      expect(stream.isClosed, isTrue);
    });
  });
}
