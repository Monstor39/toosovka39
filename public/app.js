const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

const state = {
  tickets: [],
  current: null,
  qty: 1,
};

const $ = (id) => document.getElementById(id);

async function init() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    state.tickets = data.tickets;
    renderTickets();
    renderSticky();
  } catch (e) {
    $("tickets-grid").innerHTML =
      '<p class="tickets__loading">Не удалось загрузить страницу. Запусти сервер (Запустить сайт.bat).</p>';
  }
}

/* ---------- Карточки ---------- */

function renderTickets() {
  const grid = $("tickets-grid");
  grid.innerHTML = "";
  state.tickets.forEach((t) => {
    const card = document.createElement(t.soldOut ? "div" : "button");

    card.className =
      "ticket" +
      (t.badge === "СТОЛ" ? " ticket--vip" : "") +
      (t.free ? " ticket--free" : "") +
      (t.soldOut ? " ticket--soldout" : "");

    // Короткая выгода под ценой — понятнее, чем длинное описание
    const hint = t.hasDeposit
      ? `<p class="ticket__hint">Вся сумма вернётся к тебе баром</p>`
      : `<p class="ticket__hint ticket__hint--plain">Платить не нужно — только анкета</p>`;

    card.innerHTML = `
      ${t.badge ? `<span class="ticket__badge">${t.badge}</span>` : ""}
      <h2 class="ticket__name">${t.name}</h2>
      <div class="ticket__price">${t.priceLabel}</div>
      ${hint}
      <p class="ticket__desc">${t.description}</p>
      ${t.remaining !== null && t.remaining <= 10 && !t.soldOut ? `<p class="ticket__left">Осталось ${t.remaining} шт.</p>` : ""}
      ${
        t.soldOut
          ? `<div class="ticket__soldout">${t.soldOutText}</div>`
          : `<div class="ticket__cta">${t.free ? "Заполнить анкету →" : "Забронировать →"}</div>`
      }`;
    if (!t.soldOut) card.addEventListener("click", () => openModal(t));
    grid.appendChild(card);
  });
}

/* ---------- Кнопки-«прокрутки» и липкая панель ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-scroll]");
  if (!el) return;
  const target = $(el.dataset.scroll);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
});

const sticky = $("sticky");

function renderSticky() {
  if (!state.tickets.length) return;
  const live = state.tickets.filter((t) => !t.soldOut);
  if (!live.length) return;

  const free = live.find((t) => t.free);
  $("sticky-price").textContent = free ? "Вход бесплатный" : `Стол от ${fmt(Math.min(...live.map((t) => t.price)))}`;
  sticky.hidden = false;
}

// Панель выезжает, когда первый экран пролистан, и прячется, когда открыта анкета
function updateSticky() {
  const show = window.scrollY > 420 && modal.hidden && state.tickets.length > 0;
  sticky.classList.toggle("sticky--on", show);
}
window.addEventListener("scroll", updateSticky, { passive: true });

/* ---------- Модалка ---------- */
const modal = $("modal");

function openModal(ticket) {
  state.current = ticket;
  state.qty = 1;

  $("step-buy").hidden = false;
  $("step-success").hidden = true;
  $("m-error").hidden = true;

  const badge = $("m-badge");
  if (ticket.badge) { badge.textContent = ticket.badge; badge.hidden = false; }
  else badge.hidden = true;

  $("m-name").textContent = ticket.name;
  $("m-price").textContent = ticket.priceLabel;
  $("m-desc").textContent = ticket.description;
  $("f-contact").value = "";
  // remaining === null — вариант без ограничения по количеству
  $("m-note").textContent =
    ticket.remaining !== null && ticket.remaining <= 10 ? `Осталось ${ticket.remaining} шт.` : "";

  // Депозит: у бесплатного входа его нет, пишем честно
  $("m-deposit-box").innerHTML = ticket.hasDeposit
    ? "💸 Эта сумма — <b>ваш депозит</b>: вы тратите её за столом на баре."
    : "🎫 Вход <b>бесплатный</b>: анкета нужна, чтобы внести вас в базу гостей. Бар оплачивается отдельно.";

  updateQty();
  modal.hidden = false;
  updateSticky();
  document.body.classList.add("no-scroll");
}

function closeModal() {
  modal.hidden = true;
  document.body.classList.remove("no-scroll");
  updateSticky();
}

function updateQty() {
  const t = state.current;
  const max = t.remaining === null ? t.maxQty : Math.min(t.maxQty, t.remaining);
  state.qty = Math.max(1, Math.min(max, state.qty));
  $("qty-value").textContent = state.qty;
  updateTotal();
}

// Надпись на кнопке: бесплатный вход оплачивать нечем
function payLabel() {
  return state.current && state.current.free ? "Получить код" : "Оплатить";
}

function updateTotal() {
  const total = state.current.price * state.qty;
  $("m-total").textContent = total === 0 ? "бесплатно" : fmt(total);
  $("pay-btn").textContent = payLabel();
}

$("qty-minus").addEventListener("click", () => { state.qty--; updateQty(); });
$("qty-plus").addEventListener("click", () => { state.qty++; updateQty(); });

modal.addEventListener("click", (e) => {
  if (e.target.dataset.close !== undefined) closeModal();
});

/* ---------- Отправка анкеты ---------- */
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
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Не удалось оформить.");

    // Цель для Яндекс.Метрики: отправил анкету / начал оплату стола
    if (typeof ym === "function") ym(110941103, "reachGoal", "checkout");

    // Стол: сервер вернул ссылку на оплату ЮKassa — уходим туда.
    // После оплаты ЮKassa вернёт на success.html, там покажем коды.
    if (data.paymentUrl) {
      window.location.href = data.paymentUrl;
      return;
    }

    showSuccess(data.order);
    init(); // обновим остатки столов
  } catch (e) {
    showErr(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = payLabel();
  }
});

function showSuccess(order) {
  // Бесплатный вход оплаты не проходит и на success.html человек не попадает,
  // поэтому цель «покупка» отмечаем здесь.
  if (typeof ym === "function") ym(110941103, "reachGoal", "purchase");

  $("step-buy").hidden = true;
  $("step-success").hidden = false;
  $("s-title").textContent = order.hasDeposit ? "Стол за вами!" : "Ты в списке!";
  $("s-sub").textContent = `${order.ticketName} × ${order.qty} · ${order.totalLabel}`;
  $("s-info").innerHTML = order.hasDeposit
    ? "Это ваш пропуск на <b>DUBAI PARTY</b>. Оплаченная сумма — <b>ваш депозит</b>, потратите её за столом на баре. По указанному контакту мы сможем связаться, чтобы не потеряться."
    : "Это ваш пропуск на <b>DUBAI PARTY</b> сегодня вечером. Вход бесплатный, бар оплачивается отдельно. По указанному контакту мы сможем связаться, чтобы не потеряться.";
  $("s-codes").innerHTML = order.codes
    .map((c) => `<div class="code">${c}</div>`)
    .join("");
}

$("done-btn").addEventListener("click", closeModal);

init();
