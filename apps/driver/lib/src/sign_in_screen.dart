import 'package:flutter/material.dart';
import 'package:mowasalat_core/mowasalat_core.dart';

import 'strings.dart';

/// رقم الهاتف → رمز التحقق. Two fields, and nothing else asked for.
class SignInScreen extends StatefulWidget {
  const SignInScreen({required this.api, required this.onSignedIn, super.key});

  final MowasalatApi api;
  final Future<void> Function(String driverToken) onSignedIn;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();

  OtpChallenge? _challenge;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (e) {
      // The backend's message is already written for a person to read.
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestCode() => _run(() async {
        final challenge = await widget.api.requestCode(_phone.text);
        setState(() => _challenge = challenge);
      });

  Future<void> _verify() => _run(() async {
        final session = await widget.api.verifyCode(
          challengeId: _challenge!.challengeId,
          code: _code.text,
          phone: _phone.text,
        );
        await widget.onSignedIn(session.driverToken);
      });

  @override
  Widget build(BuildContext context) {
    final onCode = _challenge != null;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 32),
              Text(Ar.welcome, style: Theme.of(context).textTheme.displaySmall),
              const SizedBox(height: 40),
              Text(onCode ? Ar.enterCode : Ar.phoneNumber,
                  style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 16),
              if (!onCode)
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  style: const TextStyle(fontSize: 28),
                  textAlign: TextAlign.center,
                  autofocus: true,
                )
              else ...[
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(fontSize: 32, letterSpacing: 8),
                  textAlign: TextAlign.center,
                  autofocus: true,
                ),
                if (_challenge!.isManualDelivery) ...[
                  const SizedBox(height: 12),
                  // Where SMS cannot be relied on, a person reads the code out.
                  // Say so, rather than promising a message that never comes.
                  Text(Ar.codeByPerson, textAlign: TextAlign.center),
                ],
              ],
              const SizedBox(height: 24),
              if (_error != null) ...[
                Text(_error!,
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 18)),
                const SizedBox(height: 16),
              ],
              FilledButton(
                onPressed: _busy ? null : (onCode ? _verify : _requestCode),
                child: Text(onCode ? Ar.verify : Ar.sendCode),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
