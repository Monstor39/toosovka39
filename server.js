import "dotenv/config"; // ВАЖНО: грузим .env ДО остальных импортов, иначе бот не увидит токен
import express from "express";
import crypto from "crypto";
import { event, currency, tickets, ticketById, TEST_MODE } from "./config.js";
import * as db from "./lib/db.js";
import { makeUniqueCode } from "./lib/codes.js";
import { notifyAdmin } from "./lib/telegram.js";
import { startBot } from "./lib/bot.js";

db.load();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "dubai2026";

app.use(express.json());

const fmtMoney = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// ---------- Публичный статус: билеты + сколько осталось ----------
function ticketStatus(t) {
  const sold = db.soldCount(t.id);
  const remaining = Math.max(0, t.limit - sold);
  return {
    id: t.id,
    name: t.name,
    price: t.price,
    priceLabel: t.priceLabel || fmtMoney(t.price),
    description: t.description,
    badge: t.badge,
    remaining,
    soldOut: remaining <= 0,
    soldOutText: t.soldOutText || "Билеты закончились",
  };
}

app.get("/api/status", (req, res) => {
  res.json({ event, currency, testMode: TEST_MODE, tickets: tickets.map(ticketStatus) });
});

// ---------- Оформление заказа ----------
app.post("/api/checkout", async (req, res) => {
  try {
    const { ticketId, qty, contact } = req.body || {};
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

    // Доступность (критическая секция — без await до сохранения!)
    const sold = db.soldCount(ticket.id);
    const remaining = ticket.limit - sold;
    if (remaining <= 0)
      return res.status(409).json({ error: ticket.soldOutText || "Билеты закончились", soldOut: true });
    if (count > remaining)
      return res.status(409).json({ error: `Осталось только ${remaining} шт.`, remaining });

    const total = ticket.price * count;

    // --- ТЕСТ-РЕЖИМ: оплата имитируется, код выдаём сразу ---
    if (TEST_MODE) {
      const codes = [];
      for (let i = 0; i < count; i++) {
        codes.push(makeUniqueCode(ticket.codeFormat, db.codeExists));
      }
      const order = {
        id: crypto.randomUUID(),
        ticket: ticket.id,
        ticketName: ticket.name,
        qty: count,
        unitPrice: ticket.price,
        total,
        contact: contactValue,
        contactType,
        createdAt: new Date().toISOString(),
        paid: true,
        codes,
      };
      db.addOrder(order); // сохраняем синхронно

      // Уведомление тебе в Telegram (не блокирует ответ покупателю)
      const contactLabel = contactType === "phone" ? "Телефон" : "Telegram";
      notifyAdmin(
        `🎟 <b>Новая покупка — ${event.title}</b>\n` +
          `Билет: <b>${ticket.name}</b> × ${count}\n` +
          `Сумма: <b>${fmtMoney(total)}</b>\n` +
          `${contactLabel}: ${contactValue}\n` +
          `Код(ы): <b>${codes.join(", ")}</b>`
      );

      return res.json({
        ok: true,
        testMode: true,
        order: {
          ticketName: ticket.name,
          qty: count,
          total,
          totalLabel: fmtMoney(total),
          contact: contactValue,
          codes,
        },
      });
    }

    // --- БОЕВОЙ РЕЖИМ: здесь будет создание платежа ЮKassa ---
    // (код выдаётся после подтверждения оплаты в вебхуке)
    return res.status(501).json({ error: "Онлайн-оплата ещё не подключена." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера." });
  }
});

// ---------- АДМИНКА (охрана на входе + база заказов) ----------
function requireAdmin(req, res, next) {
  const pass = req.get("x-admin-password") || req.query.pass;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Неверный пароль." });
  next();
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
  });
});

// Пропустить на входе (отметить использованным)
app.post("/api/checkin", requireAdmin, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const result = db.markUsed(code);
  if (!result.ok && result.reason === "not_found") return res.json({ status: "not_found" });
  if (!result.ok && result.reason === "already_used")
    return res.json({ status: "used", ticketName: result.code.ticketName, usedAt: result.code.usedAt });
  const info = db.getCode(code);
  res.json({ status: "checked_in", ticketName: info.ticketName, contact: info.contact });
});

// Список заказов (база: какой код кому выдан)
app.get("/api/orders", requireAdmin, (req, res) => {
  const data = db.getDb();
  const sold = {};
  tickets.forEach((t) => (sold[t.id] = { name: t.name, sold: db.soldCount(t.id), limit: t.limit }));
  res.json({ orders: data.orders, sold });
});

app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`\n🎉 ${event.title} — сайт запущен: http://localhost:${PORT}`);
  console.log("🛡 Охрана проверяет коды в Telegram-боте (пришли код боту).");
  console.log(TEST_MODE ? "🧪 ТЕСТ-РЕЖИМ: оплата имитируется.\n" : "💳 Боевой режим ЮKassa.\n");
  startBot();
});
