// Telegram-бот для охраны на входе.
// Авторизация — по кодовому слову (SECURITY_PASSWORD, по умолч. toosovka39).
// Кто ввёл слово — получает доступ: присылает код билета, бот отвечает тип
// билета, число проверок и кнопки «Подтвердить проход» / «Отмена».
// Код гасится один раз. Есть статистика и история проходов.
import { tickets, ticketById } from "../config.js";
import * as db from "./db.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const PASSWORD = (process.env.SECURITY_PASSWORD || "toosovka39").trim();
let offset = 0;

// Кто уже ввёл кодовое слово (сбрасывается при перезапуске сервера).
const authorized = new Set();
const isAuthorized = (id) => authorized.has(String(id));

// Кнопки для охраны
const KB_STATS = "📊 Статистика";
const KB_HISTORY = "🕒 История проходов";
const KB_LEFT = "🏃 Отметить уход";
const KB_LOGOUT = "🔒 Выйти";
const guardKeyboard = {
  keyboard: [[{ text: KB_STATS }, { text: KB_HISTORY }], [{ text: KB_LEFT }], [{ text: KB_LOGOUT }]],
  resize_keyboard: true,
};

async function api(method, payload) {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    console.error("Бот API ошибка:", method, e.message);
    return null;
  }
}

function ticketLabel(id) {
  return id === "vip" ? "🥂 <b>VIP-столик</b>" : "🎟 <b>Обычный билет</b>";
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString("ru-RU"); } catch { return iso; }
}
const fmtMoney = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// Депозит человека — сколько он реально заплатил (по промокоду меньше).
// Охране это нужно на входе: у одного депозит 1 200 ₽, у другого 800 ₽.
function depositOf(info) {
  return info.deposit ?? ticketById[info.ticket]?.price ?? null;
}
function depositShort(info) {
  const price = depositOf(info);
  if (price === null) return "—";
  return price === 0 ? "бесплатно" : fmtMoney(price);
}
function depositLine(info) {
  const price = depositOf(info);
  if (price === null) return "";
  const promo = info.promo ? ` · промокод ${info.promo}` : "";
  return `💰 Депозит на баре: <b>${price === 0 ? "нет (бесплатный вход)" : fmtMoney(price)}</b>${promo}\n`;
}

async function handleCode(chatId, text) {
  const code = text.trim().toUpperCase();
  const info = db.getCode(code);

  if (!info) {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `✕ Код <b>${code}</b> не найден в базе.` });
    return;
  }

  const checks = db.incrementCheck(code);

  if (info.used) {
    await api("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `⚠️ <b>КОД УЖЕ ИСПОЛЬЗОВАН</b>\n${ticketLabel(info.ticket)}\n` +
        depositLine(info) +
        `Вход был: ${fmtTime(info.usedAt)}\n` +
        `Код запрашивали раз: <b>${checks}</b>`,
    });
    return;
  }

  await api("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `✅ <b>ДЕЙСТВИТЕЛЕН</b>\n${ticketLabel(info.ticket)}\n` +
      depositLine(info) +
      `Код запрашивали раз: <b>${checks}</b>\n\nПодтвердить проход?`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Подтвердить проход", callback_data: `ok:${code}` },
        { text: "❌ Отмена", callback_data: `no:${code}` },
      ]],
    },
  });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const [action, code] = String(cb.data || "").split(":");

  if (!isAuthorized(cb.from.id)) {
    await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Нет доступа. Введи кодовое слово." });
    return;
  }

  if (action === "ok") {
    const r = db.markUsed(code);
    if (r.ok) {
      const info = db.getCode(code);
      await api("editMessageText", {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text:
          `✅ <b>ПРОХОД ПОДТВЕРЖДЁН</b>\n${ticketLabel(info.ticket)}\n` +
          depositLine(info) +
          `Код <b>${code}</b> погашен.\n${fmtTime(info.usedAt)}`,
      });
    } else if (r.reason === "already_used") {
      await api("editMessageText", {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: `⚠️ Код <b>${code}</b> уже был использован ранее (${fmtTime(r.code.usedAt)}).`,
      });
    } else {
      await api("editMessageText", { chat_id: chatId, message_id: msgId, text: `✕ Код не найден.` });
    }
    await api("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }

  if (action === "left") {
    const r = db.markLeft(code);
    if (r.ok) {
      // Перерисовываем панель ухода с обновлённым списком
      const panel = insidePanel();
      await api("editMessageText", {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text: `🚪 <b>${code}</b> — отметил уход (${fmtTime(r.code.leftAt)}).\n\n` + panel.text,
        reply_markup: panel.reply_markup,
      });
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: `Ушёл: ${code}` });
    } else {
      const txt = r.reason === "already_left" ? "Уже отмечен как ушедший" : "Не найден или ещё не входил";
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: txt });
    }
    return;
  }

  // action === "no" — отмена подтверждения прохода
  await api("editMessageText", {
    chat_id: chatId, message_id: msgId, parse_mode: "HTML",
    text: `❌ Отменено. Код <b>${code}</b> НЕ погашен.`,
  });
  await api("answerCallbackQuery", { callback_query_id: cb.id });
}

