/**
 * Matching what a person typed against what a place is called.
 *
 * A passenger looking for ملكا may type ملكة, مَلكا, or الملكا. She should find
 * it. Arabic search that only does exact string equality fails constantly — on
 * hamza, on ta marbuta, on the definite article, on the diacritics a keyboard
 * sometimes inserts — and each failure looks to her like the app not knowing
 * her village.
 *
 * A direct port of packages/core/lib/src/arabic.dart. The two are tested
 * against the same cases so the web and native clients agree on what a name is.
 */

const DIACRITICS = "ًٌٍَُِّْٰٕٓٔ";
const TATWEEL = "ـ";

const FOLD: Record<string, string> = {
  "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
  "ى": "ي",
  "ة": "ه",
  "ؤ": "و",
  "ئ": "ي",
  // Eastern Arabic digits, which a keyboard may produce mid-word.
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** Folds the differences that are spelling rather than meaning. */
export function foldArabic(input: string): string {
  let out = "";
  for (const ch of input) {
    if (DIACRITICS.includes(ch) || ch === TATWEEL) continue;
    out += FOLD[ch] ?? ch.toLowerCase();
  }

  let folded = out.trim();
  // The definite article is optional in speech and in typing.
  if (folded.startsWith("ال") && folded.length > 3) folded = folded.slice(2);
  return folded.replace(/\s+/g, " ");
}

/** Edit distance, capped so a long comparison stops early. */
function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * True when `query` plausibly names `candidate`.
 *
 * Folding handles the differences that are spelling. One further edit is
 * allowed on names long enough for it to be safe, which catches the ordinary
 * typo and the autocorrect that turns ملكا into ملكة — village names are far
 * enough apart that this does not confuse two of them.
 */
export function matchesPlace(query: string, candidate: string): boolean {
  const q = foldArabic(query);
  const c = foldArabic(candidate);
  if (!q) return false;

  if (c.includes(q) || q.includes(c)) return true;
  if (q.length < 4 || c.length < 4) return false;
  return editDistance(q, c, 1) <= 1;
}
