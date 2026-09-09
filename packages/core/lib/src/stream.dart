import 'dart:async';
import 'dart:convert';

/// Server-Sent Events, and the connection life cycle around them.
///
/// Push, not polling: a phone that asks every few seconds spends its battery
/// and its data bundle on nothing. The backend pushes only when a line changes.
///
/// Two things this has to survive on a real phone. Snapshots repeat — the
/// backend resends the whole picture rather than diffing, and a reconnect
/// replays the current one — so identical payloads are dropped rather than
/// redrawing the screen. And the network drops constantly, so reconnection
/// backs off and gives up only when told to.
enum StreamState { idle, connecting, open, reconnecting, closed }

/// Opens a byte stream for a URL. Injected so tests need no sockets.
typedef StreamOpener = Future<Stream<List<int>>> Function(String url);

/// Turns SSE bytes into `data:` payloads, a chunk at a time.
///
/// Incremental rather than an `async*` generator on purpose. Cancelling a
/// subscription to a generator that is blocked reading a source which never
/// closes does not complete — which would mean ending a trip hangs the app
/// instead of tearing everything down. Feeding a parser from a plain listener
/// keeps cancellation immediate.
class SseParser {
  var _buffer = '';

  /// Returns the payloads completed by this chunk, which may be none.
  List<String> add(String chunk) {
    _buffer += chunk;
    final payloads = <String>[];

    var split = _buffer.indexOf('\n\n');
    while (split != -1) {
      final frame = _buffer.substring(0, split);
      _buffer = _buffer.substring(split + 2);

      for (final line in frame.split('\n')) {
        // Comment lines (`: keep-alive`) and `retry:` are consumed and ignored.
        if (line.startsWith('data: ')) payloads.add(line.substring(6));
      }
      split = _buffer.indexOf('\n\n');
    }
    return payloads;
  }

  void reset() => _buffer = '';
}

/// Convenience wrapper for a finite byte stream, used by tests.
Stream<String> parseSse(Stream<List<int>> bytes) {
  final parser = SseParser();
  return bytes.transform(utf8.decoder).expand(parser.add);
}

/// A reconnecting subscription to one stream.
///
/// Deliberately not a broadcast controller shared between screens: a stream is
/// bound to one trip or one ticket, and closing it must actually close it.
class LiveStream<T> {
  LiveStream({
    required StreamOpener open,
    required T Function(Map<String, dynamic> json) decode,
    Duration firstBackoff = const Duration(seconds: 1),
    Duration maxBackoff = const Duration(seconds: 30),
    Future<void> Function(Duration)? delay,
  })  : _open = open,
        _decode = decode,
        _firstBackoff = firstBackoff,
        _maxBackoff = maxBackoff,
        _delay = delay ?? Future<void>.delayed;

  final StreamOpener _open;
  final T Function(Map<String, dynamic>) _decode;
  final Duration _firstBackoff;
  final Duration _maxBackoff;
  final Future<void> Function(Duration) _delay;

  // Broadcast so more than one part of the UI can watch, and because closing a
  // single-subscription controller nothing ever listened to never completes.
  final _events = StreamController<T>.broadcast();
  final _states = StreamController<StreamState>.broadcast();

  StreamSubscription<List<int>>? _subscription;
  final _parser = SseParser();
  String? _lastPayload;
  bool _closed = false;
  bool _reconnecting = false;
  var _state = StreamState.idle;
  int _attempt = 0;

  Stream<T> get events => _events.stream;
  Stream<StreamState> get states => _states.stream;
  StreamState get state => _state;

  /// How many reconnections have been attempted since the last clean open.
  int get reconnectAttempts => _attempt;

  void _setState(StreamState next) {
    if (_state == next) return;
    _state = next;
    if (!_states.isClosed) _states.add(next);
  }

  Future<void> connect(String url) async {
    if (_closed) throw StateError('this stream has been closed');
    _setState(_attempt == 0 ? StreamState.connecting : StreamState.reconnecting);

    try {
      final bytes = await _open(url);
      _attempt = 0;
      _setState(StreamState.open);

      _parser.reset();
      _subscription = bytes.listen(
        (chunk) {
          for (final payload in _parser.add(utf8.decode(chunk, allowMalformed: true))) {
            _onPayload(payload);
          }
        },
        onError: (Object _) => unawaited(_scheduleReconnect(url)),
        onDone: () => unawaited(_scheduleReconnect(url)),
        cancelOnError: false,
      );
    } on Object {
      await _scheduleReconnect(url);
    }
  }

  void _onPayload(String payload) {
    // The backend resends the whole picture on every change and on reconnect,
    // so an unchanged snapshot is discarded rather than redrawn — this is what
    // keeps a slow phone from rebuilding its screen for nothing.
    if (payload == _lastPayload) return;
    _lastPayload = payload;

    try {
      final json = jsonDecode(payload) as Map<String, dynamic>;
      if (!_events.isClosed) _events.add(_decode(json));
    } on Object {
      // A malformed frame is skipped; the next snapshot corrects the screen.
    }
  }

  Future<void> _scheduleReconnect(String url) async {
    if (_closed || _reconnecting) return;
    _reconnecting = true;

    // A source that errors and then closes fires both callbacks; without this
    // the two would race into two parallel reconnection chains.
    final previous = _subscription;
    _subscription = null;
    unawaited(previous?.cancel());

    _attempt++;
    _setState(StreamState.reconnecting);

    final backoffMs = _firstBackoff.inMilliseconds * (1 << (_attempt - 1).clamp(0, 10));
    await _delay(Duration(
      milliseconds: backoffMs.clamp(_firstBackoff.inMilliseconds, _maxBackoff.inMilliseconds),
    ));

    _reconnecting = false;
    if (_closed) return;
    // A reconnect must not be mistaken for fresh news, so the last payload is
    // forgotten and the replayed snapshot is delivered once.
    _lastPayload = null;
    await connect(url);
  }

  /// Closes for good. Ending a trip or signing out must leave nothing running.
  Future<void> close() async {
    if (_closed) return;
    _closed = true;

    // Not awaited: a source that never closes would otherwise hold the
    // cancellation open, and ending a trip must be immediate.
    unawaited(_subscription?.cancel());
    _subscription = null;
    _setState(StreamState.closed);
    await _events.close();
    await _states.close();
  }

  bool get isClosed => _closed;
}