function statsText() {
  // limit может быть null — это билет без ограничения по количеству
  const perTicket = tickets
    .map((t) => `${t.name}: куплено <b>${db.soldCount(t.id)}</b>${t.limit ? ` из ${t.limit}` : ""}`)
    .join("\n");
  const c = db.counts();
  return (
    "📊 <b>Статистика — DUBAI PARTY</b>\n\n" +
    perTicket +
    "\n\n" +
    `🟢 <b>Сейчас внутри: ${c.inside}</b>\n` +
    `✅ Всего прошло на вход: <b>${c.entered}</b>\n` +
    `🚪 Ушли: <b>${c.left}</b>\n` +
    `⏳ Куплено, но ещё не зашли: <b>${c.notArrived}</b>\n` +
    `🏷 По промокоду: куплено <b>${c.promoSold}</b>, из них зашли <b>${c.promoEntered}</b>`
  );
}

// Панель «кто ушёл»: текст + кнопки с людьми, что сейчас внутри
function insidePanel() {
  const all = db.insideList();
  if (!all.length) {
    return {
      text: "🟢 Сейчас внутри никого нет — отмечать уход некого.",
      reply_markup: { inline_keyboard: [] },
    };
  }
  // Показываем последних вошедших сверху, максимум 50 кнопок
  const shown = all.slice(-50).reverse();
  const buttons = shown.map((r) => [
    {
      text: `${r.ticket === "vip" ? "🥂" : "🎟"} ${r.code} · ${depositShort(r)} · ${r.contact}`,
      callback_data: `left:${r.code}`,
    },
  ]);
  const more = all.length > shown.length ? `\n(показаны последние ${shown.length} из ${all.length})` : "";
  return {
    text:
      `🏃 <b>Кто ушёл?</b>\nСейчас внутри: <b>${all.length}</b>.\n` +
      `Нажми на человека, который уходит — он спишется со счётчика.${more}`,
    reply_markup: { inline_keyboard: buttons },
  };
}

function historyText() {
  const rows = db.history(20);
  if (!rows.length) return "🕒 <b>История проходов пуста.</b>\nПока никто не прошёл.";
  const lines = rows.map(
    (r) => `${r.ticket === "vip" ? "🥂" : "🎟"} <b>${r.code}</b> · ${depositShort(r)} — ${fmtTime(r.usedAt)}`
  );
  return `🕒 <b>Последние проходы (${rows.length}):</b>\n` + lines.join("\n");
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text = (msg.text || "").trim();

  // Кодовое слово — вход
  if (text.toLowerCase() === PASSWORD.toLowerCase()) {
    authorized.add(String(fromId));
    await api("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "🛡 <b>Доступ открыт.</b>\nПрисылай код билета — проверю. Кнопки внизу.",
      reply_markup: guardKeyboard,
    });
    return;
  }

  if (text === "/start") {
    await api("sendMessage", {
      chat_id: chatId,
      text: isAuthorized(fromId)
        ? "🛡 Бот охраны DUBAI PARTY. Присылай код билета."
        : "🔒 Бот охраны DUBAI PARTY.\nЧтобы начать проверять коды — введи кодовое слово.",
      reply_markup: isAuthorized(fromId) ? guardKeyboard : undefined,
    });
    return;
  }

  // Всё остальное — только для авторизованных
  if (!isAuthorized(fromId)) {
    await api("sendMessage", { chat_id: chatId, text: "🔒 Введи кодовое слово, чтобы получить доступ." });
    return;
  }

  if (text === KB_LOGOUT || text === "/logout") {
    authorized.delete(String(fromId));
    await api("sendMessage", { chat_id: chatId, text: "🚪 Вышел. Введи кодовое слово, чтобы снова получить доступ.", reply_markup: { remove_keyboard: true } });
    return;
  }
  if (text === KB_STATS || text === "/stats") {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: statsText(), reply_markup: guardKeyboard });
    return;
  }
  if (text === KB_HISTORY || text === "/history") {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: historyText(), reply_markup: guardKeyboard });
    return;
  }
  if (text === KB_LEFT || text === "/left") {
    const panel = insidePanel();
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: panel.text, reply_markup: panel.reply_markup });
    return;
  }

  await handleCode(chatId, text);
}

async function poll() {
  const res = await api("getUpdates", { offset, timeout: 30 });
  if (res && res.ok) {
    for (const u of res.result) {
      offset = u.update_id + 1;
      try {
        if (u.callback_query) await handleCallback(u.callback_query);
        else if (u.message && u.message.text) await handleMessage(u.message);
      } catch (e) {
        console.error("Ошибка обработки апдейта:", e.message);
      }
    }
  }
  setTimeout(poll, res && res.ok ? 300 : 3000);
}

// Пропустить старые сообщения, начать с новых
async function drain() {
  const res = await api("getUpdates", { offset: -1, timeout: 0 });
  if (res && res.ok && res.result.length) {
    offset = res.result[res.result.length - 1].update_id + 1;
  }
}

export async function startBot() {
  if (!TOKEN) {
    console.log("🤖 Бот не запущен: не задан TELEGRAM_BOT_TOKEN.");
    return;
  }
  await drain();
  console.log(`🤖 Бот охраны запущен. Кодовое слово: "${PASSWORD}"`);
  poll();
}
