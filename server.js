import "dotenv/config"; // ВАЖНО: грузим .env ДО остальных импортов, иначе бот не увидит токен
import express from "express";
import crypto from "crypto";
import { event, currency, tickets, ticketById, manualTicket, wheel as wheelConfig, TEST_MODE } from "./config.js";
import * as db from "./lib/db.js";
import { makeUniqueCode } from "./lib/codes.js";
import { notifyAdmin } from "./lib/telegram.js";
import { startBot } from "./lib/bot.js";
import { createPayment, getPayment } from "./lib/yookassa.js";
import { checkPromo, hasPromoFor } from "./lib/promo.js";
import * as wheel from "./lib/wheel.js";

db.load();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "dubai2026";

// За nginx: берём настоящий IP посетителя из X-Forwarded-For —
// на нём держится правило колеса «один прокрут с одного IP».
// Именно 1 (а не true): доверяем ровно одному прокси — нашему nginx. При true
// Express взял бы самый левый адрес цепочки, а его любой может подставить
// заголовком сам и крутить колесо сколько угодно.
app.set("trust proxy", 1);

app.use(express.json());

const fmtMoney = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// Строка «сколько всего куплено» для уведомления в Telegram.
// Если у билета есть лимит — дописываем и остаток.
function soldLine(ticket) {
  const sold = db.soldCount(ticket.id);
  const tail = ticket.limit
    ? ` (свободно ${Math.max(0, ticket.limit - sold)} из ${ticket.limit})`
    : "";
  return `Всего куплено «${ticket.name}»: <b>${sold}</b>${tail}`;
}

// Строка про скидку для уведомления в Telegram (пусто, если скидки не было).
// Скидка могла прийти из промокода или с колеса CRAZY DUBAI.
function discountLine(order, fullPrice) {
  const saved = (fullPrice - order.unitPrice) * order.qty;
  if (order.promo) return `Промокод: <b>${order.promo}</b> (скидка ${fmtMoney(saved)})\n`;
  if (order.wheel) return `🎡 Колесо: <b>−${order.wheel}%</b> (скидка ${fmtMoney(saved)})\n`;
  return "";
}

// Что писать про депозит: у входного билета его нет
function depositNote(ticket, unitPrice) {
  if (ticket.deposit === false) return `Депозит на баре: <b>нет</b> (входной билет)\n`;
  return `Депозит на баре: <b>${unitPrice === 0 ? "нет" : fmtMoney(unitPrice)}</b> у каждого\n`;
}

// ---------- Публичный статус: билеты + сколько осталось ----------
function ticketStatus(t) {
  const sold = db.soldCount(t.id);
  // limit === null — билет без ограничения: остаток не считаем, продажи не закрываем
  const remaining = t.limit ? Math.max(0, t.limit - sold) : null;
  return {
    id: t.id,
    name: t.name,
    price: t.price,
    priceLabel: t.priceLabel || fmtMoney(t.price),
    description: t.description,
    badge: t.badge,
    limit: t.limit,
    // сколько уже продано, наружу не отдаём — это видно только в боте и админке
    remaining,
    soldOut: remaining !== null && remaining <= 0,
    soldOutText: t.soldOutText || "Билеты закончились",
    // есть ли живой промокод на этот билет — показывать ли поле ввода
    // (сами промокоды наружу, разумеется, не отдаём)
    promoEnabled: hasPromoFor(t.id),
    hasDeposit: t.deposit !== false, // цена = депозит на баре?
    wheelEligible: wheel.appliesTo(t), // действует ли на него скидка колеса
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    event,
    currency,
    testMode: TEST_MODE,
    tickets: tickets.map(ticketStatus),
    wheel: wheel.state(wheel.clientKey(req)),
  });
});

// ---------- Колесо CRAZY DUBAI ----------
// Сектор выбирает сервер, браузер только докручивает анимацию до него.
app.post("/api/wheel/spin", (req, res) => {
  const key = wheel.clientKey(req);
  const result = wheel.spin(key);
  if (!result.ok) return res.status(409).json({ error: result.error, state: wheel.state(key) });
  res.json({ ok: true, ...result, title: wheelConfig.title });
});

