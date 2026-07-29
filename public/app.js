const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n) + " ₽";

// promo — применённый промокод: { code, unitPrice, discountPerTicket, ... } с сервера
// wheel — состояние колеса «Крейзи Дубай» с сервера: { state, sectors, index, percent, msLeft }
const state = {
  tickets: [],
  current: null,
  qty: 1,
  promo: null,
  wheel: null,
  wheelEndsAt: 0, // когда сгорит скидка (метка времени браузера)
  spinning: false, // колесо крутится прямо сейчас — не трогаем его перерисовкой
};

const $ = (id) => document.getElementById(id);

// Идентификатор браузера: нужен на локальной разработке, где у всех один IP.
// На бою правило «один прокрут» держится на IP, этот cid — подстраховка.
function clientId() {
  try {
    let id = localStorage.getItem("dubai-cid");
    if (!id) {
      id = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/[^a-zA-Z0-9-]/g, "");
      localStorage.setItem("dubai-cid", id);
    }
    return id;
  } catch (e) {
    return ""; // приватный режим — обойдёмся одним IP
  }
}
const CID = clientId();

async function init() {
  try {
    const res = await fetch("/api/status?cid=" + encodeURIComponent(CID));
    const data = await res.json();
    state.tickets = data.tickets;
    applyWheelState(data.wheel);
    renderTickets();
    renderSticky();
  } catch (e) {
    $("tickets-grid").innerHTML =
      '<p class="tickets__loading">Не удалось загрузить билеты. Запусти сервер (Запустить сайт.bat).</p>';
  }
}

/* ---------- Билеты ---------- */

// Цена билета со скидкой колеса — считается так же, как на сервере
function wheelPrice(ticket, percent) {
  return Math.max(0, Math.round(ticket.price - (ticket.price * percent) / 100));
}

// Действует ли на этот билет живая скидка колеса (иначе null)
function wheelPercentFor(ticket) {
  if (!ticket || !ticket.wheelEligible) return null;
  if (!state.wheel || state.wheel.state !== "active") return null;
  return state.wheel.percent;
}

function renderTickets() {
  const grid = $("tickets-grid");
  grid.innerHTML = "";
  state.tickets.forEach((t) => {
    const card = document.createElement(t.soldOut ? "div" : "button");
    const pct = wheelPercentFor(t);
    const newPrice = pct ? wheelPrice(t, pct) : null;

    card.className =
      "ticket" +
      (t.badge === "VIP" ? " ticket--vip" : "") +
      (pct ? " ticket--hot" : "") +
      (t.soldOut ? " ticket--soldout" : "");

    // Со скидкой колеса старую цену зачёркиваем и рядом показываем новую
    const priceHtml = pct
      ? `<s class="old-price">${t.priceLabel}</s><span class="new-price">${fmt(newPrice)}</span>`
      : t.priceLabel;

    // Короткая выгода под ценой — понятнее, чем длинное описание
    const hint = t.hasDeposit
      ? `<p class="ticket__hint">💸 Вся сумма вернётся к тебе баром</p>`
      : `<p class="ticket__hint ticket__hint--plain">Просто вход, бар оплачивается отдельно</p>`;

    card.innerHTML = `
      ${t.badge ? `<span class="ticket__badge">${t.badge}</span>` : ""}
      <h2 class="ticket__name">${t.name}</h2>
      <div class="ticket__price">${priceHtml}</div>
      ${pct ? `<span class="ticket__save">−${pct}% · экономия ${fmt(t.price - newPrice)}</span>` : ""}
      ${hint}
      <p class="ticket__desc">${t.description}</p>
      ${t.remaining !== null && t.remaining <= 10 && !t.soldOut ? `<p class="ticket__left">Осталось ${t.remaining} шт.</p>` : ""}
      ${
        t.soldOut
          ? `<div class="ticket__soldout">${t.soldOutText}</div>`
          : `<div class="ticket__cta">Купить →</div>`
      }`;
    if (!t.soldOut) card.addEventListener("click", () => openModal(t));
    grid.appendChild(card);
  });
}

/* ---------- Колесо «Крейзи Дубай» ---------- */
const wheelSec = $("wheelsec");
const disc = $("wheel-disc");
const goBtn = $("wheel-go");
let discAngle = 0; // текущий угол диска (растёт, чтобы крутить всегда вперёд)

// Цвета секторов чередуются: светлый золотой / тёмный «инстаграмный»
const SECTOR_LIGHT = "rgba(255, 226, 160, 0.92)";
const SECTOR_DARK = "rgba(150, 47, 191, 0.85)";

