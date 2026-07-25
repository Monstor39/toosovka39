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
    priceLabel: "депозит 1 200 ₽",
    description:
      "Твои 1 200 ₽ — это депозит: всю сумму тратишь на баре. По сути вход бесплатный. Вход строго по билету.",
    badge: null,
    codeFormat: { letters: 1, digits: 2 }, // например A42
    soldOutText: "Билеты закончились — вход по факту",
  },
  {
    id: "vip",
    name: "VIP-столик",
    price: 10000, // депозит целиком уходит на бар/кальян за столиком
    limit: 4,
    priceLabel: "депозит 10 000 ₽",
    description:
      "Свой столик до 4 человек. Депозит 10 000 ₽ тратите за столиком на бар и кальян. Вход строго по билету.",
    badge: "VIP",
    codeFormat: { letters: 2, digits: 2 }, // например AB42
    soldOutText: "VIP-столики закончились",
  },
];

export const ticketById = Object.fromEntries(tickets.map((t) => [t.id, t]));

// Тест-режим: оплата имитируется (код выдаётся сразу).
// Станет false автоматически, когда впишешь ключи ЮKassa в .env.
export const TEST_MODE = !process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY;
