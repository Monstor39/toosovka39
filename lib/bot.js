// Telegram-бот для охраны на входе и барменов на баре.
// Авторизация — по кодовому слову (SECURITY_PASSWORD), одно на всех:
// охрана, бармены и владелец. Забывшим слово бот показывает подсказку
// (SECURITY_HINT), само слово, разумеется, не пишет.
// Прислал код билета — бот показывает карточку:
//   не заходил  → кнопки «Подтвердить проход» / «Отмена» (это охране);
//   уже зашёл   → кнопки списания с депозита (это бармену).
// Списывать можно только после прохода и только в пределах депозита;
// ошибочное списание отменяется кнопкой «Отменить последнее».
import { tickets, ticketById, manualTicket } from "../config.js";
import * as db from "./db.js";
import { guestList, guestsCsv, guestsSummary } from "./guests.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const PASSWORD = (process.env.SECURITY_PASSWORD || "toosovka39").trim();
const HINT = (process.env.SECURITY_HINT || "").trim();
let offset = 0;

// Кто уже ввёл кодовое слово (сбрасывается при перезапуске сервера).
const authorized = new Set();
const isAuthorized = (id) => authorized.has(String(id));

// Владелец — только он выдаёт коды гостям и помечает коды тестовыми.
// Кодовое слово одно на всех, поэтому право решает Telegram-ID из .env.
const OWNER_ID = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
const isOwner = (id) => !!OWNER_ID && String(id) === OWNER_ID;

// Кто сейчас вводит сумму списания вручную: chatId → код билета
const awaitingAmount = new Map();
// Кто сейчас вводит депозит для нового кода гостя: chatId
const awaitingGive = new Set();

// Быстрые суммы на кнопках бармена
const QUICK_SUMS = [100, 200, 300, 500, 1000];

// Кнопки для охраны и бара
const KB_STATS = "📊 Статистика";
const KB_HISTORY = "🕒 История проходов";
const KB_BAR = "💰 Остатки на баре";
const KB_SPENDS = "🧾 Списания";
const KB_LEFT = "🏃 Отметить уход";
const KB_GIVE = "🎁 Выдать код";
const KB_GUESTS = "📇 База гостей";
const KB_LOGOUT = "🔒 Выйти";

// Клавиатура зависит от того, кто пишет: выдача кодов и база гостей —
// только владельцу (в базе телефоны и ники людей, охране их видеть незачем)
function keyboardFor(id) {
  const rows = [
    [{ text: KB_STATS }, { text: KB_HISTORY }],
    [{ text: KB_BAR }, { text: KB_SPENDS }],
    [{ text: KB_LEFT }],
  ];
  if (isOwner(id)) rows.push([{ text: KB_GIVE }, { text: KB_GUESTS }]);
  rows.push([{ text: KB_LOGOUT }]);
  return { keyboard: rows, resize_keyboard: true };
}

// Подсказка тем, кто забыл кодовое слово
const hintLine = () => (HINT ? `\nПодсказка: <i>${HINT}</i>` : "");

// Код могли набрать в русской раскладке («Ф42» вместо «A42») — возвращаем латиницу
const CYR_TO_LAT = {
  Й: "Q", Ц: "W", У: "E", К: "R", Е: "T", Н: "Y", Г: "U", Ш: "I", Щ: "O", З: "P",
  Ф: "A", Ы: "S", В: "D", А: "F", П: "G", Р: "H", О: "J", Л: "K", Д: "L",
  Я: "Z", Ч: "X", С: "C", М: "V", И: "B", Т: "N", Ь: "M",
};
const normCode = (s) =>
  String(s || "").trim().toUpperCase().split("").map((ch) => CYR_TO_LAT[ch] || ch).join("");

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

// Отправка файла (sendDocument) — тут не JSON, а multipart-форма
async function sendFile(chatId, filename, content, caption) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("parse_mode", "HTML");
    if (caption) form.append("caption", caption);
    form.append("document", new Blob([content], { type: "text/csv" }), filename);
    const res = await fetch(`${API}/sendDocument`, { method: "POST", body: form });
    return await res.json();
  } catch (e) {
    console.error("Бот: не смог отправить файл:", e.message);
    return null;
  }
}

