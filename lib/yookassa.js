// Работа с API ЮKassa (https://yookassa.ru/developers/api).
// Авторизация — Basic Auth: shopId + секретный ключ из .env.
import crypto from "crypto";

const API = "https://api.yookassa.ru/v3";

function authHeader() {
  const creds = `${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`;
  return "Basic " + Buffer.from(creds).toString("base64");
}

// Создать платёж. Возвращает объект платежа ЮKassa,
// из него нужен confirmation.confirmation_url — туда отправляем покупателя.
export async function createPayment({ amountRub, description, returnUrl, metadata }) {
  const res = await fetch(`${API}/payments`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      "Idempotence-Key": crypto.randomUUID(), // защита от дублей при повторе запроса
    },
    body: JSON.stringify({
      amount: { value: amountRub.toFixed(2), currency: "RUB" },
      capture: true, // списать деньги сразу после оплаты
      confirmation: { type: "redirect", return_url: returnUrl },
      description,
      metadata, // сюда кладём orderId — вернётся в вебхуке
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("ЮKassa createPayment:", res.status, data);
    throw new Error(data.description || `ЮKassa: ошибка ${res.status}`);
  }
  return data;
}

// Запросить платёж по id. Вебхуку не доверяем на слово:
// статус всегда перепроверяем прямым запросом к ЮKassa.
export async function getPayment(paymentId) {
  const res = await fetch(`${API}/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("ЮKassa getPayment:", res.status, data);
    throw new Error(data.description || `ЮKassa: ошибка ${res.status}`);
  }
  return data;
}
