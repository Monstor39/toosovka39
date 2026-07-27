// Промокоды: поиск, проверка и расчёт цены со скидкой.
// Список самих промокодов живёт в config.js — здесь только логика.
// Цену всегда считает сервер: из браузера приходит только текст промокода.
import { promoCodes } from "../config.js";
import * as db from "./db.js";

// "  тут свои " → "ТУТСВОИ"
export function normalizeCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

// Раскладка клавиатуры: та же клавиша по-английски и по-русски.
// Промокод русскими буквами часто набирают, забыв переключить раскладку
// («ТУТСВОИ» → «NENCDJB») — такой ввод тоже принимаем.
const LAT_TO_CYR = new Map(
  Object.entries({
    Q: "Й", W: "Ц", E: "У", R: "К", T: "Е", Y: "Н", U: "Г", I: "Ш", O: "Щ", P: "З", "[": "Х", "]": "Ъ",
    A: "Ф", S: "Ы", D: "В", F: "А", G: "П", H: "Р", J: "О", K: "Л", L: "Д", ";": "Ж", "'": "Э",
    Z: "Я", X: "Ч", C: "С", V: "М", B: "И", N: "Т", M: "Ь", ",": "Б", ".": "Ю",
  })
);
const CYR_TO_LAT = new Map([...LAT_TO_CYR].map(([lat, cyr]) => [cyr, lat]));

// Транслит: «ТУТСВОИ» → «TUTSVOI» (так тоже пробуют писать)
const TRANSLIT = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "E", Ж: "ZH", З: "Z", И: "I",
  Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T",
  У: "U", Ф: "F", Х: "H", Ц: "TS", Ч: "CH", Ш: "SH", Щ: "SCH", Ъ: "", Ы: "Y",
  Ь: "", Э: "E", Ю: "YU", Я: "YA",
};

const map = (str, fn) => [...str].map(fn).join("");

// Все написания одного и того же промокода
function forms(raw) {
  const s = normalizeCode(raw);
  return new Set([
    s,
    map(s, (ch) => LAT_TO_CYR.get(ch) ?? ch),
    map(s, (ch) => CYR_TO_LAT.get(ch) ?? ch),
    map(s, (ch) => TRANSLIT[ch] ?? ch),
  ]);
}

// Найти активный промокод по введённому тексту (регистр, пробелы,
// раскладка и транслит значения не имеют)
export function findPromo(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  const typed = forms(code);
  return (
    promoCodes.find((p) => {
      if (p.active === false) return false;
      const real = forms(p.code);
      return [...typed].some((f) => f && real.has(f));
    }) || null
  );
}

// Действует ли промокод на этот билет (пустой список tickets — на все)
function appliesTo(promo, ticketId) {
  if (!promo.tickets || promo.tickets.length === 0) return true;
  return promo.tickets.includes(ticketId);
}

// Есть ли хоть один живой промокод на этот билет —
// витрина по этому флагу решает, показывать ли поле ввода.
export function hasPromoFor(ticketId) {
  return promoCodes.some(
    (p) =>
      p.active !== false &&
      appliesTo(p, ticketId) &&
      !(p.maxUses && db.promoUses(p.code) >= p.maxUses)
  );
}

// Цена одного билета со скидкой (не ниже нуля, до целых рублей)
function discountedPrice(ticket, promo) {
  let price = ticket.price;
  if (promo.percent) price -= (ticket.price * promo.percent) / 100;
  if (promo.rub) price -= promo.rub;
  return Math.max(0, Math.round(price));
}

// Полная проверка. Успех: { ok: true, code, unitPrice, discountPerTicket }
// Ошибка:  { ok: false, error: "текст для покупателя" }
export function checkPromo(rawCode, ticket) {
  const promo = findPromo(rawCode);
  if (!promo) return { ok: false, error: "Такого промокода нет." };
  if (!appliesTo(promo, ticket.id))
    return { ok: false, error: `Промокод не действует на «${ticket.name}».` };
  if (promo.maxUses && db.promoUses(promo.code) >= promo.maxUses)
    return { ok: false, error: "Этот промокод уже закончился." };

  const unitPrice = discountedPrice(ticket, promo);
  if (unitPrice >= ticket.price)
    return { ok: false, error: "Промокод не даёт скидки на этот билет." };

  return {
    ok: true,
    code: normalizeCode(promo.code),
    unitPrice,
    discountPerTicket: ticket.price - unitPrice,
  };
}
