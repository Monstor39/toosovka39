// Простая база данных на JSON-файле (data/db.json).
// Для масштаба вечеринки (сотни билетов) этого достаточно и надёжно.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ticketById, manualTicket } from "../config.js";
import { makeUniqueCode } from "./codes.js";

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
    // Депозит — сколько человек может потратить на баре
    if (c.deposit === undefined) c.deposit = ticketById[c.ticket]?.price ?? null;
    // Сколько реально заплачено (у старых записей — цена билета)
    if (c.paidRub === undefined) c.paidRub = c.deposit;
    if (c.noDeposit === undefined) c.noDeposit = ticketById[c.ticket]?.deposit === false;
    // Бар: сколько с депозита уже списано и каждое списание отдельно
    if (c.spent === undefined) c.spent = 0;
    if (!Array.isArray(c.spends)) c.spends = [];
    // Выдан вручную владельцем? Помечен тестовым (нигде не считается)?
    if (c.manual === undefined) c.manual = false;
    if (c.test === undefined) c.test = false;
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

// Все коды, которые идут в счёт: помеченные тестовыми не считаются нигде
// (ни в проданных билетах, ни в выручке, ни в списках).
function realCodes() {
  return Object.values(db.codes).filter((c) => !c.test);
}

// Сколько билетов данного типа уже продано
export function soldCount(ticketId) {
  return realCodes().filter((c) => c.ticket === ticketId).length;
}

// На какую сумму продано билетов данного типа — сколько за них реально
// заплатили (со скидкой промокода или колеса меньше полной цены).
export function soldSum(ticketId) {
  return realCodes()
    .filter((c) => c.ticket === ticketId)
    .reduce((sum, c) => sum + (c.paidRub || 0), 0);
}

export function codeExists(code) {
  return Object.prototype.hasOwnProperty.call(db.codes, code);
}

