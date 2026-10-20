import { type Locale } from "./types";
import { isPseudoLocale, pseudoLocalize } from "./pseudo";

export type TranslationDictionary = Record<string, string>;

export const EN_US: TranslationDictionary = {
  // Navigation
  "nav.features": "Features",
  "nav.howItWorks": "How It Works",
  "nav.pricing": "Pricing",
  "nav.dashboard": "Dashboard",
  "nav.expenses": "Expenses",
  "nav.trips": "Trips",
  "nav.signIn": "Sign In",
  "nav.signOut": "Sign Out",
  "nav.wallet": "Wallet",
  "nav.copied": "Copied!",
  "nav.copyUnavailable": "Clipboard access is blocked. Please copy manually.",
  "nav.language": "Language",

  // Common UI
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.create": "Create",
  "common.loading": "Loading...",
  "common.success": "Success",
  "common.error": "Error",
  "common.back": "Back",
  "common.confirm": "Confirm",
  "common.search": "Search",
  "common.filter": "Filter",
  "common.close": "Close",
  "common.add": "Add",
  "common.actions": "Actions",
  "common.date": "Date",
  "common.amount": "Amount",
  "common.status": "Status",

  // Forms
  "form.title": "Title",
  "form.description": "Description",
  "form.amount": "Amount",
  "form.currency": "Currency",
  "form.paidBy": "Paid By",
  "form.splitMode": "Split Mode",
  "form.members": "Members",
  "form.tags": "Tags",
  "form.category": "Category",
  "form.name": "Name",
  "form.stellarAddress": "Stellar Address",

  // Expenses
  "expenses.newExpense": "New Expense",
  "expenses.recentExpenses": "Recent Expenses",
  "expenses.allExpenses": "All Expenses",
  "expenses.splitEqually": "Split Equally",
  "expenses.exactSplit": "Exact Amounts",
  "expenses.percentageSplit": "Percentage Split",
  "expenses.settlementPreview": "Settlement Preview",
  "expenses.unsettled": "Unsettled",
  "expenses.settled": "Settled",
  "expenses.totalOwed": "You are owed",
  "expenses.totalOwe": "You owe",
  "expenses.paid": "Paid",
  "expenses.unpaid": "Unpaid",
  "expenses.noExpensesTrip": "No expenses in this trip yet.",
  "expenses.paidRatio": "{paid}/{total} paid",
  "expenses.agreedAs": "agreed as",
  "expenses.membersCount": "{count} members",
  "expenses.exchangeRateLabel": "Exchange rate:",
  "expenses.deleteConfirm": "Delete “{title}”? This cannot be undone.",
  "expenses.onlyPayerCanDelete": "Only the payer can delete",
  "expenses.splitLabel": "Split: {mode}",

  // Trips & Workspace
  "trips.myTrips": "My Trips",
  "trips.newTrip": "New Trip",
  "trips.workspace": "Travel Workspace",
  "trips.tabExpenses": "Expenses",
  "trips.tabWorkspace": "Workspace",
  "trips.tabRecurring": "Recurring",
  "trips.tabSettle": "Settle Up",
  "trips.itinerary": "Itinerary",
  "trips.packingList": "Packing List",
  "trips.bookings": "Bookings & References",
  "trips.exportCalendar": "Export to Calendar",
  "trips.privacyExport": "Export My Travel Data",
  "trips.privacyPurge": "Delete Travel Workspace Data",

  // Reminders
  "reminders.title": "Reminders",
  "reminders.inbox": "Reminder Inbox",
  "reminders.snooze": "Snooze",
  "reminders.dismiss": "Dismiss",

  // Errors & Validation
  "errors.required": "This field is required.",
  "errors.invalidAmount": "Enter a valid amount.",
  "errors.ambiguousAmount": "Ambiguous amount format. Please verify decimal separator.",
  "errors.invalidAddress": "Invalid Stellar address (must start with G, 56 chars).",
  "errors.minMembers": "Add at least 2 members.",
  "errors.quoteUnavailable": "Live exchange rate is temporarily unavailable.",
};

