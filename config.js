// ============================================================
//  НАСТРОЙКИ МЕРОПРИЯТИЯ, БИЛЕТОВ, ЛИМИТОВ И КОДОВ
//  Меняй значения здесь.
// ============================================================

export const event = {
  title: "DUBAI PARTY",
  date: "1 августа",
  venue: "Правая Набережная 21, Калининград",
  telegram: "@TOOSOVKA39",
  telegramUrl: "https://t.me/TOOSOVKA39",
  instagram: "@imgolod",
  instagramUrl: "https://instagram.com/imgolod",
};

// Валюта ЮKassa — рубли
export const currency = "RUB";

// Билеты. limit — сколько всего можно продать этого типа.
// codeFormat — формат уникального кода: letters букв + digits цифр.
export const tickets = [
  {
    id: "standard",
    name: "Обычный билет",
    price: 1200,
    limit: 300,
    description: "Вход по билету на вечеринку DUBAI PARTY.",
    badge: null,
    codeFormat: { letters: 1, digits: 2 }, // например A42
    soldOutText: "Билеты закончились — вход по факту",
  },
  {
    id: "vip",
    name: "VIP-столик",
    price: 10000, // депозит: 4 000 ₽ — вход, 6 000 ₽ — на алкоголь/кальян
    limit: 4,
    priceLabel: "депозит 10 000 ₽",
    description:
      "Столик до 4 человек. Из депозита 4 000 ₽ — вход, а 6 000 ₽ можно потратить за столиком на алкоголь или кальян.",
    badge: "VIP",
    codeFormat: { letters: 2, digits: 2 }, // например AB42
    soldOutText: "VIP-столики закончились",
  },
];

export const ticketById = Object.fromEntries(tickets.map((t) => [t.id, t]));

// Тест-режим: оплата имитируется (код выдаётся сразу).
// Станет false автоматически, когда впишешь ключи ЮKassa в .env.
export const TEST_MODE = !process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY;