// Запись кода в базе. Депозит на баре = сколько человек реально заплатил.
// У вариантов с deposit: false (бесплатный вход) депозита на баре нет вообще.
function codeRecord(order) {
  const noDeposit = ticketById[order.ticket]?.deposit === false;
  return {
    ticket: order.ticket,
    ticketName: order.ticketName,
    contact: order.contact,
    contactType: order.contactType,
    orderId: order.id,
    createdAt: order.createdAt,
    paidRub: order.unitPrice, // сколько заплатил
    deposit: noDeposit ? 0 : order.unitPrice, // сколько может потратить на баре
    noDeposit,
    manual: false, // взят на сайте, а не выдан вручную
    test: false, // тестовые коды исключаются из всей статистики
    used: false,
    usedAt: null,
    checks: 0, // сколько раз охрана проверяла код
    left: false, // ушёл ли человек с мероприятия
    leftAt: null,
    spent: 0, // сколько бармены уже списали с депозита
    spends: [], // каждое списание отдельно — чтобы можно было отменить ошибочное
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

// ---------- Коды, выданные вручную (владелец из бота) ----------
// Гостю, другу, за наличные на входе. Код сразу живёт в базе как обычный:
// охрана пропускает, бар списывает депозит. В статистике идёт отдельной
// строкой, чтобы не мешаться с выручкой сайта.
//   deposit — сколько гость может потратить на баре (0 — только вход);
//   paidRub — сколько денег реально получено (0 — подарок).
// Синхронно, без await — как и остальные записи.
export function issueCode({ deposit = 0, paidRub = 0, contact = null, by = null } = {}) {
  const dep = Math.max(0, Math.round(Number(deposit) || 0));
  const paid = Math.max(0, Math.round(Number(paidRub) || 0));
  const code = makeUniqueCode(manualTicket.codeFormat, codeExists);
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const who = contact ? String(contact).slice(0, 60) : "🎁 вручную";

  db.orders.push({
    id: orderId,
    ticket: manualTicket.id,
    ticketName: manualTicket.name,
    qty: 1,
    unitPrice: dep, // депозит гостя
    total: paid, // сколько получено деньгами (0 — подарок)
    contact: who,
    contactType: "manual",
    createdAt: now,
    paid: true,
    status: "paid",
    manual: true,
    issuedBy: by ? String(by) : null,
    codes: [code],
  });

  db.codes[code] = {
    ticket: manualTicket.id,
    ticketName: manualTicket.name,
    contact: who,
    contactType: "manual",
    orderId,
    createdAt: now,
    paidRub: paid,
    deposit: dep,
    noDeposit: dep === 0,
    manual: true,
    issuedBy: by ? String(by) : null,
    test: false,
    used: false,
    usedAt: null,
    checks: 0,
    left: false,
    leftAt: null,
    spent: 0,
    spends: [],
  };
  save();
  return { code, deposit: dep, paidRub: paid, contact: who };
}

// Гость всё-таки заплатил за выданный вручную код — сумма идёт в кассу
export function setCashPaid(code, amount) {
  const c = db.codes[code];
  if (!c || !c.manual) return null;
  c.paidRub = Math.max(0, Math.round(Number(amount) || 0));
  const o = findOrder(c.orderId);
  if (o) o.total = c.paidRub;
  save();
  return c;
}

// Пометить код тестовым (или вернуть в статистику).
// Сам код из базы не удаляем — он просто перестаёт считаться где-либо:
// ни в проданных билетах, ни в выручке, ни в списках и остатках бара.
export function setTest(code, flag = true) {
  const c = db.codes[code];
  if (!c) return null;
  c.test = !!flag;
  const o = findOrder(c.orderId);
  if (o) o.test = !!flag;
  save();
  return c;
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
    .filter(([, c]) => c.used && !c.test)
    .map(([code, c]) => ({ code, ticket: c.ticket, ticketName: c.ticketName, contact: c.contact, usedAt: c.usedAt, deposit: c.deposit, noDeposit: c.noDeposit, paidRub: c.paidRub, manual: c.manual }))
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

// ---------- Бар: депозит гостя ----------
// Гость называет свой код, бармен списывает с него сумму заказа.
// Списывать можно только после прохода на входе и только в пределах депозита.

// Сколько на коде осталось денег на бар
export function balanceOf(c) {
  if (!c || c.noDeposit) return 0;
  return Math.max(0, (c.deposit ?? 0) - (c.spent ?? 0));
}

// Списать сумму с кода. by — кто списал (id бармена в Telegram), для истории.
export function spend(code, amount, by = null) {
  const c = db.codes[code];
  if (!c) return { ok: false, reason: "not_found" };
  if (c.noDeposit) return { ok: false, reason: "no_deposit", code: c };
  if (!c.used) return { ok: false, reason: "not_entered", code: c }; // сначала вход
  const sum = Math.round(Number(amount));
  if (!Number.isFinite(sum) || sum <= 0) return { ok: false, reason: "bad_amount", code: c };
  const left = balanceOf(c);
  if (left <= 0) return { ok: false, reason: "empty", code: c, left: 0 };
  if (sum > left) return { ok: false, reason: "too_much", code: c, left };

  c.spent = (c.spent || 0) + sum;
  if (!Array.isArray(c.spends)) c.spends = [];
  c.spends.push({ amount: sum, at: new Date().toISOString(), by: by ? String(by) : null });
  save();
  return { ok: true, code: c, amount: sum, left: balanceOf(c) };
}

// Отменить последнее списание по коду (бармен ошибся с суммой)
export function undoLastSpend(code) {
  const c = db.codes[code];
  if (!c) return { ok: false, reason: "not_found" };
  const last = (c.spends || []).pop();
  if (!last) return { ok: false, reason: "nothing_to_undo", code: c };
  c.spent = Math.max(0, (c.spent || 0) - last.amount);
  save();
  return { ok: true, code: c, amount: last.amount, left: balanceOf(c) };
}

// Гости внутри, у которых ещё остались деньги на баре (для списка бармену)
export function barList() {
  return Object.entries(db.codes)
    .filter(([, c]) => c.used && !c.left && !c.noDeposit && !c.test && balanceOf(c) > 0)
    .map(([code, c]) => ({ code, ticket: c.ticket, contact: c.contact, deposit: c.deposit, spent: c.spent || 0, left: balanceOf(c) }))
    .sort((a, b) => b.left - a.left);
}

// Последние списания по всем кодам, новые сверху
export function spendHistory(limit = 15) {
  const rows = [];
  for (const [code, c] of Object.entries(db.codes)) {
    if (c.test) continue;
    for (const s of c.spends || []) rows.push({ code, ticket: c.ticket, contact: c.contact, ...s, left: balanceOf(c) });
  }
  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

// Кто сейчас внутри: вошёл и ещё не ушёл (старые входы сверху)
export function insideList() {
  return Object.entries(db.codes)
    .filter(([, c]) => c.used && !c.left && !c.test)
    .map(([code, c]) => ({ code, ticket: c.ticket, contact: c.contact, usedAt: c.usedAt, deposit: c.deposit, noDeposit: c.noDeposit, paidRub: c.paidRub, manual: c.manual }))
    .sort((a, b) => new Date(a.usedAt) - new Date(b.usedAt));
}

// Сводные числа для статистики
export function counts() {
  const all = Object.values(db.codes);
  const vals = all.filter((c) => !c.test); // тестовые коды не считаем нигде
  const sold = vals.length;
  const entered = vals.filter((c) => c.used).length;
  const left = vals.filter((c) => c.left).length;
  // Бар: сколько депозитов уже проедено и сколько ещё осталось у тех, кто внутри
  const barSpent = vals.reduce((sum, c) => sum + (c.spent || 0), 0);
  const barLeftInside = vals
    .filter((c) => c.used && !c.left)
    .reduce((sum, c) => sum + balanceOf(c), 0);
  // Деньги. Выручка сайта — сколько реально заплатили за билеты (со скидками).
  // Коды, выданные вручную, в выручку сайта не идут: подарок — это 0 ₽,
  // а полученные за код наличные считаются отдельной строкой.
  const siteCodes = vals.filter((c) => !c.manual);
  const manualCodes = vals.filter((c) => c.manual);
  const money = (list) => list.reduce((sum, c) => sum + (c.paidRub || 0), 0);
  const deposits = (list) => list.reduce((sum, c) => sum + (c.noDeposit ? 0 : c.deposit || 0), 0);
  const revenue = money(siteCodes);
  const cash = money(manualCodes);
  return {
    sold, entered, left, inside: entered - left, notArrived: sold - entered,
    barSpent, barLeftInside,
    // деньги и выданные вручную коды
    soldSite: siteCodes.length, manualCount: manualCodes.length,
    revenue, cash, total: revenue + cash,
    manualDeposit: deposits(manualCodes),
    depositTotal: deposits(vals),
    testCount: all.length - vals.length,
  };
}