export const DE_DE: TranslationDictionary = {
  // Navigation
  "nav.features": "Funktionen",
  "nav.howItWorks": "So funktioniert's",
  "nav.pricing": "Preise",
  "nav.dashboard": "Übersicht",
  "nav.expenses": "Ausgaben",
  "nav.trips": "Reisen",
  "nav.signIn": "Anmelden",
  "nav.signOut": "Abmelden",
  "nav.wallet": "Wallet",
  "nav.copied": "Kopiert!",
  "nav.copyUnavailable": "Zwischenablage nicht verfügbar. Bitte manuell kopieren.",
  "nav.language": "Sprache",

  // Common UI
  "common.save": "Speichern",
  "common.cancel": "Abbrechen",
  "common.delete": "Löschen",
  "common.edit": "Bearbeiten",
  "common.create": "Erstellen",
  "common.loading": "Wird geladen...",
  "common.success": "Erfolgreich",
  "common.error": "Fehler",
  "common.back": "Zurück",
  "common.confirm": "Bestätigen",
  "common.search": "Suchen",
  "common.filter": "Filtern",
  "common.close": "Schließen",
  "common.add": "Hinzufügen",
  "common.actions": "Aktionen",
  "common.date": "Datum",
  "common.amount": "Betrag",
  "common.status": "Status",

  // Forms
  "form.title": "Titel",
  "form.description": "Beschreibung",
  "form.amount": "Betrag",
  "form.currency": "Währung",
  "form.paidBy": "Bezahlt von",
  "form.splitMode": "Aufteilung",
  "form.members": "Mitglieder",
  "form.tags": "Schlagwörter",
  "form.category": "Kategorie",
  "form.name": "Name",
  "form.stellarAddress": "Stellar-Adresse",

  // Expenses
  "expenses.newExpense": "Neue Ausgabe",
  "expenses.recentExpenses": "Aktuelle Ausgaben",
  "expenses.allExpenses": "Alle Ausgaben",
  "expenses.splitEqually": "Zu gleichen Teilen",
  "expenses.exactSplit": "Genaue Beträge",
  "expenses.percentageSplit": "Prozentuale Aufteilung",
  "expenses.settlementPreview": "Abrechnungsvorschau",
  "expenses.unsettled": "Offen",
  "expenses.settled": "Beglichen",
  "expenses.totalOwed": "Ihnen steht zu",
  "expenses.totalOwe": "Sie schulden",
  "expenses.paid": "Bezahlt",
  "expenses.unpaid": "Offen",
  "expenses.noExpensesTrip": "Noch keine Ausgaben in dieser Reise.",
  "expenses.paidRatio": "{paid}/{total} bezahlt",
  "expenses.agreedAs": "vereinbart als",
  "expenses.membersCount": "{count} Mitglieder",
  "expenses.exchangeRateLabel": "Wechselkurs:",
  "expenses.deleteConfirm": "„{title}“ löschen? Dies kann nicht rückgängig gemacht werden.",
  "expenses.onlyPayerCanDelete": "Nur der Zahler kann löschen",
  "expenses.splitLabel": "Aufteilung: {mode}",

  // Trips & Workspace
  "trips.myTrips": "Meine Reisen",
  "trips.newTrip": "Neue Reise",
  "trips.workspace": "Reisebereich",
  "trips.tabExpenses": "Ausgaben",
  "trips.tabWorkspace": "Reisebereich",
  "trips.tabRecurring": "Wiederkehrend",
  "trips.tabSettle": "Abrechnen",
  "trips.itinerary": "Reiseplan",
  "trips.packingList": "Packliste",
  "trips.bookings": "Buchungsreferenzen",
  "trips.exportCalendar": "In Kalender exportieren",
  "trips.privacyExport": "Reisedaten exportieren",
  "trips.privacyPurge": "Reisedaten löschen",

  // Reminders
  "reminders.title": "Erinnerungen",
  "reminders.inbox": "Erinnerungspostfach",
  "reminders.snooze": "Schlummern",
  "reminders.dismiss": "Schließen",

  // Errors & Validation
  "errors.required": "Dieses Feld ist erforderlich.",
  "errors.invalidAmount": "Geben Sie einen gültigen Betrag ein.",
  "errors.ambiguousAmount": "Uneindeutiges Zahlenformat. Bitte Dezimaltrennzeichen prüfen.",
  "errors.invalidAddress": "Ungültige Stellar-Adresse (beginnt mit G, 56 Zeichen).",
  "errors.minMembers": "Mindestens 2 Mitglieder erforderlich.",
  "errors.quoteUnavailable": "Wechselkurs ist derzeit nicht verfügbar.",
};

