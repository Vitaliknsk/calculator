import { useCallback, useEffect, useRef, useState } from "react";

/* ================================================================
   ВАЛЮТНЫЙ ДВОР — SPA-калькулятор валют: RUB / USD / THB
   ----------------------------------------------------------------
   • Данные о курсах хранятся в LocalStorage браузера — бэкенд
     не нужен, курсы переживают перезагрузку страницы.
   • Администратор задаёт только ДВА курса относительно базовой
     валюты USD. Все остальные пары (в том числе RUB ↔ THB)
     пересчитываются автоматически — это и есть логика
     «треугольного арбитража»: любые три валюты через общий
     базис всегда согласованы, «дыр» в кросс-курсах не возникает.
   • При первом запуске подставляются курсы по умолчанию,
     поэтому калькулятор никогда не показывает NaN.
   • Кроссбраузерность: код написан в пределах синтаксиса
     Safari 14+ (без опциональных цепочек в рантайм-критичных
     местах), буфер обмена имеет запасной путь для iOS,
     вёрстка учитывает safe-area и dvh.
   ================================================================ */

/* ---------------- Типы и справочники ---------------- */

type Currency = "RUB" | "USD" | "THB";

interface Rates {
  usdRub: number; // сколько рублей (₽) дают за 1 доллар США
  usdThb: number; // сколько тайских бат (฿) дают за 1 доллар США
  savedAt: number; // момент сохранения (unix-время в мс) — для «обновлено N назад»
}

interface Prefs {
  amount: string;
  from: Currency;
  to: Currency;
}

const CURRENCY_META: Record<Currency, { title: string; symbol: string; name: string }> = {
  RUB: { title: "Российский рубль", symbol: "₽", name: "Рубль" },
  USD: { title: "Доллар США", symbol: "$", name: "Доллар" },
  THB: { title: "Тайский бат", symbol: "฿", name: "Бат" },
};

const CURRENCIES: Currency[] = ["RUB", "USD", "THB"];

const LS_RATES_KEY = "valdvor.rates.v1";
const LS_PREFS_KEY = "valdvor.prefs.v1";

// Дефолтные курсы первого запуска (приближены к рыночным).
// Если LocalStorage пуст или повреждён — используем именно их.
const DEFAULT_RATES: Rates = { usdRub: 96.45, usdThb: 34.12, savedAt: Date.now() };

const sym = (c: Currency) => CURRENCY_META[c].symbol;

/* ================================================================
   ЛОГИКА ПЕРЕСЧЁТА КУРСОВ (включая треугольный арбитраж)
   ----------------------------------------------------------------
   Храним только два числа относительно базовой валюты USD:
     usdRub — «₽ за 1 $»,  usdThb — «฿ за 1 $».

   Курс любой пары X → Y вычисляется через базовый доллар:

     rate(X → Y) = rate(USD → Y) / rate(USD → X)

   Пример треугольника RUB → USD → THB:
     rate(RUB → THB) = usdThb / usdRub
     Если 1 $ = 96,45 ₽ и 1 $ = 34,12 ฿, то
     1 ₽ = 34,12 / 96,45 ≈ 0,3538 ฿.

   Обратные направления — просто перевёрнутая дробь:
     rate(THB → RUB) = usdRub / usdThb ≈ 2,8268.

   Поэтому, когда администратор меняет USD/RUB или USD/THB,
   курс RUB/THB пересчитывается сам: все шесть направлений
   всегда сходятся в один согласованный «треугольник».
   ================================================================ */

function getRate(from: Currency, to: Currency, rates: Rates): number {
  if (from === to) return 1;
  // «Цена» каждой валюты, выраженная в единицах за 1 доллар:
  const perUsd: Record<Currency, number> = {
    RUB: rates.usdRub, // за 1 $ дают usdRub рублей
    USD: 1,
    THB: rates.usdThb, // за 1 $ дают usdThb бат
  };
  // rate(X→Y) = (Y за 1 $) / (X за 1 $) — универсальная формула,
  // она же покрывает и прямой курс (USD→RUB), и кросс-курс (RUB→THB).
  return perUsd[to] / perUsd[from];
}

/* ---------------- LocalStorage: чтение с защитой от NaN ---------------- */

