# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Проект и общение с пользователем — на русском.

## Что это

Одностраничный сайт продажи билетов на вечеринку DUBAI PARTY (боевая оплата ЮKassa) + Telegram-бот охраны, который проверяет и гасит коды билетов на входе. Node.js + Express, ES-модули (`"type": "module"`), без фронтенд-фреймворка (ванильный JS в `public/`).

## Команды

```bash
npm install        # зависимости (только express + dotenv)
npm start          # прод-запуск: node server.js  → http://localhost:3000
npm run dev        # разработка с авто-перезапуском: node --watch server.js
```

- Тестов, линтера и сборки в проекте **нет**. Быстрая проверка синтаксиса: `node --check server.js`.
- На Windows пользователь запускает двойным кликом `Запустить сайт.bat` (ставит зависимости при первом запуске и открывает браузер).

## Архитектура

`server.js` — единственная точка входа. **Первой строкой грузит `dotenv/config` до всех импортов** — иначе бот не увидит токен. Поднимает Express (API + отдача `public/`) и в конце вызывает `startBot()`.

**Единый источник правды — `config.js`.** Здесь мероприятие, билеты, цены, лимиты продаж и форматы кодов. Цены и лимиты живут только на сервере и не принимаются из браузера. `TEST_MODE` вычисляется автоматически: пусто в `YOOKASSA_*` → тест-режим (оплата имитируется, код выдаётся сразу в ответе `/api/checkout`).

**Боевой путь оплаты (ЮKassa, `lib/yookassa.js` + `server.js`):**
1. `/api/checkout` **синхронно** резервирует билеты pending-заказом на 20 минут (`addPendingOrder` до первого `await` — защита от гонки; свободный остаток = `limit − soldCount − pendingQty`), затем `createPayment` (redirect-flow, `capture: true`, `metadata.orderId`) и отдаёт `paymentUrl`. При ошибке создания платежа — `markOrderCanceled` (снятие резерва).
2. Коды выдаются **только после подтверждения оплаты** — двумя путями:
   - вебхук `POST /api/yookassa/webhook` (настроен в кабинете ЮKassa на `https://toosovka39.ru/api/yookassa/webhook`, события `payment.succeeded`/`payment.canceled`);
   - страховка: фоновый опрос каждые 30 сек всех pending-заказов с `paymentId` (на случай недоставленного вебхука).
   Оба пути идут через общий `processPayment()`: уведомлению **не доверяем**, статус перепроверяется прямым `getPayment(id)`; не-платёжные события (`refund.*`) вебхук подтверждает 200 и игнорирует.
3. ЮKassa возвращает покупателя на `public/success.html?order=<id>` — страница опрашивает `/api/order-status` каждые 3 сек (до 2 минут) и показывает коды.

**Данные — JSON-файл `data/db.json`** через `lib/db.js` (своя мини-БД, без внешних зависимостей). Ключевые моменты:
- Все записи (`addOrder`, `addPendingOrder`, `markOrderPaid`…) **синхронные, без `await`** — проверку остатка и сохранение в `server.js` нельзя разрывать через `await`.
- Статусы заказа: `pending` → `paid` | `canceled`. Жизненный цикл кода: создан → `used` (проход на входе) → `left` (ушёл). `counts()` даёт `inside = entered − left`.
- `load()` умеет мигрировать старые записи (добавляет `left`/`leftAt` кодам, `status`/`codes` заказам).

**`lib/codes.js`** — генерация уникальных кодов по формату `{ letters, digits }` из `config.js`. Буквы `I` и `O` исключены (похожи на цифры).

**Telegram-бот охраны — `lib/bot.js`.** Работает через **long-polling (`getUpdates`), НЕ webhook** — поэтому боту не нужны публичный домен, HTTPS или открытые порты. Авторизация охраны — по кодовому слову `SECURITY_PASSWORD` в переписке; список авторизованных хранится в памяти и сбрасывается при перезапуске. UI бота — reply-клавиатура (Статистика / История / Отметить уход / Выйти) + inline-кнопки подтверждения прохода.

**`lib/telegram.js`** — `notifyAdmin()`: уведомление владельцу в ЛС о каждой покупке (`TELEGRAM_ADMIN_CHAT_ID`), включая коды и остаток свободных мест.

**Фронтенд `public/`:**
- `index.html` → `app.js` — витрина и оформление заказа (`/api/status`, `/api/checkout`; в боевом режиме редирект на `paymentUrl`).
- `success.html` — результат оплаты, скрипт встроен в страницу.
- `admin.html` — веб-страница охраны/базы заказов, скрипт **встроен в саму страницу** (не отдельный файл). Защищена паролем `ADMIN_PASSWORD`, который передаётся в API через заголовок `x-admin-password`.
- `public/script.js` — **не подключён ни к одной странице** (устаревший файл), не трогай его при правках витрины — правь `app.js`.
- **Яндекс.Метрика** (счётчик `110941103`) вставлена в `index.html` и `success.html`; цели: `checkout` (нажал «Оплатить», в `app.js`) и `purchase` (увидел код, в `success.html`).

**Две разные авторизации, не путать:** бот охраны в Telegram — по `SECURITY_PASSWORD`; веб-страница `/admin.html` и её API-эндпоинты (`/api/verify`, `/api/checkin`, `/api/orders`) — по `ADMIN_PASSWORD`.

## Переменные окружения

`.env` **в `.gitignore`** (как и `data/`) — при деплое через git на сервер не попадает, переносить руками. Значения см. в `.env.example`. Для бота обязательны `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `SECURITY_PASSWORD`; для веб-админки — `ADMIN_PASSWORD`. `YOOKASSA_SHOP_ID` + `YOOKASSA_SECRET_KEY` включают боевую оплату (пустые = тест-режим); `RETURN_URL` на бою — `https://toosovka39.ru/success.html`.

## Деплой (боевой VPS)

- GitHub: `Monstor39/toosovka39` (ветка `main`).
- Сервер RUVDS `194.87.102.249` (SSH-ключ настроен, вход `ssh root@194.87.102.249`), проект в `/root/dubai` — git-чекаут с upstream `origin/main`, запущен под pm2 (автозапуск через systemd).
- Домен `toosovka39.ru`: nginx проксирует на порт 3000, HTTPS от Let's Encrypt (автопродление включено).
- **Деплой:** `ssh root@194.87.102.249 "cd /root/dubai && git pull && pm2 restart dubai"`. Правки только в `public/` не требуют рестарта pm2.
- **Важная особенность:** провайдер выборочно блокирует `api.telegram.org:443` — из-за этого бот падает с `getUpdates fetch failed`, хотя код и токен исправны. Фикс — прибить домен к открытому IP в `/etc/hosts` на сервере (`149.154.167.220 api.telegram.org`). Проверить, что IP ещё открыт: `timeout 5 bash -c 'echo >/dev/tcp/149.154.167.220/443' && echo OPEN`.
- Логи на сервере: `pm2 logs dubai`; вебхуки ЮKassa видны в `/var/log/nginx/access.log` (grep `yookassa/webhook`).
