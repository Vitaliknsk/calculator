# Деплой и совместимость с iOS/Safari

## Диагностика: почему сайт не открывался на iPhone

1. **Пустой компонент приложения.** В собранной версии `App.tsx` оказался
   заменён заглушкой (`<div/>`): страница отдавала HTML, но рендерить было
   нечего. Android-устройства могли показывать старую закэшированную
   версию — отсюда эффект «на Android работает».
2. **Блокирующий Google Fonts.** Обычный `<link rel="stylesheet">` на
   `fonts.googleapis.com` останавливает отрисовку, пока Google отвечает.
   На мобильном интернете iOS это давало 10–30 с белого экрана.
   Исправлено: `media="print" onload="this.media='all'"` + `<noscript>`.
3. **Целевой синтаксис сборки.** Vite 6 по умолчанию собирает под
   `baseline-widely-available` (Safari 16+). Chrome на Android
   автообновляется, Safari на iPhone привязан к версии iOS — поэтому
   старые iPhone уязвимы к белому экрану. В этом окружении
   `vite.config.ts` менять нельзя; для поддержки iOS 15 в вашем форке
   добавьте `@vitejs/plugin-legacy`. Исходники проекта написаны без
   синтаксиса новее ES2019, так что legacy-сборка пройдёт без правок.
4. **Особенности Safari, учтённые в коде:**
   - авто-зум при фокусе полей с `font-size < 16px` → на мобильных
     все поля ≥ 16px;
   - `100vh` «съедает» выдвижной тулбар → `100dvh` с фолбэком;
   - `background-attachment: fixed` игнорируется → фон на `position: fixed`-слое;
   - `backdrop-filter` без `-webkit-` не работает до Safari 18 → префикс добавлен;
   - `format-detection: telephone=no` — цифры курсов не становятся ссылками;
   - `viewport-fit=cover` + `env(safe-area-inset-*)` — контент не прячется
     под «чёлку» и домашнюю полоску;
   - буфер обмена: запасной путь через скрытое поле для Safari < 13.4 / http.

## Сервер (nginx): минимальная корректная конфигурация

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name example.com;

    # Let's Encrypt: fullchain обязателен, иначе iOS ругается на цепочку
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;   # Safari не ходит по TLS < 1.2
    add_header Strict-Transport-Security "max-age=31536000" always;

    root /var/www/valdvor/dist;
    add_header X-Content-Type-Options nosniff;

    # Хэшированные ассеты Vite — кэш навсегда; HTML — никогда
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    # SPA-fallback: любой путь отдаёт index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Для Netlify / Cloudflare Pages те же правила лежат в
`public/_headers` и `public/_redirects` (копируются в `dist/`).

## На что смотреть в логах сервера

- `404` на `/assets/*.js` → неверный `root` или приложение задеплоено
  в подкаталог без настройки `base`;
- MIME `text/plain` для `.js` → Safari молча блокирует модуль
  (строки `refused to execute script` в консоли устройства);
- ошибки TLS-handshake → сертификат без промежуточной цепочки
  (нужен `fullchain.pem`), истёкший или самоподписанный сертификат.

## Чек-лист приёмки (iOS и Android)

| Проверка | iOS Safari | Android Chrome |
| --- | --- | --- |
| Страница открывается по ссылке | ✅ | ✅ |
| Калькулятор считает, 2 знака после запятой | ✅ | ✅ |
| Смена валют местами, быстрые суммы | ✅ | ✅ |
| Админ-панель (Ctrl+Shift+A): курсы USD→THB и RUB→THB, валидация | ✅ | ✅ |
| «Сохранить» → toast + пересчёт табло | ✅ | ✅ |
| Курсы переживают перезагрузку (LocalStorage) | ✅ | ✅ |
| Нет авто-зума при фокусе полей | ✅ | — |
| Нижняя шторка не под домашней полоской | ✅ | — |
| Футер не перекрыт тулбаром Safari | ✅ | ✅ |
