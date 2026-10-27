/**
 * assessmentConfig.ts
 * -------------------
 * Single source of truth for every question, option, score, rule, outcome copy
 * and CRM field key used by the 6toFit Consult form.
 *
 * Persian strings here are user-facing copy. English identifiers are technical
 * keys used by validation, scoring and the CRM payload.
 */

export const FORM_VERSION = "consult-2.1.0";
export const CONSENT_VERSION = "consent-1.0.0";

export type Severity = "RED" | "YELLOW" | null;
export type SafetyOutcome = "GREEN" | "YELLOW_REVIEW" | "RED_SPECIALIST";

export type Option = {
  value: string;
  label: string;
  description?: string;
  severity?: Severity;
  points?: number;
  hardRedFlag?: boolean;
};

/* ------------------------------------------------------------------ */
/* Step 1 — Welcome                                                    */
/* ------------------------------------------------------------------ */

export const welcomeCopy = {
  title: "شروع مشاوره تخصصی",
  description: "با چند سؤال کوتاه، مناسب‌ترین مسیر مشاوره را برای شما مشخص می‌کنیم.",
  cta: "شروع فرم",
  bullets: [
    "کمتر از ۵ دقیقه زمان می‌برد",
    "پاسخ‌ها فقط برای مسیر‌دهی مشاوره استفاده می‌شود",
    "این فرم جایگزین تشخیص یا درمان پزشکی نیست",
  ],
};

/* ------------------------------------------------------------------ */
/* Step 2 — Contact                                                    */
/* ------------------------------------------------------------------ */

export type Country = { iso: string; dial: string; flag: string; fa: string; en: string };