export const HI_IN: TranslationDictionary = {
  // Navigation
  "nav.features": "सुविधाएँ",
  "nav.howItWorks": "यह कैसे काम करता है",
  "nav.pricing": "मूल्य निर्धारण",
  "nav.dashboard": "डैशबोर्ड",
  "nav.expenses": "खर्चे",
  "nav.trips": "यात्राएँ",
  "nav.signIn": "साइन इन करें",
  "nav.signOut": "साइन आउट",
  "nav.wallet": "वॉलेट",
  "nav.copied": "कॉपी हो गया!",
  "nav.copyUnavailable": "क्लिपबोर्ड एक्सेस अवरुद्ध है। कृपया मैन्युअल रूप से कॉपी करें।",
  "nav.language": "भाषा",

  // Common UI
  "common.save": "सहेजें",
  "common.cancel": "रद्द करें",
  "common.delete": "हटाएं",
  "common.edit": "संपादित करें",
  "common.create": "बनाएं",
  "common.loading": "लोड हो रहा है...",
  "common.success": "सफल",
  "common.error": "त्रुटि",
  "common.back": "वापस",
  "common.confirm": "पुष्टि करें",
  "common.search": "खोजें",
  "common.filter": "फ़िल्टर",
  "common.close": "बंद करें",
  "common.add": "जोड़ें",
  "common.actions": "कार्रवाई",
  "common.date": "तारीख",
  "common.amount": "राशि",
  "common.status": "स्थिति",

  // Forms
  "form.title": "शीर्षक",
  "form.description": "विवरण",
  "form.amount": "राशि",
  "form.currency": "मुद्रा",
  "form.paidBy": "द्वारा भुगतान",
  "form.splitMode": "विभाजन प्रकार",
  "form.members": "सदस्य",
  "form.tags": "टैग",
  "form.category": "श्रेणी",
  "form.name": "नाम",
  "form.stellarAddress": "स्टेलर पता",

  // Expenses
  "expenses.newExpense": "नया खर्च",
  "expenses.recentExpenses": "हाल के खर्चे",
  "expenses.allExpenses": "सभी खर्चे",
  "expenses.splitEqually": "बराबर बांटें",
  "expenses.exactSplit": "सटीक राशि",
  "expenses.percentageSplit": "प्रतिशत विभाजन",
  "expenses.settlementPreview": "निपटान पूर्वावलोकन",
  "expenses.unsettled": "असमन्वित",
  "expenses.settled": "निपटाया गया",
  "expenses.totalOwed": "आपको मिलने योग्य",
  "expenses.totalOwe": "आपकी देनदारी",
  "expenses.paid": "भुगतान किया गया",
  "expenses.unpaid": "बकाया",
  "expenses.noExpensesTrip": "इस यात्रा में अभी कोई खर्च नहीं है।",
  "expenses.paidRatio": "{paid}/{total} भुगतान किया गया",
  "expenses.agreedAs": "सहमति बनी",
  "expenses.membersCount": "{count} सदस्य",
  "expenses.exchangeRateLabel": "विनिमय दर:",
  "expenses.deleteConfirm": "क्या “{title}” को हटाना चाहते हैं? इसे पूर्ववत नहीं किया जा सकता।",
  "expenses.onlyPayerCanDelete": "केवल भुगतानकर्ता ही हटा सकता है",
  "expenses.splitLabel": "विभाजन: {mode}",

  // Trips & Workspace
  "trips.myTrips": "मेरी यात्राएँ",
  "trips.newTrip": "नई यात्रा",
  "trips.workspace": "यात्रा कार्यक्षेत्र",
  "trips.tabExpenses": "खर्चे",
  "trips.tabWorkspace": "कार्यस्थान",
  "trips.tabRecurring": "आवर्ती",
  "trips.tabSettle": "हिसाब चुकता करें",
  "trips.itinerary": "यात्रा कार्यक्रम",
  "trips.packingList": "पैकिंग सूची",
  "trips.bookings": "बुकिंग और संदर्भ",
  "trips.exportCalendar": "कैलेंडर में निर्यात करें",
  "trips.privacyExport": "मेरा यात्रा डेटा निर्यात करें",
  "trips.privacyPurge": "यात्रा डेटा हटाएं",

  // Reminders
  "reminders.title": "अनुस्मारक",
  "reminders.inbox": "अनुस्मारक इनबॉक्स",
  "reminders.snooze": "बाद में याद दिलाएं",
  "reminders.dismiss": "खारिज करें",

  // Errors & Validation
  "errors.required": "यह फ़ील्ड आवश्यक है।",
  "errors.invalidAmount": "कृपया मान्य राशि दर्ज करें।",
  "errors.ambiguousAmount": "अस्पष्ट राशि प्रारूप। कृपया दशमलव विभाजक जांचें।",
  "errors.invalidAddress": "अमान्य स्टेलर पता (G से शुरू होना चाहिए, 56 अक्षर)।",
  "errors.minMembers": "कम से कम 2 सदस्य जोड़ें।",
  "errors.quoteUnavailable": "विनिमय दर वर्तमान में अनुपलब्ध है।",
};