// ---------- База гостей (только владелец) ----------
// Выгрузка контактов файлом: кто оставил телефон или телеграм,
// кто из них дошёл до входа, а кто взял код и не пришёл.
async function sendGuests(chatId, filter = "all") {
  const rows = guestList(filter);
  if (!rows.length) {
    await api("sendMessage", { chat_id: chatId, text: "Пока некого выгружать — база гостей пуста." });
    return;
  }
  const s = guestsSummary(rows);
  const names = { all: "все", came: "дошли", missed: "не дошли" };
  const date = new Date().toISOString().slice(0, 10);
  const caption =
    `📇 <b>База гостей — ${names[filter]}</b>\n\n` +
    `👤 Людей: <b>${s.people}</b> (телефонов ${s.phones}, телеграмов ${s.telegrams})\n` +
    `🎟 Кодов взяли: <b>${s.codes}</b>, погашено на входе: <b>${s.came}</b>\n` +
    `✅ Дошли: <b>${s.camepeople}</b> · ❌ не дошли: <b>${s.missed}</b>\n\n` +
    `<i>Файл открывается в Excel двойным кликом.</i>`;

  const sent = await sendFile(chatId, `dubai-party-guests-${filter}-${date}.csv`, guestsCsv(rows), caption);
  if (!sent || !sent.ok) {
    await api("sendMessage", { chat_id: chatId, text: "Не получилось отправить файл. Попробуй ещё раз." });
    return;
  }
  if (filter !== "all") return;
  await api("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: "Нужен отдельный список?",
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ Кто дошёл (${s.camepeople})`, callback_data: "gst:came" },
        { text: `❌ Кто не дошёл (${s.missed})`, callback_data: "gst:missed" },
      ]],
    },
  });
}

// Иконка типа билета (для списков) и полная подпись (для карточки кода)
// standard/entry — билеты прошлых вечеринок, их коды ещё лежат в базе
const ICONS = { vip: "🥂", free: "🎫", standard: "🎟", entry: "🎫", manual: "🎁" };
const ticketIcon = (id) => ICONS[id] || "🎟";
// Название типа: у кодов, выданных вручную, своего билета в конфиге нет
const ticketName = (id) => (id === manualTicket.id ? manualTicket.name : ticketById[id]?.name);
function ticketLabel(id) {
  return `${ticketIcon(id)} <b>${ticketName(id) || "Билет"}</b>`;
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString("ru-RU"); } catch { return iso; }
}
const fmtMoney = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// Депозит человека — сколько он реально заплатил. Охране это нужно на входе:
// у гостя со столом депозит 10 000 ₽, а у бесплатного входа депозита нет вовсе.
function depositOf(info) {
  if (info.noDeposit) return 0;
  return info.deposit ?? ticketById[info.ticket]?.price ?? null;
}
function depositShort(info) {
  if (info.noDeposit) return "без депозита";
  const price = depositOf(info);
  if (price === null) return "—";
  return price === 0 ? "бесплатно" : fmtMoney(price);
}
// Откуда взялся код — чтобы охрана не спорила с гостем
const sourceNote = (info) => (info.manual ? " · выдан вручную" : "");
// Помеченный тестовым код работает как обычный, но в статистике его нет —
// пишем это в карточке, чтобы никто не удивлялся расхождению чисел
const testLine = (info) =>
  info.test ? `🧪 <i>Помечен тестовым — в статистике не считается</i>\n` : "";
function depositLine(info) {
  if (info.noDeposit) {
    const paid = info.paidRub ?? ticketById[info.ticket]?.price;
    const kind = info.manual ? "выдан вручную" : "бесплатный вход";
    return `💰 Депозит на баре: <b>нет</b> (${kind}${paid ? `, оплачено ${fmtMoney(paid)}` : ""})\n`;
  }
  const price = depositOf(info);
  if (price === null) return "";
  return `💰 Депозит на баре: <b>${price === 0 ? "нет (бесплатный вход)" : fmtMoney(price)}</b>${sourceNote(info)}\n`;
}

// ---------- Бар ----------
// Карточка кода для бармена: сколько денег на коде осталось и кнопки списания.
// note — строка сверху («Списано 300 ₽»), когда карточку перерисовываем после операции.
// owner — показывать ли владельцу кнопку «не считать этот код в статистике»
function barCard(code, info, note = "", owner = false) {
  const testRow = owner
    ? [[{
        text: info.test ? "✅ Вернуть в статистику" : "🧪 Не считать (тест)",
        callback_data: `test:${code}:${info.test ? 0 : 1}`,
      }]]
    : [];

  if (info.noDeposit) {
    const kind = info.manual ? "код выдан без депозита" : "это бесплатный вход";
    return {
      text:
        `${note}🎫 <b>${code}</b> · ${ticketName(info.ticket) || "билет"}\n` +
        testLine(info) +
        `💰 Депозита на баре <b>нет</b> — ${kind}, бар оплачивается отдельно.`,
      reply_markup: { inline_keyboard: testRow },
    };
  }

  const left = db.balanceOf(info);
  const spent = info.spent || 0;
  const text =
    `${note}🍸 <b>БАР · код ${code}</b>\n${ticketLabel(info.ticket)}\n` +
    testLine(info) +
    `💰 Депозит: <b>${fmtMoney(info.deposit ?? 0)}</b>\n` +
    `🧾 Уже списано: <b>${fmtMoney(spent)}</b>\n` +
    `${left > 0 ? "🟢" : "🔴"} <b>Остаток: ${left > 0 ? fmtMoney(left) : "0 ₽ — депозит закончился"}</b>\n` +
    (info.contact ? `👤 ${info.contact}\n` : "") +
    (left > 0 ? `\nСколько списать?` : "");

  const rows = [];
  const quick = QUICK_SUMS.filter((s) => s <= left);
  for (let i = 0; i < quick.length; i += 3) {
    rows.push(quick.slice(i, i + 3).map((s) => ({ text: `${s} ₽`, callback_data: `sp:${code}:${s}` })));
  }
  if (left > 0) {
    rows.push([
      { text: "✏️ Своя сумма", callback_data: `spx:${code}` },
      { text: `💸 Весь остаток (${left} ₽)`, callback_data: `sp:${code}:${left}` },
    ]);
  }
  const last = (info.spends || []).at(-1);
  if (last) rows.push([{ text: `↩️ Отменить последнее (${last.amount} ₽)`, callback_data: `undo:${code}` }]);

  return { text, reply_markup: { inline_keyboard: [...rows, ...testRow] } };
}

async function sendBarCard(chatId, code, info, note = "", owner = false) {
  const card = barCard(code, info, note, owner);
  await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: card.text, reply_markup: card.reply_markup });
}

async function handleCode(chatId, text, fromId) {
  const code = normCode(text);
  const info = db.getCode(code);

  if (!info) {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `✕ Код <b>${code}</b> не найден в базе.` });
    return;
  }

  const checks = db.incrementCheck(code);

  // Гость уже прошёл на вход — значит это бар: показываем остаток и кнопки списания.
  // Охране заголовок тоже нужен: второй раз по этому коду не пропускать.
  if (info.used) {
    const card = barCard(
      code,
      info,
      `⚠️ <b>КОД УЖЕ ИСПОЛЬЗОВАН НА ВХОДЕ</b> (${fmtTime(info.usedAt)}), запрашивали раз: <b>${checks}</b>\n\n`,
      isOwner(fromId)
    );
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: card.text, reply_markup: card.reply_markup });
    return;
  }

  const rows = [[
    { text: "✅ Подтвердить проход", callback_data: `ok:${code}` },
    { text: "❌ Отмена", callback_data: `no:${code}` },
  ]];
  if (isOwner(fromId)) {
    rows.push([{
      text: info.test ? "✅ Вернуть в статистику" : "🧪 Не считать (тест)",
      callback_data: `test:${code}:${info.test ? 0 : 1}`,
    }]);
  }

  await api("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `✅ <b>ДЕЙСТВИТЕЛЕН</b>\n${ticketLabel(info.ticket)}\n` +
      testLine(info) +
      depositLine(info) +
      `Код запрашивали раз: <b>${checks}</b>\n\nПодтвердить проход?\n` +
      `<i>Списать с бара можно после того, как отмечен проход.</i>`,
    reply_markup: { inline_keyboard: rows },
  });
}

// ---------- Выдача кодов вручную (только владелец) ----------
// Панель с быстрыми суммами депозита. Дальше код сразу пишется в базу.
function givePanel() {
  const rows = [];
  const sums = manualTicket.deposits;
  for (let i = 0; i < sums.length; i += 3) {
    rows.push(sums.slice(i, i + 3).map((s) => ({ text: `${s} ₽`, callback_data: `gv:${s}` })));
  }
  rows.push([
    { text: "✏️ Своя сумма", callback_data: "gvx" },
    { text: "🎫 Без депозита", callback_data: "gv:0" },
  ]);
  return {
    text:
      "🎁 <b>Выдать код гостю</b>\n\n" +
      "Выбери депозит — сколько гость сможет потратить на баре.\n" +
      "Код сразу попадёт в базу: охрана пропустит по нему, бар спишет депозит, " +
      "в статистике он идёт отдельной строкой (не как продажа с сайта).\n\n" +
      "Можно и одной строкой:\n" +
      "• <code>выдать 1200 Ваня</code> — подарок с депозитом 1 200 ₽\n" +
      "• <code>выдать нал 1200 Ваня</code> — гость заплатил наличными",
    reply_markup: { inline_keyboard: rows },
  };
}

// Выдать код и показать карточку с ним
async function doIssue(chatId, { deposit, cash = false, contact = null }, byId) {
  const r = db.issueCode({ deposit, paidRub: cash ? deposit : 0, contact, by: byId });
  const rows = [];
  // Подарок можно потом переписать в наличные — одной кнопкой
  if (!r.paidRub && r.deposit > 0) {
    rows.push([{ text: `💵 Гость заплатил ${r.deposit} ₽`, callback_data: `gcash:${r.code}:${r.deposit}` }]);
  }
  rows.push([{ text: "🎁 Выдать ещё", callback_data: "gvmore" }]);

  await api("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `🎁 <b>Код выдан</b>\n\n<code>${r.code}</code>\n\n` +
      (r.deposit > 0
        ? `💰 Депозит на баре: <b>${fmtMoney(r.deposit)}</b>\n`
        : `🎫 Без депозита — только вход\n`) +
      (r.paidRub > 0
        ? `💵 Получено наличными: <b>${fmtMoney(r.paidRub)}</b>\n`
        : `🎁 Подарок — денег не получено\n`) +
      `👤 ${r.contact}\n\n` +
      `Перешли код гостю. На входе охрана пришлёт его боту и отметит проход.`,
    reply_markup: { inline_keyboard: rows },
  });
}

// «1200 Ваня», «нал 1200 Ваня», «1 200» → { deposit, cash, contact }
function parseGive(text) {
  let t = String(text || "").trim();
  let cash = false;
  const nal = t.match(/^(нал\.?|наличные|наличка|кэш)\s+/i);
  if (nal) {
    cash = true;
    t = t.slice(nal[0].length);
  }
  const m = t.match(/^(\d[\d\s]*)(?:[\s,]+(.*))?$/);
  if (!m) return null;
  const deposit = Number(m[1].replace(/\s/g, ""));
  if (!Number.isFinite(deposit) || deposit < 0 || deposit > 1000000) return null;
  return { deposit, cash, contact: (m[2] || "").trim() || null };
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const [action, code, arg] = String(cb.data || "").split(":");

  if (!isAuthorized(cb.from.id)) {
    await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Нет доступа. Введи кодовое слово." });
    return;
  }

  // ---------- Выдача кодов, тестовые коды и база гостей: только владелец ----------
  if (action === "gv" || action === "gvx" || action === "gvmore" || action === "gcash" || action === "test" || action === "gst") {
    if (!isOwner(cb.from.id)) {
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Это может только владелец." });
      return;
    }

    if (action === "gst") {
      // здесь в позиции кода приехал срез базы: came / missed
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Собираю файл…" });
      await sendGuests(chatId, code);
      return;
    }

    if (action === "gvmore") {
      const panel = givePanel();
      await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: panel.text, reply_markup: panel.reply_markup });
      await api("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (action === "gvx") {
      awaitingAmount.delete(String(chatId));
      awaitingGive.add(String(chatId));
      await api("sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          "✏️ Пришли сумму депозита числом — например <b>1500</b>.\n" +
          "Можно с именем гостя: <code>1500 Ваня</code>.\n" +
          "Если гость платит наличными: <code>нал 1500 Ваня</code>.\n" +
          "Передумал — напиши «отмена».",
      });
      await api("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (action === "gv") {
      // здесь в позиции кода приехала сумма депозита
      await doIssue(chatId, { deposit: Number(code) }, cb.from.id);
      await api("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (action === "gcash") {
      const c = db.setCashPaid(code, Number(arg));
      if (!c) {
        await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Код не найден или выдан не вручную." });
        return;
      }
      await api("editMessageText", {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        text:
          `🎁 <b>Код выдан</b>\n\n<code>${code}</code>\n\n` +
          (c.deposit > 0
            ? `💰 Депозит на баре: <b>${fmtMoney(c.deposit)}</b>\n`
            : `🎫 Без депозита — только вход\n`) +
          `💵 Получено наличными: <b>${fmtMoney(c.paidRub)}</b>\n👤 ${c.contact}`,
        reply_markup: { inline_keyboard: [[{ text: "🎁 Выдать ещё", callback_data: "gvmore" }]] },
      });
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: `В кассу +${c.paidRub} ₽` });
      return;
    }

    // action === "test" — код перестаёт (или снова начинает) считаться в статистике
    const on = arg === "1";
    const c = db.setTest(code, on);
    if (!c) {
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Код не найден." });
      return;
    }
    await api("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: on ? "Код помечен тестовым" : "Код снова в статистике",
    });
    await api("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: on
        ? `🧪 Код <b>${code}</b> помечен тестовым.\nВ статистике минус 1 билет` +
          `${c.paidRub ? ` и минус ${fmtMoney(c.paidRub)} из выручки` : ""}. ` +
          `На входе и на баре код при этом работает как обычно.`
        : `✅ Код <b>${code}</b> снова считается в статистике.`,
    });
    return;
  }

  // ---------- Бар: списание с депозита ----------
  if (action === "sp" || action === "undo" || action === "bar" || action === "spx") {
    const info = db.getCode(code);
    if (!info) {
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: "Код не найден." });
      return;
    }

    if (action === "bar") {
      // Кнопка «Списать с бара» под сообщением о проходе — открываем карточку бара
      await sendBarCard(chatId, code, info, "", isOwner(cb.from.id));
      await api("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    if (action === "spx") {
      awaitingAmount.set(String(chatId), code);
      await api("sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `✏️ Пришли сумму для кода <b>${code}</b> числом — например <b>350</b>.\n` +
          `Остаток на коде: <b>${fmtMoney(db.balanceOf(info))}</b>.\n` +
          `Передумал — напиши «отмена».`,
      });
      await api("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    const r = action === "sp" ? db.spend(code, Number(arg), cb.from.id) : db.undoLastSpend(code);
    if (!r.ok) {
      const reasons = {
        no_deposit: "У этого билета нет депозита",
        not_entered: "Сначала охрана отмечает проход",
        too_much: `На коде только ${fmtMoney(r.left ?? 0)}`,
        empty: "Депозит уже закончился",
        bad_amount: "Сумма должна быть больше нуля",
        nothing_to_undo: "Отменять нечего",
      };
      await api("answerCallbackQuery", { callback_query_id: cb.id, text: reasons[r.reason] || "Не получилось" });
      return;
    }

    const note =
      action === "sp"
        ? `✅ <b>Списано ${fmtMoney(r.amount)}</b>\n\n`
        : `↩️ <b>Отменено списание ${fmtMoney(r.amount)}</b>\n\n`;
    const card = barCard(code, db.getCode(code), note, isOwner(cb.from.id));
    await api("editMessageText", {
      chat_id: chatId, message_id: msgId, parse_mode: "HTML",
      text: card.text, reply_markup: card.reply_markup,
    });
    await api("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: action === "sp" ? `Списано ${r.amount} ₽ · остаток ${r.left} ₽` : `Возвращено ${r.amount} ₽`,
    });
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
        // депозит теперь можно тратить на баре — кнопка сразу под сообщением
        reply_markup: info.noDeposit
          ? undefined
          : { inline_keyboard: [[{ text: "🍸 Списать с бара", callback_data: `bar:${code}` }]] },
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
  // limit может быть null — это вариант без ограничения по количеству.
  // Рядом с количеством — сумма, на которую его взяли (бесплатный вход — 0 ₽).
  const perTicket = tickets
    .map(
      (t) =>
        `${ticketIcon(t.id)} ${t.name}: <b>${db.soldCount(t.id)}</b> шт` +
        `${t.limit ? ` из ${t.limit}` : ""}` +
        `${t.price === 0 ? "" : ` · <b>${fmtMoney(db.soldSum(t.id))}</b>`}`
    )
    .join("\n");
  const c = db.counts();
  return (
    "📊 <b>Статистика — DUBAI PARTY</b>\n\n" +
    "🎟 <b>Кодов выдано с сайта</b>\n" +
    perTicket +
    "\n\n" +
    `💵 <b>Выручка с сайта: ${fmtMoney(c.revenue)}</b> (${c.soldSite} кодов)\n` +
    (c.manualCount
      ? `🎁 Выдано вручную: <b>${c.manualCount}</b> · депозитов на ${fmtMoney(c.manualDeposit)}\n`
      : "") +
    (c.cash ? `💵 Получено наличными: <b>${fmtMoney(c.cash)}</b>\n` : "") +
    (c.cash ? `🧮 <b>Всего денег: ${fmtMoney(c.total)}</b>\n` : "") +
    (c.testCount ? `🧪 Тестовые (не в счёт): <b>${c.testCount}</b>\n` : "") +
    "\n" +
    `🟢 <b>Сейчас внутри: ${c.inside}</b>\n` +
    `✅ Всего прошло на вход: <b>${c.entered}</b>\n` +
    `🚪 Ушли: <b>${c.left}</b>\n` +
    `⏳ Взяли код, но ещё не зашли: <b>${c.notArrived}</b>\n\n` +
    `🍸 <b>Бар</b>\n` +
    `💰 Депозитов выдано всего: <b>${fmtMoney(c.depositTotal)}</b>\n` +
    `🧾 Списано с депозитов: <b>${fmtMoney(c.barSpent)}</b>\n` +
    `💰 Осталось у тех, кто внутри: <b>${fmtMoney(c.barLeftInside)}</b>`
  );
}

// Список гостей внутри, у кого ещё есть деньги на баре
function barListText() {
  const rows = db.barList();
  if (!rows.length) return "💰 <b>Остатков на баре нет.</b>\nЛибо ещё никто не зашёл, либо все депозиты потрачены.";
  const total = rows.reduce((sum, r) => sum + r.left, 0);
  const lines = rows
    .slice(0, 40)
    .map((r) => `${ticketIcon(r.ticket)} <b>${r.code}</b> · остаток <b>${fmtMoney(r.left)}</b> из ${fmtMoney(r.deposit)} · ${r.contact}`);
  const more = rows.length > 40 ? `\n(показаны 40 из ${rows.length})` : "";
  return (
    `💰 <b>Остатки на баре (${rows.length})</b>\nВсего не потрачено: <b>${fmtMoney(total)}</b>\n\n` +
    lines.join("\n") +
    more
  );
}

// Последние списания — видно, кто и сколько снял с кодов
function spendHistoryText() {
  const rows = db.spendHistory(20);
  if (!rows.length) return "🧾 <b>Списаний ещё не было.</b>";
  const lines = rows.map(
    (r) => `<b>${r.code}</b> · −${fmtMoney(r.amount)} · остаток ${fmtMoney(r.left)} — ${fmtTime(r.at)}`
  );
  return `🧾 <b>Последние списания (${rows.length}):</b>\n` + lines.join("\n");
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
      text: `${ticketIcon(r.ticket)} ${r.code} · ${depositShort(r)} · ${r.contact}`,
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
    (r) => `${ticketIcon(r.ticket)} <b>${r.code}</b> · ${depositShort(r)} — ${fmtTime(r.usedAt)}`
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
      text:
        "🛡 <b>Доступ открыт.</b>\n\n" +
        "Присылай код билета:\n" +
        "• гость <b>ещё не заходил</b> — кнопки прохода (это для охраны);\n" +
        "• гость <b>уже внутри</b> — остаток депозита и кнопки списания (это для бара).\n\n" +
        "Бармену быстрее так: <b>КОД СУММА</b> — например <code>A42 350</code>." +
        (isOwner(fromId)
          ? "\n\n🎁 Выдать код гостю: кнопка «Выдать код» или <code>выдать 1200 Ваня</code>." +
            "\n📇 Контакты гостей файлом — кнопка «База гостей»."
          : ""),
      reply_markup: keyboardFor(fromId),
    });
    return;
  }

  if (text === "/start") {
    await api("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: isAuthorized(fromId)
        ? "🛡 Бот DUBAI PARTY: вход и бар. Присылай код билета."
        : "🔒 Бот DUBAI PARTY (охрана и бар).\nЧтобы начать работать — введи кодовое слово." + hintLine(),
      reply_markup: isAuthorized(fromId) ? keyboardFor(fromId) : undefined,
    });
    return;
  }

  // Всё остальное — только для авторизованных
  if (!isAuthorized(fromId)) {
    await api("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "🔒 Введи кодовое слово, чтобы получить доступ." + hintLine(),
    });
    return;
  }

  // Ждём сумму депозита для нового кода гостя (нажали «Своя сумма» в выдаче)
  if (awaitingGive.has(String(chatId))) {
    if (/^(отмена|стоп|\/cancel)$/i.test(text)) {
      awaitingGive.delete(String(chatId));
      await api("sendMessage", { chat_id: chatId, text: "Ок, код не выдал." });
      return;
    }
    const give = parseGive(text);
    if (!give) {
      await api("sendMessage", {
        chat_id: chatId, parse_mode: "HTML",
        text: "Нужна сумма депозита числом — например <b>1500</b> или <code>1500 Ваня</code>. Или напиши «отмена».",
      });
      return;
    }
    awaitingGive.delete(String(chatId));
    await doIssue(chatId, give, fromId);
    return;
  }

  // Ждём сумму списания (нажали «Своя сумма»)
  const pendingCode = awaitingAmount.get(String(chatId));
  if (pendingCode) {
    if (/^(отмена|стоп|\/cancel)$/i.test(text)) {
      awaitingAmount.delete(String(chatId));
      await api("sendMessage", { chat_id: chatId, text: "Ок, ничего не списал." });
      return;
    }
    const amount = Number(text.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: "Нужна сумма числом — например <b>350</b>. Или напиши «отмена»." });
      return;
    }
    awaitingAmount.delete(String(chatId));
    await doSpend(chatId, pendingCode, amount, fromId);
    return;
  }

  if (text === KB_LOGOUT || text === "/logout") {
    authorized.delete(String(fromId));
    await api("sendMessage", { chat_id: chatId, text: "🚪 Вышел. Введи кодовое слово, чтобы снова получить доступ.", reply_markup: { remove_keyboard: true } });
    return;
  }
  if (text === KB_STATS || text === "/stats") {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: statsText(), reply_markup: keyboardFor(fromId) });
    return;
  }
  if (text === KB_HISTORY || text === "/history") {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: historyText(), reply_markup: keyboardFor(fromId) });
    return;
  }
  if (text === KB_BAR || text === "/bar") {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: barListText(), reply_markup: keyboardFor(fromId) });
    return;
  }
  if (text === KB_SPENDS || text === "/spends") {
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: spendHistoryText(), reply_markup: keyboardFor(fromId) });
    return;
  }
  if (text === KB_LEFT || text === "/left") {
    const panel = insidePanel();
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: panel.text, reply_markup: panel.reply_markup });
    return;
  }

  // База гостей файлом — в ней личные контакты, поэтому только владельцу
  if (text === KB_GUESTS || text === "/guests") {
    if (!isOwner(fromId)) {
      await api("sendMessage", { chat_id: chatId, text: "Базу гостей может выгрузить только владелец." });
      return;
    }
    await sendGuests(chatId, "all");
    return;
  }

  // Выдача кодов гостям — только владелец. Проверяем до разбора «КОД СУММА»,
  // иначе «выдать 1500» бот примет за списание с кода.
  const giveCmd = text.match(/^(?:выдать|выдай|\/give)\s*(.*)$/i);
  if (text === KB_GIVE || giveCmd) {
    if (!isOwner(fromId)) {
      await api("sendMessage", { chat_id: chatId, text: "Выдавать коды может только владелец." });
      return;
    }
    const arg = giveCmd ? giveCmd[1].trim() : "";
    const give = arg ? parseGive(arg) : null;
    if (give) {
      await doIssue(chatId, give, fromId);
      return;
    }
    if (arg) {
      await api("sendMessage", {
        chat_id: chatId, parse_mode: "HTML",
        text: "Не понял сумму. Пиши так: <code>выдать 1200 Ваня</code> или <code>выдать нал 1200 Ваня</code>.",
      });
      return;
    }
    const panel = givePanel();
    await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: panel.text, reply_markup: panel.reply_markup });
    return;
  }

  // «A42 350» — код и сумма одним сообщением: самый быстрый способ для бара
  const pair = text.match(/^([A-Za-zА-Яа-я0-9]{2,10})[\s,]+(\d+([.,]\d+)?)$/);
  if (pair) {
    await doSpend(chatId, normCode(pair[1]), Number(pair[2].replace(",", ".")), fromId);
    return;
  }

  await handleCode(chatId, text, fromId);
}

// Списать сумму с кода и показать карточку с новым остатком
async function doSpend(chatId, code, amount, byId) {
  const r = db.spend(code, amount, byId);
  if (r.ok) {
    await sendBarCard(chatId, code, db.getCode(code), `✅ <b>Списано ${fmtMoney(r.amount)}</b>\n\n`, isOwner(byId));
    return;
  }
  const info = db.getCode(code);
  const texts = {
    not_found: `✕ Код <b>${code}</b> не найден в базе.`,
    no_deposit: `🎫 У кода <b>${code}</b> нет депозита — бар оплачивается отдельно.`,
    not_entered: `⛔️ Код <b>${code}</b> ещё не прошёл вход. Сначала охрана отмечает проход — потом бар.`,
    empty: `🔴 На коде <b>${code}</b> депозит закончился.`,
    too_much: `⚠️ На коде <b>${code}</b> только <b>${fmtMoney(r.left ?? 0)}</b> — списать ${fmtMoney(Math.round(amount))} нельзя.`,
    bad_amount: "Сумма должна быть больше нуля.",
  };
  await api("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: texts[r.reason] || "Не получилось списать." });
  // Если код рабочий — сразу показываем карточку, чтобы бармен ввёл верную сумму
  if (info && info.used && !info.noDeposit && r.reason !== "not_found")
    await sendBarCard(chatId, code, info, "", isOwner(byId));
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