/** Default order: US, Canada, Iran, then everyone else. Each +1 country is its own entry. */
export const countries: Country[] = [
  { iso: "US", dial: "+1", flag: "🇺🇸", fa: "آمریکا", en: "United States" },
  { iso: "CA", dial: "+1", flag: "🇨🇦", fa: "کانادا", en: "Canada" },
  { iso: "IR", dial: "+98", flag: "🇮🇷", fa: "ایران", en: "Iran" },
  { iso: "AE", dial: "+971", flag: "🇦🇪", fa: "امارات متحده عربی", en: "United Arab Emirates" },
  { iso: "TR", dial: "+90", flag: "🇹🇷", fa: "ترکیه", en: "Turkey" },
  { iso: "GB", dial: "+44", flag: "🇬🇧", fa: "انگلستان", en: "United Kingdom" },
  { iso: "DE", dial: "+49", flag: "🇩🇪", fa: "آلمان", en: "Germany" },
  { iso: "FR", dial: "+33", flag: "🇫🇷", fa: "فرانسه", en: "France" },
  { iso: "NL", dial: "+31", flag: "🇳🇱", fa: "هلند", en: "Netherlands" },
  { iso: "SE", dial: "+46", flag: "🇸🇪", fa: "سوئد", en: "Sweden" },
  { iso: "NO", dial: "+47", flag: "🇳🇴", fa: "نروژ", en: "Norway" },
  { iso: "DK", dial: "+45", flag: "🇩🇰", fa: "دانمارک", en: "Denmark" },
  { iso: "FI", dial: "+358", flag: "🇫🇮", fa: "فنلاند", en: "Finland" },
  { iso: "BE", dial: "+32", flag: "🇧🇪", fa: "بلژیک", en: "Belgium" },
  { iso: "CH", dial: "+41", flag: "🇨🇭", fa: "سوئیس", en: "Switzerland" },
  { iso: "AT", dial: "+43", flag: "🇦🇹", fa: "اتریش", en: "Austria" },
  { iso: "IT", dial: "+39", flag: "🇮🇹", fa: "ایتالیا", en: "Italy" },
  { iso: "ES", dial: "+34", flag: "🇪🇸", fa: "اسپانیا", en: "Spain" },
  { iso: "PT", dial: "+351", flag: "🇵🇹", fa: "پرتغال", en: "Portugal" },
  { iso: "IE", dial: "+353", flag: "🇮🇪", fa: "ایرلند", en: "Ireland" },
  { iso: "PL", dial: "+48", flag: "🇵🇱", fa: "لهستان", en: "Poland" },
  { iso: "HU", dial: "+36", flag: "🇭🇺", fa: "مجارستان", en: "Hungary" },
  { iso: "CZ", dial: "+420", flag: "🇨🇿", fa: "چک", en: "Czechia" },
  { iso: "GR", dial: "+30", flag: "🇬🇷", fa: "یونان", en: "Greece" },
  { iso: "CY", dial: "+357", flag: "🇨🇾", fa: "قبرس", en: "Cyprus" },
  { iso: "RU", dial: "+7", flag: "🇷🇺", fa: "روسیه", en: "Russia" },
  { iso: "UA", dial: "+380", flag: "🇺🇦", fa: "اوکراین", en: "Ukraine" },
  { iso: "AM", dial: "+374", flag: "🇦🇲", fa: "ارمنستان", en: "Armenia" },
  { iso: "GE", dial: "+995", flag: "🇬🇪", fa: "گرجستان", en: "Georgia" },
  { iso: "AZ", dial: "+994", flag: "🇦🇿", fa: "آذربایجان", en: "Azerbaijan" },
  { iso: "AF", dial: "+93", flag: "🇦🇫", fa: "افغانستان", en: "Afghanistan" },
  { iso: "TJ", dial: "+992", flag: "🇹🇯", fa: "تاجیکستان", en: "Tajikistan" },
  { iso: "IQ", dial: "+964", flag: "🇮🇶", fa: "عراق", en: "Iraq" },
  { iso: "SA", dial: "+966", flag: "🇸🇦", fa: "عربستان سعودی", en: "Saudi Arabia" },
  { iso: "QA", dial: "+974", flag: "🇶🇦", fa: "قطر", en: "Qatar" },
  { iso: "KW", dial: "+965", flag: "🇰🇼", fa: "کویت", en: "Kuwait" },
  { iso: "BH", dial: "+973", flag: "🇧🇭", fa: "بحرین", en: "Bahrain" },
  { iso: "OM", dial: "+968", flag: "🇴🇲", fa: "عمان", en: "Oman" },
  { iso: "IN", dial: "+91", flag: "🇮🇳", fa: "هند", en: "India" },
  { iso: "MY", dial: "+60", flag: "🇲🇾", fa: "مالزی", en: "Malaysia" },
  { iso: "TH", dial: "+66", flag: "🇹🇭", fa: "تایلند", en: "Thailand" },
  { iso: "CN", dial: "+86", flag: "🇨🇳", fa: "چین", en: "China" },
  { iso: "JP", dial: "+81", flag: "🇯🇵", fa: "ژاپن", en: "Japan" },
  { iso: "KR", dial: "+82", flag: "🇰🇷", fa: "کره جنوبی", en: "South Korea" },
  { iso: "AU", dial: "+61", flag: "🇦🇺", fa: "استرالیا", en: "Australia" },
  { iso: "NZ", dial: "+64", flag: "🇳🇿", fa: "نیوزیلند", en: "New Zealand" },
  { iso: "BR", dial: "+55", flag: "🇧🇷", fa: "برزیل", en: "Brazil" },
  { iso: "MX", dial: "+52", flag: "🇲🇽", fa: "مکزیک", en: "Mexico" },
  { iso: "ZA", dial: "+27", flag: "🇿🇦", fa: "آفریقای جنوبی", en: "South Africa" },
  { iso: "EG", dial: "+20", flag: "🇪🇬", fa: "مصر", en: "Egypt" },
];

export const countryByIso = Object.fromEntries(countries.map((c) => [c.iso, c])) as Record<string, Country>;

const normalizeSearch = (s: string) =>
  s
    .toLowerCase()
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .trim();

