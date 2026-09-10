import 'package:flutter/material.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

import 'strings.dart';

/// وين رايح؟ — the common places as large tiles, and a search for the rest.
class DestinationScreen extends StatefulWidget {
  const DestinationScreen({
    required this.controller,
    required this.onChosen,
    super.key,
  });

  final PassengerController controller;
  final void Function(DestinationOption destination) onChosen;

  @override
  State<DestinationScreen> createState() => _DestinationScreenState();
}

class _DestinationScreenState extends State<DestinationScreen> {
  final _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final options = widget.controller.destinations(query: _query.text);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 16),
              Text(Ar.whereTo, style: Theme.of(context).textTheme.displaySmall),
              const SizedBox(height: 24),
              TextField(
                controller: _query,
                decoration: const InputDecoration(hintText: Ar.search),
                style: const TextStyle(fontSize: 22),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 24),
              if (options.isEmpty)
                Text(Ar.noPlace, style: Theme.of(context).textTheme.bodyLarge)
              else
                Expanded(
                  child: GridView.count(
                    crossAxisCount: 2,
                    mainAxisSpacing: 16,
                    crossAxisSpacing: 16,
                    childAspectRatio: 1.6,
                    children: [
                      for (final option in options)
                        FilledButton(
                          onPressed: () => widget.onChosen(option),
                          child: Text(option.nameAr, textAlign: TextAlign.center),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The buses running towards where she is going, soonest first.
class BusesScreen extends StatelessWidget {
  const BusesScreen({
    required this.destination,
    required this.ride,
    required this.sightings,
    required this.streamState,
    required this.onWait,
    required this.onBack,
    super.key,
  });

  final DestinationOption destination;
  final RideOption? ride;
  final List<BusSighting> sightings;
  final StreamState streamState;
  final VoidCallback onWait;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(destination.nameAr), leading: BackButton(onPressed: onBack)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (ride == null) ...[
                Text(Ar.noLineHere, style: Theme.of(context).textTheme.headlineMedium),
              ] else ...[
                Text(ride!.route.nameAr, style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 24),

                if (sightings.isEmpty) ...[
                  // Useful even with nothing running: where the buses leave from.
                  Text(Ar.noBusNow, style: Theme.of(context).textTheme.bodyLarge),
                  const SizedBox(height: 8),
                  Text('${Ar.departsFrom} ${ride!.route.originNameAr}',
                      style: Theme.of(context).textTheme.bodyMedium),
                ] else
                  Expanded(
                    child: ListView.separated(
                      itemCount: sightings.length,
                      separatorBuilder: (_, __) => const Divider(height: 32),
                      itemBuilder: (context, i) => Text(
                        sightings[i].etaText,
                        style: Theme.of(context).textTheme.displaySmall,
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),

                if (streamState == StreamState.reconnecting)
                  Text(Ar.reconnecting, textAlign: TextAlign.center),

                const Spacer(),
                FilledButton(onPressed: onWait, child: const Text(Ar.imWaiting)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// After أنا مستني هون: the bus approaching, and two ways out.
class WaitingScreen extends StatelessWidget {
  const WaitingScreen({
    required this.sightings,
    required this.minutesLeft,
    required this.expired,
    required this.onBoarded,
    required this.onCancel,
    super.key,
  });

  final List<BusSighting> sightings;
  final int minutesLeft;
  final bool expired;
  final Future<void> Function() onBoarded;
  final Future<void> Function() onCancel;

  @override
  Widget build(BuildContext context) {
    final nearest = sightings.isEmpty ? null : sightings.first;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 32),
              Text(
                expired ? Ar.requestExpired : Ar.waitingForBus,
                style: Theme.of(context).textTheme.headlineMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 32),
              if (nearest != null)
                Text(nearest.etaText,
                    style: Theme.of(context).textTheme.displaySmall,
                    textAlign: TextAlign.center),
              const SizedBox(height: 16),
              if (!expired)
                Text(Ar.minutesLeft(minutesLeft), textAlign: TextAlign.center),
              const Spacer(),
              FilledButton(onPressed: onBoarded, child: const Text(Ar.iBoarded)),
              const SizedBox(height: 12),
              // Small on purpose: cancelling is the rarer thing.
              TextButton(
                onPressed: () => _confirmCancel(context),
                child: const Text(Ar.cancel, style: TextStyle(fontSize: 18)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmCancel(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(Ar.confirmCancel, style: const TextStyle(fontSize: 22)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text(Ar.notYet)),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(Ar.yesCancel),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await onCancel();
  }
}