// ---------- Проверка промокода (до оплаты, чтобы показать новую цену) ----------
// Итоговую цену всё равно пересчитывает /api/checkout — этот ответ только для витрины.
app.post("/api/promo", (req, res) => {
  const ticket = ticketById[req.body?.ticketId];
  if (!ticket) return res.status(400).json({ error: "Такого билета нет." });

  const check = checkPromo(req.body?.code, ticket);
  if (!check.ok) return res.status(400).json({ error: check.error });

  res.json({
    ok: true,
    code: check.code,
    unitPrice: check.unitPrice,
    unitPriceLabel: check.unitPrice === 0 ? "бесплатно" : fmtMoney(check.unitPrice),
    discountPerTicket: check.discountPerTicket,
    discountLabel: fmtMoney(check.discountPerTicket),
  });
});

// ---------- Оформление заказа ----------
app.post("/api/checkout", async (req, res) => {
  try {
    const { ticketId, qty, contact, promo } = req.body || {};
    const ticket = ticketById[ticketId];
    const count = Number(qty);
    const raw = String(contact || "").trim();

    // Проверки
    if (!ticket) return res.status(400).json({ error: "Такого билета нет." });
    if (!Number.isInteger(count) || count < 1 || count > 20)
      return res.status(400).json({ error: "Укажи количество от 1 до 20." });

    // Определяем: телефон или Telegram (телефон — только цифры, Telegram — с буквами)
    let contactValue, contactType;
    if (/[a-zA-Z]/.test(raw)) {
      const handle = raw.replace(/^https?:\/\/t\.me\//, "").replace(/^@/, "");
      if (!/^[a-zA-Z0-9_]{3,32}$/.test(handle))
        return res.status(400).json({ error: "Укажи корректный Telegram (например @nickname)." });
      contactValue = "@" + handle;
      contactType = "telegram";
    } else {
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15)
        return res.status(400).json({ error: "Укажи телефон или Telegram (@nickname)." });
      contactValue = raw;
      contactType = "phone";
    }

    // Промокод: цену со скидкой считает только сервер, из браузера приходит
    // лишь текст промокода. Пустое поле — обычная цена.
    let unitPrice = ticket.price;
    let promoCode = null;
    if (String(promo || "").trim()) {
      const check = checkPromo(promo, ticket);
      if (!check.ok) return res.status(400).json({ error: check.error, promoError: true });
      unitPrice = check.unitPrice;
      promoCode = check.code;
    }

    // Скидка с колеса CRAZY DUBAI. Браузер ничего о цене не решает:
    // сервер сам смотрит, есть ли у этого IP живой (не сгоревший) выигрыш.
    // Со скидкой режется и цена, и депозит на баре: 50% с обычного билета —
    // платишь 600 ₽ и тратишь на баре тоже 600 ₽.
    // С промокодом не суммируем — применяем то, что выгоднее покупателю.
    const wheelKey = wheel.clientKey(req);
    const wheelDiscount = wheel.discountFor(wheelKey, ticket);
    let wheelPercent = null;
    if (wheelDiscount && wheelDiscount.unitPrice < unitPrice) {
      unitPrice = wheelDiscount.unitPrice;
      wheelPercent = wheelDiscount.percent;
      promoCode = null;
    }

    // Доступность (критическая секция — без await до сохранения!)
    // pendingQty — билеты, зарезервированные под неоплаченные заказы ЮKassa.
    // Если limit не задан — билет продаётся без ограничения, проверять нечего.
    if (ticket.limit) {
      const sold = db.soldCount(ticket.id);
      const remaining = ticket.limit - sold - db.pendingQty(ticket.id);
      if (remaining <= 0)
        return res.status(409).json({ error: ticket.soldOutText || "Билеты закончились", soldOut: true });
      if (count > remaining)
        return res.status(409).json({ error: `Осталось только ${remaining} шт.`, remaining });
    }

    const total = unitPrice * count;

    // --- Оплата не нужна: тест-режим либо билет бесплатный по промокоду ---
    // (ЮKassa не примет платёж на 0 ₽, поэтому код выдаём сразу.)
    if (TEST_MODE || total === 0) {
      const codes = [];
      for (let i = 0; i < count; i++) {
        codes.push(makeUniqueCode(ticket.codeFormat, db.codeExists));
      }
      const order = {
        id: crypto.randomUUID(),
        ticket: ticket.id,
        ticketName: ticket.name,
        qty: count,
        unitPrice,
        total,
        promo: promoCode,
        wheel: wheelPercent, // процент скидки с колеса — фиксируем в базе
        wheelKey: wheelPercent ? wheelKey : null,
        fullPrice: ticket.price,
        contact: contactValue,
        contactType,
        createdAt: new Date().toISOString(),
        paid: true,
        status: "paid",
        codes,
      };
      db.addOrder(order); // сохраняем синхронно
      if (wheelPercent) db.markSpinUsed(wheelKey, order.id); // скидка потрачена

      // Уведомление тебе в Telegram (не блокирует ответ покупателю)
      const contactLabel = contactType === "phone" ? "Телефон" : "Telegram";
      notifyAdmin(
        `🎟 <b>Новая покупка — ${event.title}</b>\n` +
          `Билет: <b>${ticket.name}</b> × ${count}\n` +
          `Сумма: <b>${total === 0 ? "бесплатно (промокод)" : fmtMoney(total)}</b>\n` +
          discountLine(order, ticket.price) +
          depositNote(ticket, unitPrice) +
          `${contactLabel}: ${contactValue}\n` +
          `Код(ы): <b>${codes.join(", ")}</b>\n` +
          soldLine(ticket)
      );

      return res.json({
        ok: true,
        testMode: TEST_MODE,
        order: {
          ticketName: ticket.name,
          qty: count,
          total,
          totalLabel: total === 0 ? "бесплатно по промокоду" : fmtMoney(total),
          contact: contactValue,
          hasDeposit: ticket.deposit !== false,
          codes,
        },
      });
    }

    // --- БОЕВОЙ РЕЖИМ: создаём платёж ЮKassa ---
    // Коды выдаются ПОСЛЕ подтверждения оплаты (вебхук payment.succeeded).
    // Сначала синхронно резервируем билеты (защита от гонки), потом идём в ЮKassa.
    const orderId = crypto.randomUUID();
    db.addPendingOrder({
      id: orderId,
      ticket: ticket.id,
      ticketName: ticket.name,
      qty: count,
      unitPrice,
      total,
      promo: promoCode,
      wheel: wheelPercent, // скидка с колеса фиксируется в заказе
      wheelKey: wheelPercent ? wheelKey : null, // чей это выигрыш — погасим после оплаты
      fullPrice: ticket.price, // цена без скидки — для уведомления после оплаты
      contact: contactValue,
      contactType,
      createdAt: new Date().toISOString(),
      paid: false,
      status: "pending",
      // Резерв на 20 минут — если не оплатил, билеты снова в продаже
      expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      codes: [],
    });

    let payment;
    try {
      const baseReturn = process.env.RETURN_URL || `http://localhost:${PORT}/success.html`;
      payment = await createPayment({
        amountRub: total,
        description: `${event.title} — ${ticket.name} × ${count}${promoCode ? ` (промокод ${promoCode})` : ""}`.slice(0, 128),
        returnUrl: `${baseReturn}?order=${orderId}`,
        metadata: { orderId },
      });
    } catch (err) {
      db.markOrderCanceled(orderId); // снимаем резерв
      console.error("Создание платежа не удалось:", err);
      return res.status(502).json({ error: "Не удалось создать платёж. Попробуй ещё раз." });
    }

    db.setOrderPayment(orderId, payment.id);
    return res.json({ ok: true, paymentUrl: payment.confirmation?.confirmation_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера." });
  }
});

// ---------- Подтверждение оплаты ЮKassa ----------
// Перепроверяет статус платежа прямым запросом и выдаёт коды, если оплачен.
// Используется и вебхуком, и фоновой проверкой зависших оплат.
async function processPayment(paymentId) {
  const payment = await getPayment(paymentId);
  const order = payment.metadata?.orderId ? db.findOrder(payment.metadata.orderId) : null;
  if (!order) return; // не наш платёж

  if (payment.status === "succeeded" && !order.paid) {
    const ticket = ticketById[order.ticket];
    const codes = [];
    for (let i = 0; i < order.qty; i++) {
      codes.push(makeUniqueCode(ticket.codeFormat, db.codeExists));
    }
    db.markOrderPaid(order.id, codes); // синхронно
    // Скидка колеса потрачена — второй раз её не применить
    if (order.wheel && order.wheelKey) db.markSpinUsed(order.wheelKey, order.id);

    const contactLabel = order.contactType === "phone" ? "Телефон" : "Telegram";
    notifyAdmin(
      `🎟 <b>Новая покупка — ${event.title}</b>\n` +
        `Билет: <b>${order.ticketName}</b> × ${order.qty}\n` +
        `Сумма: <b>${fmtMoney(order.total)}</b>\n` +
        discountLine(order, order.fullPrice ?? ticket.price) +
        depositNote(ticket, order.unitPrice) +
        `${contactLabel}: ${order.contact}\n` +
        `Код(ы): <b>${codes.join(", ")}</b>\n` +
        soldLine(ticket)
    );
  } else if (payment.status === "canceled") {
    db.markOrderCanceled(order.id);
  }
}

// Вебхук ЮKassa (основной путь). Уведомлению не доверяем — processPayment перепроверяет.
app.post("/api/yookassa/webhook", async (req, res) => {
  try {
    // Обрабатываем только события платежей (refund.* и прочие — подтверждаем и игнорируем)
    const evt = String(req.body?.event || "");
    if (evt && !evt.startsWith("payment.")) return res.status(200).end();
    const paymentId = req.body?.object?.id;
    if (!paymentId) return res.status(400).end();
    await processPayment(paymentId);
    res.status(200).end(); // ЮKassa ждёт 200, иначе будет слать повторно
  } catch (err) {
    console.error("Вебхук ЮKassa:", err);
    res.status(500).end(); // ЮKassa повторит уведомление позже
  }
});

// Страховка: если вебхук не дошёл (не настроен/сбой сети) — сами опрашиваем
// зависшие pending-заказы каждые 30 секунд, пока не истёк их резерв.
if (!TEST_MODE) {
  setInterval(async () => {
    const pending = db
      .getDb()
      .orders.filter((o) => o.status === "pending" && o.paymentId);
    for (const o of pending) {
      try {
        await processPayment(o.paymentId);
      } catch (err) {
        console.error("Фоновая проверка оплаты:", err.message);
      }
    }
  }, 30 * 1000);
}

// ---------- Статус заказа (страница success.html после оплаты) ----------
app.get("/api/order-status", (req, res) => {
  const order = db.findOrder(String(req.query.id || ""));
  if (!order) return res.status(404).json({ status: "not_found" });
  if (order.paid) {
    return res.json({
      status: "paid",
      order: {
        ticketName: order.ticketName,
        qty: order.qty,
        total: order.total,
        totalLabel: fmtMoney(order.total),
        // у входного билета депозита на баре нет — на странице пишем иначе
        hasDeposit: ticketById[order.ticket]?.deposit !== false,
        deposit: order.unitPrice,
        depositLabel: fmtMoney(order.unitPrice),
        wheel: order.wheel || null,
        codes: order.codes,
      },
    });
  }
  res.json({ status: order.status }); // pending | canceled
});

// ---------- АДМИНКА (охрана на входе + база заказов) ----------
function requireAdmin(req, res, next) {
  const pass = req.get("x-admin-password") || req.query.pass;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Неверный пароль." });
  next();
}

// Депозит по коду для охраны: сколько человек может потратить на баре.
// По промокоду или скидке колеса — меньше, у входного билета депозита нет вовсе.
function depositInfo(info) {
  const noDeposit = info.noDeposit ?? ticketById[info.ticket]?.deposit === false;
  const deposit = noDeposit ? 0 : info.deposit ?? ticketById[info.ticket]?.price ?? null;
  return {
    deposit,
    noDeposit,
    depositLabel: noDeposit
      ? `нет (${info.manual ? "гостевой код" : "входной билет"})`
      : deposit === null ? "—" : deposit === 0 ? "бесплатно" : fmtMoney(deposit),
    paidRub: info.paidRub ?? deposit, // сколько реально заплачено
    promo: info.promo || null,
    wheel: info.wheel || null, // процент скидки, выигранный на колесе
    manual: !!info.manual, // код выдан вручную владельцем, а не куплен
    test: !!info.test, // помечен тестовым — в статистике не считается
  };
}

// Проверить код (без отметки)
app.post("/api/verify", requireAdmin, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const info = db.getCode(code);
  if (!info) return res.json({ status: "not_found" });
  res.json({
    status: info.used ? "used" : "valid",
    ticketName: info.ticketName,
    contact: info.contact,
    usedAt: info.usedAt,
    ...depositInfo(info),
  });
});

// Пропустить на входе (отметить использованным)
app.post("/api/checkin", requireAdmin, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const result = db.markUsed(code);
  if (!result.ok && result.reason === "not_found") return res.json({ status: "not_found" });
  if (!result.ok && result.reason === "already_used")
    return res.json({
      status: "used",
      ticketName: result.code.ticketName,
      usedAt: result.code.usedAt,
      ...depositInfo(result.code),
    });
  const info = db.getCode(code);
  res.json({ status: "checked_in", ticketName: info.ticketName, contact: info.contact, ...depositInfo(info) });
});