export const JA_JP: TranslationDictionary = {
  // Navigation
  "nav.features": "機能",
  "nav.howItWorks": "使い方",
  "nav.pricing": "料金",
  "nav.dashboard": "ダッシュボード",
  "nav.expenses": "経費",
  "nav.trips": "旅行",
  "nav.signIn": "ログイン",
  "nav.signOut": "ログアウト",
  "nav.wallet": "ウォレット",
  "nav.copied": "コピーしました！",
  "nav.copyUnavailable": "クリップボードがブロックされています。手動でコピーしてください。",
  "nav.language": "言語",

  // Common UI
  "common.save": "保存",
  "common.cancel": "キャンセル",
  "common.delete": "削除",
  "common.edit": "編集",
  "common.create": "作成",
  "common.loading": "読み込み中...",
  "common.success": "成功",
  "common.error": "エラー",
  "common.back": "戻る",
  "common.confirm": "確認",
  "common.search": "検索",
  "common.filter": "フィルター",
  "common.close": "閉じる",
  "common.add": "追加",
  "common.actions": "操作",
  "common.date": "日付",
  "common.amount": "金額",
  "common.status": "ステータス",

  // Forms
  "form.title": "タイトル",
  "form.description": "説明",
  "form.amount": "金額",
  "form.currency": "通貨",
  "form.paidBy": "支払者",
  "form.splitMode": "分割方法",
  "form.members": "メンバー",
  "form.tags": "タグ",
  "form.category": "カテゴリ",
  "form.name": "名前",
  "form.stellarAddress": "ステラアドレス",

  // Expenses
  "expenses.newExpense": "新規経費",
  "expenses.recentExpenses": "最近の経費",
  "expenses.allExpenses": "すべての経費",
  "expenses.splitEqually": "均等分割",
  "expenses.exactSplit": "個別金額",
  "expenses.percentageSplit": "割合分割",
  "expenses.settlementPreview": "精算プレビュー",
  "expenses.unsettled": "未精算",
  "expenses.settled": "精算済み",
  "expenses.totalOwed": "受取予定",
  "expenses.totalOwe": "支払予定",
  "expenses.paid": "支払済",
  "expenses.unpaid": "未払い",
  "expenses.noExpensesTrip": "この旅行にはまだ経費がありません。",
  "expenses.paidRatio": "{paid}/{total} 支払い済み",
  "expenses.agreedAs": "合意金額",
  "expenses.membersCount": "{count} 人のメンバー",
  "expenses.exchangeRateLabel": "為替レート:",
  "expenses.deleteConfirm": "「{title}」を削除しますか？この操作は元に戻せません。",
  "expenses.onlyPayerCanDelete": "支払者のみが削除できます",
  "expenses.splitLabel": "分割: {mode}",

  // Trips & Workspace
  "trips.myTrips": "マイトリップ",
  "trips.newTrip": "新規旅行",
  "trips.workspace": "旅行ワークスペース",
  "trips.tabExpenses": "経費",
  "trips.tabWorkspace": "ワークスペース",
  "trips.tabRecurring": "定期",
  "trips.tabSettle": "清算する",
  "trips.itinerary": "日程表",
  "trips.packingList": "持ち物リスト",
  "trips.bookings": "予約・参照",
  "trips.exportCalendar": "カレンダーにエクスポート",
  "trips.privacyExport": "旅行データをエクスポート",
  "trips.privacyPurge": "旅行データを削除",

  // Reminders
  "reminders.title": "リマインダー",
  "reminders.inbox": "リマインダー受信箱",
  "reminders.snooze": "スヌーズ",
  "reminders.dismiss": "閉じる",

  // Errors & Validation
  "errors.required": "この項目は必須です。",
  "errors.invalidAmount": "有効な金額を入力してください。",
  "errors.ambiguousAmount": "あいまいな数値形式です。小数点を確認してください。",
  "errors.invalidAddress": "無効なステラアドレスです（Gで始まる56文字）。",
  "errors.minMembers": "2人以上のメンバーを追加してください。",
  "errors.quoteUnavailable": "現在為替レートを取得できません。",
};

