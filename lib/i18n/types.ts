export type Locale = "en-US" | "de-DE" | "hi-IN" | "ja-JP" | "ar-SA" | "qps-ploc";

export interface LocaleInfo {
  code: Locale;
  label: string;
  nativeName: string;
  flag: string;
  dir: "ltr" | "rtl";
}

export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: "en-US", label: "English (US)", nativeName: "English", flag: "🇺🇸", dir: "ltr" },
  { code: "de-DE", label: "Deutsch", nativeName: "Deutsch", flag: "🇩🇪", dir: "ltr" },
  { code: "hi-IN", label: "Hindi", nativeName: "हिन्दी", flag: "🇮🇳", dir: "ltr" },
  { code: "ja-JP", label: "Japanese", nativeName: "日本語", flag: "🇯🇵", dir: "ltr" },
  { code: "ar-SA", label: "Arabic", nativeName: "العربية", flag: "🇸🇦", dir: "rtl" },
  { code: "qps-ploc", label: "Pseudo-LOC", nativeName: "[!!! Ƥšèúďó !!!]", flag: "🔤", dir: "ltr" },
];

export const DEFAULT_LOCALE: Locale = "en-US";
