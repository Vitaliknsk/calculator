import { createClient } from "@supabase/supabase-js";

/* ================================================================
   SUPABASE — общий бэкенд для синхронизации курсов между устройствами
   ----------------------------------------------------------------
   Курсы хранятся в облачной PostgreSQL и синхронизируются в реальном
   времени через Realtime-подписки (WebSocket). Когда админ меняет
   курсы на одном устройстве — все остальные клиенты получают
   обновление мгновенно.

   Настройка:
   1. Создайте проект на https://supabase.com (бесплатно)
   2. Создайте таблицу `rates` с полями: id (int8), usd_thb (float8),
      rub_thb (float8), saved_at (timestamptz)
   3. Включите Realtime для таблицы `rates`
   4. Вставьте URL и anon-key в переменные окружения VITE_SUPABASE_URL
      и VITE_SUPABASE_ANON_KEY (или замените плейсхолдеры ниже)
   5. Вставьте одну запись с id=1 (единственная строка с курсами)

   Fallback: если Supabase не настроен — приложение работает через
   LocalStorage (как раньше), но без синхронизации между устройствами.
   ================================================================ */

// Плейсхолдеры — замените на реальные значения из Supabase Dashboard
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "YOUR_ANON_KEY";

// Клиент Supabase (singleton)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Проверка: настроен ли Supabase (есть ли реальные credentials)
export function isSupabaseConfigured(): boolean {
  return (
    SUPABASE_URL !== "https://YOUR_PROJECT.supabase.co" &&
    SUPABASE_ANON_KEY !== "YOUR_ANON_KEY" &&
    SUPABASE_URL.startsWith("https://") &&
    SUPABASE_ANON_KEY.length > 20
  );
}

// Тип данных курсов (должен совпадать с таблицей `rates` в Supabase)
export interface RatesRow {
  id: number; // всегда 1 (единственная строка с курсами)
  usd_thb: number; // ฿ за 1 $
  rub_thb: number; // ฿ за 1 ₽
  saved_at: string; // ISO-строка timestamp
}

// Чтение курсов из Supabase (одна строка с id=1)
export async function fetchRates(): Promise<RatesRow | null> {
  if (!isSupabaseConfigured()) return null;

  const { data, error } = await supabase
    .from("rates")
    .select("*")
    .eq("id", 1)
    .single();

  if (error || !data) {
    console.warn("Supabase: не удалось прочитать курсы", error);
    return null;
  }

  return data as RatesRow;
}

// Запись курсов в Supabase (обновление строки с id=1)
export async function saveRates(usdThb: number, rubThb: number): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  const { error } = await supabase
    .from("rates")
    .update({
      usd_thb: usdThb,
      rub_thb: rubThb,
      saved_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) {
    console.error("Supabase: не удалось сохранить курсы", error);
    return false;
  }

  return true;
}

// Realtime-подписка на изменения курсов
// Колбэк вызывается каждый раз, когда кто-то обновляет таблицу `rates`
export function subscribeToRates(callback: (rates: RatesRow) => void) {
  if (!isSupabaseConfigured()) {
    console.warn("Supabase: подписка не создана — credentials не настроены");
    return () => {}; // пустая функция отписки
  }

  const channel = supabase
    .channel("rates-changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "rates", filter: "id=eq.1" },
      (payload) => {
        console.log("Supabase: получено обновление курсов", payload);
        const newRow = payload.new as RatesRow;
        callback(newRow);
      }
    )
    .subscribe((status) => {
      console.log("Supabase: статус подписки на курсы", status);
    });

  // Функция отписки
  return () => {
    supabase.removeChannel(channel);
  };
}
