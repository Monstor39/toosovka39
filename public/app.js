const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// promo — применённый промокод: { code, unitPrice, discountPerTicket, ... } с сервера
const state = { tickets: [], current: null, qty: 1, promo: null };

const $ = (id) => document.getElementById(id);

async function init() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    state.tickets = data.tickets;
    renderTickets();
  } catch (e) {
    $("tickets-grid").innerHTML =
      '<p class="tickets__loading">Не удалось загрузить билеты. Запусти сервер (Запустить сайт.bat).</p>';
  }
}

function renderTickets() {
  const grid = $("tickets-grid");
  grid.innerHTML = "";
  state.tickets.forEach((t) => {
    const card = document.createElement(t.soldOut ? "div" : "button");
    card.className = "ticket" + (t.badge ? " ticket--vip" : "") + (t.soldOut ? " ticket--soldout" : "");
    card.innerHTML = `
      ${t.badge ? `<span class="ticket__badge">${t.badge}</span>` : ""}
      <h2 class="ticket__name">${t.name}</h2>
      <div class="ticket__price">${t.priceLabel}</div>
      <p class="ticket__desc">${t.description}</p>
      ${
        t.soldOut
          ? `<div class="ticket__soldout">${t.soldOutText}</div>`
          : `<div class="ticket__cta">Купить →</div>`
      }`;
    if (!t.soldOut) card.addEventListener("click", () => openModal(t));
    grid.appendChild(card);
  });
}

/* ---------- Модалка ---------- */
const modal = $("modal");

function openModal(ticket) {
  state.current = ticket;
  state.qty = 1;
  resetPromo(); // при открытии окна промокод всегда чистый

  $("promo-box").hidden = !ticket.promoEnabled;
  $("step-buy").hidden = false;
  $("step-success").hidden = true;
  $("m-error").hidden = true;

  const badge = $("m-badge");
  if (ticket.badge) { badge.textContent = ticket.badge; badge.hidden = false; }
  else badge.hidden = true;

  $("m-name").textContent = ticket.name;
  $("m-desc").textContent = ticket.description;
  $("f-contact").value = "";
  // remaining === null — билет без ограничения по количеству
  $("m-note").textContent =
    ticket.remaining !== null && ticket.remaining <= 10 ? `Осталось ${ticket.remaining} шт.` : "";
  updateQty();
  modal.hidden = false;
  document.body.classList.add("no-scroll");
}

function closeModal() {
  modal.hidden = true;
  document.body.classList.remove("no-scroll");
}

function updateQty() {
  const t = state.current;
  const max = t.remaining === null ? 20 : Math.min(20, t.remaining);
  state.qty = Math.max(1, Math.min(max, state.qty));
  $("qty-value").textContent = state.qty;
  updateTotal();
}

// Цена за один билет: со скидкой, если применён промокод
function unitPrice() {
  return state.promo ? state.promo.unitPrice : state.current.price;
}

// Надпись на кнопке: бесплатный билет по промокоду оплачивать нечем
function payLabel() {
  return unitPrice() * state.qty === 0 ? "Получить билет" : "Оплатить";
}

function updateTotal() {
  const t = state.current;
  const total = unitPrice() * state.qty;
  const totalText = total === 0 ? "бесплатно" : fmt(total);

  // С промокодом старую цену зачёркиваем и рядом показываем новую
  if (state.promo) {
    $("m-price").innerHTML =
      `<s class="old-price">${t.priceLabel}</s> <span class="new-price">${fmt(state.promo.unitPrice)}</span>`;
    $("m-total").innerHTML =
      `<s class="old-price">${fmt(t.price * state.qty)}</s> <span class="new-price">${totalText}</span>`;
  } else {
    $("m-price").textContent = t.priceLabel;
    $("m-total").textContent = totalText;
  }

  const disc = $("m-discount");
  if (state.promo) {
    $("m-discount-value").textContent = "−" + fmt(state.promo.discountPerTicket * state.qty);
    disc.hidden = false;
  } else {
    disc.hidden = true;
  }
  $("pay-btn").textContent = payLabel();
}

$("qty-minus").addEventListener("click", () => { state.qty--; updateQty(); });
$("qty-plus").addEventListener("click", () => { state.qty++; updateQty(); });