/** Matches fa/en name, ISO code or dial code; prefix matches come first. */
export function searchCountries(query: string): Country[] {
  const q = normalizeSearch(query).replace(/^\+/, "");
  if (!q) return countries;
  const ranked: { c: Country; rank: number; i: number }[] = [];
  countries.forEach((c, i) => {
    const keys = [c.fa, c.en.toLowerCase(), c.iso.toLowerCase(), c.dial.slice(1)];
    if (keys.some((k) => k.startsWith(q))) ranked.push({ c, rank: 0, i });
    else if (keys.some((k) => k.includes(q))) ranked.push({ c, rank: 1, i });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.i - b.i).map((r) => r.c);
}

export const consultChannelOptions: Option[] = [
  { value: "whatsapp_chat", label: "چت متنی در واتساپ" },
  { value: "whatsapp_call", label: "تماس صوتی در واتساپ" },
  { value: "google_meet", label: "تماس صوتی در Google Meet" },
];

/* ------------------------------------------------------------------ */
/* Step 3 — Goal & basics                                              */
/* ------------------------------------------------------------------ */

export const primaryGoalOptions: Option[] = [
  { value: "fat_loss", label: "کاهش وزن و چربی" },
  { value: "muscle_strength", label: "افزایش عضله و قدرت" },
  { value: "performance", label: "عملکرد و استقامت" },
  { value: "health_lifestyle", label: "سلامت و سبک زندگی" },
  { value: "body_recomposition", label: "فرم‌دهی بدن" },
];

export const adherenceBarrierOptions: Option[] = [
  { value: "motivation", label: "کمبود انگیزه" },
  { value: "time", label: "کمبود زمان برای تمرین یا آماده‌سازی غذا" },
  { value: "no_results", label: "نتیجه نگرفتن" },
  { value: "boredom", label: "تکراری و خسته‌کننده‌بودن برنامه" },
  { value: "injury", label: "آسیب یا محدودیت جسمی" },
  { value: "other", label: "سایر" },
];

export const serviceInterestOptions: Option[] = [
  { value: "nutrition", label: "تغذیه" },
  { value: "training", label: "تمرین" },
  { value: "nutrition_training", label: "ترکیب تغذیه و تمرین" },
  { value: "not_sure", label: "مطمئن نیستم" },
];

/** Service selections that unlock the exercise-safety step. */
export const exerciseScreeningTriggers = [
  "training",
  "nutrition_training",
  "not_sure",
];

/** Longest e-mail accepted: the CRM e-mail fields (Consultation Submissions, Leads, Contacts) hold 100 characters. */
export const EMAIL_MAX_LENGTH = 100;

export const limits = {
  age: { min: 14, max: 100 },
  height_cm: { min: 100, max: 250 },
  weight_kg: { min: 25, max: 350 },
};

/* ------------------------------------------------------------------ */
/* Step 4 — Health screening (independent flags)                       */
/* ------------------------------------------------------------------ */

export const nutritionIntro =
  "این بخش برای انتخاب مسیر ایمن‌تر است و جایگزین تشخیص یا درمان پزشکی نیست.";

/**
 * Each checkbox is an independent flag_code, shown as one flat list (no UI
 * grouping). `severity` drives safety routing; "SPECIALIST_ROUTING" never
 * blocks purchase and only routes toward a more specialised programme.
 */
export type FlagSeverity = "RED" | "YELLOW" | "SPECIALIST_ROUTING";

export type HealthFlag = { code: string; label: string; severity: FlagSeverity };

export const allHealthFlags: HealthFlag[] = [
  { code: "age_under_18", label: "زیر ۱۸ سال دارم.", severity: "RED" },
  { code: "diabetes_hypoglycemia_risk", label: "دیابت و خطر افت قند دارم.", severity: "YELLOW" },
  { code: "eating_disorder_history", label: "سابقه یا تشخیص اختلال خوردن دارم.", severity: "RED" },
  {
    code: "unstable_cardiac_or_stroke",
    label: "بیماری قلبی ناپایدار یا سابقهٔ سکتهٔ مغزی / قلبی دارم.",
    severity: "RED",
  },
  { code: "liver_cirrhosis_failure", label: "سیروز یا نارسایی کبدی دارم.", severity: "RED" },
  {
    code: "gi_disease_or_surgery",
    label: "بیماری گوارشی یا سابقهٔ جراحی در دستگاه گوارش دارم.",
    severity: "RED",
  },
  {
    code: "unintentional_weight_loss",
    label: "در ماه‌های اخیر کاهش وزن ناخواسته داشته‌ام.",
    severity: "RED",
  },
  {
    code: "severe_weakness_syncope",
    label: "ضعف و سرگیجهٔ شدید یا سابقهٔ غش دارم.",
    severity: "RED",
  },
  {
    code: "severe_food_allergy",
    label: "به مواد غذایی یا منابع پروتئینی آلرژی شدید یا سابقهٔ آنافیلاکسی دارم.",
    severity: "YELLOW",
  },
  { code: "competitive_athlete", label: "ورزشکار حرفه‌ای یا رقابتی هستم.", severity: "SPECIALIST_ROUTING" },
];
export const healthFlagByCode = Object.fromEntries(
  allHealthFlags.map((f) => [f.code, f]),
) as Record<string, HealthFlag>;

export const healthChecklist = {
  question: "کدام‌یک از موارد زیر دربارهٔ شما صدق می‌کند؟",
  helper: "هر موردی که دارید را علامت بزنید.",
  noneValue: "none",
  noneLabel: "هیچ‌کدام از موارد بالا را ندارم",
};

export const sexQuestion = {
  key: "sex",
  question: "جنسیت",
  options: [
    { value: "female", label: "زن" },
    { value: "male", label: "مرد" },
  ] as Option[],
};

export const blockerDetails = {
  key: "blocker_details",
  question: "نام تشخیص، دارو، زمان شروع و نظر پزشک را کوتاه بنویسید.",
};

/** Under-18 forces a specialist route on the nutrition side. */
export const UNDER_18_AGE = 18;

/* ------------------------------------------------------------------ */
/* Step 5 — Exercise safety screening                                  */
/* ------------------------------------------------------------------ */

export const ts01 = {
  key: "ts_01_has_limitation",
  code: "TS-01",
  question:
    "آیا در حال حاضر آسیب، بیماری یا محدودیتی دارید که ممکن است روی تمرین اثر بگذارد؟",
  options: [
    { value: "no", label: "خیر" },
    { value: "yes", label: "بله" },
    { value: "unsure", label: "مطمئن نیستم" },
  ] as Option[],
};

export const ts02 = {
  key: "ts_02_categories",
  code: "TS-02",
  question: "کدام حوزه‌ها مرتبط‌اند؟",
};

export const ts03 = {
  key: "ts_03_clearance",
  code: "TS-03",
  question: "آیا پزشک یا فیزیوتراپیست فعلاً تمرین را ممنوع کرده است؟",
  options: [
    { value: "no", label: "خیر", severity: null },
    { value: "yes", label: "بله", severity: "RED", hardRedFlag: true },
    { value: "not_assessed", label: "هنوز ارزیابی نشده‌ام", severity: "YELLOW" },
  ] as Option[],
};

export type ModuleFieldKey =
  | "diagnosis"
  | "onset"
  | "recovery"
  | "pain"
  | "reaction"
  | "clearance"
  | "notes";

export type ModuleField = {
  key: ModuleFieldKey;
  label: string;
  type: "text" | "textarea" | "radio";
  required: boolean;
  options?: Option[];
};

/** Default, configurable point mapping shared by every sport module. */
const defaultModuleOptions: Record<string, Option[]> = {
  onset: [
    { value: "lt_2w", label: "کمتر از ۲ هفته", points: 3 },
    { value: "2_6w", label: "۲ تا ۶ هفته", points: 2 },
    { value: "6w_6m", label: "۶ هفته تا ۶ ماه", points: 1 },
    { value: "gt_6m", label: "بیش از ۶ ماه", points: 0 },
  ],
  recovery: [
    { value: "improving", label: "رو به بهبود", points: 0 },
    { value: "unchanged", label: "بدون تغییر", points: 2 },
    { value: "worsening", label: "رو به بدتر شدن", points: 4 },
  ],
  pain: [
    { value: "none", label: "ندارم", points: 0 },
    { value: "mild", label: "خفیف", points: 1 },
    { value: "moderate", label: "متوسط", points: 3 },
    { value: "severe", label: "شدید", points: 5 },
  ],
  reaction: [
    { value: "fine", label: "بدون مشکل", points: 0 },
    { value: "slightly_worse", label: "کمی بدتر می‌شود", points: 2 },
    { value: "much_worse", label: "به‌شدت بدتر می‌شود", points: 4 },
  ],
  clearance: [
    { value: "cleared", label: "مجوز دارم", points: 0 },
    { value: "no_ban", label: "مجوز ندارم ولی منع هم نشده‌ام", points: 2 },
    { value: "not_assessed", label: "هنوز ارزیابی نشده‌ام", points: 3 },
  ],
};

export function buildModuleFields(
  overrides: Partial<Record<string, Option[]>> = {},
): ModuleField[] {
  const opts = (k: string) => overrides[k] ?? defaultModuleOptions[k]!;
  return [
    { key: "diagnosis", label: "تشخیص یا نوع وضعیت", type: "text", required: true },
    {
      key: "onset",
      label: "زمان شروع یا آسیب",
      type: "radio",
      required: true,
      options: opts("onset"),
    },
    {
      key: "recovery",
      label: "روند بهبودی یا تغییر علائم",
      type: "radio",
      required: true,
      options: opts("recovery"),
    },
    {
      key: "pain",
      label: "درد یا محدودیت فعلی",
      type: "radio",
      required: true,
      options: opts("pain"),
    },
    {
      key: "reaction",
      label: "واکنش به فعالیت یا تمرین",
      type: "radio",
      required: true,
      options: opts("reaction"),
    },
    {
      key: "clearance",
      label: "مجوز پزشک یا فیزیوتراپیست",
      type: "radio",
      required: true,
      options: opts("clearance"),
    },
    { key: "notes", label: "توضیح تکمیلی", type: "textarea", required: false },
  ];
}

export type SportModule = {
  key: string;
  label: string;
  /** CRM field name for this module's isolated score. */
  scoreField: string;
  fields: ModuleField[];
  hardRedFlags: { value: string; label: string }[];
};

export const sportScoreBands = {
  noReviewMax: 3,
  yellowMin: 4,
  yellowMax: 10,
  redMin: 11,
};

export const sportModules: SportModule[] = [
  {
    key: "tendon",
    label: "تاندون",
    scoreField: "module_score_tendon",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "complete_rupture", label: "پارگی کامل" },
      { value: "visible_deformity", label: "تغییر شکل واضح" },
      { value: "sudden_strength_loss", label: "از دست دادن ناگهانی قدرت" },
      { value: "training_banned", label: "ممنوعیت تمرین از پزشک" },
    ],
  },
  {
    key: "ligament",
    label: "رباط یا بی‌ثباتی مفصل",
    scoreField: "module_score_ligament",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "instability", label: "بی‌ثباتی واضح یا خالی کردن مفصل" },
      { value: "training_banned", label: "ممنوعیت تمرین از پزشک" },
      { value: "acute_symptoms", label: "علائم حاد" },
    ],
  },
  {
    key: "cardiovascular",
    label: "قلب و عروق",
    scoreField: "module_score_cardiovascular",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "chest_pain", label: "درد، فشار یا سنگینی قفسه سینه" },
      { value: "severe_dyspnea", label: "تنگی نفس شدید یا غیرعادی" },
      { value: "palpitations", label: "تپش قلب همراه سرگیجه یا ضعف" },
      { value: "syncope", label: "غش یا نزدیک غش" },
      { value: "uncontrolled_cvd", label: "بیماری قلبی یا عروقی کنترل‌نشده" },
      { value: "recent_stroke", label: "سکته اخیر بدون مجوز فعالیت" },
    ],
  },
  {
    key: "neurological",
    label: "عصبی",
    scoreField: "module_score_neurological",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "seizure", label: "تشنج" },
      { value: "loss_of_consciousness", label: "بیهوشی" },
      { value: "new_weakness", label: "ضعف جدید" },
      { value: "coordination_loss", label: "اختلال هماهنگی قابل توجه" },
    ],
  },
  {
    key: "respiratory",
    label: "تنفسی",
    scoreField: "module_score_respiratory",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "severe_or_worsening", label: "بیماری تنفسی شدید یا در حال تشدید" },
      { value: "recent_admission", label: "بستری اخیر" },
      { value: "cannot_speak", label: "ناتوانی در صحبت کردن به دلیل تنگی نفس" },
      { value: "cyanosis", label: "کبودی لب یا صورت" },
      { value: "chest_pain_syncope", label: "درد قفسه سینه یا غش همراه تنگی نفس" },
    ],
  },
  {
    key: "hematologic",
    label: "خونی یا عروقی",
    scoreField: "module_score_hematologic",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "severe_bleeding", label: "خونریزی شدید" },
      { value: "sudden_dyspnea", label: "تنگی نفس ناگهانی" },
      { value: "chest_pain", label: "درد قفسه سینه" },
      { value: "syncope", label: "غش" },
      { value: "limb_pain_swelling", label: "درد یا تورم جدید اندام" },
    ],
  },
  {
    key: "surgery",
    label: "جراحی یا پیوند",
    scoreField: "module_score_surgery",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "very_recent_surgery", label: "جراحی بسیار اخیر" },
      { value: "post_op_complication", label: "بدتر شدن وضعیت یا عارضه پس از جراحی" },
      { value: "wound_dehiscence", label: "باز شدن زخم" },
      { value: "abnormal_discharge", label: "ترشح غیرعادی زخم" },
      { value: "bleeding", label: "خونریزی" },
      { value: "fever_wound", label: "تب همراه مشکل زخم" },
      { value: "post_op_chest", label: "تنگی نفس یا درد قفسه سینه پس از جراحی" },
    ],
  },
  {
    key: "oncology",
    label: "توده، کیست یا سرطان",
    scoreField: "module_score_oncology",
    fields: buildModuleFields(),
    hardRedFlags: [
      { value: "unknown_mass", label: "توده با نوع نامشخص" },
      { value: "active_cancer", label: "سرطان فعال" },
      { value: "recurrent_metastatic", label: "سرطان عودکننده یا متاستاتیک" },
      { value: "active_heavy_treatment", label: "درمان سنگین فعال بدون ارزیابی فعالیت" },
      { value: "training_banned", label: "ممنوعیت تمرین از پزشک" },
    ],
  },
  {
    key: "other",
    label: "سایر",
    scoreField: "module_score_other",
    fields: buildModuleFields(),
    hardRedFlags: [{ value: "training_banned", label: "ممنوعیت تمرین از پزشک" }],
  },
];