export const AR_SA: TranslationDictionary = {
  // Navigation
  "nav.features": "الميزات",
  "nav.howItWorks": "كيف يعمل",
  "nav.pricing": "الأسعار",
  "nav.dashboard": "لوحة التحكم",
  "nav.expenses": "المصاريف",
  "nav.trips": "الرحلات",
  "nav.signIn": "تسجيل الدخول",
  "nav.signOut": "تسجيل الخروج",
  "nav.wallet": "المحفظة",
  "nav.copied": "تم النسخ!",
  "nav.copyUnavailable": "الحافظة محظورة. يرجى النسخ يدويًا.",
  "nav.language": "اللغة",

  // Common UI
  "common.save": "حفظ",
  "common.cancel": "إلغاء",
  "common.delete": "حذف",
  "common.edit": "تعديل",
  "common.create": "إنشاء",
  "common.loading": "جارٍ التحميل...",
  "common.success": "نجاح",
  "common.error": "خطأ",
  "common.back": "رجوع",
  "common.confirm": "تأكيد",
  "common.search": "بحث",
  "common.filter": "تصفية",
  "common.close": "إغلاق",
  "common.add": "إضافة",
  "common.actions": "الإجراءات",
  "common.date": "التاريخ",
  "common.amount": "المبلغ",
  "common.status": "الحالة",

  // Forms
  "form.title": "العنوان",
  "form.description": "الوصف",
  "form.amount": "المبلغ",
  "form.currency": "العملة",
  "form.paidBy": "دُفع بواسطة",
  "form.splitMode": "طريقة التقسيم",
  "form.members": "الأعضاء",
  "form.tags": "الوسوم",
  "form.category": "الفئة",
  "form.name": "الاسم",
  "form.stellarAddress": "عنوان ستيلار",

  // Expenses
  "expenses.newExpense": "مصروف جديد",
  "expenses.recentExpenses": "المصاريف الأخيرة",
  "expenses.allExpenses": "جميع المصاريف",
  "expenses.splitEqually": "تقسيم بالتساوي",
  "expenses.exactSplit": "مبالغ محددة",
  "expenses.percentageSplit": "تقسيم بالنسبة المئوية",
  "expenses.settlementPreview": "معاينة التسوية",
  "expenses.unsettled": "غير معلق",
  "expenses.settled": "تمت التسوية",
  "expenses.totalOwed": "المستحق لك",
  "expenses.totalOwe": "المستحق عليك",
  "expenses.paid": "مدفوع",
  "expenses.unpaid": "غير مدفوع",
  "expenses.noExpensesTrip": "لا توجد مصاريف في هذه الرحلة بعد.",
  "expenses.paidRatio": "{paid}/{total} تم الدفع",
  "expenses.agreedAs": "متفق عليه كـ",
  "expenses.membersCount": "{count} أعضاء",
  "expenses.exchangeRateLabel": "سعر الصرف:",
  "expenses.deleteConfirm": "هل تريد حذف \"{title}\"؟ لا يمكن التراجع عن هذا الإجراء.",
  "expenses.onlyPayerCanDelete": "يمكن للدافع فقط الحذف",
  "expenses.splitLabel": "التقسيم: {mode}",

  // Trips & Workspace
  "trips.myTrips": "رحلاتي",
  "trips.newTrip": "رحلة جديدة",
  "trips.workspace": "مساحة عمل السفر",
  "trips.tabExpenses": "المصاريف",
  "trips.tabWorkspace": "مساحة العمل",
  "trips.tabRecurring": "متكرر",
  "trips.tabSettle": "تسوية الحساب",
  "trips.itinerary": "جدول الرحلة",
  "trips.packingList": "قائمة الأمتعة",
  "trips.bookings": "الحجوزات والمراجع",
  "trips.exportCalendar": "تصدير إلى التقويم",
  "trips.privacyExport": "تصدير بيانات السفر",
  "trips.privacyPurge": "حذف بيانات السفر",

  // Reminders
  "reminders.title": "التذكيرات",
  "reminders.inbox": "صندوق التذكيرات",
  "reminders.snooze": "تأجيل",
  "reminders.dismiss": "إغلاق",

  // Errors & Validation
  "errors.required": "هذا الحقل مطلوب.",
  "errors.invalidAmount": "يرجى إدخال مبلغ صحيح.",
  "errors.ambiguousAmount": "تنسيق الرقم غير واضح. يرجى التحقق من الفاصلة العشرية.",
  "errors.invalidAddress": "عنوان ستيلار غير صالح (يبدأ بـ G، 56 حرفًا).",
  "errors.minMembers": "أضف عضوين على الأقل.",
  "errors.quoteUnavailable": "سعر الصرف غير متوفر حاليًا.",
};

const TRANSLATION_MAP: Record<string, TranslationDictionary> = {
  "en-US": EN_US,
  "de-DE": DE_DE,
  "hi-IN": HI_IN,
  "ja-JP": JA_JP,
  "ar-SA": AR_SA,
};

/**
 * Resolves translation for the given key, falling back to English if missing.
 * Handles pseudo-localization dynamically when locale is "qps-ploc".
 * Interpolates variables formatted as {param}.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  if (isPseudoLocale(locale)) {
    const baseText = EN_US[key] ?? key;
    // Interpolate parameters first or preserve them?
    // In pseudo-localization, placeholders should stay readable while surrounding text is pseudo-localized.
    let pseudoBase = pseudoLocalize(baseText);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        pseudoBase = pseudoBase.replaceAll(`{${k}}`, String(v));
      });
    }
    return pseudoBase;
  }

  const dict = TRANSLATION_MAP[locale] ?? EN_US;
  let text = dict[key] ?? EN_US[key] ?? key;

  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replaceAll(`{${k}}`, String(v));
    });
  }

  return text;
}