function loadRates(): Rates {
  try {
    const raw = localStorage.getItem(LS_RATES_KEY);
    if (!raw) return { ...DEFAULT_RATES }; // первый запуск — дефолты
    const parsed = JSON.parse(raw) as Partial<Rates>;
    const usdRub = Number(parsed.usdRub);
    const usdThb = Number(parsed.usdThb);
    const savedAt = Number(parsed.savedAt);
    // Защита: любые нечисловые/неположительные значения → дефолты
    if (!Number.isFinite(usdRub) || usdRub <= 0) return { ...DEFAULT_RATES };
    if (!Number.isFinite(usdThb) || usdThb <= 0) return { ...DEFAULT_RATES };
    return {
      usdRub,
      usdThb,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now(),
    };
  } catch {
    return { ...DEFAULT_RATES }; // битый JSON — тоже не страшно
  }
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { amount: "1000", from: "RUB", to: "THB" };
  try {
    const raw = localStorage.getItem(LS_PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const isCur = (v: unknown): v is Currency => v === "RUB" || v === "USD" || v === "THB";
    return {
      amount: typeof p.amount === "string" ? sanitizeAmount(p.amount) : fallback.amount,
      from: isCur(p.from) ? p.from : fallback.from,
      to: isCur(p.to) ? p.to : fallback.to,
    };
  } catch {
    return fallback;
  }
}

/* ---------------- Валидация и форматирование ---------------- */

// Пропускаем только цифры и один разделитель (точку или запятую) —
// вставить буквы в поле суммы физически не получится.
function sanitizeAmount(raw: string): string {
  let s = raw.replace(/\s/g, "").replace(",", ".");
  s = s.replace(/[^0-9.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  return s.slice(0, 12);
}

function parseAmount(s: string): number | null {
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Строгая проверка курса для админ-панели:
// только число, строго больше нуля, без «космических» значений.
function parseRateInput(raw: string): { value: number | null; error: string | null } {
  const s = raw.trim().replace(",", ".");
  if (!s) return { value: null, error: "Введите значение курса" };
  if (!/^\d*\.?\d*$/.test(s)) return { value: null, error: "Допустимы только цифры и одна точка" };
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) return { value: null, error: "Курс должен быть числом больше нуля" };
  if (v > 100000) return { value: null, error: "Слишком большое значение (максимум 100 000)" };
  return { value: v, error: null };
}

const nf2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfSig = new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 4 });
const nfInt = new Intl.NumberFormat("ru-RU");

// Результат конвертации — всегда ровно 2 знака после запятой (по ТЗ)
const formatMoney = (n: number) => nf2.format(n);
// Курсы: 4 значащие цифры, чтобы мелкие значения (0,0104) не теряли смысл
const formatRate = (n: number) => nfSig.format(n);

function timeAgo(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 45) return "только что";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---------------- Хук scroll-reveal ----------------
   Секции мягко всплывают при попадании в зону видимости.
   С защитой: если IntersectionObserver недоступен (старый Safari)
   или событие так и не пришло — контент показываем по таймауту,
   страница никогда не остаётся «слепой». */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        });
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    const fallback = window.setTimeout(() => setInView(true), 1500);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);
  return { ref, inView };
}

const revealClass = (inView: boolean) => `reveal ${inView ? "is-in" : ""}`;

/* ---------------- Копирование в буфер (iOS-совместимое) ----------------
   navigator.clipboard в Safari работает только по HTTPS и с версии 13.4,
   поэтому всегда держим запасной путь через скрытое поле:
   именно связка select() + setSelectionRange() надёжна на iOS. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* переходим к запасному способу */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // обязательно для iOS Safari
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ---------------- Иконки (инлайновые SVG) ---------------- */

const svgProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconSwap() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" {...svgProps}>
      <path d="M7 4v13" />
      <path d="m3.5 7.5 3.5-3.5 3.5 3.5" />
      <path d="M17 20V7" />
      <path d="m13.5 16.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" {...svgProps} strokeWidth={2}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} strokeWidth={2.6}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps}>
      <path d="M12 3.5 2.5 20h19L12 3.5z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.6h.01" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </svg>
  );
}

function IconCalc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps}>
      <rect x="5" y="3" width="14" height="18" rx="2.5" />
      <path d="M8.5 7.2h7" />
      <path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...svgProps}>
      <path d="M3 3v6h6" />
      <path d="M3.5 9A9 9 0 1 1 3 13.5" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...svgProps}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} strokeWidth={2.6}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...svgProps} strokeWidth={2}>
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15h-.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5" />
    </svg>
  );
}

