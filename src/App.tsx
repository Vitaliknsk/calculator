import { useCallback, useEffect, useRef, useState } from "react";

/* ================================================================
   ВАЛЮТНЫЙ ДВОР — минималистичный SPA-калькулятор: RUB / USD / THB
   ----------------------------------------------------------------
   Интерфейс пользователя — только самое нужное:
     сумма → валюта «Из» → swap → валюта «В» → результат + курс пары.

    Админ задаёт вручную лишь ДВА курса (оба — к тайскому бату):
      usdThb — ฿ за 1 $,   rubThb — ฿ за 1 ₽.
    Обратные направления (฿ → $, ฿ → ₽) выводятся автоматически.

    ВАЖНО: конвертация между USD и RUB ОТКЛЮЧЕНА на уровне продукта —
    калькулятор не даёт выбрать эту пару ни в одном направлении
    (см. isAllowedPair), не считает и не показывает её курс.
   Курсы лежат в LocalStorage (ключ valdvor.rates.v2) и переживают
   перезагрузку. Админ-панель скрыта: вход — неприметная ссылка
   «Настройки курсов» в подвале или Ctrl/Cmd + Shift + A.
   ================================================================ */

/* ---------------- Типы и справочники ---------------- */

type Currency = "RUB" | "USD" | "THB";

interface Rates {
  usdThb: number; // сколько бат (฿) за 1 доллар США — задаёт админ
  rubThb: number; // сколько бат (฿) за 1 российский рубль — задаёт админ
  savedAt: number; // момент сохранения (unix, мс) — для «обновлено N назад»
}

interface Prefs {
  amount: string;
  from: Currency;
  to: Currency;
}

const CURRENCY_META: Record<Currency, { title: string; symbol: string }> = {
  RUB: { title: "Российский рубль", symbol: "₽" },
  USD: { title: "Доллар США", symbol: "$" },
  THB: { title: "Тайский бат", symbol: "฿" },
};

const CURRENCIES: Currency[] = ["RUB", "USD", "THB"];

const LS_RATES_KEY = "valdvor.rates.v2";
const LS_RATES_KEY_V1 = "valdvor.rates.v1"; // старый формат (база USD) — для миграции
const LS_PREFS_KEY = "valdvor.prefs.v1";

// Дефолтные курсы первого запуска — калькулятор никогда не покажет NaN
const DEFAULT_RATES: Rates = { usdThb: 34.12, rubThb: 0.3538, savedAt: Date.now() };

const sym = (c: Currency) => CURRENCY_META[c].symbol;

/* ================================================================
   ЛОГИКА ПЕРЕСЧЁТА
   ----------------------------------------------------------------
   Базис всех вычислений — тайский бат. Для каждой валюты известна
   её «цена» в батах:  perThb = { RUB: rubThb, USD: usdThb, THB: 1 }.

    Курс любой пары:  rate(X → Y) = perThb[X] / perThb[Y]
      RUB → THB = rubThb / 1 = rubThb          (прямой курс админа)
      THB → RUB = 1 / rubThb                   (обратный)
      USD → THB = usdThb,  THB → USD = 1 / usdThb
    Направление USD ↔ RUB в интерфейсе запрещено (isAllowedPair),
    поэтому в расчётах участвуют только пары через бат.
    ================================================================ */

function getRate(from: Currency, to: Currency, rates: Rates): number {
  if (from === to) return 1;
  const perThb: Record<Currency, number> = {
    RUB: rates.rubThb,
    USD: rates.usdThb,
    THB: 1,
  };
  return perThb[from] / perThb[to];
}

// Продуктовое правило обменника: доллар и рубль между собой
// НЕ конвертируются (ни USD → RUB, ни RUB → USD), «пара с собой»
// тоже лишена смысла. Разрешены только направления через бат.
function isAllowedPair(a: Currency, b: Currency): boolean {
  if (a === b) return false;
  const noDirectExchange: Currency[] = ["USD", "RUB"];
  return !(noDirectExchange.includes(a) && noDirectExchange.includes(b));
}
/* ---------------- LocalStorage: чтение с защитой от NaN ---------------- */

