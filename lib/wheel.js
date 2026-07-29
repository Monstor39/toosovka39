// Колесо «Крейзи Дубай»: скидка на депозитные билеты.
// Правила: один прокрут с одного IP; выигрыш живёт 15 минут (config.wheel.ttlMinutes),
// не купил за это время — скидка сгорает навсегда и крутить больше нельзя.
// Всё решает сервер: браузер только рисует анимацию по индексу сектора,
// который выбрал сервер, и цену со скидкой сервер пересчитывает сам при оплате.
import { wheel } from "../config.js";
import * as db from "./db.js";

const TTL_MS = () => wheel.ttlMinutes * 60 * 1000;

// Ключ клиента. Обычно это IP (правило «1 IP — 1 прокрут»).
// Если IP определить нельзя (локальная разработка или nginx не передал
// X-Forwarded-For — тогда у всех был бы один и тот же 127.0.0.1),
// подстраховываемся идентификатором из браузера, чтобы колесо не заклинило на всех сразу.
export function clientKey(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const local = !raw || raw === "::1" || raw === "127.0.0.1" || raw.startsWith("192.168.") || raw.startsWith("10.");
  if (!local) return "ip:" + raw;
  const cid = String(req.body?.cid || req.query?.cid || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  return cid ? "cid:" + cid : "ip:" + (raw || "unknown");
}

// Секторы для витрины — наружу отдаём только проценты, веса это наша кухня
export function publicSectors() {
  return wheel.sectors.map((s) => ({ percent: s.percent }));
}

// Взвешенный розыгрыш сектора
function pickSector() {
  const total = wheel.sectors.reduce((sum, s) => sum + (s.weight || 1), 0);
  let r = Math.random() * total;
  for (let i = 0; i < wheel.sectors.length; i++) {
    r -= wheel.sectors[i].weight || 1;
    if (r < 0) return i;
  }
  return wheel.sectors.length - 1;
}

// Живая (ещё не сгоревшая и не потраченная) скидка этого клиента
export function activeSpin(key) {
  const spin = db.getSpin(key);
  if (!spin || spin.used) return null;
  if (new Date(spin.expiresAt).getTime() <= Date.now()) return null;
  return spin;
}

// Что показывать на сайте:
//   available — можно крутить
//   active    — скидка выиграна и ещё действует
//   burned    — крутил, скидку не использовал вовремя (или уже купил): всё, больше нельзя
export function state(key) {
  if (!wheel.enabled) return { state: "off" };
  const spin = db.getSpin(key);
  if (!spin) return { state: "available", sectors: publicSectors(), ttlMinutes: wheel.ttlMinutes };

  const msLeft = new Date(spin.expiresAt).getTime() - Date.now();
  if (!spin.used && msLeft > 0) {
    return {
      state: "active",
      sectors: publicSectors(),
      index: spin.index,
      percent: spin.percent,
      msLeft,
      tickets: wheel.tickets,
    };
  }
  return { state: "burned", sectors: publicSectors(), index: spin.index, percent: spin.percent, used: !!spin.used };
}

// Крутим. Если этот IP уже крутил — второй раз не даём.
export function spin(key) {
  if (!wheel.enabled) return { ok: false, error: "Колесо сейчас выключено." };
  if (db.getSpin(key))
    return { ok: false, error: "Колесо крутится один раз: твоё устройство мы видим по IP, повторный прокрут невозможен." };

  const index = pickSector();
  const record = {
    key,
    index,
    percent: wheel.sectors[index].percent,
    spunAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TTL_MS()).toISOString(),
    used: false,
    orderId: null,
  };
  db.saveSpin(key, record);
  return { ok: true, index, percent: record.percent, msLeft: TTL_MS(), tickets: wheel.tickets, ttlMinutes: wheel.ttlMinutes };
}

// Действует ли скидка колеса на этот билет
export function appliesTo(ticket) {
  if (!wheel.enabled || !ticket || ticket.noPromo) return false;
  return !wheel.tickets?.length || wheel.tickets.includes(ticket.id);
}

// Цена билета со скидкой колеса. Скидка режет и цену, и депозит на баре:
// 50% с обычного билета — платишь 600 ₽ и на баре у тебя тоже 600 ₽.
export function priceWith(ticket, percent) {
  return Math.max(0, Math.round(ticket.price - (ticket.price * percent) / 100));
}

// Скидка клиента на конкретный билет: { percent, unitPrice } или null
export function discountFor(key, ticket) {
  if (!appliesTo(ticket)) return null;
  const spin = activeSpin(key);
  if (!spin) return null;
  return { percent: spin.percent, unitPrice: priceWith(ticket, spin.percent), expiresAt: spin.expiresAt };
}
