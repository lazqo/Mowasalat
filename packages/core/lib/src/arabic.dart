/// Matching what a person typed against what a place is called.
///
/// A passenger looking for ملكا may type ملكة, مَلكا, or الملكا. She should find
/// it. Arabic search that only does exact string equality fails constantly —
/// on hamza, on ta marbuta, on the definite article, on the diacritics a
/// keyboard sometimes inserts — and each failure looks to her like the app not
/// knowing her village.
library;

const _diacritics = 'ًٌٍَُِّْٰٕٓٔ';
const _tatweel = 'ـ';

/// Folds the differences that are spelling rather than meaning.
String foldArabic(String input) {
  final buffer = StringBuffer();

  for (final rune in input.runes) {
    final ch = String.fromCharCode(rune);
    if (_diacritics.contains(ch) || ch == _tatweel) continue;

    buffer.write(switch (ch) {
      'أ' || 'إ' || 'آ' || 'ٱ' => 'ا',
      'ى' => 'ي',
      'ة' => 'ه',
      'ؤ' => 'و',
      'ئ' => 'ي',
      // Eastern Arabic digits, which a keyboard may produce mid-word.
      '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4',
      '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
      _ => ch.toLowerCase(),
    });
  }

  var folded = buffer.toString().trim();
  // The definite article is optional in speech and in typing.
  if (folded.startsWith('ال') && folded.length > 3) folded = folded.substring(2);
  return folded.replaceAll(RegExp(r'\s+'), ' ');
}

/// Edit distance, capped so a long comparison stops early.
int _editDistance(String a, String b, {int max = 2}) {
  if ((a.length - b.length).abs() > max) return max + 1;

  var previous = List<int>.generate(b.length + 1, (i) => i);
  for (var i = 1; i <= a.length; i++) {
    final current = <int>[i, ...List<int>.filled(b.length, 0)];
    for (var j = 1; j <= b.length; j++) {
      final cost = a.codeUnitAt(i - 1) == b.codeUnitAt(j - 1) ? 0 : 1;
      current[j] = [current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost]
          .reduce((x, y) => x < y ? x : y);
    }
    previous = current;
  }
  return previous[b.length];
}

/// True when [query] plausibly names [candidate].
///
/// Folding handles the differences that are spelling. One further edit is
/// allowed on names long enough for it to be safe, which catches the ordinary
/// typo and the autocorrect that turns ملكا into ملكة — village names are far
/// enough apart that this does not confuse two of them.
bool matchesPlace(String query, String candidate) {
  final q = foldArabic(query);
  final c = foldArabic(candidate);
  if (q.isEmpty) return false;

  if (c.contains(q) || q.contains(c)) return true;
  if (q.length < 4 || c.length < 4) return false;
  return _editDistance(q, c, max: 1) <= 1;
}