/* ---------- Промокод ---------- */
function promoMsg(text, ok) {
  const el = $("promo-msg");
  el.textContent = text;
  el.className = "promo__msg" + (ok ? " promo__msg--ok" : " promo__msg--err");
  el.hidden = false;
}

// Снять промокод и вернуть поле в исходное состояние
function resetPromo() {
  state.promo = null;
  $("f-promo").value = "";
  $("f-promo").readOnly = false;
  $("promo-btn").textContent = "Применить";
  $("promo-msg").hidden = true;
  if (state.current) updateTotal();
}

async function applyPromo() {
  const code = $("f-promo").value.trim();
  if (!code) return promoMsg("Введи промокод.", false);

  const btn = $("promo-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId: state.current.id, code }),
    });
    const data = await res.json();
    if (!res.ok) {
      state.promo = null;
      promoMsg(data.error || "Промокод не подошёл.", false);
    } else {
      state.promo = data;
      $("f-promo").value = data.code;
      $("f-promo").readOnly = true;
      btn.textContent = "Убрать";
      promoMsg(`Промокод применён — билет за ${data.unitPriceLabel}`, true);
    }
  } catch (e) {
    state.promo = null;
    promoMsg("Не получилось проверить промокод. Попробуй ещё раз.", false);
  } finally {
    btn.disabled = false;
    updateTotal();
  }
}

$("promo-btn").addEventListener("click", () => {
  if (state.promo) resetPromo(); // кнопка работает как «Убрать»
  else applyPromo();
});

$("f-promo").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); if (!state.promo) applyPromo(); }
});

modal.addEventListener("click", (e) => {
  if (e.target.dataset.close !== undefined) closeModal();
});

/* ---------- Оплата ---------- */
$("pay-btn").addEventListener("click", async () => {
  const err = $("m-error");
  const showErr = (m) => { err.textContent = m; err.hidden = false; };

  const contact = $("f-contact").value.trim();

  // Телефон (только цифры/+) или Telegram (есть буквы)
  const isTelegram = /[a-zA-Z]/.test(contact);
  if (isTelegram) {
    if (contact.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "").length < 3)
      return showErr("Укажи корректный Telegram (например @nickname).");
  } else {
    if (contact.replace(/\D/g, "").length < 10)
      return showErr("Укажи телефон (например +7 900 000-00-00) или Telegram (@nickname).");
  }

  const btn = $("pay-btn");
  btn.disabled = true;
  btn.textContent = "Обрабатываем…";
  err.hidden = true;

  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticketId: state.current.id,
        qty: state.qty,
        contact,
        promo: state.promo ? state.promo.code : null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      // Промокод протух между «Применить» и оплатой (закончился, выключили) —
      // снимаем его, чтобы человек мог оплатить по обычной цене.
      if (data.promoError) { resetPromo(); promoMsg(data.error, false); }
      throw new Error(data.error || "Не удалось оформить.");
    }

    // Цель для Яндекс.Метрики: начал оплату (для воронки визит → оплата → покупка)
    if (typeof ym === "function") ym(110941103, "reachGoal", "checkout");

    // Боевой режим: сервер вернул ссылку на оплату ЮKassa — уходим туда.
    // После оплаты ЮKassa вернёт на success.html, там покажем коды.
    if (data.paymentUrl) {
      window.location.href = data.paymentUrl;
      return;
    }

    showSuccess(data.order);
    // обновим остатки
    init();
  } catch (e) {
    showErr(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = payLabel();
  }
});

function showSuccess(order) {
  // Билет по промокоду может быть бесплатным — тогда оплаты нет и на success.html
  // человек не попадает, поэтому цель «покупка» отмечаем здесь.
  if (typeof ym === "function") ym(110941103, "reachGoal", "purchase");

  $("step-buy").hidden = true;
  $("step-success").hidden = false;
  $("s-sub").textContent = `${order.ticketName} × ${order.qty} · ${order.totalLabel}`;
  $("s-codes").innerHTML = order.codes
    .map((c) => `<div class="code">${c}</div>`)
    .join("");
}

$("done-btn").addEventListener("click", closeModal);

init();
