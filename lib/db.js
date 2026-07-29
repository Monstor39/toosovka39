// Простая база данных на JSON-файле (data/db.json).
// Для масштаба вечеринки (сотни билетов) этого достаточно и надёжно.
import fs from "fs";
import path from "path";
import { ticketById } from "../config.js";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "db.json");

let db = { codes: {}, orders: [], spins: {} };

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
  if (!db.spins) db.spins = {}; // прокруты колеса «Крейзи Дубай» по клиентам
  // Миграция старых записей: добавляем поля ухода, если их нет
  for (const c of Object.values(db.codes)) {
    if (c.left === undefined) c.left = false;
    if (c.leftAt === undefined) c.leftAt = null;
    // Депозит (сколько человек заплатил) — у старых кодов промокодов не было,
    // значит депозит равен полной цене билета
    if (c.deposit === undefined) c.deposit = ticketById[c.ticket]?.price ?? null;
    if (c.promo === undefined) c.promo = null;
    // Сколько реально заплачено и была ли скидка с колеса (у старых записей — нет)
    if (c.paidRub === undefined) c.paidRub = c.deposit;
    if (c.wheel === undefined) c.wheel = null;
    if (c.noDeposit === undefined) c.noDeposit = ticketById[c.ticket]?.deposit === false;
  }
  // Миграция заказов: у старых (тестовых) заказов не было поля status
  for (const o of db.orders) {
    if (o.status === undefined) o.status = o.paid ? "paid" : "canceled";
    if (!o.codes) o.codes = [];
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

// Запись кода в базе. Депозит на баре = сколько человек реально заплатил
// (со скидкой промокода или колеса — меньше). У билетов с deposit: false
// (входной за 200 ₽) депозита на баре нет вообще.
function codeRecord(order) {
  const noDeposit = ticketById[order.ticket]?.deposit === false;
  return {
    ticket: order.ticket,
    ticketName: order.ticketName,
    contact: order.contact,
    contactType: order.contactType,
    orderId: order.id,
    createdAt: order.createdAt,
    paidRub: order.unitPrice, // сколько заплатил за этот билет
    deposit: noDeposit ? 0 : order.unitPrice, // сколько может потратить на баре
    noDeposit,
    promo: order.promo || null,
    wheel: order.wheel ?? null, // процент скидки, выигранный на колесе
    used: false,
    usedAt: null,
    checks: 0, // сколько раз охрана проверяла код
    left: false, // ушёл ли человек с мероприятия
    leftAt: null,
  };
}

// Сохранить заказ и его коды. Вызывается синхронно (без await внутри),
// чтобы не было гонки при одновременных покупках.
export function addOrder(order) {
  db.orders.push(order);
  for (const code of order.codes) {
    db.codes[code] = codeRecord(order);
  }
  save();
}

export function getCode(code) {
  return db.codes[code] || null;
}

// ---------- Заказы с онлайн-оплатой (ЮKassa) ----------

export function findOrder(orderId) {
  return db.orders.find((o) => o.id === orderId) || null;
}

// Сколько билетов данного типа сейчас «в резерве»:
// заказ создан, ждёт оплаты и резерв ещё не истёк.
export function pendingQty(ticketId) {
  const now = Date.now();
  return db.orders
    .filter((o) => o.ticket === ticketId && o.status === "pending" && new Date(o.expiresAt).getTime() > now)
    .reduce((sum, o) => sum + o.qty, 0);
}

// Сколько раз промокод уже применён: оплаченные заказы плюс те,
// что сейчас ждут оплаты (резерв не истёк) — чтобы лимит нельзя было обойти.
export function promoUses(code) {
  const c = String(code || "").toUpperCase();
  if (!c) return 0;
  const now = Date.now();
  return db.orders.filter(
    (o) =>
      String(o.promo || "").toUpperCase() === c &&
      (o.status === "paid" ||
        (o.status === "pending" && new Date(o.expiresAt).getTime() > now))
  ).length;
}

// Сохранить заказ, ожидающий оплаты (коды выдадим после вебхука).
// Вызывается синхронно — резервирует билеты до создания платежа.
export function addPendingOrder(order) {
  db.orders.push(order);
  save();
}

// Привязать к заказу id платежа ЮKassa
export function setOrderPayment(orderId, paymentId) {
  const o = findOrder(orderId);
  if (!o) return;
  o.paymentId = paymentId;
  save();
}

// Оплата подтверждена: выдаём коды (та же структура, что в addOrder)
export function markOrderPaid(orderId, codes) {
  const o = findOrder(orderId);
  if (!o || o.paid) return o;
  o.paid = true;
  o.status = "paid";
  o.paidAt = new Date().toISOString();
  o.codes = codes;
  for (const code of codes) {
    db.codes[code] = codeRecord(o);
  }
  save();
  return o;
}

// Платёж отменён (не оплатил / отказ банка) — снимаем резерв
export function markOrderCanceled(orderId) {
  const o = findOrder(orderId);
  if (!o || o.paid) return;
  o.status = "canceled";
  save();
}

// История проходов: погашённые коды, новые сверху
export function history(limit = 15) {
  return Object.entries(db.codes)
    .filter(([, c]) => c.used)
    .map(([code, c]) => ({ code, ticket: c.ticket, ticketName: c.ticketName, contact: c.contact, usedAt: c.usedAt, deposit: c.deposit, noDeposit: c.noDeposit, paidRub: c.paidRub, wheel: c.wheel, promo: c.promo }))
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
    .map(([code, c]) => ({ code, ticket: c.ticket, contact: c.contact, usedAt: c.usedAt, deposit: c.deposit, noDeposit: c.noDeposit, paidRub: c.paidRub, wheel: c.wheel, promo: c.promo }))
    .sort((a, b) => new Date(a.usedAt) - new Date(b.usedAt));
}

// Сводные числа для статистики
export function counts() {
  const vals = Object.values(db.codes);
  const sold = vals.length;
  const entered = vals.filter((c) => c.used).length;
  const left = vals.filter((c) => c.left).length;
  // Сколько билетов куплено по промокоду и сколько таких уже прошло на вход
  const promoSold = vals.filter((c) => c.promo).length;
  const promoEntered = vals.filter((c) => c.promo && c.used).length;
  // Колесо «Крейзи Дубай»: сколько крутили, сколько из них купили
  const spins = Object.values(db.spins || {});
  const wheelSpins = spins.length;
  const wheelUsed = spins.filter((s) => s.used).length;
  const wheelSold = vals.filter((c) => c.wheel).length;
  return {
    sold, entered, left, inside: entered - left, notArrived: sold - entered,
    promoSold, promoEntered, wheelSpins, wheelUsed, wheelSold,
  };
}

// ---------- Колесо «Крейзи Дубай» ----------
// Ключ — клиент (обычно IP): один прокрут на клиента, запись остаётся навсегда,
// поэтому второй раз крутить уже нельзя, даже если скидка сгорела.

export function getSpin(key) {
  return db.spins[key] || null;
}

export function saveSpin(key, record) {
  db.spins[key] = record;
  save();
}

// Скидка потрачена: билет куплен по ней
export function markSpinUsed(key, orderId) {
  const s = db.spins[key];
  if (!s || s.used) return;
  s.used = true;
  s.usedAt = new Date().toISOString();
  s.orderId = orderId;
  save();
}
