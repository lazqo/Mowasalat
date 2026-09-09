import 'package:flutter/material.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

import 'strings.dart';

/// The screen a driver looks at while driving.
///
/// A driving interface, not a dashboard: the line, how many are waiting, where
/// they are, and one large way to stop. No menu, no settings, no statistics,
/// nothing that moves.
class TripScreen extends StatelessWidget {
  const TripScreen({
    required this.controller,
    required this.streamState,
    required this.onEnd,
    super.key,
  });

  final TripController controller;
  final StreamState streamState;
  final Future<void> Function() onEnd;

  @override
  Widget build(BuildContext context) {
    final route = controller.route;
    final trip = controller.trip;
    final lines = controller.describePins();
    final waiting = controller.waitingCount;
    final offCorridor = controller.lastFix?.inside == false;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (route != null && trip != null)
                Text(route.labelFor(trip.dir),
                    style: Theme.of(context).textTheme.headlineMedium,
                    textAlign: TextAlign.center),
              const SizedBox(height: 24),

              // The number that matters, alone and large.
              Text(
                waiting == 0 ? Ar.nobodyWaiting : Ar.waitingForYou(waiting),
                style: Theme.of(context).textTheme.displaySmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),

              if (offCorridor)
                Text(Ar.offCorridor,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 18, color: Theme.of(context).colorScheme.error))
              else if (streamState == StreamState.reconnecting)
                Text(Ar.reconnecting,
                    textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),

              const SizedBox(height: 24),
              Expanded(
                child: ListView.separated(
                  itemCount: lines.length,
                  separatorBuilder: (_, __) => const Divider(height: 24),
                  itemBuilder: (context, i) => Text(
                    lines[i],
                    style: Theme.of(context).textTheme.bodyLarge,
                    textAlign: TextAlign.right,
                  ),
                ),
              ),

              FilledButton(
                onPressed: () => _confirmEnd(context),
                style: FilledButton.styleFrom(
                  backgroundColor: Theme.of(context).colorScheme.error,
                  foregroundColor: Theme.of(context).colorScheme.onError,
                ),
                child: const Text(Ar.endTrip),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Ending is two taps, because a misplaced thumb should not take a bus off
  /// the map mid-route.
  Future<void> _confirmEnd(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(Ar.confirmEnd, style: const TextStyle(fontSize: 22)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text(Ar.notYet)),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(Ar.yesEnded),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await onEnd();
  }
}

/// Shown when the app comes back and finds a trip it never finished.
///
/// The driver is asked rather than guessed at: silently resuming would put a
/// bus on the map he thinks he parked, and silently dropping would take one off
/// the map he is still driving.
class RecoveryScreen extends StatelessWidget {
  const RecoveryScreen({
    required this.route,
    required this.dir,
    required this.onContinue,
    required this.onEnd,
    super.key,
  });

  final Route route;
  final Direction dir;
  final VoidCallback onContinue;
  final Future<void> Function() onEnd;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(Ar.tripStillRunning,
                  style: Theme.of(context).textTheme.displaySmall, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              Text(route.labelFor(dir),
                  style: Theme.of(context).textTheme.headlineMedium, textAlign: TextAlign.center),
              const SizedBox(height: 48),
              FilledButton(onPressed: onContinue, child: const Text(Ar.continueTrip)),
              const SizedBox(height: 16),
              OutlinedButton(onPressed: onEnd, child: const Text(Ar.endTrip)),
            ],
          ),
        ),
      ),
    );
  }
}
