// Отправка уведомления тебе в Telegram через твоего бота.
// Нужны переменные окружения:
//   TELEGRAM_BOT_TOKEN     — токен бота от @BotFather
//   TELEGRAM_ADMIN_CHAT_ID — твой числовой Telegram ID (узнать: @userinfobot)

export async function notifyAdmin(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.log("\n[Telegram не настроен — уведомление в консоль]\n" + text + "\n");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram API ошибка:", err);
    }
  } catch (e) {
    console.error("Не удалось отправить в Telegram:", e.message);
  }
}
