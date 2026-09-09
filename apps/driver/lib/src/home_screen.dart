import 'package:flutter/material.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

import 'strings.dart';

/// وين رايح؟ — his own lines, and nothing he can type into.
///
/// Ops owns the network, so a driver picks from what he is assigned and cannot
/// invent a route.
class HomeScreen extends StatelessWidget {
  const HomeScreen({
    required this.routes,
    required this.onChoose,
    this.recentRouteId,
    super.key,
  });

  final List<Route> routes;
  final void Function(Route route, Direction dir) onChoose;

  /// The line he ran last sits first; most drivers run the same one all week.
  final String? recentRouteId;

  List<Route> get _ordered {
    if (recentRouteId == null) return routes;
    final ordered = [...routes];
    ordered.sort((a, b) {
      if (a.id == recentRouteId) return -1;
      if (b.id == recentRouteId) return 1;
      return 0;
    });
    return ordered;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 16),
              Text(Ar.whereTo, style: Theme.of(context).textTheme.displaySmall),
              const SizedBox(height: 32),
              if (routes.isEmpty)
                Text(Ar.noLines, style: Theme.of(context).textTheme.bodyLarge)
              else
                Expanded(
                  child: ListView.separated(
                    itemCount: _ordered.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 16),
                    itemBuilder: (context, i) {
                      final route = _ordered[i];
                      return OutlinedButton(
                        onPressed: () => _chooseDirection(context, route),
                        child: Text(route.nameAr),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// A line is bidirectional, so the second question is which way — asked as a
  /// destination rather than an arrow, because that is how a driver thinks.
  Future<void> _chooseDirection(BuildContext context, Route route) async {
    final dir = await showModalBottomSheet<Direction>(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(Ar.whereTo, style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: () => Navigator.pop(context, 0),
                child: Text(route.destinationNameAr),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => Navigator.pop(context, 1),
                child: Text(route.originNameAr),
              ),
            ],
          ),
        ),
      ),
    );
    if (dir != null) onChoose(route, dir);
  }
}
