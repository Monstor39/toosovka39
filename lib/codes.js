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

// Уникальный код: existsFn(code) -> true, если код уже занят
export function makeUniqueCode(format, existsFn) {
  for (let attempt = 0; attempt < 100000; attempt++) {
    const code = makeCode(format);
    if (!existsFn(code)) return code;
  }
  throw new Error("Не удалось сгенерировать уникальный код (все комбинации заняты).");
}
