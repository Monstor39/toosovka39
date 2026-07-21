// Простая база данных на JSON-файле (data/db.json).
// Для масштаба вечеринки (сотни билетов) этого достаточно и надёжно.
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "db.json");

let db = { codes: {}, orders: [] };

export function load() {
  try {
    if (fs.existsSync(FILE)) {
      db = JSON.parse(fs.readFileSync(FILE, "utf8"));
    }
  } catch (e) {
    console.error("Ошибка чтения базы:", e);
  }
  if (!db.codes) db.codes = {};
  if (!db.orders) db.orders = [];
  // Миграция старых записей: добавляем поля ухода, если их нет
  for (const c of Object.values(db.codes)) {
    if (c.left === undefined) c.left = false;
    if (c.leftAt === undefined) c.leftAt = null;
  }
}

function save() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}

export function getDb() {
  return db;
}

// Сколько билетов данного типа уже продано
export function soldCount(ticketId) {
  return Object.values(db.codes).filter((c) => c.ticket === ticketId).length;
}

export function codeExists(code) {
  return Object.prototype.hasOwnProperty.call(db.codes, code);
}

// Сохранить заказ и его коды. Вызывается синхронно (без await внутри),
// чтобы не было гонки при одновременных покупках.
export function addOrder(order) {
  db.orders.push(order);
  for (const code of order.codes) {
    db.codes[code] = {
      ticket: order.ticket,
      ticketName: order.ticketName,
      contact: order.contact,
      contactType: order.contactType,
      orderId: order.id,
      createdAt: order.createdAt,
      used: false,
      usedAt: null,
      checks: 0, // сколько раз охрана проверяла код
      left: false, // ушёл ли человек с мероприятия
      leftAt: null,
    };
  }
  save();
}

export function getCode(code) {
  return db.codes[code] || null;
}

// История проходов: погашённые коды, новые сверху
export function history(limit = 15) {
  return Object.entries(db.codes)
    .filter(([, c]) => c.used)
    .map(([code, c]) => ({ code, ticket: c.ticket, ticketName: c.ticketName, contact: c.contact, usedAt: c.usedAt }))
    .sort((a, b) => new Date(b.usedAt) - new Date(a.usedAt))
    .slice(0, limit);
}

// Увеличить счётчик проверок кода охраной, вернуть новое значение
export function incrementCheck(code) {
  const c = db.codes[code];
  if (!c) return 0;
  c.checks = (c.checks || 0) + 1;
  save();
  return c.checks;
}

// Отметить код использованным (на входе). Повторно — вернёт already_used.
export function markUsed(code) {
  const c = db.codes[code];
  if (!c) return { ok: false, reason: "not_found" };
  if (c.used) return { ok: false, reason: "already_used", code: c };
  c.used = true;
  c.usedAt = new Date().toISOString();
  save();
  return { ok: true, code: c };
}

// Отметить, что человек ушёл с мероприятия
export function markLeft(code) {
  const c = db.codes[code];
  if (!c) return { ok: false, reason: "not_found" };
  if (!c.used) return { ok: false, reason: "not_entered" };
  if (c.left) return { ok: false, reason: "already_left", code: c };
  c.left = true;
  c.leftAt = new Date().toISOString();
  save();
  return { ok: true, code: c };
}

// Кто сейчас внутри: вошёл и ещё не ушёл (старые входы сверху)
export function insideList() {
  return Object.entries(db.codes)
    .filter(([, c]) => c.used && !c.left)
    .map(([code, c]) => ({ code, ticket: c.ticket, contact: c.contact, usedAt: c.usedAt }))
    .sort((a, b) => new Date(a.usedAt) - new Date(b.usedAt));
}

// Сводные числа для статистики
export function counts() {
  const vals = Object.values(db.codes);
  const sold = vals.length;
  const entered = vals.filter((c) => c.used).length;
  const left = vals.filter((c) => c.left).length;
  return { sold, entered, left, inside: entered - left, notArrived: sold - entered };
}