function drawWheel(sectors) {
  const step = 360 / sectors.length;
  const stops = sectors
    .map((s, i) => `${i % 2 ? SECTOR_DARK : SECTOR_LIGHT} ${i * step}deg ${(i + 1) * step}deg`)
    .join(", ");
  disc.style.background = `conic-gradient(${stops})`;
  disc.innerHTML = sectors
    .map((s, i) => {
      const a = i * step + step / 2;
      // В нижней половине колеса метку переворачиваем, чтобы проценты читались
      const flip = a > 90 && a < 270;
      const cls = `wheel__label${i % 2 ? " wheel__label--top" : ""}${flip ? " wheel__label--flip" : ""}`;
      return `<span class="${cls}" style="--a:${flip ? a + 180 : a}deg">−${s.percent}%</span>`;
    })
    .join("");
}

// Угол, при котором сектор index встаёт под стрелку (стрелка сверху)
function angleFor(index, count) {
  const step = 360 / count;
  return -(index * step + step / 2);
}

// Поставить колесо на сектор: animate=false — мгновенно (при загрузке страницы)
function setSector(index, count, animate) {
  const target = angleFor(index, count);
  if (!animate) {
    disc.style.transition = "none";
    discAngle = target;
    disc.style.transform = `rotate(${target}deg)`;
    void disc.offsetWidth; // сброс, чтобы вернуть плавность
    disc.style.transition = "";
    return;
  }
  let next = target;
  while (next < discAngle + 360 * 6) next += 360; // минимум 6 оборотов вперёд
  discAngle = next;
  disc.style.transform = `rotate(${next}deg)`;
}

// Разложить состояние с сервера по экрану
function applyWheelState(w) {
  state.wheel = w || null;
  if (!w || w.state === "off") {
    wheelSec.hidden = true;
    return;
  }
  wheelSec.hidden = false;
  if (state.spinning) return; // идёт анимация — не мешаем

  drawWheel(w.sectors);

  if (w.state === "active") {
    state.wheelEndsAt = Date.now() + w.msLeft;
    setSector(w.index, w.sectors.length, false);
    showWin(w.percent);
  } else if (w.state === "burned") {
    setSector(w.index, w.sectors.length, false);
    showDead(w.used);
  } else {
    // available — колесо ждёт первого прокрута
    $("wheel-result").hidden = true;
    $("wheel-dead").hidden = true;
    goBtn.disabled = false;
  }
}

function showWin(percent) {
  $("wheel-percent").textContent = "−" + percent + "%";
  $("wheel-result").hidden = false;
  $("wheel-dead").hidden = true;
  goBtn.disabled = true;
  tickTimer();
}

function showDead(used) {
  $("wheel-result").hidden = true;
  $("wheel-dead").hidden = false;
  goBtn.disabled = true;
  $("wheel-dead-title").textContent = used ? "Скидка уже использована" : "Скидка сгорела";
  $("wheel-dead-text").textContent = used
    ? "Ты уже купил билет по этой скидке. Колесо крутится один раз с устройства — второй попытки не будет."
    : "Колесо крутится один раз с устройства. Но билеты на месте — забирай без скидки, депозит всё равно возвращается баром.";
}

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

// Обратный отсчёт: тикает раз в секунду, пока скидка жива
function tickTimer() {
  if (!state.wheel || state.wheel.state !== "active") return;
  const left = state.wheelEndsAt - Date.now();
  if (left <= 0) {
    // Скидка сгорела: цены возвращаются к обычным, колесо больше не крутится
    state.wheel = { ...state.wheel, state: "burned", used: false };
    showDead(false);
    renderTickets();
    renderSticky();
    if (!modal.hidden && state.current) updateTotal();
    if (!modal.hidden) $("m-wheel").hidden = true;
    return;
  }
  $("wheel-timer").textContent = mmss(left);
  if (!modal.hidden) $("m-wheel-timer").textContent = mmss(left);
}
setInterval(tickTimer, 1000);

goBtn.addEventListener("click", async () => {
  if (state.spinning) return;
  state.spinning = true;
  goBtn.disabled = true;
  try {
    const res = await fetch("/api/wheel/spin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid: CID }),
    });
    const data = await res.json();
    if (!res.ok) {
      // Уже крутил (например, с другой вкладки) — показываем реальное состояние
      state.spinning = false;
      applyWheelState(data.state);
      return;
    }

    const count = state.wheel?.sectors?.length || 10;
    setSector(data.index, count, true);

    // Ждём, пока диск остановится (transition в style.css — 5.4s)
    setTimeout(() => {
      state.spinning = false;
      state.wheel = { ...state.wheel, state: "active", index: data.index, percent: data.percent };
      state.wheelEndsAt = Date.now() + data.msLeft;
      showWin(data.percent);
      renderTickets(); // цены на карточках сразу со скидкой
      renderSticky();
    }, 5500);
  } catch (e) {
    state.spinning = false;
    goBtn.disabled = false;
  }
});

