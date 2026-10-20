/**
 * Character replacement mapping for pseudo-localization (accented letters).
 */
const PSEUDO_MAP: Record<string, string> = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î",
  j: "ĵ", k: "ƙ", l: "ļ", m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "q̇", r: "ŕ",
  s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ж", y: "ý", z: "ž",
  A: "À", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î",
  J: "Ĵ", K: "Ҟ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ö", P: "Þ", Q: "Q̇", R: "Ŕ",
  S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ж", Y: "Ý", Z: "Ž",
};

/**
 * Checks if the locale is a pseudo-localization locale.
 */
export function isPseudoLocale(locale: string): boolean {
  if (!locale) return false;
  const lower = locale.toLowerCase();
  return lower === "qps-ploc" || lower === "en-xa" || lower === "pseudo";
}

/**
 * Transforms an English source string into a pseudo-localized string:
 * 1. Accents all standard letters.
 * 2. Lengthens the text by approximately ~30% to reveal layout truncation issues.
 * 3. Delimits with [!!! and !!!] to highlight hardcoded/untranslated strings.
 * 4. Preserves placeholders like `{name}`, `{{count}}`, and HTML tags unchanged.
 */
export function pseudoLocalize(text: string): string {
  if (!text || typeof text !== "string") return text;

  // Split text by placeholders ({param}, {{param}}) and HTML tags (<tag>...</tag>)
  // Capturing parentheses in split() keep delimiters in the array.
  const parts = text.split(/(\{+[^{}]+\}+|<[^>]+>)/g);

  const transformedParts = parts.map((part) => {
    // If it's a placeholder or HTML tag, preserve as-is
    if (/^\{+[^{}]+\}+$/.test(part) || /^<[^>]+>$/.test(part)) {
      return part;
    }

    // Transform letters to accented versions
    let transformed = "";
    for (const char of part) {
      transformed += PSEUDO_MAP[char] ?? char;
    }

    // Add string expansion (approx 30% length increase using padding)
    const expansionLength = Math.ceil(part.trim().length * 0.3);
    if (expansionLength > 0 && part.trim().length > 2) {
      const pad = "~".repeat(Math.min(expansionLength, 12));
      transformed = `${transformed} ${pad}`;
    }

    return transformed;
  });

  return `[!!! ${transformedParts.join("")} !!!]`;
}