function loadRates(): Rates {
  try {
    const raw = localStorage.getItem(LS_RATES_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Rates>;
      const usdThb = Number(p.usdThb);
      const rubThb = Number(p.rubThb);
      const savedAt = Number(p.savedAt);
      if (Number.isFinite(usdThb) && usdThb > 0 && Number.isFinite(rubThb) && rubThb > 0) {
        return { usdThb, rubThb, savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now() };
      }
    }
    // Мягкая миграция со старой версии (база USD): rubThb = usdThb / usdRub
    const legacy = localStorage.getItem(LS_RATES_KEY_V1);
    if (legacy) {
      const p = JSON.parse(legacy) as { usdRub?: unknown; usdThb?: unknown; savedAt?: unknown };
      const usdRub = Number(p.usdRub);
      const usdThb = Number(p.usdThb);
      if (Number.isFinite(usdRub) && usdRub > 0 && Number.isFinite(usdThb) && usdThb > 0) {
        return { usdThb, rubThb: usdThb / usdRub, savedAt: Number(p.savedAt) || Date.now() };
      }
    }
  } catch {
    /* битый JSON или приватный режим — используем дефолты */
  }
  return { ...DEFAULT_RATES };
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { amount: "1000", from: "RUB", to: "THB" };
  try {
    const raw = localStorage.getItem(LS_PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const isCur = (v: unknown): v is Currency => v === "RUB" || v === "USD" || v === "THB";
    const from = isCur(p.from) ? p.from : fallback.from;
    let to = isCur(p.to) ? p.to : fallback.to;
    // В старых настройках могла остаться запрещённая пара (например,
    // USD → RUB) — мягко приводим к допустимому направлению через бат
    if (!isAllowedPair(from, to)) to = from === "THB" ? "RUB" : "THB";
    return {
      amount: typeof p.amount === "string" ? sanitizeAmount(p.amount) : fallback.amount,
      from,
      to,
    };
  } catch {
    return fallback;
  }
}

/* ---------------- Валидация и форматирование ---------------- */

// Только цифры и один разделитель (точка или запятая) — буквы не проходят
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

// Проверка курса в админ-панели: число строго больше нуля
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

// Результат — всегда ровно 2 знака после запятой (по ТЗ)
const formatMoney = (n: number) => nf2.format(n);
// Курсы — 4 значащие цифры, чтобы 0,3538 не превратилось в «0,35»
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
    <svg width="13" height="13" viewBox="0 0 24 24" {...svgProps} strokeWidth={2}>
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

function IconClock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" {...svgProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
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

function IconChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...svgProps} strokeWidth={2.6}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true">
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

/* ---------------- Появление при прокрутке ---------------- */

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            el.classList.add("is-in");
            io.disconnect();
          }
        });
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="reveal" style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

/* ---------------- Табло курсов (только две пары админа) ---------------- */