// Список заказов (база: какой код кому выдан)
app.get("/api/orders", requireAdmin, (req, res) => {
  const data = db.getDb();
  const sold = {};
  tickets.forEach(
    (t) =>
      (sold[t.id] = {
        name: t.name,
        sold: db.soldCount(t.id),
        sum: db.soldSum(t.id), // на какую сумму продано
        limit: t.limit,
        hasDeposit: t.deposit !== false,
      })
  );
  const c = db.counts();
  // Коды, выданные вручную — отдельной строкой, это не продажа с сайта
  if (c.manualCount) {
    sold[manualTicket.id] = {
      name: manualTicket.name,
      sold: c.manualCount,
      sum: c.cash,
      limit: null,
      hasDeposit: true,
    };
  }
  res.json({
    orders: data.orders,
    sold,
    money: {
      revenue: c.revenue, // выручка сайта
      cash: c.cash, // наличные за коды, выданные вручную
      total: c.total,
      deposits: c.depositTotal, // сколько депозитов выдано всего
      barSpent: c.barSpent, // сколько на баре уже проели
      testCount: c.testCount,
    },
  });
});

// Короткая ссылка для QR-кода на столах: toosovka39.ru/menu → меню бара.
// Отдаём файл сразу, без редиректа — со сканера камеры страница открывается быстрее.
app.get("/menu", (req, res) => {
  res.sendFile("menu.html", { root: "public" });
});

// Статика. Картинки/шрифты кэшируем в браузере надолго (афиша тяжёлая — качать
// её при каждом заходе незачем), а html/css/js — только на 5 минут,
// чтобы правки текста на сайте появлялись у людей быстро.
app.use(
  express.static("public", {
    setHeaders(res, filePath) {
      const long = /\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(filePath);
      res.setHeader("Cache-Control", long ? "public, max-age=2592000" : "public, max-age=300");
    },
  })
);

app.listen(PORT, () => {
  console.log(`\n🎉 ${event.title} — сайт запущен: http://localhost:${PORT}`);
  console.log("🛡 Охрана проверяет коды в Telegram-боте (пришли код боту).");
  console.log(TEST_MODE ? "🧪 ТЕСТ-РЕЖИМ: оплата имитируется.\n" : "💳 Боевой режим ЮKassa.\n");
  startBot();
});
