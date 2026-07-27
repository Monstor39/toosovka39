// Генерация уникальных кодов билетов.
// Буквы без похожих (без I и O), цифры 0-9.

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // исключены I, O
const DIGITS = "0123456789";

function pick(str) {
  return str[Math.floor(Math.random() * str.length)];
}

// Один код по формату { letters, digits }
export function makeCode(format) {
  let s = "";
  for (let i = 0; i < format.letters; i++) s += pick(LETTERS);
  for (let i = 0; i < format.digits; i++) s += pick(DIGITS);
  return s;
}

// Уникальный код: existsFn(code) -> true, если код уже занят.
// Билеты продаются без ограничения по количеству, а коротких кодов конечное
// число (1 буква + 2 цифры = 2400). Когда они начнут заканчиваться — добавляем
// к коду ещё одну цифру, чтобы продажи не встали и оплаченный билет не остался
// без кода. Старые короткие коды при этом продолжают работать.
export function makeUniqueCode(format, existsFn) {
  for (let extra = 0; extra <= 4; extra++) {
    const wide = { letters: format.letters, digits: format.digits + extra };
    for (let attempt = 0; attempt < 5000; attempt++) {
      const code = makeCode(wide);
      if (!existsFn(code)) return code;
    }
  }
  throw new Error("Не удалось сгенерировать уникальный код (все комбинации заняты).");
}