function Logo() {
  return (
    <svg width="42" height="42" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="var(--color-pine-900)" stroke="var(--color-pine-700)" />
      <circle cx="23" cy="25" r="12" stroke="var(--color-gold-400)" strokeWidth="2.6" />
      <path
        d="M19 18v14M19 21.5h5a3.6 3.6 0 0 1 0 7.2h-5"
        stroke="var(--color-gold-400)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="37" cy="11" r="7" fill="var(--color-gold-500)" />
      <path d="M34.2 11h5.6M37 8.2v5.6" stroke="var(--color-pine-950)" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------- Бегущая строка курсов ---------------- */

const TICKER_PAIRS: [Currency, Currency][] = [
  ["USD", "RUB"],
  ["USD", "THB"],
  ["RUB", "THB"],
  ["THB", "RUB"],
  ["RUB", "USD"],
  ["THB", "USD"],
];

function Ticker({ rates }: { rates: Rates }) {
  const items = TICKER_PAIRS.map(([a, b]) => ({
    label: `${a} → ${b}`,
    value: formatRate(getRate(a, b, rates)),
  }));
  // Две одинаковые половины дорожки: сдвиг на -50% = бесшовный цикл
  const half = (hidden: boolean) => (
    <div className="flex shrink-0 items-center" aria-hidden={hidden}>
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-3 px-5">
          <span className="text-[0.72rem] font-bold tracking-widest text-pine-300">{it.label}</span>
          <span className="font-display text-[0.8rem] font-semibold text-gold-300 tabular-nums">{it.value}</span>
          <span className="text-[0.55rem] text-pine-700">◆</span>
        </span>
      ))}
    </div>
  );
  return (
    <div
      className="ticker overflow-hidden border-b border-pine-800 bg-pine-950 py-2.5"
      title="Наведите, чтобы остановить строку"
    >
      <div className="ticker-track flex w-max">
        {half(false)}
        {half(true)}
      </div>
    </div>
  );
}

/* ---------------- Табло актуальных курсов ---------------- */

