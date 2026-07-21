const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

const state = { tickets: [], current: null, qty: 1 };

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
  $("m-note").textContent =
    ticket.remaining <= 10 ? `Осталось ${ticket.remaining} шт.` : "";
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
  const max = Math.min(20, t.remaining);
  state.qty = Math.max(1, Math.min(max, state.qty));
  $("qty-value").textContent = state.qty;
  $("m-total").textContent = fmt(t.price * state.qty);
}

$("qty-minus").addEventListener("click", () => { state.qty--; updateQty(); });
$("qty-plus").addEventListener("click", () => { state.qty++; updateQty(); });

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
      body: JSON.stringify({ ticketId: state.current.id, qty: state.qty, contact }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Не удалось оформить.");
    showSuccess(data.order);
    // обновим остатки
    init();
  } catch (e) {
    showErr(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Оплатить";
  }
});

function showSuccess(order) {
  $("step-buy").hidden = true;
  $("step-success").hidden = false;
  $("s-sub").textContent = `${order.ticketName} × ${order.qty} · ${order.totalLabel}`;
  $("s-codes").innerHTML = order.codes
    .map((c) => `<div class="code">${c}</div>`)
    .join("");
}

$("done-btn").addEventListener("click", closeModal);

init();
