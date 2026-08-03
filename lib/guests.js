// База гостей: кто оставил контакт, кто дошёл до входа, а кто нет.
// Собирается из кодов (db.codes) — один человек = одна строка, даже если
// он брал коды несколько раз. Отдаётся файлом CSV для Excel.
import { getDb } from "./db.js";

// Телефоны приводим к +7…, ники — к нижнему регистру,
// иначе «89001234567» и «+7 900 123-45-67» станут двумя разными гостями.
export function normContact(contact = "", type = "") {
  const s = String(contact).trim();
  if (type === "phone") {
    const d = s.replace(/\D/g, "");
    if (d.length === 11 && (d[0] === "8" || d[0] === "7")) return "+7" + d.slice(1);
    if (d.length === 10) return "+7" + d;
    return s;
  }
  if (type === "telegram") return s.startsWith("@") ? s.toLowerCase() : "@" + s.toLowerCase();
  return s;
}

// filter: "all" — все, "came" — кто дошёл, "missed" — кто взял код и не пришёл.
// Тестовые коды не попадают в базу, как и везде в статистике.
export function guestList(filter = "all") {
  const db = getDb();
  const guests = new Map();

  for (const [code, c] of Object.entries(db.codes)) {
    if (c.test) continue;
    const contact = normContact(c.contact, c.contactType) || "(без контакта)";
    // Коды, выданные вручную, часто без имени — их не склеиваем в одну строку
    const key = c.contactType === "manual" ? `${contact}#${code}` : contact;

    let g = guests.get(key);
    if (!g) {
      g = {
        contact,
        type: c.contactType,
        tickets: new Set(),
        codes: [],
        total: 0,
        came: 0,
        first: c.createdAt,
        entered: null,
        paid: 0,
      };
      guests.set(key, g);
    }
    g.tickets.add(c.ticketName || c.ticket);
    g.codes.push(code + (c.used ? "✓" : "✗"));
    g.total++;
    g.paid += c.paidRub || 0;
    if (c.createdAt && c.createdAt < g.first) g.first = c.createdAt;
    if (c.used) {
      g.came++;
      if (!g.entered || c.usedAt > g.entered) g.entered = c.usedAt;
    }
  }

  const rows = [...guests.values()].sort((a, b) => (a.first < b.first ? -1 : 1));
  if (filter === "came") return rows.filter((g) => g.came > 0);
  if (filter === "missed") return rows.filter((g) => g.came === 0);
  return rows;
}

const TYPE_RU = { phone: "телефон", telegram: "телеграм", manual: "выдан вручную" };

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Телефон и ник заворачиваем в формулу-строку: иначе Excel съедает «+» и нули
function cell(value) {
  const s = String(value ?? "");
  if (/^[+@]/.test(s)) return `="${s}"`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV под Excel: BOM (иначе кириллица превратится в кракозябры),
// разделитель «;» (так Excel с русской локалью открывает файл сразу колонками).
export function guestsCsv(rows) {
  const head = [
    "Контакт", "Тип", "Пришёл", "Кодов взял", "Из них пришло",
    "Вариант", "Коды", "Оставил контакт", "Был на входе", "Заплатил, ₽",
  ];
  const lines = [head.join(";")];
  for (const g of rows) {
    const status = g.came === 0 ? "нет" : g.came === g.total ? "да" : `частично (${g.came} из ${g.total})`;
    lines.push([
      cell(g.contact),
      TYPE_RU[g.type] || g.type,
      status,
      g.total,
      g.came,
      cell([...g.tickets].join(", ")),
      cell(g.codes.join(" ")),
      fmtDate(g.first),
      fmtDate(g.entered),
      g.paid,
    ].join(";"));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function guestsSummary(rows) {
  return {
    people: rows.length,
    phones: rows.filter((g) => g.type === "phone").length,
    telegrams: rows.filter((g) => g.type === "telegram").length,
    codes: rows.reduce((s, g) => s + g.total, 0),
    came: rows.reduce((s, g) => s + g.came, 0),
    camepeople: rows.filter((g) => g.came > 0).length,
    missed: rows.filter((g) => g.came === 0).length,
  };
}