function RatesBoard({ rates, from, to, now }: { rates: Rates; from: Currency; to: Currency; now: number }) {
  // Две пары админ задаёт напрямую, третья (RUB/THB) — производная
  const rows: { a: Currency; b: Currency; note: string }[] = [
    { a: "USD", b: "RUB", note: "Базовый курс — задаёт администратор" },
    { a: "USD", b: "THB", note: "Базовый курс — задаёт администратор" },
    { a: "RUB", b: "THB", note: "Кросс-курс — вычислен через USD" },
  ];

  return (
    <section className="card p-5 sm:p-6" aria-label="Актуальные курсы">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold text-ink">Табло курсов</h2>
          <p className="mt-1.5 flex items-center gap-1.5 text-[0.78rem] font-medium text-ink-soft">
            <IconClock />
            обновлено {timeAgo(rates.savedAt, now)}
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-pine-100 bg-pine-50 px-3 py-1.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pine-500 opacity-60" />
            <span className="live-glow relative inline-flex h-2.5 w-2.5 rounded-full bg-pine-500" />
          </span>
          <span className="text-[0.66rem] font-extrabold uppercase tracking-[0.16em] text-pine-600">онлайн</span>
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-gold-300 bg-gold-100 px-4 py-2.5">
        <span className="text-[0.74rem] font-bold text-gold-700">Базовая валюта</span>
        <span className="font-display text-sm font-bold text-pine-900">USD $</span>
      </div>

      <div className="mt-4 flex flex-col gap-2.5">
        {rows.map(({ a, b, note }) => {
          const r = getRate(a, b, rates);
          const active = (from === a && to === b) || (from === b && to === a);
          return (
            <div
              key={`${a}-${b}`}
              className={`rounded-2xl border p-4 transition-all duration-300 ${
                active
                  ? "border-pine-500 bg-pine-50 shadow-soft"
                  : "border-line bg-white hover:-translate-y-0.5 hover:border-pine-200 hover:bg-pine-50/60"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[0.82rem] font-semibold tracking-wide text-pine-800">
                      {a} → {b}
                    </span>
                    {active && (
                      <span className="rounded-full bg-pine-600 px-2 py-0.5 text-[0.6rem] font-extrabold uppercase tracking-widest text-white">
                        ваша пара
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[0.72rem] text-ink-soft">{note}</p>
                </div>
                <div className="text-right">
                  {/* key меняется вместе со значением → жёлтая вспышка при обновлении курса */}
                  <span
                    key={`${a}${b}${formatRate(r)}`}
                    className="rate-flash inline-block px-1 font-display text-xl font-bold text-ink tabular-nums"
                  >
                    {formatRate(r)}
                  </span>
                  <p className="text-[0.72rem] text-ink-soft tabular-nums">
                    1 {b} = {formatRate(1 / r)} {a}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-xl border border-pine-100 bg-pine-50 p-3 text-[0.74rem] leading-relaxed text-pine-800">
        <span className="mt-0.5 shrink-0 text-pine-600">
          <IconInfo />
        </span>
        Кросс-курс RUB ↔ THB не хранится, а вычисляется через базовый доллар: (฿ за $) ÷ (₽ за $).
        Треугольник всегда сходится — арбитражных разрывов нет.
      </p>
    </section>
  );
}

/* ---------------- Калькулятор ---------------- */

interface ConverterProps {
  amount: string;
  onAmount: (v: string) => void;
  from: Currency;
  to: Currency;
  onFrom: (c: Currency) => void;
  onTo: (c: Currency) => void;
  onSwap: () => void;
  onCalc: () => void;
  onCopy: () => void;
  spinKey: number;
  pulseKey: number;
  rates: Rates;
}

function CurrencySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Currency;
  onChange: (c: Currency) => void;
}) {
  return (
    <div className="select-shell mt-1.5">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as Currency)}>
        {CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c} · {sym(c)} — {CURRENCY_META[c].title}
          </option>
        ))}
      </select>
      <IconChevron />
    </div>
  );
}

function ConverterCard(props: ConverterProps) {
  const { amount, onAmount, from, to, onFrom, onTo, onSwap, onCalc, onCopy, spinKey, pulseKey, rates } = props;

  // Авторасчёт: результат пересчитывается при каждом изменении полей
  const rate = getRate(from, to, rates);
  const amountValue = parseAmount(amount);
  const result = amountValue === null ? null : amountValue * rate;

  return (
    <section className="card anim-rise relative overflow-hidden p-5 sm:p-7" aria-label="Калькулятор валют">
      {/* Декоративные круги — лёгкая «монетная» геометрия */}
      <div className="pointer-events-none absolute -right-14 -top-14 h-44 w-44 rounded-full border-[10px] border-pine-50" />
      <div className="pointer-events-none absolute -right-2 -top-2 h-16 w-16 rounded-full bg-gold-100" />

      <header className="relative">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-bold text-ink sm:text-2xl">Калькулятор валют</h1>
            <p className="mt-1.5 text-sm text-ink-soft">
              {CURRENCY_META[from].name} ⇄ {CURRENCY_META[to].name} — пересчёт при каждом изменении
            </p>
          </div>
          <span className="rounded-full border border-line bg-paper px-3 py-1.5 text-[0.68rem] font-extrabold uppercase tracking-widest text-ink-soft">
            ₽ · $ · ฿
          </span>
        </div>
      </header>

      <form
        className="relative mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          onCalc();
        }}
      >
        {/* Сумма + валюта «Из» */}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <div>
            <label htmlFor="amount" className="field-label">
              Сумма
            </label>
            <div className="relative mt-1.5">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-display text-lg font-bold text-pine-600">
                {sym(from)}
              </span>
              <input
                id="amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="1 000"
                className="w-full rounded-2xl border-2 border-line bg-white py-3.5 pl-11 pr-4 font-display text-lg font-semibold text-ink transition placeholder:text-ink-soft/40 focus:border-pine-500 focus:outline-none focus:ring-4 focus:ring-pine-500/15 sm:text-xl"
                value={amount}
                onChange={(e) => onAmount(sanitizeAmount(e.target.value))}
              />
            </div>
          </div>
          <div>
            <label htmlFor="cur-from" className="field-label">
              Из валюты
            </label>
            <CurrencySelect id="cur-from" value={from} onChange={onFrom} />
          </div>
        </div>

        {/* Кнопка «поменять местами» */}
        <div className="relative z-10 -my-1 flex justify-center py-1">
          <button
            type="button"
            onClick={onSwap}
            title="Поменять валюты местами"
            aria-label="Поменять валюты местами"
            className="rounded-full bg-pine-700 p-3 text-white shadow-lift transition hover:bg-pine-600 active:scale-90"
          >
            <span key={spinKey} className={spinKey ? "anim-spin-once block" : "block"}>
              <IconSwap />
            </span>
          </button>
        </div>

        {/* Валюта «В» + текущий курс пары */}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <div>
            <label htmlFor="cur-to" className="field-label">
              В валюту
            </label>
            <CurrencySelect id="cur-to" value={to} onChange={onTo} />
          </div>
          <div>
            <span className="field-label">Текущий курс пары</span>
            <div className="mt-1.5 rounded-2xl border-2 border-dashed border-line bg-pine-50/70 px-4 py-3 text-sm font-semibold text-pine-800 tabular-nums">
              1 {from} ={" "}
              <span key={formatRate(rate)} className="rate-flash inline-block px-0.5 font-bold">
                {formatRate(rate)}
              </span>{" "}
              {to}
            </div>
          </div>
        </div>

        {/* Быстрые суммы */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[0.7rem] font-extrabold uppercase tracking-widest text-ink-soft">Быстро:</span>
          {[100, 1000, 5000, 10000, 50000].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onAmount(String(v))}
              className={`rounded-full border px-3 py-1 text-[0.78rem] font-bold transition active:scale-95 ${
                amount === String(v)
                  ? "border-pine-600 bg-pine-600 text-white"
                  : "border-line bg-white text-pine-800 hover:border-pine-300 hover:bg-pine-50"
              }`}
            >
              {nfInt.format(v)}
            </button>
          ))}
        </div>

        <button
          type="submit"
          className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-gold-500 px-5 py-3.5 font-display text-[0.95rem] font-bold text-pine-950 shadow-soft transition hover:bg-gold-400 hover:shadow-lift active:scale-[0.98]"
        >
          <IconCalc />
          Рассчитать
        </button>
      </form>

      {/* Панель результата */}
      <div
        key={pulseKey}
        className={`relative mt-5 overflow-hidden rounded-2xl bg-pine-900 text-white shadow-lift ${pulseKey ? "anim-pop" : ""}`}
        aria-live="polite"
      >
        <div className="pointer-events-none absolute -right-10 -bottom-16 h-40 w-40 rounded-full border-[12px] border-pine-800" />
        <div className="pointer-events-none absolute -left-6 -top-10 h-24 w-24 rounded-full bg-pine-800/70" />

        {result !== null ? (
          <div className="relative px-5 py-5 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[0.68rem] font-extrabold uppercase tracking-[0.18em] text-pine-300">Результат</p>
              <button
                type="button"
                onClick={onCopy}
                title="Скопировать результат"
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-pine-700 bg-pine-800/80 px-3 py-1.5 text-[0.72rem] font-bold text-pine-200 transition hover:border-gold-500 hover:text-gold-300 active:scale-95"
              >
                <IconCopy />
                Скопировать
              </button>
            </div>
            <p className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
              <span className="text-sm font-semibold text-pine-200 tabular-nums">
                {formatMoney(amountValue ?? 0)} {sym(from)}
              </span>
              <span className="self-center text-pine-400">
                <IconArrowRight />
              </span>
              <span className="font-display text-3xl font-bold leading-none text-gold-300 tabular-nums sm:text-4xl">
                {formatMoney(result)}
              </span>
              <span className="font-display text-xl font-semibold text-gold-500">{sym(to)}</span>
            </p>
            <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-1 text-[0.78rem] font-medium text-pine-200 tabular-nums">
              <span>
                Курс: 1 {from} = {formatRate(rate)} {to}
              </span>
              <span>
                Обратный: 1 {to} = {formatRate(1 / rate)} {from}
              </span>
            </div>
            {/* Подсказка про треугольник — только для кросс-пары RUB↔THB */}
            {from !== "USD" && to !== "USD" && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-pine-800 px-2.5 py-1.5 text-[0.7rem] font-bold text-gold-300">
                <IconInfo />
                Кросс-курс через базовый USD: треугольник {from} – USD – {to}
              </p>
            )}
          </div>
        ) : (
          <div className="relative px-5 py-6 sm:px-6">
            <p className="text-[0.68rem] font-extrabold uppercase tracking-[0.18em] text-pine-300">Результат</p>
            <p className="mt-2.5 font-display text-base font-semibold text-pine-100/90 sm:text-lg">
              Введите сумму — результат появится мгновенно
            </p>
            <p className="mt-1 text-[0.78rem] text-pine-300">
              Например: 1 000 {sym(from)} = {formatMoney(1000 * rate)} {sym(to)}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- Админ-панель (модальное окно) ---------------- */

interface AdminModalProps {
  rates: Rates;
  onSave: (next: { usdRub: number; usdThb: number }) => void;
  onClose: () => void;
}

function AdminModal({ rates, onSave, onClose }: AdminModalProps) {
  // Черновики курсов — как строки, чтобы админ мог свободно редактировать
  const [rubStr, setRubStr] = useState(() => String(rates.usdRub).replace(".", ","));
  const [thbStr, setThbStr] = useState(() => String(rates.usdThb).replace(".", ","));
  const [justSaved, setJustSaved] = useState(false);

  // Закрытие по Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rub = parseRateInput(rubStr);
  const thb = parseRateInput(thbStr);
  const valid = rub.value !== null && thb.value !== null;

  /* Треугольный арбитраж в действии: как только оба базовых курса
     корректны, МГНОВЕННО показываем производные пары.
     RUB → THB = (฿ за 1 $) ÷ (₽ за 1 $)
     THB → RUB = (₽ за 1 $) ÷ (฿ за 1 $) — и так далее. */
  const derived = valid
    ? {
        rubThb: (thb.value as number) / (rub.value as number),
        thbRub: (rub.value as number) / (thb.value as number),
        rubUsd: 1 / (rub.value as number),
        thbUsd: 1 / (thb.value as number),
      }
    : null;

  const previewRows: [string, string | null][] = [
    ["RUB → THB", derived ? formatRate(derived.rubThb) : null],
    ["THB → RUB", derived ? formatRate(derived.thbRub) : null],
    ["RUB → USD", derived ? formatRate(derived.rubUsd) : null],
    ["THB → USD", derived ? formatRate(derived.thbUsd) : null],
  ];

  // Сохранение: короткая зелёная индикация на кнопке, затем коммит
  const handleSave = () => {
    if (!valid || justSaved) return;
    setJustSaved(true);
    window.setTimeout(() => onSave({ usdRub: rub.value as number, usdThb: thb.value as number }), 700);
  };

  const inputClass = (hasError: boolean) =>
    `w-full rounded-xl border-2 bg-white px-4 py-3 pr-12 font-display text-lg font-semibold text-ink tabular-nums transition focus:outline-none focus:ring-4 ${
      hasError
        ? "border-danger-600 focus:border-danger-600 focus:ring-danger-600/15"
        : "border-line focus:border-pine-500 focus:ring-pine-500/15"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Настройки курсов — админ-панель"
      /* safe-area: на iPhone с «чёлкой» нижний лист не налезает на домашнюю полоску */
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div className="anim-backdrop modal-backdrop absolute inset-0" onMouseDown={onClose} />

      <div className="anim-modal relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-line bg-card shadow-lift sm:rounded-3xl">
        <div className="p-5 sm:p-7">
          {/* Шапка */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-pine-900 text-gold-400">
                <IconGear />
              </span>
              <div>
                <h2 className="font-display text-lg font-bold text-ink">Настройки курсов</h2>
                <p className="text-[0.74rem] font-semibold uppercase tracking-widest text-pine-600">
                  админ-панель · база USD
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Закрыть"
              className="rounded-xl border border-line bg-white p-2.5 text-ink-soft transition hover:border-pine-200 hover:bg-pine-50 hover:text-ink"
            >
              <IconClose />
            </button>
          </div>

          <p className="mt-4 rounded-xl border border-pine-100 bg-pine-50 p-3.5 text-[0.8rem] leading-relaxed text-pine-800">
            Задайте <b>два курса относительно доллара</b> — все остальные пары, включая RUB ↔ THB,
            пересчитаются автоматически по треугольнику.
          </p>

          {/* Два базовых курса */}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="adm-rub" className="field-label">
                Курс USD → RUB
              </label>
              <div className="relative mt-1.5">
                <input
                  id="adm-rub"
                  inputMode="decimal"
                  autoComplete="off"
                  className={inputClass(!!rub.error)}
                  value={rubStr}
                  onChange={(e) => setRubStr(sanitizeAmount(e.target.value))}
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-display font-bold text-ink-soft">
                  ₽
                </span>
              </div>
              <p className="mt-1 text-[0.72rem] text-ink-soft">сколько рублей за 1 доллар</p>
              {rub.error && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[0.74rem] font-bold text-danger-600">
                  <IconAlert /> {rub.error}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="adm-thb" className="field-label">
                Курс USD → THB
              </label>
              <div className="relative mt-1.5">
                <input
                  id="adm-thb"
                  inputMode="decimal"
                  autoComplete="off"
                  className={inputClass(!!thb.error)}
                  value={thbStr}
                  onChange={(e) => setThbStr(sanitizeAmount(e.target.value))}
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-display font-bold text-ink-soft">
                  ฿
                </span>
              </div>
              <p className="mt-1 text-[0.72rem] text-ink-soft">сколько бат за 1 доллар</p>
              {thb.error && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[0.74rem] font-bold text-danger-600">
                  <IconAlert /> {thb.error}
                </p>
              )}
            </div>
          </div>

          {/* Производные пары — живой пересчёт треугольника */}
          <div className="mt-5 rounded-2xl border border-line bg-paper/70 p-4">
            <p className="field-label">Производные пары · пересчёт автоматически</p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {previewRows.map(([label, val]) => (
                <div key={label} className="rounded-xl border border-line bg-white px-3.5 py-2.5">
                  <p className="text-[0.66rem] font-extrabold uppercase tracking-widest text-ink-soft">{label}</p>
                  <p className="mt-1 font-display text-[0.95rem] font-bold text-pine-800 tabular-nums">{val ?? "—"}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[0.72rem] leading-relaxed text-ink-soft">
              RUB → THB = (฿ за 1 $) ÷ (₽ за 1 $). Меняется любой базовый курс — весь треугольник
              сходится заново, рассинхрон невозможен.
            </p>
          </div>

          {/* Действия */}
          <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <button
              onClick={() => {
                setRubStr(String(DEFAULT_RATES.usdRub).replace(".", ","));
                setThbStr(String(DEFAULT_RATES.usdThb).replace(".", ","));
              }}
              className="flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold text-ink-soft transition hover:bg-pine-50 hover:text-pine-800"
            >
              <IconRefresh />
              Курсы по умолчанию
            </button>
            <div className="flex gap-2.5">
              <button
                onClick={onClose}
                className="rounded-xl border-2 border-line bg-white px-4 py-2.5 text-sm font-bold text-ink-soft transition hover:border-pine-200 hover:text-ink"
              >
                Отмена
              </button>
              <button
                onClick={handleSave}
                disabled={!valid || justSaved}
                className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white shadow-soft transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                  justSaved ? "bg-pine-600" : "bg-pine-700 hover:bg-pine-600"
                }`}
              >
                {justSaved ? (
                  <>
                    <IconCheck /> Сохранено
                  </>
                ) : (
                  "Сохранить"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Toast-уведомления ---------------- */

interface ToastState {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

function ToastView({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  return (
    <div
      className="fixed left-1/2 z-[60] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0"
      /* отступ от нижнего края с учётом домашней полоски iPhone */
      style={{ bottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
    >
      <div
        key={toast.id}
        className="anim-toast flex items-center gap-3 rounded-2xl border border-pine-700 bg-pine-900 px-4 py-3.5 text-white shadow-lift"
        role="status"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            toast.kind === "success"
              ? "bg-pine-600"
              : toast.kind === "error"
                ? "bg-danger-600"
                : "bg-gold-500 text-pine-950"
          }`}
        >
          {toast.kind === "success" ? <IconCheck /> : toast.kind === "error" ? <IconAlert /> : <IconInfo />}
        </span>
        <p className="text-sm font-semibold leading-snug">{toast.text}</p>
        <button
          onClick={onClose}
          aria-label="Закрыть уведомление"
          className="ml-auto rounded-lg p-1.5 text-pine-300 transition hover:bg-pine-800 hover:text-white"
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}

/* ---------------- Главный компонент ---------------- */

export default function App() {
  // Курсы и настройки читаются из LocalStorage уже при инициализации
  const [rates, setRates] = useState<Rates>(() => loadRates());
  const [amount, setAmount] = useState<string>(() => loadPrefs().amount);
  const [from, setFrom] = useState<Currency>(() => loadPrefs().from);
  const [to, setTo] = useState<Currency>(() => loadPrefs().to);

  const [adminOpen, setAdminOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [spinKey, setSpinKey] = useState(0); // анимация разворота swap-кнопки
  const [pulseKey, setPulseKey] = useState(0); // «всплеск» панели результата
  const [now, setNow] = useState(() => Date.now()); // для «обновлено N назад»

  // Scroll-reveal для секций правого столбца
  const boardReveal = useReveal<HTMLDivElement>();
  const howReveal = useReveal<HTMLElement>();

  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((text: string, kind: ToastState["kind"] = "success") => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), kind, text });
    toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  // Запоминаем выбор пользователя (сумма + валюты) между визитами
  useEffect(() => {
    try {
      localStorage.setItem(LS_PREFS_KEY, JSON.stringify({ amount, from, to }));
    } catch {
      /* приватный режим Safari — не критично */
    }
  }, [amount, from, to]);

  // Тик раз в 15 секунд, чтобы «обновлено N мин назад» не застывало
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  const handleSwap = () => {
    setFrom(to);
    setTo(from);
    setSpinKey((k) => k + 1);
  };

  const handleCalc = () => {
    if (parseAmount(amount) === null) {
      showToast("Введите корректную сумму — число больше нуля", "error");
      return;
    }
    setPulseKey((k) => k + 1); // авторасчёт уже сработал — кнопка лишь подтверждает
  };

  const handleCopy = async () => {
    const v = parseAmount(amount);
    if (v === null) {
      showToast("Нечего копировать — сначала введите сумму", "error");
      return;
    }
    const text = `${formatMoney(v * getRate(from, to, rates))} ${sym(to)}`;
    const ok = await copyText(text);
    showToast(ok ? `Скопировано: ${text}` : "Не удалось скопировать — выделите результат вручную", ok ? "info" : "error");
  };

  // Сохранение курсов из админ-панели: LocalStorage + мгновенное применение
  const handleSaveRates = (next: { usdRub: number; usdThb: number }) => {
    const updated: Rates = { ...next, savedAt: Date.now() };
    setRates(updated);
    try {
      localStorage.setItem(LS_RATES_KEY, JSON.stringify(updated));
    } catch {
      /* приватный режим Safari — курсы проживут до перезагрузки */
    }
    setAdminOpen(false);
    setPulseKey((k) => k + 1);
    showToast("Курсы сохранены и применены к калькулятору", "success");
  };

  return (
    <div className="flex min-h-screen flex-col font-body text-ink">
      {/* Бегущая строка — первое, что видит посетитель обменника */}
      <Ticker rates={rates} />

      {/* Шапка (с отступом под «чёлку» в полноэкранном PWA-режиме) */}
      <header
        className="anim-rise mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 sm:px-6"
        style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-3.5">
          <Logo />
          <div>
            <p className="font-display text-lg font-bold leading-tight text-ink">Валютный двор</p>
            <p className="mt-0.5 text-[0.68rem] font-extrabold uppercase tracking-[0.22em] text-pine-600">
              RUB · USD · THB
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="hidden items-center gap-1.5 rounded-full border border-line bg-white px-3.5 py-2 text-[0.75rem] font-semibold text-ink-soft md:flex">
            <IconClock />
            курсы: {timeAgo(rates.savedAt, now)}
          </span>
          <button
            onClick={() => setAdminOpen(true)}
            className="flex items-center gap-2 rounded-full bg-pine-900 px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:bg-pine-700 active:scale-95"
          >
            <IconGear />
            Настройки курсов
          </button>
        </div>
      </header>

      {/* Контент: калькулятор + табло курсов */}
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-start">
        <ConverterCard
          amount={amount}
          onAmount={setAmount}
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
          onSwap={handleSwap}
          onCalc={handleCalc}
          onCopy={handleCopy}
          spinKey={spinKey}
          pulseKey={pulseKey}
          rates={rates}
        />

        <div className="flex flex-col gap-5">
          <div ref={boardReveal.ref} className={revealClass(boardReveal.inView)}>
            <RatesBoard rates={rates} from={from} to={to} now={now} />
          </div>

          {/* Как это устроено */}
          <section
            ref={howReveal.ref}
            className={`card p-5 sm:p-6 ${revealClass(howReveal.inView)}`}
            aria-label="Как работает пересчёт"
          >
            <h2 className="font-display text-base font-bold text-ink">Как работает пересчёт</h2>
            <ol className="mt-4 flex flex-col gap-3.5">
              {[
                ["01", "Администратор фиксирует два курса относительно базового доллара: USD → RUB и USD → THB."],
                ["02", "Кросс-курс RUB ↔ THB вычисляется автоматически: (฿ за $) ÷ (₽ за $) — треугольник всегда согласован."],
                ["03", "Курсы сохраняются в LocalStorage браузера и мгновенно применяются к калькулятору и табло."],
              ].map(([num, text]) => (
                <li key={num} className="flex gap-3.5">
                  <span className="font-display text-sm font-bold text-gold-600">{num}</span>
                  <p className="text-[0.82rem] leading-relaxed text-ink-soft">{text}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>

      {/* Футер */}
      <footer className="mx-auto w-full max-w-6xl px-4 pb-safe sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[0.74rem] text-ink-soft">
          <p>Курсы задаются вручную в админ-панели и хранятся локально в вашем браузере — без сервера и внешних API.</p>
          <p className="tabular-nums">
            Последнее сохранение: {new Date(rates.savedAt).toLocaleString("ru-RU")}
          </p>
        </div>
      </footer>

      {/* Админ-панель */}
      {adminOpen && <AdminModal rates={rates} onSave={handleSaveRates} onClose={() => setAdminOpen(false)} />}

      {/* Уведомления */}
      {toast && <ToastView toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
