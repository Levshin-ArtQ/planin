/**
 * Planin. Жесты листа:
 *   свайп листа влево — следующий день, вправо — предыдущий
 *   строка вправо — на завтра, вправо и вниз — глубже по дням
 *   строка влево или двойной тап — выполнить, строка остаётся
 *   из дня строка исчезает только через «удалить»
 *   долгое нажатие — меню
 *   свайп вверх по полосе внизу — клавиатура, вниз — закрыть и записать
 *   палочки справа — перетащить строку и поменять местами
 *   короткий тап по дате — сегодня, долгий — выбор дня
 * Фразы — в js/parse.js, ими же разбирается голос.
 */
(function () {
  const D = () => window.ListokDay;
  const P = () => window.ListokParse;
  const DB = () => window.ListokDB;
  const M = () => window.ListokMotion;

  const HIT = { claim: 10, dragDelay: 170, done: 68, defer: 64, depthDy: 28, hold: 190, press: 320 };

  const state = {
    today: "",
    cursor: "",
    tasks: [],
    errands: [],
    habits: [],
    settings: null,
    dayMeta: {},
    selected: null,
    editing: null,
    editDraft: null,
    overlay: null,
    cal: null,
    focusTitle: false,
    doneOpen: {},
    importMode: "merge",
    rec: null,
    sliding: false,
    shopOld: false,
    shopWait: false
  };

  const scrollMemory = {};
  let drag = null;
  let swallowClick = false;
  let slideToken = 0;
  let toastTimer = null;
  let undoFn = null;
  let goKey = null;
  let arm = null;
  let tapWait = null;
  let lineHold = null;
  let sendHold = false;
  let skipBlurCommit = false;
  let committing = false;
  let painting = false;
  let painted = null;

  const SAY = { buy: "купить", pickup: "забрать", order: "заказать" };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function ico(name) {
    const stroke = `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
    const paths = {
      send: `<path ${stroke} d="M5 12h12"/><path ${stroke} d="M13 6l6 6-6 6"/>`,
      trash: `<path ${stroke} d="M5 7h14"/><path ${stroke} d="M9 7V5h6v2"/><path ${stroke} d="M8 7l1 12h6l1-12"/>`,
      check: `<path ${stroke} d="M5 12.5l4.2 4.2L19 7"/>`,
      calendar: `<rect ${stroke} x="4" y="5" width="16" height="15" rx="2"/><path ${stroke} d="M8 3.5v4M16 3.5v4M4 10h16"/>`,
      plus: `<path ${stroke} d="M12 5v14M5 12h14"/>`,
      bag: `<path ${stroke} d="M6.5 8h11l-1 11h-9l-1-11z"/><path ${stroke} d="M9 8V7a3 3 0 0 1 6 0v1"/>`,
      list: `<path ${stroke} d="M9 7h10M9 12h10M9 17h10"/><path ${stroke} d="M5 7h.01M5 12h.01M5 17h.01"/>`,
      pencil: `<path ${stroke} d="M4 20l1.2-4.2L16.5 4.5a1.8 1.8 0 0 1 2.5 2.5L7.7 18.3 4 20z"/>`,
      up: `<path ${stroke} d="M6 14l6-6 6 6"/>`,
      down: `<path ${stroke} d="M6 10l6 6 6-6"/>`,
      chevron: `<path ${stroke} d="M6 14l6-6 6 6"/>`,
      sun: `<circle ${stroke} cx="12" cy="12" r="3.2"/><path ${stroke} d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2"/>`,
      clock: `<circle ${stroke} cx="12" cy="12" r="7.5"/><path ${stroke} d="M12 8v4.5l3 2"/>`
    };
    return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function xy(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }
  function snapshot() {
    return JSON.parse(JSON.stringify({
      tasks: state.tasks,
      errands: state.errands,
      habits: state.habits,
      dayMeta: state.dayMeta,
      settings: state.settings
    }));
  }
  function nextOrder(date) {
    const manual = state.dayMeta[date] && state.dayMeta[date].manualOrder;
    return state.tasks
      .filter((t) => t.date === date && (manual || t.kind === "loose"))
      .reduce((m, t) => Math.max(m, t.order || 0), 0) + 1;
  }
  function nextErrandOrder() {
    return state.errands.reduce((m, e) => Math.max(m, e.order || 0), 0) + 1;
  }

  async function boot() {
    await DB().init();
    state.settings = await DB().getSettings();
    state.tasks = await DB().listTasks();
    state.errands = await DB().listErrands();
    state.habits = await DB().listHabits();
    state.dayMeta = await DB().getDayMetaAll();
    state.today = D().todayKey();
    state.cursor = state.today;
    applyTextSize();
    mount();
    bind();
    renderHeader();
    renderSheets(false);
    updateGhost();
    pinViewport();
    tintTheme();
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", tintTheme);
    }
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    setInterval(updateNow, 30000);
  }

  function mount() {
    $("#app").innerHTML = `
      <header class="top">
        <button type="button" class="date-hit" id="date-hit" aria-label="Сегодня. Долгое нажатие — выбрать день">
          <p class="kicker" id="kicker"></p>
          <p class="date-line"><span id="date-num"></span><span id="date-rest"></span></p>
        </button>
        <button type="button" class="gear" id="more" aria-label="Настройки">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <circle cx="8" cy="7" r="2.1" fill="var(--bg)" stroke="currentColor" stroke-width="1.6"/>
            <circle cx="15" cy="12" r="2.1" fill="var(--bg)" stroke="currentColor" stroke-width="1.6"/>
            <circle cx="10" cy="17" r="2.1" fill="var(--bg)" stroke="currentColor" stroke-width="1.6"/>
          </svg>
        </button>
      </header>
      <div class="deck" id="deck">
        <div class="track" id="track">
          <section class="sheet" id="sheet-prev"></section>
          <section class="sheet" id="sheet-cur"></section>
          <section class="sheet" id="sheet-next"></section>
        </div>
      </div>
      <div class="compose" id="compose">
        <p class="ghost" id="ghost"></p>
        <div class="compose-row">
          <button type="button" class="shop-btn" id="shop-btn" aria-label="Список покупок">${ico("bag")}<span class="shop-count" id="shop-count" hidden></span></button>
          <div id="line" class="line is-empty" contenteditable="plaintext-only" role="textbox" aria-multiline="false" aria-label="На этот день" data-placeholder="на этот день" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false"></div>
          <button type="button" class="send" id="send" aria-label="Вписать">${ico("send")}</button>
        </div>
      </div>
      <div class="toast" id="toast" hidden role="status">
        <span id="toast-text"></span>
        <span class="toast-actions">
          <button type="button" id="toast-go" hidden>открыть</button>
          <button type="button" id="toast-undo" hidden>отмена</button>
        </span>
      </div>
      <div id="rail-close" class="rail-close" hidden>
        <button type="button" data-act="toggle-rail">${ico("list")}к списку</button>
      </div>
      <div id="scrim" class="scrim" hidden></div>
      <div id="sheet-ui" class="sheet-ui" hidden></div>`;
  }

  function bind() {
    $("#more").addEventListener("click", () => openSettings());
    bindDateHit();
    $("#scrim").addEventListener("click", () => closeOverlay(true));
    bindSheetSwipe();
    document.addEventListener("contextmenu", (e) => {
      if (!e.target.closest("input, textarea, #shop-line")) e.preventDefault();
    });
    document.addEventListener("selectstart", (e) => {
      if (!e.target.closest("input, textarea, [contenteditable]")) e.preventDefault();
    });
    bindComposer();
    $("#toast-undo").addEventListener("click", () => runUndo());
    $("#toast-go").addEventListener("click", () => {
      if (goKey) goTo(goKey);
    });
    $("#app").addEventListener("click", onClick);
    $("#app").addEventListener("submit", onSubmit);
    $("#app").addEventListener("change", onChange);
    $("#app").addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisible);
    const deck = $("#deck");
    deck.addEventListener("touchstart", (e) => begin(e, "touch"), { passive: true });
    deck.addEventListener("touchmove", (e) => move(e, "touch"), { passive: false });
    deck.addEventListener("touchend", (e) => end(e, "touch"));
    deck.addEventListener("touchcancel", () => cancelDrag());
    deck.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      begin(e, "mouse");
    });
    const sheetUi = $("#sheet-ui");
    sheetUi.addEventListener("touchstart", (e) => begin(e, "touch"), { passive: true });
    sheetUi.addEventListener("touchmove", (e) => move(e, "touch"), { passive: false });
    sheetUi.addEventListener("touchend", (e) => end(e, "touch"));
    sheetUi.addEventListener("touchcancel", () => cancelDrag());
    sheetUi.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      begin(e, "mouse");
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag || drag.input !== "mouse" || e.pointerType === "touch") return;
      move(e, "mouse");
    });
    window.addEventListener("pointerup", (e) => {
      if (!drag || drag.input !== "mouse" || e.pointerType === "touch") return;
      end(e, "mouse");
    });
    deck.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaX) < 28 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
        e.preventDefault();
        if (state.sliding || drag) return;
        slideDay(e.deltaX > 0 ? 1 : -1);
      },
      { passive: false }
    );
    const file = $("#import-file");
    file.addEventListener("change", () => importFile(file));
  }

  function tintTheme() {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#141311" : "#f3f0e8");
  }

  function pinViewport() {
    const vk = navigator.virtualKeyboard;
    if (vk) {
      try { vk.overlaysContent = false; } catch { /* Safari рисует клавиатуру сам */ }
    }
    const vv = window.visualViewport;
    const app = $("#app");
    if (!vv) return;
    const apply = () => {
      app.style.height = `${vv.height}px`;
      app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
  }

  function onVisible() {
    if (document.visibilityState !== "visible") return;
    const today = D().todayKey();
    if (today === state.today) {
      updateNow();
      return;
    }
    const follow = state.cursor === state.today;
    state.today = today;
    if (follow) state.cursor = today;
    renderHeader();
    renderSheets(false);
  }

  function renderHeader() {
    const h = D().head(state.cursor, state.today);
    const named = h.kicker === "сегодня" || h.kicker === "завтра" || h.kicker === "вчера";
    $("#kicker").textContent = named ? `${h.weekday}, ${h.kicker}` : h.kicker;
    $("#date-num").textContent = String(h.day);
    $("#date-rest").textContent = h.month;
    $("#date-hit").classList.toggle("is-today", state.cursor === state.today);
    syncRail();
  }

  function bindDateHit() {
    const hit = $("#date-hit");
    let timer = null;
    let long = false;
    const start = () => {
      long = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        long = true;
        if (navigator.vibrate) navigator.vibrate(8);
        openDays();
      }, 450);
    };
    const stop = () => clearTimeout(timer);
    hit.addEventListener("pointerdown", start);
    hit.addEventListener("pointerup", stop);
    hit.addEventListener("pointerleave", stop);
    hit.addEventListener("pointercancel", stop);
    hit.addEventListener("click", (e) => {
      if (long) {
        long = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (state.cursor !== state.today) goTo(state.today);
    });
  }

  function syncRail() {
    const button = $("#rail-close");
    if (!button || !state.settings) return;
    const timed = tasksOn(state.cursor).filter((t) => !t.done && (t.kind === "window" || t.kind === "slot"));
    const full = D().railMode(timed, state.dayMeta[state.cursor]) === "full";
    button.hidden = !full || !!state.overlay;
  }

  function renderSheets(animate) {
    const cur = $("#sheet-cur");
    if (cur && cur.dataset.date) scrollMemory[cur.dataset.date] = cur.scrollTop;
    const first = animate ? M().measure(cur) : null;
    fillSheet($("#sheet-prev"), D().addDays(state.cursor, -1));
    fillSheet($("#sheet-cur"), state.cursor);
    fillSheet($("#sheet-next"), D().addDays(state.cursor, 1));
    ["sheet-prev", "sheet-cur", "sheet-next"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.dataset.date && scrollMemory[el.dataset.date] != null) {
        el.scrollTop = scrollMemory[el.dataset.date];
      }
    });
    if (first) M().play($("#sheet-cur"), first);
    paintShopCount();
    const title = $("#sheet-title");
    if (title && state.focusTitle) {
      state.focusTitle = false;
      title.focus();
      const v = title.value.length;
      try { title.setSelectionRange(v, v); } catch { /* iOS */ }
    }
    syncRail();
  }

  function tasksOn(key) {
    return state.tasks.filter((t) => t.date === key);
  }

  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0);
  }

  function taskSequence(key) {
    const dayTasks = tasksOn(key);
    const timed = dayTasks
      .filter((t) => t.kind === "window" || t.kind === "slot")
      .sort((a, b) => (a.startMin ?? a.endMin ?? 0) - (b.startMin ?? b.endMin ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
    const loose = dayTasks.filter((t) => t.kind === "loose").sort(byOrder);
    const manual = !!(state.dayMeta[key] && state.dayMeta[key].manualOrder);
    return manual ? [...timed, ...loose].sort(byOrder) : [...timed, ...loose];
  }

  function visibleHabits(key) {
    return state.habits
      .map((h) => ({ h, st: D().habitState(h, key, state.today) }))
      .filter((v) => v.st)
      .sort((a, b) => (a.h.order ?? 1e9) - (b.h.order ?? 1e9) || (a.h.createdAt || 0) - (b.h.createdAt || 0));
  }

  function planItems(key, listTasks, habitViews) {
    const saved = (state.dayMeta[key] && state.dayMeta[key].planOrder) || [];
    const tasks = new Map(listTasks.map((t) => [t.id, t]));
    const habits = new Map(habitViews.map((v) => [v.h.id, v]));
    const usedT = new Set();
    const usedH = new Set();
    const out = [];
    saved.forEach((token) => {
      const cut = String(token).indexOf(":");
      if (cut < 0) return;
      const kind = token.slice(0, cut);
      const id = token.slice(cut + 1);
      if (kind === "h" && habits.has(id) && !usedH.has(id)) {
        out.push({ kind: "habit", view: habits.get(id) });
        usedH.add(id);
      } else if (kind === "t" && tasks.has(id) && !usedT.has(id)) {
        out.push({ kind: "task", task: tasks.get(id) });
        usedT.add(id);
      }
    });
    listTasks.forEach((t) => {
      if (!usedT.has(t.id)) out.push({ kind: "task", task: t });
    });
    habitViews.forEach((v) => {
      if (!usedH.has(v.h.id)) out.push({ kind: "habit", view: v });
    });
    return out;
  }

  function listTokens(key) {
    return planItems(key, taskSequence(key), visibleHabits(key)).map((item) => (
      item.kind === "habit" ? `h:${item.view.h.id}` : `t:${item.task.id}`
    ));
  }

  function fillSheet(el, key) {
    const dayTasks = tasksOn(key);
    const timed = dayTasks
      .filter((t) => t.kind === "window" || t.kind === "slot")
      .sort((a, b) => (a.startMin ?? a.endMin ?? 0) - (b.startMin ?? b.endMin ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
    const meta = state.dayMeta[key] || {};
    const seq = taskSequence(key);
    const liveTimed = timed.filter((t) => !t.done);
    const mode = D().railMode(liveTimed, meta);
    const views = visibleHabits(key);
    const onRail = mode === "full" ? views.filter((v) => v.st !== "done" && D().habitAt(v.h) != null) : [];
    const below = views.filter((v) => !onRail.includes(v));
    const listTasks = mode === "full" ? seq.filter((t) => t.kind === "loose") : seq;
    const plan = planItems(key, listTasks, below).map((item) => (
      item.kind === "habit" ? habitRow(item.view) : taskRow(item.task, key)
    ));
    el.dataset.date = key;
    el.innerHTML = [
      mode === "full" ? railHTML(key, timed, onRail) : stripHTML(key, liveTimed),
      plan.length ? `<div class="rows plan" data-group="plan">${plan.join("")}</div>` : ""
    ].join("");
  }

  function stripHTML(key, timed) {
    const work = D().workOn(key, state.settings);
    const from = 6 * 60;
    const to = 24 * 60;
    const pos = (m) => clamp(((m - from) / (to - from)) * 100, 0, 100);
    const s = state.settings;
    const wash = work
      ? `<span class="strip-wash" style="left:${pos(s.workStartMin)}%;width:${Math.max(0, pos(s.workEndMin) - pos(s.workStartMin))}%"></span>`
      : "";
    const ticks = timed
      .map((t) => {
        const m = t.startMin != null ? t.startMin : t.endMin;
        if (m == null) return "";
        return `<span class="strip-tick" style="left:${pos(m)}%"></span>`;
      })
      .join("");
    const label = work
      ? `${D().clockLabel(s.workStartMin, { short: true })}–${D().clockLabel(s.workEndMin, { short: true })}`
      : D().WD_SHORT[D().dow(key)];
    return `<button type="button" class="strip" data-act="toggle-rail" aria-label="Часы дня, развернуть расписание">${wash}${ticks}<span class="strip-label">${label}</span></button>`;
  }

  function railHTML(key, timed, habitViews) {
    const settings = state.settings;
    const items = timed.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      startMin: t.startMin != null ? t.startMin : t.endMin != null ? Math.max(0, t.endMin - 60) : settings.workStartMin,
      endMin: t.endMin != null ? t.endMin : t.startMin != null ? t.startMin + 40 : settings.workStartMin + 40,
      openStart: t.startMin == null,
      done: !!t.done
    }));
    habitViews.forEach((v) => {
      const at = D().habitAt(v.h);
      items.push({
        id: v.h.id,
        kind: "habit",
        title: v.h.title,
        startMin: at,
        endMin: at + 24,
        meta: D().habitMeta(v.h, v.st)
      });
    });
    const bounds = D().railBounds(items, settings);
    const placed = D().layoutLanes(items);
    const top = (min) => ((min - bounds.from) / 60) * D().HOUR;
    const hours = [];
    for (let m = bounds.from; m < bounds.to; m += 60) {
      hours.push(`<button type="button" class="hour" data-act="hour-add" data-min="${m}" style="top:${top(m)}px" aria-label="Добавить на ${D().clockLabel(m, { short: true })}"><span>${D().clockLabel(m, { short: true })}</span>${ico("plus")}</button>`);
    }
    hours.push(`<span class="hour-end" style="top:${top(bounds.to)}px">24</span>`);
    let wash = "";
    if (D().workOn(key, settings)) {
      const a = Math.max(settings.workStartMin, bounds.from);
      const b = Math.min(settings.workEndMin, bounds.to);
      if (b > a) wash = `<div class="wash" style="top:${top(a)}px;height:${top(b) - top(a)}px"></div>`;
    }
    let now = "";
    if (key === state.today) {
      const d = new Date();
      const mins = d.getHours() * 60 + d.getMinutes();
      if (mins >= bounds.from && mins <= bounds.to) now = `<div class="now" data-now style="top:${top(mins)}px"></div>`;
    }
    const blocks = placed
      .map((b) => {
        const y = top(b.start);
        const h = b.kind === "window" ? Math.max(36, ((b.end - b.start) / 60) * D().HOUR - 4) : 36;
        const time = b.kind === "habit" ? D().clockLabel(b.start, { short: true }) : D().rangeLabel(b.openStart ? null : b.start, b.kind === "slot" ? null : b.end);
        return `<button type="button" class="block ${esc(b.kind)}${doneClass(b.done)}" data-id="${esc(b.id)}" data-kind="${b.kind === "habit" ? "habit" : "task"}" data-flip="${b.kind === "habit" ? `h-${esc(b.id)}` : esc(b.id)}" style="top:${y}px;height:${h}px;left:calc(46px + (100% - 58px) * ${b.lane} / ${b.lanes});width:calc((100% - 58px) / ${b.lanes} - 6px)">
          <p class="block-time">${esc(time)}</p>
          <p class="block-title">${esc(b.title)}</p>
        </button>`;
      })
      .join("");
    return `<div class="rail" style="height:${bounds.height}px" data-from="${bounds.from}">
      ${hours.join("")}${wash}${now}${blocks}
    </div>`;
  }

  function inWork(task, key) {
    if (!D().workOn(key, state.settings)) return false;
    const a = state.settings.workStartMin;
    const b = state.settings.workEndMin;
    if (task.kind === "slot" && task.startMin != null) return task.startMin >= a && task.startMin < b;
    if (task.kind === "window") {
      const s = task.startMin == null ? a : task.startMin;
      const e = task.endMin == null ? b : task.endMin;
      return s < b && e > a;
    }
    return false;
  }

  function doneClass(done) {
    if (!done) return "";
    const style = (state.settings && state.settings.doneStyle) || "both";
    if (style === "fade") return " is-done is-fade";
    if (style === "strike") return " is-done is-strike";
    return " is-done is-fade is-strike";
  }

  function taskRow(task, key) {
    const label = task.kind === "loose"
      ? ""
      : task.kind === "window"
        ? D().rangeLabel(task.startMin, task.endMin)
        : D().clockLabel(task.startMin, { short: true });
    const gutter = label
      ? `<span class="gutter${inWork(task, key) ? " in-work" : ""}">${esc(label)}</span>`
      : "";
    const sel = state.selected === task.id ? " is-selected" : "";
    return `<article class="row${doneClass(task.done)}${sel}" data-id="${esc(task.id)}" data-kind="task" data-flip="${esc(task.id)}"><p class="title">${esc(task.title)}</p>${gutter}<span class="grip" aria-label="Порядок"><i></i><i></i><i></i></span><span class="ink"></span></article>`;
  }

  function habitRow(v) {
    const sel = state.selected === v.h.id ? " is-selected" : "";
    const at = D().habitAt(v.h);
    const when = at != null ? `<span class="gutter">${esc(D().clockLabel(at, { short: true }))}</span>` : "";
    return `<article class="row habit${doneClass(v.st === "done")}${sel}" data-id="${esc(v.h.id)}" data-kind="habit" data-flip="h-${esc(v.h.id)}"><p class="title">${esc(v.h.title)}</p>${when}<p class="meta">${esc(D().habitMeta(v.h, v.st))}</p><span class="grip" aria-label="Порядок"><i></i><i></i><i></i></span><span class="ink"></span></article>`;
  }

  function shopHTML() {
    const err = D().errandsFor(state.errands, state.cursor);
    const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
    const fresh = err.doneToday.filter((e) => e.doneOn === state.today).sort(byOrder);
    const old = err.doneToday.filter((e) => e.doneOn !== state.today).sort(byOrder);
    const waiting = state.errands
      .filter((e) => !e.done && D().errandWaits(e, state.cursor))
      .sort(byOrder);
    const oldBlock = old.length
      ? `<button type="button" class="archive" data-act="toggle-shop-old">${state.shopOld ? "скрыть купленное" : `куплено раньше · ${old.length}`}</button>${state.shopOld ? `<div class="rows plan" data-group="errand">${old.map((item) => errandRow(item)).join("")}</div>` : ""}`
      : "";
    const waitBlock = waiting.length
      ? `<button type="button" class="archive" data-act="toggle-shop-wait">${state.shopWait ? "скрыть будущие" : `приедет позже · ${waiting.length}`}</button>${state.shopWait ? `<div class="rows plan">${waiting.map((item) => errandRow(item)).join("")}</div>` : ""}`
      : "";
    return `<h2>список покупок</h2>
      <div class="rows plan" data-group="errand">${err.open.sort(byOrder).map((item) => errandRow(item)).join("")}</div>
      <div id="shop-line" class="line shop-line is-empty" contenteditable="plaintext-only" role="textbox" aria-multiline="false" aria-label="В список" data-placeholder="в список" autocapitalize="sentences" spellcheck="false"></div>
      ${fresh.length ? `<div class="rows plan">${fresh.map((item) => errandRow(item)).join("")}</div>` : ""}
      ${oldBlock}
      ${waitBlock}`;
  }

  function orderReady(item) {
    if (!item || (item.tag !== "pickup" && item.tag !== "order") || !item.from) return "";
    const h = D().head(item.from, state.today);
    return `с ${h.short} ${h.day}`;
  }

  function errandRow(item) {
    const ready = orderReady(item);
    const when = item.atMin != null ? `<span class="gutter">${esc(D().clockLabel(item.atMin, { short: true }))}</span>` : "";
    const meta = ready ? `<p class="meta">${esc(ready)}</p>` : "";
    return `<article class="row${doneClass(item.done)}" data-id="${esc(item.id)}" data-kind="errand" data-flip="e-${esc(item.id)}"><p class="title"><span class="tag">${esc(SAY[item.tag] || "купить")}</span>${esc(item.text)}</p>${when}${meta}<span class="ink"></span></article>`;
  }

  function doneHTML(key, tasks, habits) {
    const items = [
      ...tasks.map((t) => ({ kind: "task", id: t.id, title: t.title, flip: t.id, task: t })),
      ...habits.map((h) => ({ kind: "habit-done", id: h.id, title: h.title, flip: `h-${h.id}` }))
    ];
    if (!items.length) return "";
    const open = !!state.doneOpen[key];
    const show = open || items.length <= 4 ? items : items.slice(-2);
    const hidden = items.length - show.length;
    const rows = show
      .map((item) => {
        if (item.kind === "task") return taskRow({ ...item.task, done: true }, key);
        return `<article class="row is-done" data-id="${esc(item.id)}" data-kind="habit-done" data-flip="${esc(item.flip)}"><p class="title">${esc(item.title)}</p><span class="ink"></span></article>`;
      })
      .join("");
    const more = hidden ? `<button type="button" class="more-done" data-act="toggle-done">ещё ${hidden}</button>` : "";
    return `<section class="done-wrap"><div class="group-h"><span>сделано</span></div><div class="rows">${rows}</div>${more}</section>`;
  }

  function editTaskHTML(task) {
    const d = state.editDraft;
    const chip = (kind, label) =>
      `<button type="button" data-set-kind="${kind}" aria-pressed="${d.kind === kind}">${label}</button>`;
    let times = "";
    if (d.kind === "slot") {
      times = `<div class="time-fields"><input class="clock" data-field="start" inputmode="numeric" value="${esc(d.startMin == null ? "" : D().clockLabel(d.startMin))}" placeholder="14:30" /></div>`;
    } else if (d.kind === "window") {
      times = `<div class="time-fields"><input class="clock" data-field="start" inputmode="numeric" value="${esc(d.startMin == null ? "" : D().clockLabel(d.startMin))}" placeholder="с" /><span>–</span><input class="clock" data-field="end" inputmode="numeric" value="${esc(d.endMin == null ? "" : D().clockLabel(d.endMin))}" placeholder="до" /></div>`;
    }
    return `<article class="row is-edit" data-id="${esc(task.id)}" data-kind="task" data-flip="${esc(task.id)}">
      <input id="edit-title" value="${esc(d.title)}" />
      <div class="kinds">${chip("loose", "весь день")}${chip("window", "окно")}${chip("slot", "час")}<button type="button" data-set-kind="habit">привычка</button></div>
      ${times}
      <div class="edit-row">
        <button type="button" data-act="shift-minus">− день</button>
        <button type="button" data-act="shift-plus">+ день</button>
        <button type="button" data-act="delete">убрать</button>
      </div>
    </article>`;
  }

  function editHabitHTML(habit) {
    const d = state.editDraft;
    const anchor = (name, label) =>
      `<button type="button" data-anchor="${name}" aria-pressed="${(d.anchor || "") === name}">${label}</button>`;
    return `<article class="row is-edit habit" data-id="${esc(habit.id)}" data-kind="habit" data-flip="h-${esc(habit.id)}">
      <input id="edit-title" value="${esc(d.title)}" />
      <div class="edit-row">
        <button type="button" data-act="every-min" data-delta="-1">−</button>
        <span>раз в ${d.everyMin}${d.everyMax !== d.everyMin ? `–${d.everyMax}` : ""}</span>
        <button type="button" data-act="every-min" data-delta="1">+</button>
        <button type="button" data-act="every-max" data-delta="-1">до −</button>
        <button type="button" data-act="every-max" data-delta="1">до +</button>
      </div>
      <div class="anchors">${anchor("", "—")}${anchor("morning", "утро")}${anchor("day", "день")}${anchor("evening", "вечер")}${anchor("night", "ночь")}</div>
      <div class="edit-row">
        <button type="button" data-act="shift-minus">− день</button>
        <button type="button" data-act="shift-plus">+ день</button>
        <button type="button" data-act="delete">убрать</button>
      </div>
    </article>`;
  }

  function readEditable(el) {
    if (!el) return "";
    let out = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) out += node.textContent;
    return out.replace(/\u00a0/g, " ").replace(/\n/g, "");
  }

  function readLine() {
    return readEditable($("#line"));
  }

  function caretOffset(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return readEditable(el).length;
    const range = sel.getRangeAt(0).cloneRange();
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().replace(/\n/g, "").length;
  }

  function setCaret(el, offset) {
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let left = Math.max(0, offset);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent.length;
      if (left <= len) {
        range.setStart(node, left);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      left -= len;
      node = walker.nextNode();
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function markedHTML(text) {
    const ranges = text ? P().marks(text) : [];
    let html = "";
    let at = 0;
    ranges.forEach((range) => {
      html += esc(text.slice(at, range.start));
      html += `<span class="kw">${esc(text.slice(range.start, range.end))}</span>`;
      at = range.end;
    });
    html += esc(text.slice(at));
    return html;
  }

  function paintLine() {
    const line = $("#line");
    if (!line || painting) return;
    const text = readEditable(line);
    line.classList.toggle("is-empty", !text);
    if (painted === text) return;
    const offset = document.activeElement === line ? caretOffset(line) : null;
    painting = true;
    line.innerHTML = markedHTML(text);
    painted = text;
    painting = false;
    if (offset != null) setCaret(line, offset);
  }

  function writeLine(text) {
    const el = $("#line");
    if (!el) return;
    painted = null;
    painting = true;
    el.textContent = text || "";
    painting = false;
    paintLine();
  }

  function updateGhost() {
    paintLine();
    const ghost = $("#ghost");
    const text = readLine();
    if (!text.trim()) {
      ghost.textContent = state.settings.seenLegend ? "" : "тап по дате — сегодня";
      ghost.classList.toggle("is-hint", !state.settings.seenLegend);
      return;
    }
    const parsed = P().parse(text, { today: state.cursor });
    ghost.classList.remove("is-hint");
    ghost.textContent = parsed.ok ? P().describe(parsed, state.cursor) : parsed.reason || "";
  }

  function applyTextSize() {
    const size = state.settings && state.settings.textSize;
    document.documentElement.dataset.text = size === "s" || size === "l" ? size : "m";
  }

  function ensureEditable(el) {
    if (!el) return;
    const mode = el.contentEditable;
    if (mode !== "true" && mode !== "plaintext-only") el.contentEditable = "true";
  }

  function cancelLineHold() {
    if (!lineHold) return;
    clearTimeout(lineHold.timer);
    lineHold = null;
  }

  function keepPlainPaste(e) {
    const data = e.clipboardData || window.clipboardData;
    if (!data) return;
    e.preventDefault();
    const text = data.getData("text/plain").replace(/\s*\n\s*/g, " ");
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    const host = e.currentTarget;
    if (host && host.id === "shop-line") {
      host.classList.toggle("is-empty", !readEditable(host));
      return;
    }
    painted = null;
    updateGhost();
  }

  function bindLineHold(el) {
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      cancelLineHold();
      lineHold = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          lineHold = null;
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
          sendHold = true;
          swallowClick = true;
          skipBlurCommit = true;
          setTimeout(() => { swallowClick = false; }, 500);
          const line = $("#line");
          if (line) line.blur();
          openNewTaskSheet();
        }, 480)
      };
    });
    el.addEventListener("pointermove", (e) => {
      if (!lineHold) return;
      if (Math.abs(e.clientX - lineHold.x) > 8 || Math.abs(e.clientY - lineHold.y) > 8) cancelLineHold();
    });
    el.addEventListener("pointerup", cancelLineHold);
    el.addEventListener("pointercancel", cancelLineHold);
  }

  function bindComposer() {
    const line = $("#line");
    ensureEditable(line);
    line.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitComposer();
      }
    });
    line.addEventListener("paste", keepPlainPaste);
    line.addEventListener("input", () => {
      if (painting) return;
      updateGhost();
    });
    line.addEventListener("contextmenu", (e) => e.preventDefault());
    line.addEventListener("blur", () => {
      if (skipBlurCommit) {
        skipBlurCommit = false;
        return;
      }
      commitComposer(true);
    });
    const send = $("#send");
    bindLineHold(send);
    send.addEventListener("click", () => {
      if (sendHold) {
        sendHold = false;
        return;
      }
      commitComposer();
    });
    $("#shop-btn").addEventListener("click", () => openShop());
    bindKeyGesture();
  }

  function keyTarget() {
    if (state.overlay && state.overlay.type === "shop") return $("#shop-line");
    if (state.overlay) return null;
    return $("#line");
  }

  function openKeyboard() {
    const el = keyTarget();
    if (!el) return;
    el.focus();
    try { setCaret(el, readEditable(el).length); } catch { /* caret */ }
  }

  function closeKeyboard() {
    const el = document.activeElement;
    if (!el) return;
    if (el.id === "line" || el.id === "shop-line" || el.closest("#sheet-ui, #compose")) el.blur();
  }

  function bindKeyGesture() {
    const zone = $("#compose");
    let arm = null;
    let swallowed = false;
    zone.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      if (e.target.closest("#shop-btn, #send")) return;
      const t = e.touches[0];
      arm = { x: t.clientX, y: t.clientY, id: t.identifier };
    }, { passive: true });
    zone.addEventListener("touchend", (e) => {
      if (!arm) return;
      const t = [...e.changedTouches].find((touch) => touch.identifier === arm.id);
      const start = arm;
      arm = null;
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dy) < 36 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
      swallowed = true;
      if (dy < 0) openKeyboard();
      else closeKeyboard();
    }, { passive: true });
    zone.addEventListener("touchcancel", () => { arm = null; });
    zone.addEventListener("click", (e) => {
      if (swallowed) {
        swallowed = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest("#shop-btn, #send, #line, #shop-line")) return;
      openKeyboard();
    });
  }

  function openNewTaskSheet() {
    state.overlay = { type: "compose-new", title: readLine().trim() };
    renderOverlay();
  }

  function composeNewHTML() {
    return `<h2>новая задача</h2>
      <button type="button" class="menu-item" data-act="new-loose">${ico("list")}<span>весь день</span></button>
      <button type="button" class="menu-item" data-act="new-timed">${ico("clock")}<span>на время</span></button>
      <button type="button" class="menu-item" data-act="new-shop">${ico("bag")}<span>список покупок</span></button>`;
  }

  function openShop(opts) {
    if (state.editing && closeEdit(true) === false) return;
    state.overlay = { type: "shop", seed: (opts && opts.seed) || "" };
    state.focusShop = !!(opts && (opts.focus || opts.seed));
    renderOverlay();
  }

  async function createDraftTask(kind) {
    const title = (state.overlay && state.overlay.title) || "";
    writeLine("");
    updateGhost();
    const now = Date.now();
    const clock = new Date();
    const slot = Math.round((clock.getHours() * 60 + clock.getMinutes()) / 15) * 15;
    const task = {
      id: DB().id("t"),
      kind,
      title,
      date: state.cursor,
      order: nextOrder(state.cursor),
      startMin: kind === "loose" ? null : slot,
      endMin: kind === "window" ? slot + 60 : null,
      done: false,
      doneAt: null,
      createdAt: now,
      updatedAt: now
    };
    state.tasks.push(task);
    await DB().putTask(task);
    renderSheets(true);
    openEdit("task", task.id, { focus: true, force: true });
  }

  function bindShopLine() {
    const shop = $("#shop-line");
    if (!shop) return;
    ensureEditable(shop);
    const seed = state.overlay && state.overlay.seed;
    if (seed) {
      shop.textContent = seed;
      shop.classList.remove("is-empty");
      state.overlay.seed = "";
    }
    shop.addEventListener("input", () => {
      shop.classList.toggle("is-empty", !readEditable(shop));
    });
    shop.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commitShopLine(shop);
    });
    shop.addEventListener("blur", () => commitShopLine(shop));
    shop.addEventListener("paste", keepPlainPaste);
    if (state.focusShop) {
      state.focusShop = false;
      shop.focus();
      setCaret(shop, readEditable(shop).length);
    }
  }

  function setGhost(text, hint) {
    const ghost = $("#ghost");
    ghost.textContent = text;
    ghost.classList.toggle("is-hint", !!hint);
  }

  function offerUndo(text, fn, key) {
    undoFn = fn || null;
    goKey = key || null;
    $("#toast-text").textContent = text;
    $("#toast-undo").hidden = !fn;
    $("#toast-go").hidden = !key;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $("#toast").hidden = true;
      undoFn = null;
      goKey = null;
    }, 4600);
  }

  async function runUndo() {
    const fn = undoFn;
    undoFn = null;
    goKey = null;
    $("#toast").hidden = true;
    if (fn) await fn();
  }

  async function restore(before) {
    state.tasks = before.tasks;
    state.errands = before.errands;
    state.habits = before.habits;
    state.dayMeta = before.dayMeta;
    state.settings = before.settings;
    state.editing = null;
    state.editDraft = null;
    await DB().replaceAll(before);
    applyTextSize();
    renderHeader();
    renderPanel();
    renderSheets(true);
    refreshShop();
    updateGhost();
  }

  async function commitParsed(parsed) {
    if (!parsed || !parsed.ok) return;
    const before = snapshot();
    const now = Date.now();
    let label = "вписано";
    let open = null;
    if (parsed.kind === "errand") {
      const item = {
        id: DB().id("e"),
        text: parsed.title,
        tag: parsed.errandTag || "buy",
        from: parsed.dateSpoken ? parsed.date : null,
        atMin: parsed.atMin,
        done: false,
        doneOn: null,
        doneAt: null,
        order: nextErrandOrder(),
        createdAt: now
      };
      state.errands.push(item);
      await DB().putErrand(item);
      label = "в список";
    } else if (parsed.kind === "habit") {
      const habit = {
        id: DB().id("h"),
        title: parsed.title,
        everyMin: parsed.habit.everyMin || 1,
        everyMax: parsed.habit.everyMax || parsed.habit.everyMin || 1,
        weekday: parsed.habit.weekday,
        anchor: parsed.habit.anchor,
        timeMin: parsed.habit.timeMin,
        nextDue: parsed.date,
        lastDone: null,
        history: [],
        createdAt: now,
        updatedAt: now
      };
      state.habits.push(habit);
      await DB().putHabit(habit);
      label = D().habitPhrase(habit);
    } else {
      const task = {
        id: DB().id("t"),
        kind: parsed.kind,
        title: parsed.title,
        date: parsed.date,
        order: nextOrder(parsed.date),
        startMin: parsed.startMin,
        endMin: parsed.endMin,
        done: false,
        doneAt: null,
        createdAt: now,
        updatedAt: now
      };
      state.tasks.push(task);
      await DB().putTask(task);
      if (parsed.date !== state.cursor) {
        label = D().moveLabel(state.cursor, D().diffDays(state.cursor, parsed.date));
        open = parsed.date;
      }
    }
    renderSheets(true);
    refreshShop();
    offerUndo(label, () => restore(before), open);
  }

  function commitComposer(keepAnyway) {
    if (committing) return;
    const text = readLine().trim();
    const parsed = P().parse(text, { today: state.cursor });
    if (!parsed.ok) {
      if (!keepAnyway || !text) {
        updateGhost();
        return;
      }
    }
    committing = true;
    writeLine("");
    updateGhost();
    const item = parsed.ok ? parsed : {
      ok: true,
      kind: "loose",
      title: text,
      date: state.cursor,
      startMin: null,
      endMin: null
    };
    Promise.resolve(commitParsed(item)).finally(() => { committing = false; });
  }

  function commitShopLine(shop) {
    if (!shop || committing) return;
    const text = readEditable(shop).trim();
    if (!text) return;
    committing = true;
    shop.textContent = "";
    shop.classList.add("is-empty");
    Promise.resolve(addErrandFrom(text)).finally(() => { committing = false; });
  }

  async function addErrandFrom(text) {
    const raw = text.trim();
    if (!raw) return;
    const parsed = P().parse(raw, { today: state.cursor });
    const before = snapshot();
    const item = {
      id: DB().id("e"),
      text: parsed.ok ? parsed.title : raw,
      tag: parsed.ok && parsed.errandTag ? parsed.errandTag : "buy",
      from: parsed.ok && parsed.dateSpoken ? parsed.date : null,
      atMin: parsed.ok ? parsed.atMin || (parsed.kind === "slot" ? parsed.startMin : null) : null,
      done: false,
      doneOn: null,
      doneAt: null,
      order: nextErrandOrder(),
      createdAt: Date.now()
    };
    state.errands.push(item);
    await DB().putErrand(item);
    state.focusShop = true;
    renderSheets(true);
    if (state.overlay && state.overlay.type === "shop") renderOverlay();
    offerUndo("в список", () => restore(before));
  }

  function rowEl(id) {
    const safe = CSS.escape(id);
    return $(`#sheet-ui [data-id="${safe}"]`) || $(`#sheet-cur [data-id="${safe}"]`);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function strike(id) {
    const el = rowEl(id);
    if (!el || M().reduce()) return;
    el.classList.add("is-striking");
    el.style.setProperty("--strike", "1");
    await wait(170);
  }

  async function fly(id, dir) {
    const el = rowEl(id);
    if (!el || M().reduce()) return;
    const width = $("#deck").clientWidth || 320;
    const sign = dir < 0 ? -1 : 1;
    el.style.transition = "transform 200ms cubic-bezier(.2,.8,.2,1)";
    el.style.transform = `translateX(${sign * width}px)`;
    await wait(190);
  }

  async function completeTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task || task.done) return;
    await strike(id);
    const before = snapshot();
    task.done = true;
    task.doneAt = Date.now();
    task.updatedAt = task.doneAt;
    await DB().putTask(task);
    state.editing = null;
    renderSheets(true);
    offerUndo("вычеркнуто", () => restore(before));
  }

  async function restoreTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    const before = snapshot();
    task.done = false;
    task.doneAt = null;
    task.updatedAt = Date.now();
    await DB().putTask(task);
    renderSheets(true);
    offerUndo("снова в дне", () => restore(before));
  }

  async function moveTask(id, days) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    await fly(id, days);
    const before = snapshot();
    const label = D().moveLabel(task.date, days);
    const dest = D().addDays(task.date, days);
    task.date = dest;
    task.order = nextOrder(dest);
    task.updatedAt = Date.now();
    await DB().putTask(task);
    state.editing = null;
    renderSheets(true);
    offerUndo(label, () => restore(before), dest);
  }

  async function removeTask(id) {
    const before = snapshot();
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.editing = null;
    await DB().deleteTask(id);
    renderSheets(true);
    offerUndo("удалено", () => restore(before));
  }

  async function completeHabit(id) {
    const habit = state.habits.find((h) => h.id === id);
    if (!habit) return;
    await strike(id);
    const before = snapshot();
    Object.assign(habit, D().markHabitDone(habit, state.cursor));
    await DB().putHabit(habit);
    state.editing = null;
    renderSheets(true);
    offerUndo("сделано, ритм сдвинулся", () => restore(before));
  }

  async function undoHabit(id) {
    const habit = state.habits.find((h) => h.id === id);
    if (!habit) return;
    const before = snapshot();
    Object.assign(habit, D().undoHabitDone(habit, state.cursor));
    await DB().putHabit(habit);
    renderSheets(true);
    offerUndo("привычка снова в дне", () => restore(before));
  }

  async function shiftHabit(id, days) {
    const habit = state.habits.find((h) => h.id === id);
    if (!habit) return;
    await fly(id, days);
    const before = snapshot();
    Object.assign(habit, D().shiftHabit(habit, days, state.today));
    await DB().putHabit(habit);
    state.editing = null;
    renderSheets(true);
    offerUndo(D().moveLabel(state.cursor, days), () => restore(before));
  }

  async function removeHabit(id) {
    const before = snapshot();
    state.habits = state.habits.filter((h) => h.id !== id);
    state.editing = null;
    await DB().deleteHabit(id);
    renderSheets(true);
    offerUndo("привычка удалена", () => restore(before));
  }

  async function completeErrand(id) {
    const item = state.errands.find((e) => e.id === id);
    if (!item || item.done) return;
    await strike(id);
    const before = snapshot();
    item.done = true;
    item.doneAt = Date.now();
    item.doneOn = state.cursor;
    await DB().putErrand(item);
    renderSheets(true);
    refreshShop();
    offerUndo("вычеркнуто", () => restore(before));
  }

  async function restoreErrand(id) {
    const item = state.errands.find((e) => e.id === id);
    if (!item) return;
    const before = snapshot();
    item.done = false;
    item.doneAt = null;
    item.doneOn = null;
    await DB().putErrand(item);
    renderSheets(true);
    refreshShop();
    offerUndo("снова в списке", () => restore(before));
  }

  async function removeErrand(id) {
    const before = snapshot();
    state.errands = state.errands.filter((e) => e.id !== id);
    state.editing = null;
    await DB().deleteErrand(id);
    renderSheets(true);
    refreshShop();
    offerUndo("удалено из списка", () => restore(before));
  }

  function refreshShop() {
    paintShopCount();
    if (state.overlay && state.overlay.type === "shop") renderOverlay();
  }

  function paintShopCount() {
    const badge = $("#shop-count");
    if (!badge) return;
    const n = D().errandsFor(state.errands, state.cursor).open.length;
    badge.hidden = !n;
    badge.textContent = n ? String(n) : "";
  }

  async function toggleWent() {
    const before = snapshot();
    const cur = { ...(state.dayMeta[state.cursor] || {}) };
    cur.went = !cur.went;
    state.dayMeta[state.cursor] = cur;
    await DB().saveDayMeta(state.dayMeta);
    renderSheets(true);
    offerUndo(cur.went ? "отметил, что сходил" : "снял отметку", () => restore(before));
  }

  async function toggleRail() {
    const key = state.cursor;
    const timed = tasksOn(key).filter((t) => !t.done && (t.kind === "window" || t.kind === "slot"));
    const cur = D().railMode(timed, state.dayMeta[key]);
    const next = cur === "full" ? "list" : "full";
    state.dayMeta[key] = { ...(state.dayMeta[key] || {}), rail: next };
    await DB().saveDayMeta(state.dayMeta);
    renderSheets(true);
  }

  function timeText(draft) {
    if (!draft) return "";
    if (draft.timeText != null) return draft.timeText;
    if (draft.kind === "window") return D().rangeLabel(draft.startMin, draft.endMin);
    if (draft.startMin != null) return D().clockLabel(draft.startMin);
    return "";
  }

  function readSheetFields() {
    if (!state.editDraft) return true;
    const title = $("#sheet-title");
    if (title) state.editDraft.title = title.value;
    const time = $("#edit-time");
    if (!time) return true;
    state.editDraft.timeText = time.value;
    const parsed = D().parseWhen(time.value);
    const hint = $("#time-hint");
    if (!parsed.ok) {
      if (hint) {
        hint.textContent = "не разобрал — можно 14:30, 1430, 14.30, 12-14 или до 16";
        hint.classList.add("is-bad");
      }
      return false;
    }
    if (hint) {
      hint.classList.remove("is-bad");
      hint.textContent = parsed.empty ? "" : parsed.kind === "window" ? D().rangeLabel(parsed.startMin, parsed.endMin) : D().clockLabel(parsed.startMin);
    }
    if (parsed.empty) {
      if (state.editDraft.kind !== "loose") {
        if (hint) {
          hint.textContent = "напишите время или выберите «весь день»";
          hint.classList.add("is-bad");
        }
        return false;
      }
      state.editDraft.startMin = null;
      state.editDraft.endMin = null;
      return true;
    }
    state.editDraft.kind = parsed.kind;
    state.editDraft.startMin = parsed.startMin;
    state.editDraft.endMin = parsed.endMin;
    state.editDraft.timeText = null;
    return true;
  }

  function closeEdit(save) {
    if (state.editing && state.editDraft && save !== false) {
      if (!readSheetFields()) return false;
      const { kind, id } = state.editing;
      const draft = state.editDraft;
      if (kind === "task") {
        const model = state.tasks.find((t) => t.id === id);
        if (model) {
          model.title = draft.title.trim() || model.title;
          model.kind = draft.kind;
          model.startMin = draft.kind === "loose" ? null : draft.startMin;
          model.endMin = draft.kind === "window" ? draft.endMin : null;
          model.updatedAt = Date.now();
          DB().putTask(model);
        }
      } else if (kind === "habit") {
        const model = state.habits.find((h) => h.id === id);
        if (model) {
          model.title = draft.title.trim() || model.title;
          model.everyMin = draft.everyMin;
          model.everyMax = Math.max(draft.everyMin, draft.everyMax || draft.everyMin);
          model.weekday = draft.weekday == null ? null : draft.weekday;
          if (draft.nextDue) model.nextDue = draft.nextDue;
          model.anchor = draft.anchor || null;
          model.updatedAt = Date.now();
          DB().putHabit(model);
        }
      } else if (kind === "errand") {
        const model = state.errands.find((e) => e.id === id);
        if (model) {
          model.text = draft.title.trim() || model.text;
          model.tag = draft.tag || "buy";
          model.from = model.tag === "pickup" || model.tag === "order" ? draft.from || null : null;
          DB().putErrand(model);
        }
      }
    }
    const back = state.overlay && state.overlay.returnTo;
    state.editing = null;
    state.editDraft = null;
    if (back === "shop") {
      state.overlay = { type: "shop" };
      renderOverlay();
      renderSheets(false);
      return true;
    }
    state.overlay = null;
    hideOverlay();
    renderSheets(false);
    return true;
  }

  function hideOverlay() {
    const scrim = $("#scrim");
    const sheet = $("#sheet-ui");
    if (scrim) scrim.hidden = true;
    if (sheet) {
      sheet.hidden = true;
      sheet.innerHTML = "";
    }
    syncRail();
  }

  function showOverlay(html) {
    const scrim = $("#scrim");
    const sheet = $("#sheet-ui");
    scrim.hidden = false;
    sheet.hidden = false;
    const keep = sheet.scrollTop;
    sheet.innerHTML = `<div class="grab"></div>${html}`;
    const keepScroll = state.overlay && (state.overlay.type === "habit" || state.overlay.type === "shop");
    sheet.scrollTop = keepScroll ? keep : 0;
    syncRail();
  }

  function openEdit(kind, id, opts) {
    const back = (state.overlay && state.overlay.returnTo) || (state.overlay && state.overlay.type === "shop" ? "shop" : null);
    if (state.editing && !(opts && opts.force) && state.editing.id === id && state.editing.kind === kind && state.overlay) return;
    if (state.editing) {
      if (state.overlay) state.overlay.returnTo = null;
      if (closeEdit(true) === false) return;
    }
    if (kind === "task") {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return;
      state.editDraft = { title: task.title, kind: task.kind, startMin: task.startMin, endMin: task.endMin, timeText: null };
    } else if (kind === "habit") {
      const habit = state.habits.find((h) => h.id === id);
      if (!habit) return;
      state.editDraft = {
        title: habit.title,
        everyMin: habit.everyMin || 1,
        everyMax: habit.everyMax || habit.everyMin || 1,
        weekday: habit.weekday == null ? null : habit.weekday,
        nextDue: habit.nextDue,
        anchor: habit.anchor || ""
      };
    } else if (kind === "errand") {
      const item = state.errands.find((e) => e.id === id);
      if (!item) return;
      state.editDraft = { title: item.text, tag: item.tag || "buy", from: item.from || null };
    } else return;
    state.editing = { kind, id };
    state.selected = id;
    state.overlay = { type: kind === "habit" ? "habit" : "edit", returnTo: back };
    state.focusTitle = !!(opts && opts.focus);
    renderOverlay();
  }

  function applyClockField(input) {
    if (!state.editDraft) return;
    const value = D().parseClockText(input.value);
    if (input.dataset.field === "start") state.editDraft.startMin = value;
    if (input.dataset.field === "end") state.editDraft.endMin = value;
  }

  async function changeKind(kind) {
    if (!state.editing || state.editing.kind !== "task") return;
    const id = state.editing.id;
    const titleEl = $("#sheet-title");
    if (titleEl) state.editDraft.title = titleEl.value;
    document.querySelectorAll("#sheet-cur .clock").forEach(applyClockField);
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    if (kind === "habit") {
      const before = snapshot();
      const habit = {
        id: DB().id("h"),
        title: state.editDraft.title.trim() || task.title,
        everyMin: 1,
        everyMax: 1,
        weekday: null,
        anchor: null,
        timeMin: state.editDraft.startMin,
        nextDue: task.date,
        lastDone: null,
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      state.habits.push(habit);
      await DB().deleteTask(task.id);
      await DB().putHabit(habit);
      state.editing = { kind: "habit", id: habit.id };
      state.editDraft = {
        title: habit.title,
        everyMin: 1,
        everyMax: 1,
        weekday: null,
        nextDue: habit.nextDue,
        anchor: ""
      };
      state.overlay = { type: "habit" };
      renderSheets(true);
      renderOverlay();
      offerUndo("стала привычкой", () => restore(before));
      return;
    }
    state.editDraft.kind = kind;
    state.editDraft.timeText = null;
    if (kind === "loose") {
      state.editDraft.startMin = null;
      state.editDraft.endMin = null;
    } else if (kind === "slot" && state.editDraft.startMin == null) {
      state.editDraft.startMin = state.settings.workStartMin;
      state.editDraft.endMin = null;
    } else if (kind === "window" && state.editDraft.endMin == null) {
      state.editDraft.startMin = state.editDraft.startMin == null ? state.settings.workStartMin : state.editDraft.startMin;
      state.editDraft.endMin = state.editDraft.startMin + 60;
    }
    renderOverlay();
  }

  async function persistOrder(group, ids, dateKey) {
    const before = snapshot();
    if (group === "plan") {
      const date = dateKey || state.cursor;
      const dom = ids.map((id) => (String(id).includes(":") ? String(id) : `t:${id}`));
      const domSet = new Set(dom);
      const full = listTokens(date);
      const listedAll = full.length === dom.length && full.every((token) => domSet.has(token));
      const queue = dom.filter((token) => full.includes(token));
      const sequence = listedAll ? dom : full.map((token) => (domSet.has(token) ? queue.shift() : token));
      let taskAt = 0;
      sequence.forEach((token) => {
        const cut = String(token).indexOf(":");
        if (cut < 0) return;
        const kind = token.slice(0, cut);
        const id = token.slice(cut + 1);
        if (kind === "h") {
          const habit = state.habits.find((h) => h.id === id);
          if (habit) habit.order = taskAt;
        } else {
          const task = state.tasks.find((t) => t.id === id);
          if (task) task.order = taskAt;
        }
        taskAt += 1;
      });
      state.dayMeta[date] = { ...(state.dayMeta[date] || {}), manualOrder: true, planOrder: sequence };
      await Promise.all(sequence.map((token) => {
        const cut = String(token).indexOf(":");
        if (cut < 0) return null;
        const kind = token.slice(0, cut);
        const id = token.slice(cut + 1);
        if (kind === "h") {
          const habit = state.habits.find((h) => h.id === id);
          return habit ? DB().putHabit(habit) : null;
        }
        const task = state.tasks.find((t) => t.id === id);
        return task ? DB().putTask(task) : null;
      }));
      await DB().saveDayMeta(state.dayMeta);
      renderSheets(true);
      refreshShop();
      offerUndo("порядок", () => restore(before));
      return;
    }
    if (group === "loose") {
      ids.forEach((id, i) => {
        const task = state.tasks.find((t) => t.id === id);
        if (task) task.order = i;
      });
      await Promise.all(ids.map((id) => {
        const task = state.tasks.find((t) => t.id === id);
        return task ? DB().putTask(task) : null;
      }));
    } else {
      ids.forEach((id, i) => {
        const item = state.errands.find((e) => e.id === id);
        if (item) item.order = i;
      });
      await Promise.all(ids.map((id) => {
        const item = state.errands.find((e) => e.id === id);
        return item ? DB().putErrand(item) : null;
      }));
    }
    renderSheets(true);
    refreshShop();
    offerUndo("порядок", () => restore(before));
  }

  async function commitBlock(dragState) {
    const dy = dragState.y - dragState.y0;
    const delta = Math.round(((dy / D().HOUR) * 60) / 15) * 15;
    if (!delta) {
      renderSheets(false);
      return;
    }
    const before = snapshot();
    if (dragState.blockKind === "habit") {
      const habit = state.habits.find((h) => h.id === dragState.id);
      if (!habit) return;
      const origin = dragState.origin == null ? 21 * 60 : dragState.origin;
      habit.timeMin = clamp(origin + delta, 0, 23 * 60 + 45);
      habit.anchor = null;
      habit.updatedAt = Date.now();
      await DB().putHabit(habit);
    } else {
      const task = state.tasks.find((t) => t.id === dragState.id);
      if (!task) return;
      if (task.kind === "slot" || task.startMin == null) {
        const origin = task.startMin == null ? task.endMin : task.startMin;
        const next = clamp((origin || 0) + delta, 0, 23 * 60 + 45);
        if (task.kind === "slot") task.startMin = next;
        else task.endMin = clamp((task.endMin || 0) + delta, 15, 24 * 60);
      } else if (dragState.zone === "start") {
        task.startMin = clamp(task.startMin + delta, 0, (task.endMin || task.startMin + 60) - 15);
      } else if (dragState.zone === "end") {
        task.endMin = clamp((task.endMin || task.startMin + 60) + delta, task.startMin + 15, 24 * 60);
      } else {
        const dur = (task.endMin || task.startMin + 60) - task.startMin;
        task.startMin = clamp(task.startMin + delta, 0, 24 * 60 - dur);
        if (task.endMin != null) task.endMin = task.startMin + dur;
      }
      task.updatedAt = Date.now();
      await DB().putTask(task);
    }
    renderSheets(true);
    offerUndo("время", () => restore(before));
  }

  function goTo(key, keepSheet) {
    const delta = D().diffDays(state.cursor, key);
    if (!delta) return;
    if (Math.abs(delta) === 1 && !keepSheet) {
      slideDay(delta);
      return;
    }
    if (!keepSheet) closeEdit(true);
    state.cursor = key;
    if (keepSheet && state.overlay && state.overlay.type === "days") state.cal = key;
    renderHeader();
    renderSheets(false);
    const track = $("#track");
    track.style.transition = "none";
    track.style.transform = "translateX(-33.333333%)";
    track.offsetHeight;
    if (keepSheet && state.overlay && state.overlay.type === "days") renderOverlay();
  }

  function slideDay(delta) {
    if (state.sliding || !delta) return;
    if (M().reduce()) {
      commitCursor(delta);
      return;
    }
    state.sliding = true;
    const token = ++slideToken;
    const track = $("#track");
    track.style.transition = "transform 320ms cubic-bezier(.22,.8,.2,1)";
    track.style.transform = `translateX(${delta > 0 ? "-66.666666%" : "0%"})`;
    const finish = () => {
      if (slideToken !== token) return;
      slideToken += 1;
      commitCursor(delta);
    };
    track.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 380);
  }

  function commitCursor(delta) {
    if (state.overlay) state.overlay.returnTo = null;
    closeEdit(true);
    state.cursor = D().addDays(state.cursor, delta);
    state.sliding = false;
    const track = $("#track");
    track.style.transition = "none";
    renderHeader();
    renderSheets(false);
    track.style.transform = "translateX(-33.333333%)";
    track.offsetHeight;
    track.style.transition = "";
    updateGhost();
  }

  function settleDay(dx, dt) {
    const width = $("#deck").clientWidth || 1;
    const v = dx / Math.max(dt, 1);
    let delta = 0;
    if (dx < -width * 0.18 || v < -0.5) delta = 1;
    else if (dx > width * 0.18 || v > 0.5) delta = -1;
    const track = $("#track");
    if (!delta) {
      track.style.transition = "transform 260ms cubic-bezier(.2,.9,.2,1)";
      track.style.transform = "translateX(-33.333333%)";
      state.sliding = false;
      return;
    }
    state.sliding = true;
    const token = ++slideToken;
    track.style.transition = "transform 220ms cubic-bezier(.2,.8,.2,1)";
    track.style.transform = `translateX(${delta > 0 ? "-66.666666%" : "0%"})`;
    const finish = () => {
      if (slideToken !== token) return;
      slideToken += 1;
      commitCursor(delta);
    };
    track.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 280);
  }

  function begin(e, input) {
    if (state.sliding || drag) return;
    const target = e.target;
    if (target.closest("input, textarea, [contenteditable]")) return;
    const point = xy(e);
    const row = target.closest(".row");
    const inSheet = !!target.closest("#sheet-ui");
    const head = target.closest(".group-h");
    const block = target.closest(".block");
    const base = {
      input,
      x0: point.x,
      y0: point.y,
      x: point.x,
      y: point.y,
      t0: Date.now(),
      mode: null,
      timer: null,
      target
    };
    if (row && row.classList.contains("is-edit")) return;
    if (row && target.closest(".grip")) {
      drag = { ...base, kind: "row", el: row, id: row.dataset.id, rowKind: row.dataset.kind, fromGrip: true };
      return;
    }
    if (inSheet) {
      if (!row || target.closest("[data-act]")) return;
      drag = { ...base, kind: "row", el: row, id: row.dataset.id, rowKind: row.dataset.kind };
      drag.timer = setTimeout(() => armMenu(drag), HIT.press);
      return;
    }
    if (block) {
      const rect = block.getBoundingClientRect();
      const local = point.y - rect.top;
      let zone = "body";
      if (block.classList.contains("window")) {
        if (local < 14) zone = "start";
        else if (local > rect.height - 14) zone = "end";
      }
      drag = {
        ...base,
        kind: "block",
        el: block,
        id: block.dataset.id,
        blockKind: block.dataset.kind,
        rowKind: block.dataset.kind === "habit" ? "habit" : "task",
        zone
      };
      drag.timer = setTimeout(() => armMenu(drag), HIT.press);
      if (drag.blockKind === "habit") {
        const habit = state.habits.find((h) => h.id === drag.id);
        drag.origin = habit ? D().habitAt(habit) : 21 * 60;
      } else {
        const task = state.tasks.find((t) => t.id === drag.id);
        drag.origin = task ? (task.startMin != null ? task.startMin : task.endMin) : state.settings.workStartMin;
      }
      return;
    }
    if ((row || head) && !target.closest("[data-act]")) {
      const el = row || head;
      drag = { ...base, kind: "row", el, id: el.dataset.id, rowKind: el.dataset.kind };
      drag.timer = setTimeout(() => armMenu(drag), HIT.press);
      return;
    }
    drag = { ...base, kind: "day" };
  }

  function armMenu(current) {
    if (!drag || drag !== current || drag.mode) return;
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 8) return;
    if (!current.rowKind) return;
    drag.mode = "menu";
    if (navigator.vibrate) navigator.vibrate(8);
    openMenu(current.rowKind, current.id);
  }

  function armReorder(current) {
    if (!drag || drag !== current || drag.mode) return;
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 8) return;
    const group = drag.el.closest("[data-group]");
    if (!group || drag.el.classList.contains("is-done")) return;
    drag.mode = "reorder";
    drag.group = group;
    drag.el.classList.add("is-lifted");
    document.body.classList.add("is-dragging");
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function move(e, input) {
    if (!drag || drag.input !== input) return;
    const point = xy(e);
    drag.x = point.x;
    drag.y = point.y;
    const dx = point.x - drag.x0;
    const dy = point.y - drag.y0;
    if (drag.kind === "day") {
      if (!drag.mode) {
        if (Math.abs(dx) < HIT.claim && Math.abs(dy) < HIT.claim) return;
        if (Math.abs(dy) > Math.abs(dx) || (drag.x0 < 28 && dx > 0)) {
          drag = null;
          return;
        }
        drag.mode = "x";
        state.sliding = true;
      }
      if (drag.mode === "x") {
        if (e.cancelable) e.preventDefault();
        const track = $("#track");
        track.style.transition = "none";
        track.style.transform = `translateX(calc(-33.333333% + ${dx}px))`;
      }
      return;
    }
    if (drag.kind === "block") {
      if (!drag.mode) {
        if (Math.abs(dx) < HIT.claim && Math.abs(dy) < HIT.claim) return;
        if (Date.now() - drag.t0 < HIT.dragDelay) {
          if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 14) drag = null;
          return;
        }
        if (Math.abs(dx) > Math.abs(dy)) {
          clearTimeout(drag.timer);
          drag.kind = "row";
          drag.mode = dx > 0 ? "defer" : "done";
          document.body.classList.add("is-dragging");
          return;
        }
        drag.mode = "time";
        document.body.classList.add("is-dragging");
      }
      if (drag.mode === "time") {
        if (e.cancelable) e.preventDefault();
        drag.el.style.transform = `translateY(${dy}px)`;
        const time = drag.el.querySelector(".block-time");
        if (time && drag.origin != null) {
          const delta = Math.round(((dy / D().HOUR) * 60) / 15) * 15;
          time.textContent = D().clockLabel(clamp(drag.origin + delta, 0, 23 * 60 + 45), { short: true });
        }
      }
      return;
    }
    if (drag.fromGrip) {
      if (!drag.mode) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        if (Math.abs(dy) < 8 && Math.abs(dx) >= Math.abs(dy)) drag.mode = "grip-hold";
        else {
          const group = drag.el.closest("[data-group]");
          if (!group) {
            drag = null;
            return;
          }
          drag.mode = "reorder";
          drag.group = group;
          drag.el.classList.add("is-lifted");
          document.body.classList.add("is-dragging");
          if (navigator.vibrate) navigator.vibrate(8);
        }
      }
      if (drag.mode === "grip-hold") return;
    }
    if (!drag.mode) {
      if (Math.abs(dx) < HIT.claim && Math.abs(dy) < HIT.claim) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }
      if (Date.now() - drag.t0 < HIT.dragDelay) return;
      clearTimeout(drag.timer);
      if (Math.abs(dx) > Math.abs(dy)) drag.mode = dx > 0 ? "defer" : "done";
      else {
        drag = null;
        return;
      }
      document.body.classList.add("is-dragging");
    }
    if (e.cancelable && drag.mode !== "scroll") e.preventDefault();
    const el = drag.el;
    if (drag.mode === "done") {
      const pull = Math.min(0, Math.max(dx, -110));
      el.style.transform = `translateX(${pull}px)`;
      el.style.setProperty("--strike", String(Math.min(1, -pull / HIT.done)));
      return;
    }
    if (drag.mode === "defer" || drag.mode === "depth") {
      const held = Date.now() - drag.t0;
      if (drag.mode === "defer" && drag.rowKind !== "errand" && drag.rowKind !== "errand-head") {
        if (dy > HIT.depthDy || (held > HIT.hold && dx > HIT.defer && dy > 12)) {
          openDepth(drag);
          drag.mode = "depth";
        }
      }
      if (drag.mode === "depth") {
        el.style.transform = `translateX(${Math.min(dx, 120)}px) scale(0.98)`;
        pickPlate(drag, point.y);
        return;
      }
      el.style.transform = `translateX(${Math.max(0, dx)}px)`;
      return;
    }
    if (drag.mode === "reorder") {
      if (e.cancelable) e.preventDefault();
      const scrolled = nudgeScroll(point.y);
      if (scrolled) drag.y0 -= scrolled;
      const shift = point.y - drag.y0;
      el.style.transform = `translateY(${shift}px) scale(1.02)`;
      const next = neighborTask(el, 1);
      const prev = neighborTask(el, -1);
      const mid = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
      if (next && mid > next.getBoundingClientRect().top + next.offsetHeight * 0.55) {
        const h = next.getBoundingClientRect().height;
        drag.group.insertBefore(el, next.nextSibling);
        drag.y0 += h;
        el.style.transform = `translateY(${point.y - drag.y0}px) scale(1.02)`;
      } else if (prev && mid < prev.getBoundingClientRect().top + prev.offsetHeight * 0.45) {
        const h = prev.getBoundingClientRect().height;
        drag.group.insertBefore(el, prev);
        drag.y0 -= h;
        el.style.transform = `translateY(${point.y - drag.y0}px) scale(1.02)`;
      }
    }
  }

  function neighborTask(el, dir) {
    const node = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    if (!node || !node.classList.contains("row")) return null;
    if (node.dataset.kind !== "task" && node.dataset.kind !== "habit") return null;
    return node;
  }

  function nudgeScroll(y) {
    const scroller = drag && drag.el && drag.el.closest(".sheet");
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    let delta = 0;
    if (y < rect.top + 48) delta = -14;
    else if (y > rect.bottom - 48) delta = 14;
    if (!delta) return 0;
    const before = scroller.scrollTop;
    scroller.scrollTop += delta;
    return scroller.scrollTop - before;
  }

  function openDepth(current) {
    if (current.depth) return;
    const days = [1, 2, 3, 4, 5, 6, 7, 14];
    const el = document.createElement("div");
    el.className = "depth";
    el.innerHTML = days
      .map((n) => `<div class="plate" data-days="${n}"><span>${esc(plateName(current, n))}</span></div>`)
      .join("");
    current.el.after(el);
    current.depth = el;
    current.days = days;
    current.pick = 0;
    if (!M().reduce()) {
      el.animate(
        [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
        { duration: 160, easing: "cubic-bezier(.2,.7,.2,1)" }
      );
    }
  }

  function plateName(current, days) {
    let from = state.cursor;
    if (current.rowKind === "task") {
      const task = state.tasks.find((t) => t.id === current.id);
      if (task) from = task.date;
    } else if (current.rowKind === "habit") {
      const habit = state.habits.find((h) => h.id === current.id);
      if (habit) {
        const base = habit.nextDue > state.today ? habit.nextDue : state.today;
        const landing = D().addDays(base, days);
        const h = D().head(landing, state.today);
        const name = days === 1 ? "завтра" : days === 2 ? "послезавтра" : `+${days}`;
        return `${name} · ${h.short} ${h.day}`;
      }
    }
    const landing = D().addDays(from, days);
    const h = D().head(landing, from);
    const name = days === 1 ? "завтра" : days === 2 ? "послезавтра" : `+${days}`;
    return `${name} · ${h.short} ${h.day}`;
  }

  function pickPlate(current, y) {
    if (!current.depth) return;
    const plates = [...current.depth.children];
    const taskRect = current.el.getBoundingClientRect();
    if (y <= taskRect.bottom) {
      if (current.pick !== 0 && navigator.vibrate) navigator.vibrate(6);
      current.pick = 0;
      current.el.classList.add("is-stay");
      plates.forEach((plate) => plate.classList.remove("is-on"));
      return;
    }
    current.el.classList.remove("is-stay");
    let best = -1;
    plates.forEach((plate, i) => {
      const rect = plate.getBoundingClientRect();
      if (y > rect.top + rect.height * 0.35) best = i;
    });
    if (best < 0) {
      current.pick = 0;
      plates.forEach((plate) => plate.classList.remove("is-on"));
      return;
    }
    plates.forEach((plate, i) => plate.classList.toggle("is-on", i === best));
    if (current.pick !== current.days[best] && navigator.vibrate) navigator.vibrate(6);
    current.pick = current.days[best];
  }

  function end(e, input) {
    if (!drag || drag.input !== input) return;
    const current = drag;
    clearTimeout(current.timer);
    const point = xy(e);
    const dx = point.x - current.x0;
    const dy = point.y - current.y0;
    const dt = Date.now() - current.t0;
    drag = null;
    document.body.classList.remove("is-dragging");
    if (current.fromGrip && current.mode !== "reorder") {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 320);
      return;
    }
    if (current.mode === "menu") {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
      return;
    }
    if (current.mode === "x") {
      settleDay(dx, dt);
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      return;
    }
    if (current.kind === "block") {
      current.el.style.transform = "";
      if (current.mode === "time") {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 350);
        commitBlock(current);
      }
      return;
    }
    if (current.mode === "reorder") {
      current.el.classList.remove("is-lifted");
      current.el.style.transform = "";
      if (Math.hypot(dx, dy) < 8) return;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      const ids = [...current.group.querySelectorAll(".row")].filter((row) => row.dataset.kind === "task" || row.dataset.kind === "habit").map((row) => `${row.dataset.kind === "habit" ? "h" : "t"}:${row.dataset.id}`);
      const date = (current.el.closest(".sheet") || {}).dataset;
      persistOrder(current.group.dataset.group, ids, date && date.date);
      return;
    }
    if (current.el) current.el.classList.remove("is-stay");
    if (current.depth) current.depth.remove();
    const el = current.el;
    const commitDone = current.mode === "done" && dx < -HIT.done;
    const quickDefer = current.mode === "defer" && dx > HIT.defer && dy < HIT.depthDy;
    const deep = current.mode === "depth" && current.pick;
    if (commitDone || quickDefer || deep) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
      resolveRow(current, commitDone ? "done" : "defer", deep ? current.pick : 1);
      return;
    }
    if (current.mode) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 300);
      el.style.transition = "transform 220ms cubic-bezier(.2,.9,.2,1)";
      el.style.transform = "";
      el.style.setProperty("--strike", el.classList.contains("is-done") ? "1" : "0");
    }
  }

  function resolveRow(current, action, days) {
    const kind = current.rowKind;
    const id = current.id;
    if (kind === "errand-head") {
      if (action === "done") toggleWent();
      else snap(current.el);
      return;
    }
    if (kind === "errand") {
      const item = state.errands.find((x) => x.id === id);
      if (!item) return;
      if (action === "done") {
        if (item.done) restoreErrand(id);
        else completeErrand(id);
      } else snap(current.el);
      return;
    }
    if (kind === "habit") {
      const habit = state.habits.find((h) => h.id === id);
      const st = habit ? D().habitState(habit, state.cursor, state.today) : null;
      if (action === "done") {
        if (st === "done") undoHabit(id);
        else completeHabit(id);
      } else shiftHabit(id, days);
      return;
    }
    if (kind === "habit-done") {
      if (action === "done") undoHabit(id);
      else snap(current.el);
      return;
    }
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    if (action === "done") {
      if (task.done) restoreTask(id);
      else completeTask(id);
    } else moveTask(id, days);
  }

  function snap(el) {
    if (!el) return;
    el.style.transition = "transform 220ms cubic-bezier(.2,.9,.2,1)";
    el.style.transform = "";
  }

  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.depth) drag.depth.remove();
    if (drag.el) {
      drag.el.style.transform = "";
      drag.el.classList.remove("is-lifted");
    }
    drag = null;
    document.body.classList.remove("is-dragging");
    state.sliding = false;
    const track = $("#track");
    track.style.transition = "none";
    track.style.transform = "translateX(-33.333333%)";
  }

  function onClick(e) {
    if (swallowClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target.closest(".grip")) return;
    const act = e.target.closest("[data-act]");
    if (act && act.closest("#app")) {
      onAct(act);
      return;
    }
    const kind = e.target.closest("[data-set-kind]");
    if (kind) {
      changeKind(kind.dataset.setKind);
      return;
    }
    const wd = e.target.closest("[data-weekday]");
    if (wd && state.editDraft && state.editing && state.editing.kind === "habit") {
      const raw = wd.dataset.weekday;
      if (raw === "") state.editDraft.weekday = null;
      else {
        const weekday = +raw;
        state.editDraft.weekday = weekday;
        state.editDraft.everyMin = 7;
        state.editDraft.everyMax = 7;
        const base = state.editDraft.nextDue && state.editDraft.nextDue >= state.today ? state.editDraft.nextDue : state.today;
        state.editDraft.nextDue = D().dow(base) === weekday ? base : D().nextDow(base, weekday, false);
      }
      writeHabitDraft();
      return;
    }
    const anchor = e.target.closest("[data-anchor]");
    if (anchor && state.editDraft) {
      state.editDraft.anchor = anchor.dataset.anchor;
      const habit = state.habits.find((h) => state.editing && h.id === state.editing.id);
      if (habit) {
        habit.anchor = anchor.dataset.anchor || null;
        habit.updatedAt = Date.now();
        DB().putHabit(habit);
      }
      renderOverlay();
      return;
    }
    const block = e.target.closest(".block");
    if (block) {
      if (block.dataset.kind === "task") tapTask(block.dataset.id);
      else tapHabit(block.dataset.id);
      return;
    }
    if (e.target.closest("input, textarea, button")) return;
    const row = e.target.closest(".row");
    if (!row || !row.dataset.kind || row.dataset.kind === "habit-done" || row.dataset.kind === "errand-head") return;
    if (row.dataset.kind === "task") tapTask(row.dataset.id);
    else if (row.dataset.kind === "habit") tapHabit(row.dataset.id);
    else openEdit("errand", row.dataset.id);
  }

  function tapTask(id) {
    const now = Date.now();
    if (tapWait && tapWait.kind === "task" && tapWait.id === id && now - tapWait.at < 320) {
      clearTimeout(tapWait.timer);
      tapWait = null;
      const task = state.tasks.find((t) => t.id === id);
      if (task && task.done) restoreTask(id);
      else completeTask(id);
      return;
    }
    const timer = setTimeout(() => {
      if (tapWait && tapWait.id === id) {
        tapWait = null;
        openEdit("task", id);
      }
    }, 300);
    tapWait = { id, kind: "task", at: now, timer };
  }

  function tapHabit(id) {
    const now = Date.now();
    if (tapWait && tapWait.kind === "habit" && tapWait.id === id && now - tapWait.at < 320) {
      clearTimeout(tapWait.timer);
      tapWait = null;
      const habit = state.habits.find((h) => h.id === id);
      const st = habit ? D().habitState(habit, state.cursor, state.today) : null;
      if (st === "done") undoHabit(id);
      else completeHabit(id);
      return;
    }
    const timer = setTimeout(() => {
      if (tapWait && tapWait.id === id) {
        tapWait = null;
        openEdit("habit", id);
      }
    }, 300);
    tapWait = { id, kind: "habit", at: now, timer };
  }

  function onAct(el) {
    const act = el.dataset.act;
    if (act === "toggle-shop" || act === "open-shop") {
      openShop();
      return;
    }
    if (act === "new-loose" || act === "new-timed") {
      createDraftTask(act === "new-timed" ? "slot" : "loose");
      return;
    }
    if (act === "new-shop") {
      const seed = (state.overlay && state.overlay.title) || "";
      writeLine("");
      updateGhost();
      openShop({ seed, focus: true });
      return;
    }
    if (act === "text-size") {
      state.settings = { ...state.settings, textSize: el.dataset.size || "m" };
      DB().saveSettings(state.settings);
      applyTextSize();
      renderOverlay();
      return;
    }
    if (act === "pick-day") {
      goTo(el.dataset.date, true);
      return;
    }
    if (act === "cal-prev" || act === "cal-next") {
      shiftMonth(act === "cal-next" ? 1 : -1);
      return;
    }
    if (act === "hour-add") {
      addSlotAt(+el.dataset.min);
      return;
    }
    if (act === "done-style") {
      state.settings = { ...state.settings, doneStyle: el.dataset.style };
      DB().saveSettings(state.settings);
      renderOverlay();
      renderSheets(false);
      return;
    }
    if (act === "menu-done" || act === "menu-tomorrow" || act === "menu-move" || act === "menu-edit" || act === "menu-insert" || act === "menu-delete" || act === "menu-up" || act === "menu-down" || act === "pick-shift") {
      runMenu(act, el);
      return;
    }
    if ((act === "from-plus" || act === "from-minus" || act === "from-clear" || act === "from-set") && state.editDraft) {
      const title = $("#sheet-title");
      if (title) state.editDraft.title = title.value;
      if (act === "from-clear") state.editDraft.from = null;
      else if (act === "from-set") state.editDraft.from = el.dataset.date;
      else if (!state.editDraft.from) state.editDraft.from = D().addDays(state.cursor, act === "from-plus" ? 1 : 0);
      else state.editDraft.from = D().addDays(state.editDraft.from, act === "from-plus" ? 1 : -1);
      renderOverlay();
      return;
    }
    if (act === "errand-tag" && state.editDraft) {
      const title = $("#sheet-title");
      if (title) state.editDraft.title = title.value;
      state.editDraft.tag = el.dataset.tag || "buy";
      if (state.editDraft.tag === "buy") state.editDraft.from = null;
      renderOverlay();
      return;
    }
    if (act === "insert-after" && state.editing) {
      const id = state.editing.id;
      if (closeEdit(true) === false) return;
      insertAfter(id);
      return;
    }
    if (act === "toggle-rail") toggleRail();
    else if (act === "toggle-done") {
      state.doneOpen[state.cursor] = !state.doneOpen[state.cursor];
      renderSheets(false);
    } else if (act === "delete" && state.editing) {
      const { kind, id } = state.editing;
      closeEdit(false);
      if (kind === "task") removeTask(id);
      else if (kind === "habit") removeHabit(id);
      else removeErrand(id);
    } else if ((act === "shift-plus" || act === "shift-minus") && state.editing) {
      const days = act === "shift-plus" ? 1 : -1;
      const { kind, id } = state.editing;
      closeEdit(false);
      if (kind === "habit") shiftHabit(id, days);
      else moveTask(id, days);
    } else if (act === "every-step" || act === "every-slack" || act === "every-preset") {
      tuneHabit(act, el);
    } else if (act === "toggle-shop-old" || act === "toggle-shop-wait") {
      if (act === "toggle-shop-old") state.shopOld = !state.shopOld;
      else state.shopWait = !state.shopWait;
      renderOverlay();
    } else if (act === "work-start" || act === "work-end") bumpWork(act === "work-start" ? "start" : "end", +el.dataset.delta || 0);
    else if (act === "work-day") toggleWorkDay(+el.dataset.dow);
    else if (act === "export") exportJson();
    else if (act === "import-merge" || act === "import-replace") {
      state.importMode = act === "import-replace" ? "replace" : "merge";
      $("#import-file").click();
    }
  }

  function onSubmit(e) {
    const form = e.target.closest(".inline-add");
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector(".errand-line");
    if (!input) return;
    const text = input.value;
    input.value = "";
    addErrandFrom(text);
  }

  function onChange(e) {
    if (e.target.classList && e.target.classList.contains("clock")) applyClockField(e.target);
  }

  function onInput(e) {
    if (!state.editDraft) return;
    if (e.target.id === "sheet-title") state.editDraft.title = e.target.value;
    if (e.target.id !== "edit-time") return;
    state.editDraft.timeText = e.target.value;
    const hint = $("#time-hint");
    if (!hint) return;
    const parsed = D().parseWhen(e.target.value);
    if (!e.target.value.trim()) {
      hint.textContent = "";
      hint.classList.remove("is-bad");
      return;
    }
    if (!parsed.ok) {
      hint.textContent = "не разобрал — можно 14:30, 1430, 12-14 или до 16";
      hint.classList.add("is-bad");
      return;
    }
    hint.classList.remove("is-bad");
    hint.textContent = parsed.kind === "window"
      ? D().rangeLabel(parsed.startMin, parsed.endMin)
      : D().clockLabel(parsed.startMin);
  }

  function runMenu(act, el) {
    const overlay = state.overlay || {};
    const id = el.dataset.id || overlay.id;
    const kind = el.dataset.kind || overlay.kind;
    if (act === "menu-move") {
      state.overlay = { type: "move", kind, id };
      renderOverlay();
      return;
    }
    if (act === "menu-edit") {
      openEdit(kind === "habit" ? "habit" : kind === "errand" ? "errand" : "task", id, { force: true });
      return;
    }
    if (act === "pick-shift") {
      const days = +el.dataset.days || 1;
      closeOverlay(true);
      if (kind === "habit") shiftHabit(id, days);
      else moveTask(id, days);
      return;
    }
    closeOverlay(true);
    if (act === "menu-done") resolveRow({ rowKind: kind, id, el: rowEl(id) }, "done", 1);
    else if (act === "menu-tomorrow") {
      if (kind === "habit") shiftHabit(id, 1);
      else moveTask(id, 1);
    } else if (act === "menu-insert") insertAfter(id);
    else if (act === "menu-up") nudge(id, -1);
    else if (act === "menu-down") nudge(id, 1);
    else if (act === "menu-delete") {
      if (kind === "habit") removeHabit(id);
      else if (kind === "errand") removeErrand(id);
      else removeTask(id);
    }
  }

  async function insertAfter(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    const before = snapshot();
    const siblings = state.tasks
      .filter((t) => t.date === task.date && t.kind === "loose")
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    let order;
    if (task.kind === "loose") {
      const idx = siblings.findIndex((t) => t.id === task.id);
      const next = siblings[idx + 1];
      order = next ? ((task.order || 0) + (next.order || 0)) / 2 : (task.order || 0) + 1;
    } else {
      order = siblings.length ? (siblings[0].order || 0) - 1 : 1;
    }
    const created = {
      id: DB().id("t"),
      kind: "loose",
      title: "",
      date: task.date,
      order,
      startMin: null,
      endMin: null,
      done: false,
      doneAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    state.tasks.push(created);
    await DB().putTask(created);
    renderSheets(true);
    openEdit("task", created.id, { focus: true, force: true });
    offerUndo("строка после", () => restore(before));
  }

  async function nudge(id, dir) {
    const task = state.tasks.find((t) => t.id === id && t.kind === "loose");
    const errand = state.errands.find((e) => e.id === id);
    const list = task
      ? state.tasks.filter((t) => t.date === task.date && t.kind === "loose").sort((a, b) => (a.order || 0) - (b.order || 0))
      : state.errands.filter((e) => !e.done).sort((a, b) => (a.order || 0) - (b.order || 0));
    const index = list.findIndex((item) => item.id === id);
    const next = index + dir;
    if (index < 0 || next < 0 || next >= list.length) return;
    const before = snapshot();
    const swap = list[index].order;
    list[index].order = list[next].order;
    list[next].order = swap;
    if (task) {
      await DB().putTask(list[index]);
      await DB().putTask(list[next]);
    } else if (errand) {
      await DB().putErrand(list[index]);
      await DB().putErrand(list[next]);
    }
    renderSheets(true);
    refreshShop();
    offerUndo("порядок", () => restore(before));
  }

  function bumpWork(which, delta) {
    const s = { ...state.settings, workDays: [...state.settings.workDays] };
    if (which === "start") s.workStartMin = clamp(s.workStartMin + delta, 5 * 60, 16 * 60);
    else s.workEndMin = clamp(s.workEndMin + delta, 12 * 60, 23 * 60);
    if (s.workEndMin < s.workStartMin + 60) {
      if (which === "start") s.workEndMin = s.workStartMin + 60;
      else s.workStartMin = s.workEndMin - 60;
    }
    state.settings = s;
    DB().saveSettings(s);
    renderPanel();
    renderSheets(false);
  }

  function toggleWorkDay(dow) {
    const days = new Set(state.settings.workDays);
    if (days.has(dow)) days.delete(dow);
    else days.add(dow);
    state.settings = { ...state.settings, workDays: [...days].sort() };
    DB().saveSettings(state.settings);
    renderPanel();
    renderSheets(false);
  }

  function closeOverlay(save) {
    return closeEdit(save);
  }

  async function openSettings() {
    if (state.overlay && state.overlay.type === "settings") {
      closeOverlay(true);
      return;
    }
    if (state.editing) closeEdit(true);
    if (!state.settings.seenLegend) {
      state.settings = { ...state.settings, seenLegend: true };
      await DB().saveSettings(state.settings);
      updateGhost();
    }
    state.overlay = { type: "settings" };
    renderOverlay();
  }

  function shiftMonth(dir) {
    const dt = D().parseKey(state.cal || state.cursor);
    dt.setMonth(dt.getMonth() + dir);
    state.cal = D().dayKey(dt);
    renderOverlay();
  }

  function bindCalendarSwipe() {
    const zone = $("#cal-swipe");
    if (!zone || zone.dataset.bound) return;
    zone.dataset.bound = "1";
    let x0 = 0;
    let y0 = 0;
    zone.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true });
    zone.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      shiftMonth(dx < 0 ? 1 : -1);
    });
  }

  function bindSheetSwipe() {
    const sheet = $("#sheet-ui");
    if (!sheet) return;
    let y0 = 0;
    let x0 = 0;
    let tracking = false;
    sheet.addEventListener("touchstart", (e) => {
      if (!state.overlay || e.touches.length !== 1) return;
      if (e.target.closest("input, textarea, [contenteditable]")) {
        tracking = false;
        return;
      }
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      tracking = sheet.scrollTop <= 0;
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - y0;
      const dx = e.touches[0].clientX - x0;
      if (dy > 10 && dy > Math.abs(dx)) {
        sheet.style.transition = "none";
        sheet.style.transform = `translateY(${Math.min(dy, 220)}px)`;
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    sheet.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const dy = e.changedTouches[0].clientY - y0;
      const dx = e.changedTouches[0].clientX - x0;
      sheet.style.transition = "transform 180ms ease";
      sheet.style.transform = "";
      if (dy > 70 && dy > Math.abs(dx)) closeOverlay(true);
    });
  }

  async function addSlotAt(min) {
    if (!Number.isFinite(min)) return;
    const now = Date.now();
    const task = {
      id: DB().id("t"),
      kind: "slot",
      title: "",
      date: state.cursor,
      order: nextOrder(state.cursor),
      startMin: min,
      endMin: null,
      done: false,
      doneAt: null,
      createdAt: now,
      updatedAt: now
    };
    state.tasks.push(task);
    await DB().putTask(task);
    renderSheets(true);
    openEdit("task", task.id, { focus: true, force: true });
  }

  function openDays() {
    if (state.editing) closeEdit(true);
    state.cal = state.cursor;
    state.overlay = { type: "days" };
    renderOverlay();
  }

  function openMenu(kind, id) {
    const back = (state.overlay && state.overlay.returnTo) || (state.overlay && state.overlay.type === "shop" ? "shop" : null);
    if (state.editing) {
      if (state.overlay) state.overlay.returnTo = null;
      closeEdit(true);
    }
    state.overlay = { type: "menu", kind, id, returnTo: back };
    state.selected = id;
    renderOverlay();
  }

  function renderOverlay() {
    if (!state.overlay) {
      hideOverlay();
      return;
    }
    const type = state.overlay.type;
    let html = "";
    if (type === "settings") html = settingsHTML();
    else if (type === "days") html = calendarHTML();
    else if (type === "menu") html = menuHTML();
    else if (type === "move") html = moveHTML();
    else if (type === "habit") html = habitSheetHTML();
    else if (type === "shop") html = shopHTML();
    else if (type === "compose-new") html = composeNewHTML();
    else html = editSheetHTML();
    showOverlay(html);
    if (type === "days") bindCalendarSwipe();
    if (type === "shop") bindShopLine();
    const title = $("#sheet-title");
    if (title && state.focusTitle) {
      state.focusTitle = false;
      title.focus();
    }
    const form = $("#open-form");
    if (form) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const text = $("#open-line").value.trim();
        if (!text) return;
        const marked = P().parse(`${text} день`, { today: state.cursor });
        if (marked.ok && marked.dateSpoken) {
          closeOverlay(true);
          goTo(marked.date);
        } else setGhost("не разобрал дату", true);
      });
    }
  }

  function renderPanel() {
    if (state.overlay && state.overlay.type === "settings") renderOverlay();
  }

  const MONTH_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

  function calendarHTML() {
    const dt = D().parseKey(state.cal || state.cursor);
    const y = dt.getFullYear();
    const m = dt.getMonth();
    const pad = (firstDow) => (firstDow + 6) % 7;
    const startPad = pad(new Date(y, m, 1).getDay());
    const daysIn = new Date(y, m + 1, 0).getDate();
    const names = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
    const cells = [];
    for (let i = 0; i < startPad; i += 1) cells.push("<span></span>");
    for (let day = 1; day <= daysIn; day += 1) {
      const key = D().dayKey(new Date(y, m, day));
      const cls = ["cal-day"];
      if (key === state.today) cls.push("is-today");
      if (key === state.cursor) cls.push("is-cursor");
      cells.push(`<button type="button" class="${cls.join(" ")}" data-act="pick-day" data-date="${key}">${day}</button>`);
    }
    return `<div class="cal-head">
        <button type="button" class="step" data-act="cal-prev" aria-label="Предыдущий месяц">${ico("chevron")}</button>
        <strong>${MONTH_NOM[m]} ${y}</strong>
        <button type="button" class="step" data-act="cal-next" aria-label="Следующий месяц">${ico("chevron")}</button>
      </div>
      <div class="cal-swipe" id="cal-swipe">
        <div class="cal-week">${names.map((name) => `<span>${name}</span>`).join("")}</div>
        <div class="cal-grid">${cells.join("")}</div>
      </div>`;
  }

  function menuHTML() {
    const { kind, id } = state.overlay;
    const item = (act, label, icon) => `<button type="button" class="menu-item" data-act="${act}" data-id="${esc(id)}" data-kind="${esc(kind)}">${ico(icon)}<span>${label}</span></button>`;
    const parts = [];
    if (kind === "task") {
      const task = state.tasks.find((t) => t.id === id);
      parts.push(item("menu-done", task && task.done ? "снова в дне" : "выполнить", "check"));
      parts.push(item("menu-tomorrow", "на завтра", "sun"));
      parts.push(item("menu-move", "на другой день", "calendar"));
      parts.push(item("menu-edit", "править", "pencil"));
      parts.push(item("menu-insert", "вписать после", "plus"));
      if (task && task.kind === "loose") {
        parts.push(item("menu-up", "выше", "up"));
        parts.push(item("menu-down", "ниже", "down"));
      }
      parts.push(item("menu-delete", "удалить", "trash"));
    } else if (kind === "habit") {
      const habit = state.habits.find((h) => h.id === id);
      const st = habit ? D().habitState(habit, state.cursor, state.today) : null;
      parts.push(item("menu-done", st === "done" ? "снова в дне" : "сделано", "check"));
      parts.push(item("menu-tomorrow", "перенести на завтра", "sun"));
      parts.push(item("menu-move", "на другой день", "calendar"));
      parts.push(item("menu-edit", "править", "pencil"));
      parts.push(item("menu-delete", "удалить", "trash"));
    } else if (kind === "errand") {
      const row = state.errands.find((e) => e.id === id);
      parts.push(item("menu-done", row && row.done ? "снова в списке" : "куплено", "check"));
      parts.push(item("menu-edit", "править", "pencil"));
      parts.push(item("menu-up", "выше", "up"));
      parts.push(item("menu-down", "ниже", "down"));
      parts.push(item("menu-delete", "удалить", "trash"));
    }
    return parts.join("");
  }

  function moveHTML() {
    const days = [1, 2, 3, 4, 5, 6, 7, 14];
    const buttons = days
      .map((n) => `<button type="button" class="menu-item" data-act="pick-shift" data-days="${n}">${esc(plateName({ rowKind: state.overlay.kind, id: state.overlay.id }, n))}</button>`)
      .join("");
    return `<h2>на какой день</h2>${buttons}`;
  }

  function editSheetHTML() {
    const d = state.editDraft;
    const kind = state.editing && state.editing.kind;
    if (kind === "errand") {
      const tag = d.tag || "buy";
      const order = tag === "pickup" || tag === "order";
      const chip = (value, label) =>
        `<button type="button" class="choice${tag === value ? " is-on" : ""}" data-act="errand-tag" data-tag="${value}">${label}</button>`;
      let fromLabel = "пока в общем списке";
      if (d.from) {
        const h = D().head(d.from, state.today);
        fromLabel = `с ${h.weekday}, ${h.day} ${h.month}`;
      }
      const days = [];
      for (let i = 0; i < 7; i += 1) {
        const key = D().addDays(state.today, i);
        const h = D().head(key, state.today);
        const label = i === 0 ? "сегодня" : i === 1 ? "завтра" : `${h.short} ${h.day}`;
        days.push(`<button type="button" class="choice${d.from === key ? " is-on" : ""}" data-act="from-set" data-date="${key}">${label}</button>`);
      }
      const dayRow = order
        ? `<h2>показывать с дня</h2>
           <p class="field-hint">${esc(fromLabel)}. До этого дня пункт спрятан, потом остаётся в списке.</p>
           <div class="kinds from-days">${days.join("")}</div>
           <div class="sheet-row">
             <button type="button" class="sheet-action" data-act="from-minus">раньше</button>
             <button type="button" class="sheet-action" data-act="from-clear">сразу</button>
             <button type="button" class="sheet-action" data-act="from-plus">позже</button>
           </div>`
        : `<p class="field-hint">Покупка всегда в общем списке. Забрать и заказ можно спрятать до выбранного дня.</p>`;
      return `<h2>в списке</h2>
        <input id="sheet-title" class="field" value="${esc(d.title)}" />
        <div class="kinds">${chip("buy", "покупка")}${chip("pickup", "забрать")}${chip("order", "заказ")}</div>
        ${dayRow}
        <button type="button" class="sheet-action" data-act="delete">${ico("trash")}<span>удалить</span></button>`;
    }
    const chip = (value, label) =>
      `<button type="button" data-set-kind="${value}" aria-pressed="${d.kind === value}">${label}</button>`;
    const showTime = d.kind !== "loose";
    return `<h2>задача</h2>
      <input id="sheet-title" class="field" value="${esc(d.title)}" placeholder="что сделать" />
      <div class="kinds">${chip("loose", "весь день")}${chip("window", "окно")}${chip("slot", "час")}<button type="button" data-set-kind="habit">привычка</button></div>
      ${showTime ? `<input id="edit-time" class="field" inputmode="text" value="${esc(timeText(d))}" placeholder="14:30, 1430, 12-14 или до 16" /><p class="field-hint" id="time-hint"></p>` : ""}
      <div class="sheet-row">
        <button type="button" class="sheet-action" data-act="shift-minus">− день</button>
        <button type="button" class="sheet-action" data-act="shift-plus">+ день</button>
      </div>
      <button type="button" class="sheet-action" data-act="insert-after">${ico("plus")}<span>вписать после</span></button>
      <button type="button" class="sheet-action" data-act="delete">${ico("trash")}<span>удалить</span></button>`;
  }

  function habitRhythm(d) {
    if (d.weekday != null) return `каждый ${D().WD[d.weekday]}`;
    const early = d.everyMin || 1;
    const late = Math.max(early, d.everyMax || early);
    if (early === 1 && late === 1) return "каждый день";
    if (early === late) return `каждые ${early} ${D().daysWord(early)}`;
    const extra = late - early;
    return `каждые ${early} ${D().daysWord(early)}, можно ещё ${extra} ${D().daysWord(extra)}`;
  }

  function habitPreviewText(d) {
    const habit = {
      everyMin: d.everyMin || 1,
      everyMax: Math.max(d.everyMin || 1, d.everyMax || d.everyMin || 1),
      weekday: d.weekday == null ? null : d.weekday,
      nextDue: d.nextDue || state.cursor,
      history: []
    };
    const start = habit.nextDue < state.today ? state.today : habit.nextDue;
    const days = [];
    let day = start;
    for (let i = 0; i < 60 && days.length < 3; i += 1) {
      const st = D().habitState(habit, day, state.today);
      if (st === "open" || st === "due") {
        const h = D().head(day, state.today);
        days.push(`${h.short} ${h.day}`);
      }
      day = D().addDays(day, 1);
    }
    return days.length ? `в листе: ${days.join(" · ")}` : "в ближайшие дни не попадает";
  }

  function writeHabitDraft() {
    const habit = state.habits.find((h) => state.editing && h.id === state.editing.id);
    const d = state.editDraft;
    if (!habit || !d) return;
    const title = $("#sheet-title");
    if (title) d.title = title.value;
    habit.title = (d.title || "").trim() || habit.title;
    habit.everyMin = d.everyMin || 1;
    habit.everyMax = Math.max(habit.everyMin, d.everyMax || habit.everyMin);
    habit.weekday = d.weekday == null ? null : d.weekday;
    if (d.nextDue) habit.nextDue = d.nextDue;
    habit.updatedAt = Date.now();
    DB().putHabit(habit);
    renderOverlay();
  }

  function tuneHabit(act, el) {
    const d = state.editDraft;
    if (!d) return;
    const delta = +el.dataset.delta || 0;
    if (act === "every-preset") {
      const n = +el.dataset.every || 1;
      d.everyMin = n;
      d.everyMax = n;
      d.weekday = null;
    } else if (act === "every-step") {
      const slack = Math.max(0, (d.everyMax || 1) - (d.everyMin || 1));
      d.everyMin = clamp((d.everyMin || 1) + delta, 1, 30);
      d.everyMax = d.everyMin + slack;
      d.weekday = null;
    } else {
      const slack = clamp(Math.max(0, (d.everyMax || 1) - (d.everyMin || 1)) + delta, 0, 14);
      d.everyMax = (d.everyMin || 1) + slack;
    }
    writeHabitDraft();
  }

  function habitSheetHTML() {
    const d = state.editDraft;
    const anchor = (name, label) =>
      `<button type="button" data-anchor="${name}" aria-pressed="${(d.anchor || "") === name}">${label}</button>`;
    const early = d.everyMin || 1;
    const slack = Math.max(0, (d.everyMax || early) - early);
    const preset = (n, label) => {
      const on = d.weekday == null && early === n && slack === 0;
      return `<button type="button" class="choice${on ? " is-on" : ""}" data-act="every-preset" data-every="${n}">${label}</button>`;
    };
    const names = [1, 2, 3, 4, 5, 6, 0];
    const days = names.map((dow) => {
      const on = d.weekday === dow ? " is-on" : "";
      return `<button type="button" class="day-toggle${on}" data-weekday="${dow}" aria-pressed="${d.weekday === dow}">${D().WD_SHORT[dow]}</button>`;
    }).join("");
    return `<h2>привычка</h2>
      <input id="sheet-title" class="field" value="${esc(d.title)}" placeholder="что повторять" />
      <h2>как часто</h2>
      <p class="field-hint">${esc(habitRhythm(d))}. ${esc(habitPreviewText(d))}.</p>
      <div class="kinds">${preset(1, "каждый день")}${preset(2, "раз в 2")}${preset(3, "раз в 3")}${preset(7, "раз в неделю")}</div>
      <div class="sheet-row">
        <button type="button" class="sheet-action" data-act="every-step" data-delta="-1">чаще</button>
        <span class="clock-read">каждые ${early}</span>
        <button type="button" class="sheet-action" data-act="every-step" data-delta="1">реже</button>
      </div>
      <h2>окно</h2>
      <p class="field-hint">${slack ? `после первого дня можно ещё ${slack} ${esc(D().daysWord(slack))}` : "ровно в рассчитанный день"}</p>
      <div class="sheet-row">
        <button type="button" class="sheet-action" data-act="every-slack" data-delta="-1">уже</button>
        <span class="clock-read">${slack ? `+${slack}` : "ровно"}</span>
        <button type="button" class="sheet-action" data-act="every-slack" data-delta="1">шире</button>
      </div>
      <h2>или день недели</h2>
      <p class="field-hint">Если выбран день, ритм становится недельным. «любой» возвращает «каждые N».</p>
      <div class="weekdays">
        <button type="button" class="day-toggle${d.weekday == null ? " is-on" : ""}" data-weekday="" aria-pressed="${d.weekday == null}">любой</button>
        ${days}
      </div>
      <h2>время суток</h2>
      <div class="kinds">${anchor("", "без часа")}${anchor("morning", "утро")}${anchor("day", "день")}${anchor("evening", "вечер")}${anchor("night", "ночь")}</div>
      <h2>ближайший раз</h2>
      <p class="field-hint">Сдвигает следующее появление и дни после него.</p>
      <div class="sheet-row">
        <button type="button" class="sheet-action" data-act="shift-minus">на день раньше</button>
        <button type="button" class="sheet-action" data-act="shift-plus">на день позже</button>
      </div>
      <button type="button" class="sheet-action" data-act="delete">${ico("trash")}<span>удалить привычку</span></button>`;
  }

  function settingsHTML() {
    const s = state.settings;
    const days = D().WD_SHORT.map((name, i) => {
      const on = s.workDays.includes(i) ? " is-on" : "";
      return `<button type="button" class="day-toggle${on}" data-act="work-day" data-dow="${i}" aria-pressed="${s.workDays.includes(i)}">${name}</button>`;
    }).join("");
    const done = (value, label) =>
      `<button type="button" class="choice${s.doneStyle === value ? " is-on" : ""}" data-act="done-style" data-style="${value}">${label}</button>`;
    const size = (value, label) =>
      `<button type="button" class="choice${(s.textSize || "m") === value ? " is-on" : ""}" data-act="text-size" data-size="${value}">${label}</button>`;
    const info = DB().storageInfo();
    return `<h2>текст</h2>
      <div class="kinds">${size("s", "меньше")}${size("m", "обычно")}${size("l", "крупнее")}</div>
      <h2>сделанное</h2>
      <div class="kinds">${done("fade", "тускнеет")}${done("strike", "черта")}${done("both", "и то и то")}</div>
      <h2>рабочие часы</h2>
      <div class="hours-edit">
        <button type="button" class="step" data-act="work-start" data-delta="-30">−</button>
        <span class="clock-read">${esc(D().clockLabel(s.workStartMin))}</span>
        <button type="button" class="step" data-act="work-start" data-delta="30">+</button>
        <span>–</span>
        <button type="button" class="step" data-act="work-end" data-delta="-30">−</button>
        <span class="clock-read">${esc(D().clockLabel(s.workEndMin))}</span>
        <button type="button" class="step" data-act="work-end" data-delta="30">+</button>
      </div>
      <div class="weekdays">${days}</div>
      <h2>открыть день</h2>
      <form class="open-row" id="open-form">
        <input id="open-line" class="field" placeholder="23.10 или пн" autocomplete="off" enterkeyhint="go" />
      </form>
      <h2>день</h2>
      <ul class="legend">
        <li><b>тап по дате</b> — вернуться на сегодня</li>
        <li><b>долго по дате</b> — календарь</li>
        <li><b>свайп календаря</b> — другой месяц. Выбор даты его не закрывает</li>
        <li><b>лист влево</b> — следующий день</li>
        <li><b>лист вправо</b> — предыдущий день</li>
      </ul>
      <h2>строка</h2>
      <ul class="legend">
        <li><b>вправо</b> — на завтра. Строка уезжает вправо</li>
        <li><b>вправо и вниз</b> — выбрать день. Палец обратно на строку — оставить</li>
        <li><b>влево или двойной тап</b> — выполнить. Строка остаётся на месте</li>
        <li><b>палочки справа</b> — перетащить и поменять местами</li>
        <li><b>долгое нажатие</b> — меню: править, перенести, удалить</li>
        <li><b>удалить</b> — единственный способ стереть строку</li>
      </ul>
      <h2>ввод</h2>
      <ul class="legend">
        <li><b>свайп вверх по полосе внизу</b> — открыть клавиатуру, целиться в поле не нужно</li>
        <li><b>свайп вниз по ней</b> — закрыть клавиатуру и записать строку</li>
        <li><b>строка внизу</b> — пишет в открытый день. Enter, стрелка или галочка над клавиатурой</li>
        <li><b>долго на стрелку</b> — новая задача: весь день, на время или список покупок</li>
        <li><b>сумка</b> — список покупок, на одном месте</li>
      </ul>
      <h2>часы и шторки</h2>
      <ul class="legend">
        <li><b>полоса часов</b> — день по часам. Закрывается кнопкой снизу</li>
        <li><b>тап по пустому часу</b> — задача на это время</li>
        <li><b>шторка вниз или тап мимо</b> — закрыть</li>
      </ul>
      <h2>фразы</h2>
      <ul class="legend">
        <li><b>завтра в 14 врач</b> — день и время</li>
        <li><b>с 12 до 14 обед</b> — промежуток</li>
        <li><b>до 16 отчёт</b> — успеть к часу</li>
        <li><b>купить молоко</b> — в список покупок</li>
        <li><b>забрать озон с пятницы</b> — в списке только с этого дня, не в общем</li>
        <li><b>заказ витамины в пятницу</b> — то же для заказа</li>
        <li><b>привычка мазь раз в 2-3 вечером</b> — ритм, виден на будущих днях</li>
      </ul>
      <h2>устройство</h2>
      <div class="io">
        <button type="button" data-act="export">экспорт</button>
        <button type="button" data-act="import-merge">вгрузить</button>
        <button type="button" data-act="import-replace">заменить файлом</button>
      </div>
      <p class="fine">Данные только на этом устройстве${info.quota ? " · место заканчивается" : ""}.</p>`;
  }

  function removedPanel() {
    const panel = null && $("#panel");
    const more = $("#more");
    if (!panel || !more) return;
    more.setAttribute("aria-expanded", state.panel ? "true" : "false");
    panel.hidden = !state.panel;
    if (!state.panel) {
      panel.innerHTML = "";
      return;
    }
    const s = state.settings;
    const days = D().WD_SHORT.map((name, i) => {
      const on = s.workDays.includes(i) ? " is-on" : "";
      return `<button type="button" class="day-toggle${on}" data-act="work-day" data-dow="${i}" aria-pressed="${s.workDays.includes(i)}">${name}</button>`;
    }).join("");
    const info = DB().storageInfo();
    panel.innerHTML = `
      <h2>рабочие часы</h2>
      <div class="hours-edit">
        <button type="button" class="step" data-act="work-start" data-delta="-30">−</button>
        <span class="clock-read">${esc(D().clockLabel(s.workStartMin))}</span>
        <button type="button" class="step" data-act="work-start" data-delta="30">+</button>
        <span>–</span>
        <button type="button" class="step" data-act="work-end" data-delta="-30">−</button>
        <span class="clock-read">${esc(D().clockLabel(s.workEndMin))}</span>
        <button type="button" class="step" data-act="work-end" data-delta="30">+</button>
      </div>
      <div class="weekdays">${days}</div>
      <h2>открыть день</h2>
      <form class="open-row" id="open-form">
        <input id="open-line" placeholder="23.10 или пн" autocomplete="off" enterkeyhint="go" />
        <button type="submit">открыть</button>
      </form>
      <h2>жесты</h2>
      <ul class="legend">
        <li><b>лист влево</b> — следующий день</li>
        <li><b>строка вправо</b> — вычеркнуть, она тускнеет и садится вниз</li>
        <li><b>влево коротко</b> — на завтра</li>
        <li><b>влево и вниз</b> — глубже, на сколько дней</li>
        <li><b>удержать и вести</b> — порядок строк без времени</li>
        <li><b>тап</b> — править здесь же</li>
        <li><b>полоса ${esc(D().clockLabel(s.workStartMin, { short: true }))}–${esc(D().clockLabel(s.workEndMin, { short: true }))}</b> — раскрыть день по часам</li>
        <li><b>сходить вправо</b> — отметить, что сходил</li>
      </ul>
      <h2>фразы</h2>
      <p class="phrase">завтра в 14 врач</p>
      <p class="phrase">с 12 до 14 обед · до 16 отчёт</p>
      <p class="phrase">через 3 сдать книгу · пн планёрка</p>
      <p class="phrase">купить молоко · в пятницу забрать озон</p>
      <p class="phrase">привычка мазь раз в 2-3 вечером</p>
      <p class="fine">Голос разбирается теми же словами. На iPhone — микрофон на клавиатуре. Если браузер умеет слушать сам, кнопка справа пишет за вас.</p>
      <h2>устройство</h2>
      <div class="io">
        <button type="button" data-act="export">экспорт</button>
        <button type="button" data-act="import-merge">вгрузить</button>
        <button type="button" data-act="import-replace">заменить файлом</button>
      </div>
      <p class="fine">Данные только на этом устройстве${info.quota ? " · место заканчивается" : ""}.</p>`;
    const form = $("#open-form");
    if (form) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const text = $("#open-line").value.trim();
        if (!text) return;
        const marked = P().parse(`${text} день`, { today: state.cursor });
        if (marked.ok && marked.dateSpoken) goTo(marked.date);
        else setGhost("не разобрал дату", true);
      });
    }
  }

  async function exportJson() {
    const data = await DB().exportAll();
    const text = JSON.stringify(data, null, 2);
    const name = `planin-${state.today}.json`;
    const file = new File([text], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Planin" });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      offerUndo("это не json", null);
      return;
    }
    const before = snapshot();
    try {
      await DB().importAll(payload, { merge: state.importMode !== "replace" });
    } catch (err) {
      offerUndo(err.message || "не та копия", null);
      return;
    }
    state.tasks = await DB().listTasks();
    state.errands = await DB().listErrands();
    state.habits = await DB().listHabits();
    state.dayMeta = await DB().getDayMetaAll();
    state.settings = await DB().getSettings();
    state.editing = null;
    applyTextSize();
    renderHeader();
    renderPanel();
    renderSheets(true);
    offerUndo("вгружено", () => restore(before));
  }

  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const line = $("#line");
    const mic = $("#mic");
    if (!SR) {
      line.focus();
      setGhost("на iPhone — микрофон на клавиатуре, фраза разберётся", true);
      return;
    }
    if (state.rec) {
      state.rec.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "ru-RU";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      writeLine(text);
      updateGhost();
    };
    rec.onend = () => {
      state.rec = null;
      mic.classList.remove("is-on");
      const parsed = P().parse(readLine(), { today: state.cursor });
      if (parsed.ok) {
        writeLine("");
        updateGhost();
        commitParsed(parsed);
      }
    };
    rec.onerror = () => {
      state.rec = null;
      mic.classList.remove("is-on");
      if (!readLine()) setGhost("не расслышал — напишите или надиктуйте с клавиатуры", true);
    };
    state.rec = rec;
    mic.classList.add("is-on");
    try {
      rec.start();
    } catch {
      state.rec = null;
      mic.classList.remove("is-on");
    }
  }

  function rows() {
    return [...document.querySelectorAll("#sheet-cur .row, #sheet-cur .block")];
  }

  function moveSelection(dir) {
    const list = rows();
    if (!list.length) return;
    const idx = list.findIndex((el) => el.dataset.id === state.selected);
    const next = list[clamp(idx + dir, 0, list.length - 1)];
    if (idx < 0) state.selected = list[0].dataset.id;
    else state.selected = next.dataset.id;
    renderSheets(false);
    const el = rowEl(state.selected);
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function typingTarget(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      if (state.overlay || state.editing) closeOverlay(true);
      else if (readLine()) {
        writeLine("");
        updateGhost();
      }
      arm = null;
      return;
    }
    if (typingTarget(e.target)) {
      if ((e.target.id === "sheet-title" || e.target.id === "edit-time") && e.key === "Enter") {
        e.preventDefault();
        closeEdit(true);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === "Enter" && state.selected) {
        e.preventDefault();
        const el = rowEl(state.selected);
        if (el) resolveRow({ id: state.selected, rowKind: el.dataset.kind, el }, "done", 1);
      }
      return;
    }
    if (arm === "d" && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const el = rowEl(state.selected);
      arm = null;
      updateGhost();
      if (el) resolveRow({ id: state.selected, rowKind: el.dataset.kind, el }, "defer", +e.key);
      return;
    }
    arm = null;
    if (e.key === "ArrowLeft") slideDay(-1);
    else if (e.key === "ArrowRight") slideDay(1);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter" && state.selected) {
      const el = rowEl(state.selected);
      if (el && el.dataset.kind !== "habit-done") {
        openEdit(el.dataset.kind === "habit" ? "habit" : el.dataset.kind === "errand" ? "errand" : "task", el.dataset.id);
      }
    } else if (e.key === "]" && state.selected) {
      const el = rowEl(state.selected);
      if (el) resolveRow({ id: state.selected, rowKind: el.dataset.kind, el }, "defer", 1);
    } else if (e.key === "[" && state.selected) {
      const el = rowEl(state.selected);
      if (el && el.dataset.kind === "task") moveTask(state.selected, -1);
    } else if (e.key === "d" && state.selected) {
      arm = "d";
      setGhost("на сколько дней — цифра", true);
    } else if (e.key.length === 1) {
      e.preventDefault();
      const line = $("#line");
      const next = readLine() + e.key;
      line.focus();
      writeLine(next);
      updateGhost();
      setCaret(line, next.length);
    }
  }

  function updateNow() {
    document.querySelectorAll("[data-now]").forEach((el) => {
      const rail = el.closest(".rail");
      if (!rail) return;
      const from = +rail.dataset.from || 0;
      const d = new Date();
      const mins = d.getHours() * 60 + d.getMinutes();
      el.style.top = `${((mins - from) / 60) * D().HOUR}px`;
    });
  }

  boot().catch(() => {
    const app = document.getElementById("app");
    if (app) app.textContent = "Не удалось открыть хранилище на устройстве";
  });
})();