export const sportModuleByKey = Object.fromEntries(
  sportModules.map((m) => [m.key, m]),
) as Record<string, SportModule>;

/* ------------------------------------------------------------------ */
/* Step 6 — Budget & readiness                                         */
/* ------------------------------------------------------------------ */

export const budgetQuestions = {
  IR: {
    currency: "IRT",
    question: "به‌طور میانگین در ماه چقدر برای سلامت، تغذیه و ورزش هزینه می‌کنید؟",
    options: [
      { value: "lt_5m", label: "کمتر از ۵ میلیون تومان" },
      { value: "5_10m", label: "۵ تا ۱۰ میلیون تومان" },
      { value: "10_20m", label: "۱۰ تا ۲۰ میلیون تومان" },
      { value: "gt_20m", label: "بیش از ۲۰ میلیون تومان" },
    ] as Option[],
  },
  INTL: {
    currency: "USD",
    question: "به‌طور میانگین در ماه چقدر برای سلامت، تغذیه و ورزش هزینه می‌کنید؟",
    options: [
      { value: "lt_70", label: "کمتر از ۷۰ دلار" },
      { value: "70_170", label: "۷۰ تا ۱۷۰ دلار" },
      { value: "170_270", label: "۱۷۰ تا ۲۷۰ دلار" },
      { value: "gt_270", label: "بیش از ۲۷۰ دلار" },
    ] as Option[],
  },
};

