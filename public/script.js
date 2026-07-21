// Состояние: сколько билетов каждого типа выбрано
const state = { tickets: [], cart: {}, currency: "RUB" };

const fmt = (n) =>
  new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// Загружаем данные мероприятия и билеты с сервера
async function init() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    state.tickets = data.tickets;
    state.currency = data.currency;
    renderTickets();
    renderFooter(data.event);
  } catch (e) {
    document.getElementById("tickets-grid").innerHTML =
      '<p class="tickets__loading">Не удалось загрузить билеты. Запусти сервер: npm start</p>';
  }
}

function renderTickets() {
  const grid = document.getElementById("tickets-grid");
  grid.innerHTML = "";
  state.tickets.forEach((t) => {
    state.cart[t.id] = 0;
    const card = document.createElement("div");
    card.className = "ticket" + (t.badge ? " ticket--featured" : "");
    card.innerHTML = `
      ${t.badge ? `<span class="ticket__badge">${t.badge}</span>` : ""}
      <h3 class="ticket__name">${t.name}</h3>
      <div class="ticket__price">${fmt(t.price)} <small>/ билет</small></div>
      <p class="ticket__desc">${t.description}</p>
      <div class="ticket__qty">
        <span>Количество</span>
        <div class="ticket__qty-controls">
          <button class="qty-btn" data-act="minus" data-id="${t.id}" aria-label="Убрать">−</button>
          <span class="qty-value" id="qty-${t.id}">0</span>
          <button class="qty-btn" data-act="plus" data-id="${t.id}" aria-label="Добавить">+</button>
        </div>
      </div>
      <button class="btn btn--full" data-buy="${t.id}">В корзину</button>
    `;
    grid.appendChild(card);
  });

  grid.addEventListener("click", onGridClick);
}

function onGridClick(e) {
  const qtyBtn = e.target.closest(".qty-btn");
  if (qtyBtn) {
    const id = qtyBtn.dataset.id;
    const delta = qtyBtn.dataset.act === "plus" ? 1 : -1;
    state.cart[id] = Math.max(0, Math.min(20, (state.cart[id] || 0) + delta));
    document.getElementById(`qty-${id}`).textContent = state.cart[id];
    return;
  }
  const buyBtn = e.target.closest("[data-buy]");
  if (buyBtn) {
    const id = buyBtn.dataset.buy;
    if (!state.cart[id]) state.cart[id] = 1;
    document.getElementById(`qty-${id}`).textContent = state.cart[id];
    openCart();
  }
}

function renderFooter(event) {
  document.getElementById("footer-info").textContent =
    `${event.date} · ${event.venue}`;

  // Проставляем ссылку на Telegram-группу в кнопки
  if (event.telegramUrl) {
    ["tg-hero", "tg-footer"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.href = event.telegramUrl;
    });
  }
}

/* ---------- Корзина ---------- */
const cartEl = document.getElementById("cart");

function cartItems() {
  return state.tickets
    .filter((t) => state.cart[t.id] > 0)
    .map((t) => ({ ...t, qty: state.cart[t.id] }));
}

function openCart() {
  const items = cartItems();
  const box = document.getElementById("cart-items");
  const errEl = document.getElementById("cart-error");
  errEl.hidden = true;

  if (items.length === 0) {
    box.innerHTML = '<p class="cart__empty">Выбери хотя бы один билет.</p>';
    document.getElementById("cart-total").textContent = fmt(0);
  } else {
    box.innerHTML = items
      .map(
        (i) => `
      <div class="cart__item">
        <div>
          <div class="cart__item-name">${i.name}</div>
          <div class="cart__item-sub">${fmt(i.price)} × ${i.qty}</div>
        </div>
        <strong>${fmt(i.price * i.qty)}</strong>
      </div>`
      )
      .join("");
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    document.getElementById("cart-total").textContent = fmt(total);
  }
  cartEl.hidden = false;
}

function closeCart() {
  cartEl.hidden = true;
}

cartEl.addEventListener("click", (e) => {
  if (e.target.dataset.close !== undefined) closeCart();
});

// Оплата
document.getElementById("cart-pay").addEventListener("click", async () => {
  const items = cartItems();
  const errEl = document.getElementById("cart-error");
  const email = document.getElementById("cart-email").value.trim();
  const payBtn = document.getElementById("cart-pay");

  const showError = (msg) => {
    errEl.textContent = msg;
    errEl.hidden = false;
  };

  if (items.length === 0) return showError("Выбери хотя бы один билет.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return showError("Введи корректный email — на него придёт билет.");

  payBtn.disabled = true;
  payBtn.textContent = "Создаём оплату…";
  errEl.hidden = true;

  try {
    const res = await fetch("/api/create-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        items: items.map((i) => ({ id: i.id, qty: i.qty })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Ошибка оплаты.");
    // Переход на страницу оплаты ЮKassa
    window.location.href = data.confirmationUrl;
  } catch (err) {
    showError(err.message);
    payBtn.disabled = false;
    payBtn.textContent = "Перейти к оплате";
  }
});

init();