function RatesBoard({ rates, from, to, now }: { rates: Rates; from: Currency; to: Currency; now: number }) {
  const rows: { a: Currency; b: Currency; value: number; unit: string }[] = [
    { a: "USD", b: "THB", value: rates.usdThb, unit: "฿ за 1 $" },
    { a: "RUB", b: "THB", value: rates.rubThb, unit: "฿ за 1 ₽" },
  ];

  return (
    <section className="card p-5" aria-label="Актуальные курсы">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">Курсы</h2>
        <span className="flex items-center gap-1.5 text-[0.72rem] font-medium text-ink-soft">
          <IconClock />
          {timeAgo(rates.savedAt, now)}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {rows.map(({ a, b, value, unit }) => {
          const active = (from === a && to === b) || (from === b && to === a);
          return (
            <div
              key={`${a}-${b}`}
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-all duration-300 ${
                active
                  ? "border-pine-500 bg-pine-50"
                  : "border-line bg-white hover:-translate-y-0.5 hover:border-pine-200"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full transition-colors ${active ? "bg-pine-500" : "bg-line"}`}
                />
                <span className="font-display text-[0.8rem] font-semibold tracking-wide text-pine-800">
                  {a} → {b}
                </span>
              </span>
              <span className="flex items-baseline gap-2">
                {/* key меняется со значением → золотая вспышка при обновлении курса */}
                <span
                  key={`${a}${b}${formatRate(value)}`}
                  className="rate-flash inline-block px-1 font-display text-lg font-bold text-ink tabular-nums"
                >
                  {formatRate(value)}
                </span>
                <span className="text-[0.7rem] text-ink-soft">{unit}</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- Калькулятор ---------------- */

function CurrencySelect({
  id,
  label,
  value,
  onChange,
  isOptionDisabled,
}: {
  id: string;
  label: string;
  value: Currency;
  onChange: (c: Currency) => void;
  // Запрещённые варианты (например, USD при выбранном RUB) выводятся
  // серыми и неоткликающимися — пара физически не выбирается
  isOptionDisabled: (c: Currency) => boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="select-shell mt-1.5">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as Currency)}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c} disabled={isOptionDisabled(c)}>
              {c} · {sym(c)} — {CURRENCY_META[c].title}
            </option>
          ))}
        </select>
        <IconChevron />
      </div>
    </div>
  );
}

interface ConverterProps {
  amount: string;
  onAmount: (v: string) => void;
  from: Currency;
  to: Currency;
  onFrom: (c: Currency) => void;
  onTo: (c: Currency) => void;
  onSwap: () => void;
  onSubmit: () => void;
  spinKey: number;
  fx: { id: number; kind: "pulse" | "shake" };
  rates: Rates;
}

function ConverterCard(props: ConverterProps) {
  const { amount, onAmount, from, to, onFrom, onTo, onSwap, onSubmit, spinKey, fx, rates } = props;

  // Авторасчёт: результат пересчитывается при каждом изменении полей
  const rate = getRate(from, to, rates);
  const amountValue = parseAmount(amount);
  const result = amountValue === null ? null : amountValue * rate;

  return (
    <section className="card relative overflow-hidden p-5 sm:p-6" aria-label="Калькулятор валют">
      {/* Декоративная «монетная» геометрия */}
      <div className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full border-8 border-pine-50" />
      <div className="pointer-events-none absolute -right-1 -top-1 h-12 w-12 rounded-full bg-gold-100" />

      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(); // Enter в поле суммы: подтверждающий «всплеск» результата
        }}
      >
        {/* Строка 1: сумма + валюта «Из» */}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px]">
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
                className="w-full rounded-2xl border-2 border-line bg-white py-3.5 pl-11 pr-4 font-display text-lg font-semibold text-ink transition placeholder:text-ink-soft/40 focus:border-pine-500 focus:outline-none focus:ring-4 focus:ring-pine-500/15"
                value={amount}
                onChange={(e) => onAmount(sanitizeAmount(e.target.value))}
              />
            </div>
          </div>
          <CurrencySelect
            id="cur-from"
            label="Из валюты"
            value={from}
            onChange={onFrom}
            isOptionDisabled={(c) => !isAllowedPair(c, to)}
          />
        </div>

        {/* Кнопка swap — поменять валюты местами */}
        <div className="relative z-10 -my-1.5 flex justify-center py-1">
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

        {/* Строка 2: валюта «В».
            Список учитывает правило: USD ↔ RUB не конвертируются,
            «та же валюта» — тоже; запрещённые варианты серые. */}
        <CurrencySelect
          id="cur-to"
          label="В валюту"
          value={to}
          onChange={onTo}
          isOptionDisabled={(c) => !isAllowedPair(from, c)}
        />
      </form>

      {/* Результат */}
      <div
        key={fx.id}
        className={`relative mt-5 overflow-hidden rounded-2xl bg-pine-900 text-white shadow-lift ${
          fx.kind === "pulse" ? "anim-pop" : fx.kind === "shake" ? "anim-shake" : ""
        }`}
        aria-live="polite"
      >
        <div className="pointer-events-none absolute -right-8 -bottom-14 h-32 w-32 rounded-full border-[10px] border-pine-800" />

        {result !== null ? (
          <div className="relative px-5 py-5">
            <p className="text-[0.64rem] font-extrabold uppercase tracking-[0.2em] text-pine-300">Результат</p>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="font-display text-3xl font-bold leading-none text-gold-300 tabular-nums sm:text-4xl">
                {formatMoney(result)}
              </span>
              <span className="font-display text-lg font-semibold text-gold-500">{sym(to)}</span>
            </p>
            <p className="mt-2.5 text-[0.78rem] font-medium text-pine-200 tabular-nums">
              Курс: 1 {from} ={" "}
              <span key={formatRate(rate)} className="rate-flash inline-block px-0.5 font-bold text-gold-300">
                {formatRate(rate)}
              </span>{" "}
              {to}
            </p>
          </div>
        ) : (
          <div className="relative px-5 py-5">
            <p className="text-[0.64rem] font-extrabold uppercase tracking-[0.2em] text-pine-300">Результат</p>
            <p className="mt-2 font-display text-base font-semibold text-pine-100/90">
              Введите сумму — пересчёт автоматический
            </p>
            <p className="mt-1.5 text-[0.78rem] text-pine-300 tabular-nums">
              Например: 1 000 {sym(from)} = {formatMoney(1000 * rate)} {sym(to)}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- Админ-панель (скрыта от пользователей) ---------------- */

interface AdminModalProps {
  rates: Rates;
  onSave: (next: { usdThb: number; rubThb: number }) => void;
  onClose: () => void;
}

function AdminModal({ rates, onSave, onClose }: AdminModalProps) {
  // Черновики курсов — строки, чтобы админ свободно редактировал
  const [thbStr, setThbStr] = useState(() => String(rates.usdThb).replace(".", ","));
  const [rubStr, setRubStr] = useState(() => String(rates.rubThb).replace(".", ","));
  const [justSaved, setJustSaved] = useState(false);

  // Escape закрывает окно; прокрутка страницы блокируется
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const thb = parseRateInput(thbStr);
  const rub = parseRateInput(rubStr);
  const valid = thb.value !== null && rub.value !== null;

  // Сохранение: короткая зелёная индикация «Сохранено», затем коммит
  const handleSave = () => {
    if (!valid || justSaved) return;
    setJustSaved(true);
    window.setTimeout(() => onSave({ usdThb: thb.value!, rubThb: rub.value! }), 700);
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
    >
      <div className="modal-backdrop anim-backdrop absolute inset-0" onMouseDown={onClose} />

      <div className="anim-modal relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-line bg-card shadow-lift sm:rounded-3xl">
        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-bold text-ink">Настройки курсов</h2>
              <p className="mt-0.5 text-[0.68rem] font-extrabold uppercase tracking-[0.18em] text-pine-600">
                админ-панель
              </p>
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
            Задайте два курса к тайскому бату — обратные (฿ → ₽ и ฿ → $)
            пересчитаются автоматически. Конвертация USD ↔ RUB в
            калькуляторе отключена.
          </p>

          <div className="mt-5 flex flex-col gap-4">
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

            <div>
              <label htmlFor="adm-rub" className="field-label">
                Курс RUB → THB
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
                  ฿
                </span>
              </div>
              <p className="mt-1 text-[0.72rem] text-ink-soft">сколько бат за 1 рубль</p>
              {rub.error && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[0.74rem] font-bold text-danger-600">
                  <IconAlert /> {rub.error}
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <button
              onClick={() => {
                setThbStr(String(DEFAULT_RATES.usdThb).replace(".", ","));
                setRubStr(String(DEFAULT_RATES.rubThb).replace(".", ","));
              }}
              className="flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold text-ink-soft transition hover:bg-pine-50 hover:text-pine-800"
            >
              <IconRefresh />
              По умолчанию
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
  kind: "success" | "error";
  text: string;
}

function ToastView({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  return (
    <div className="pb-safe fixed bottom-5 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0">
      <div
        key={toast.id}
        className="anim-toast flex items-center gap-3 rounded-2xl border border-pine-700 bg-pine-900 px-4 py-3.5 text-white shadow-lift"
        role="status"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            toast.kind === "success" ? "bg-pine-600" : "bg-danger-600"
          }`}
        >
          {toast.kind === "success" ? <IconCheck /> : <IconAlert />}
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
  // Курсы и настройки читаются из LocalStorage при инициализации
  const [rates, setRates] = useState<Rates>(() => loadRates());
  const [prefs] = useState<Prefs>(() => loadPrefs());
  const [amount, setAmount] = useState<string>(prefs.amount);
  const [from, setFrom] = useState<Currency>(prefs.from);
  const [to, setTo] = useState<Currency>(prefs.to);

  const [adminOpen, setAdminOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [spinKey, setSpinKey] = useState(0); // анимация разворота swap-кнопки
  const [fx, setFx] = useState<{ id: number; kind: "pulse" | "shake" }>({ id: 0, kind: "pulse" });
  const [now, setNow] = useState(() => Date.now()); // для «обновлено N назад»

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
      /* приватный режим — не критично */
    }
  }, [amount, from, to]);

  // Тик раз в 15 секунд, чтобы «обновлено N мин назад» не застывало
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  // Скрытый вход в админ-панель: Ctrl/Cmd + Shift + A (работает в любой раскладке)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        setAdminOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Смена валюты «Из»: если новая пара запрещена (USD ↔ RUB или
  // «та же валюта»), валюту «В» автоматически подставляем допустимую.
  // Swap запрещённую пару создать не может — разрешённые пары симметричны.
  const handleChangeFrom = (c: Currency) => {
    setFrom(c);
    if (!isAllowedPair(c, to)) setTo(c === "THB" ? "RUB" : "THB");
  };

  // Смена валюты «В»: уважаем явный выбор пользователя, поэтому
  // подстраиваем валюту «Из», а не отменяем его выбор.
  const handleChangeTo = (c: Currency) => {
    setTo(c);
    if (!isAllowedPair(from, c)) setFrom(c === "THB" ? "RUB" : "THB");
  };

  const handleSwap = () => {
    setFrom(to);
    setTo(from);
    setSpinKey((k) => k + 1);
  };

  // Enter в поле суммы: есть число — «всплеск» результата, пусто — лёгкая встряска
  const handleSubmit = () => {
    setFx({ id: Date.now(), kind: parseAmount(amount) !== null ? "pulse" : "shake" });
  };

  // Сохранение курсов из админ-панели: LocalStorage + мгновенное применение
  const handleSaveRates = (next: { usdThb: number; rubThb: number }) => {
    const updated: Rates = { ...next, savedAt: Date.now() };
    setRates(updated);
    try {
      localStorage.setItem(LS_RATES_KEY, JSON.stringify(updated));
    } catch {
      /* приватный режим — курсы проживут до перезагрузки */
    }
    setAdminOpen(false);
    setFx({ id: Date.now(), kind: "pulse" });
    showToast("Курсы сохранены и применены", "success");
  };

  return (
    <div className="flex min-h-screen flex-col items-center font-body text-ink">
      {/* Шапка */}
      <header className="anim-rise flex w-full max-w-md items-center gap-3.5 px-4 pb-5 pt-8 sm:px-0">
        <Logo />
        <div>
          <h1 className="font-display text-lg font-bold leading-tight text-ink sm:text-xl">Валютный двор</h1>
          <p className="mt-0.5 text-[0.64rem] font-extrabold uppercase tracking-[0.22em] text-pine-600">
            RUB · USD · THB
          </p>
        </div>
      </header>

      {/* Контент: калькулятор + курсы */}
      <main className="relative flex w-full max-w-md flex-1 flex-col gap-4 px-4 sm:px-0">
        {/* Фоновые «монеты» за карточками */}
        <div className="pointer-events-none absolute -left-16 top-24 -z-10 h-40 w-40 rounded-full border-[14px] border-pine-100/80" />
        <div className="pointer-events-none absolute -right-10 bottom-10 -z-10 h-24 w-24 rounded-full bg-gold-100/70" />

        <div className="anim-rise">
          <ConverterCard
            amount={amount}
            onAmount={setAmount}
            from={from}
            to={to}
            onFrom={handleChangeFrom}
            onTo={handleChangeTo}
            onSwap={handleSwap}
            onSubmit={handleSubmit}
            spinKey={spinKey}
            fx={fx}
            rates={rates}
          />
        </div>

        <Reveal>
          <RatesBoard rates={rates} from={from} to={to} now={now} />
        </Reveal>
      </main>

      {/* Подвал: здесь же неприметный вход в админ-панель */}
      <footer className="w-full max-w-md px-4 pt-2 sm:px-0">
        <div className="pb-safe flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[0.72rem] text-ink-soft">
          <p>Курсы хранятся в LocalStorage браузера</p>
          <button
            onClick={() => setAdminOpen(true)}
            title="Ctrl + Shift + A"
            className="flex items-center gap-1.5 font-semibold text-ink-soft/80 transition hover:text-pine-700"
          >
            <IconGear />
            Настройки курсов
          </button>
        </div>
      </footer>

      {/* Админ-панель */}
      {adminOpen && <AdminModal rates={rates} onSave={handleSaveRates} onClose={() => setAdminOpen(false)} />}

      {/* Уведомления */}
      {toast && <ToastView toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