/* ---------- Кнопки-«прокрутки» и липкая панель ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-scroll]");
  if (!el) return;
  const target = $(el.dataset.scroll);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
});

const sticky = $("sticky");

// Текст на липкой панели: со скидкой колеса он важнее любой другой надписи
function renderSticky() {
  if (!state.tickets.length) return;
  const live = state.tickets.filter((t) => !t.soldOut);
  if (!live.length) return;

  const withWheel = live.find((t) => wheelPercentFor(t));
  if (withWheel) {
    const pct = wheelPercentFor(withWheel);
    $("sticky-price").textContent = `−${pct}% · билет за ${fmt(wheelPrice(withWheel, pct))}`;
  } else {
    const min = Math.min(...live.map((t) => t.price));
    $("sticky-price").textContent = `Вход от ${fmt(min)}`;
  }
  sticky.hidden = false;
}

// Панель выезжает, когда первый экран пролистан, и прячется, когда открыто окно покупки
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

  // Депозит: у входного билета его нет, пишем честно
  $("m-deposit-box").innerHTML = ticket.hasDeposit
    ? "💸 Эта сумма — <b>ваш депозит</b>: вы тратите её на баре. По сути вход бесплатный."
    : "🎫 Это <b>входной билет</b>: депозита нет, бар оплачивается отдельно.";

  // Плашка про скидку колеса
  const pct = wheelPercentFor(ticket);
  $("m-wheel").hidden = !pct;
  if (pct) {
    $("m-wheel-pct").textContent = "−" + pct + "%";
    $("m-wheel-timer").textContent = mmss(state.wheelEndsAt - Date.now());
  }

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
  const max = t.remaining === null ? 20 : Math.min(20, t.remaining);
  state.qty = Math.max(1, Math.min(max, state.qty));
  $("qty-value").textContent = state.qty;
  updateTotal();
}

// Цена за один билет. Скидки не суммируются — берём ту, что выгоднее покупателю
// (ровно так же считает сервер при оплате).
function unitPrice() {
  const t = state.current;
  let price = t.price;
  if (state.promo) price = Math.min(price, state.promo.unitPrice);
  const pct = wheelPercentFor(t);
  if (pct) price = Math.min(price, wheelPrice(t, pct));
  return price;
}

// Какая скидка сработала: колесо или промокод (или ничего)
function activeDiscount() {
  const t = state.current;
  const pct = wheelPercentFor(t);
  const wheelUnit = pct ? wheelPrice(t, pct) : null;
  const promoUnit = state.promo ? state.promo.unitPrice : null;
  if (wheelUnit !== null && (promoUnit === null || wheelUnit < promoUnit))
    return { kind: "wheel", unitPrice: wheelUnit, label: `Скидка колеса −${pct}%` };
  if (promoUnit !== null) return { kind: "promo", unitPrice: promoUnit, label: "Скидка по промокоду" };
  return null;
}

// Надпись на кнопке: бесплатный билет по промокоду оплачивать нечем
function payLabel() {
  return unitPrice() * state.qty === 0 ? "Получить билет" : "Оплатить";
}

function updateTotal() {
  const t = state.current;
  const disc = activeDiscount();
  const unit = unitPrice();
  const total = unit * state.qty;
  const totalText = total === 0 ? "бесплатно" : fmt(total);

  // Со скидкой старую цену зачёркиваем и рядом показываем новую
  if (disc) {
    $("m-price").innerHTML =
      `<s class="old-price">${t.priceLabel}</s> <span class="new-price">${fmt(unit)}</span>`;
    $("m-total").innerHTML =
      `<s class="old-price">${fmt(t.price * state.qty)}</s> <span class="new-price">${totalText}</span>`;
    $("m-discount-label").textContent = disc.label;
    $("m-discount-value").textContent = "−" + fmt((t.price - unit) * state.qty);
    $("m-discount").hidden = false;
  } else {
    $("m-price").textContent = t.priceLabel;
    $("m-total").textContent = totalText;
    $("m-discount").hidden = true;
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
      // Если скидка колеса выгоднее — честно говорим, что считаем по ней
      const disc = activeDiscount();
      promoMsg(
        disc && disc.kind === "wheel"
          ? `Промокод принят, но скидка колеса выгоднее — билет за ${fmt(disc.unitPrice)}`
          : `Промокод применён — билет за ${data.unitPriceLabel}`,
        true
      );
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
        cid: CID, // чтобы сервер нашёл выигрыш колеса этого браузера
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
    // обновим остатки и состояние колеса (скидка теперь потрачена)
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
  $("s-info").innerHTML = order.hasDeposit
    ? "Это ваш билет на <b>DUBAI PARTY</b>. Оплаченная сумма — <b>ваш депозит</b>, потратите её на баре. По указанному контакту мы сможем связаться, чтобы не потеряться."
    : "Это ваш <b>входной билет</b> на <b>DUBAI PARTY</b>. Депозита на баре нет — бар оплачивается отдельно. По указанному контакту мы сможем связаться, чтобы не потеряться.";
  $("s-codes").innerHTML = order.codes
    .map((c) => `<div class="code">${c}</div>`)
    .join("");
}

$("done-btn").addEventListener("click", closeModal);

init();