export const timezoneQuestion = {
  key: "preferred_contact_timezone",
  question: "بهترین منطقهٔ زمانی برای تماس با شما چیست؟",
  helper: "فقط برای هماهنگی زمان تماس تیم با شما استفاده می‌شود.",
  placeholder: "جست‌وجو؛ مثلاً Tehran یا Dubai",
};

export const persianPreferredHelper = "در صورت امکان فارسی وارد کنید.";

export const readinessQuestion = {
  key: "readiness_level",
  code: "CO-14",
  question: "آمادگی شما برای شروع چقدر است؟",
  options: [
    { value: "exploring", label: "در حال بررسی هستم" },
    { value: "free_only", label: "فقط راهکار ساده و رایگان می‌خواهم" },
    { value: "ready_if_results", label: "آماده‌ام اگر نتیجه ببینم" },
    { value: "committed", label: "کاملاً متعهد هستم" },
  ] as Option[],
};

/* ------------------------------------------------------------------ */
/* Step 7 — Consent                                                    */
/* ------------------------------------------------------------------ */

export const consents = {
  processing: {
    key: "consent_processing",
    code: "CO-15",
    label:
      "تأیید می‌کنم اطلاعات این فرم برای پیگیری درخواست مشاوره در Six2Fit ثبت و پردازش شود.",
  },
  accuracy: {
    key: "consent_accuracy",
    code: "CO-16",
    label:
      "اطلاعات را تا حد امکان دقیق وارد کرده‌ام. این فرم جایگزین تشخیص یا درمان پزشکی نیست.",
  },
};

export const submitCta = "ثبت درخواست مشاوره";

/* ------------------------------------------------------------------ */
/* Outcome copy & CRM routing                                          */
/* ------------------------------------------------------------------ */

export const outcomeCopy: Record<
  SafetyOutcome,
  { title: string; text: string; crmStatus: string }
> = {
  GREEN: {
    title: "درخواست شما ثبت شد",
    text: "اطلاعات شما دریافت شد و تیم Six2Fit برای هماهنگی مشاوره با شما در ارتباط خواهد بود.",
    crmStatus: "Consult – Green",
  },
  YELLOW_REVIEW: {
    title: "درخواست شما ثبت شد",
    text: "برای انتخاب مسیر مناسب‌تر، اطلاعات شما ابتدا توسط تیم تخصصی بررسی می‌شود. پس از بررسی برای ادامه مشاوره با شما در ارتباط خواهیم بود.",
    crmStatus: "Consult – Yellow Review",
  },
  RED_SPECIALIST: {
    title: "درخواست شما ثبت شد",
    text: "با توجه به پاسخ‌های شما، پلن عمومی ممکن است انتخاب مناسبی نباشد. اطلاعات شما برای بررسی مسیر تخصصی‌تر ثبت شد و تیم ما برای راهنمایی با شما در ارتباط خواهد بود.",
    crmStatus: "Consult – Red Specialist",
  },
};

export const systemCopy = {
  geoUnresolved:
    "موقعیت کشور شما قابل تشخیص نیست. لطفاً چند دقیقه دیگر دوباره تلاش کنید یا با پشتیبانی در ارتباط باشید.",
  geoLoading: "در حال آماده‌سازی فرم…",
  retry: "تلاش دوباره",
  submitting: "در حال ثبت درخواست…",
  genericError:
    "ثبت درخواست انجام نشد. لطفاً چند لحظه دیگر دوباره تلاش کنید. اگر مشکل ادامه داشت با پشتیبانی در ارتباط باشید.",
  back: "مرحله قبل",
  next: "ادامه",
  required: "لطفاً این مورد را تکمیل کنید.",
};

export const stepTitles = [
  "شروع",
  "اطلاعات تماس",
  "هدف و اطلاعات پایه",
  "غربالگری تغذیه و سلامت",
  "غربالگری ایمنی تمرین",
  "هزینه و آمادگی",
  "رضایت و ارسال",
];
