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
  const G = () => window.ListokGesture;
  // R-36: одно время удержания — 450 мс везде, с видимым прогрессом: кольцо у пальца с 150 до 450 мс
  // (до 150 мс ничего, чтобы не мигало при прокрутке). Сдвиг больше 8 px или отпускание — кольцо уходит.
  let ring = null;
  function ringStart(x, y) {
    ringStop();
    const at = { x, y, timer: null, el: null };
    at.timer = setTimeout(() => {
      if (ring !== at || M().reduce()) return;
      const el = document.createElement("div");
      el.className = "hold-ring";
      el.setAttribute("aria-hidden", "true");
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.setProperty("--hold-ms", `${HIT.press - HIT.holdShow}ms`);
      document.body.appendChild(el);
      at.el = el;
    }, HIT.holdShow);
    ring = at;
  }
  function ringStop() {
    if (!ring) return;
    clearTimeout(ring.timer);
    if (ring.el) ring.el.remove();
    ring = null;
  }
  document.addEventListener("pointermove", (e) => { if (ring && Math.hypot(e.clientX - ring.x, e.clientY - ring.y) > 8) ringStop(); }, true);
  document.addEventListener("pointerup", ringStop, true);
  document.addEventListener("pointercancel", ringStop, true);

  // Пороги свайпа строки (claim, axis, commit, flickV, resist, max…) — в js/gesture.js.
  // dragDelay остаётся только для вертикального перетаскивания блока на ленте.
  // gripTap/gripRepeat/gripHold, bridgeMs/bridgePx — ручка и мост двойного тапа (R-22).
  const HIT = Object.assign({ dragDelay: 170, depthDy: 28, depthMin: 24, hold: 190, press: 450, holdShow: 150, gripTap: 350, gripRepeat: 400, gripHold: 450, gripDrag: 170, gripSlop: 8, scrollCalm: 120, bridgeMs: 300, bridgePx: 24, pressShow: 70, pressSlop: 6, sheetClose: 96, sheetFlickV: 0.6, sheetFlickMin: 24, spaceTap: 350, hintMs: 6000, pullShow: 40, pullArm: 72 }, window.ListokGesture.HIT);

  const state = {
    today: "",
    cursor: "",
    tasks: [],
    errands: [],
    habits: [],
    settings: null,
    dayMeta: {},
    selected: null,
    tailOpen: false,
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
    shopWait: false,
    persisted: null
  };

  const scrollMemory = {};
  let drag = null;
  let lastScrollAt = 0; // последняя прокрутка любого листа (для тапа по ручке)
  let swallowClick = false;
  let slideToken = 0;
  let toastTimer = null;
  let undoFn = null;
  let goKey = null;
  let arm = null;
  let lineHold = null;
  let sendHold = false;
  let committing = false;
  let updatePending = false;
  let reloading = false;
  // R-15: черновики строки ввода. localStorage «planin:drafts» = { "<день>" | "shop": {text, caret, at} }.
  // Запись синхронная, поэтому успевает до выгрузки страницы. Без localStorage — kv в IndexedDB.
  const DRAFTS_KEY = "planin:drafts";
  let draftsLS = true;
  let draftsMem = {};
  let draftTimer = null;
  let composerDay = null;
  let pendingCaret = null;
  let lastPointerAt = 0;
  let lastPointerXY = { x: 0, y: 0 };
  let draftNote = null;
  let painting = false;
  let ghostTimer = null;
  // Подсветка ключевых слов через CSS Custom Highlight API (Safari 17.2+):
  // DOM строки ввода при этом не меняется, диктовка и QuickType не ломаются.
  const HL = window.CSS && CSS.highlights && typeof window.Highlight === "function" ? new window.Highlight() : null;
  if (HL) CSS.highlights.set("kw", HL);
  // R-35: разделители дел («потом», «;», …) — своя подсветка, терракотой.
  const HL_SEP = HL ? new window.Highlight() : null;
  if (HL_SEP) CSS.highlights.set("sep", HL_SEP);
  const SEP_RE = /;|(?:^|\s)(потом|затем|а\s+ещ[её]|и\s+ещ[её]|а\s+также)(?=\s|$)/gi;
  const drafts = new Set();

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
      clock: `<circle ${stroke} cx="12" cy="12" r="7.5"/><path ${stroke} d="M12 8v4.5l3 2"/>`,
      close: `<path ${stroke} d="M7 7l10 10M17 7L7 17"/>`,
      share: `<path ${stroke} d="M12 3.5v11"/><path ${stroke} d="M8 7.5l4-4 4 4"/><path ${stroke} d="M8.5 10.5H7a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5"/>`,
      undo: `<path ${stroke} d="M9 6.5L5 10.5l4 4"/><path ${stroke} d="M5.5 10.5H14a5 5 0 0 1 0 10h-2.5"/>`,
      arrow: `<path ${stroke} d="M5 12h13"/><path ${stroke} d="M13 7l5 5-5 5"/>`,
      week: `<rect ${stroke} x="4" y="5" width="16" height="15" rx="2"/><path ${stroke} d="M4 10h16M8 13.5h8M8 16.5h5"/>`,
      addsq: `<rect ${stroke} x="4" y="4" width="16" height="16" rx="4"/><path ${stroke} d="M12 8.5v7M8.5 12h7"/>`
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
  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement || null;
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

  // ?day=ГГГГ-ММ-ДД — открыть этот день (ссылка из заметок, календаря). Параметр убираем из адреса.
  function linkDay() {
    let q;
    try { q = new URLSearchParams(location.search); } catch { return null; }
    const v = q.get("day");
    if (v == null) return null;
    q.delete("day");
    const rest = q.toString();
    try { history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`); } catch { /* file: */ }
    return /^\d{4}-\d{2}-\d{2}$/.test(v) && D().ymdValid(...v.split("-").map(Number)) ? v : null;
  }

  async function boot() {
    await DB().init();
    state.settings = await DB().getSettings();
    state.tasks = await DB().listTasks();
    state.errands = await DB().listErrands();
    state.habits = await DB().listHabits();
    state.dayMeta = await DB().getDayMetaAll();
    state.today = D().todayKey();
    state.cursor = linkDay() || state.today;
    await loadDrafts();
    const restored = await restoreEdits();
    if (restored.length) stashRestored(restored);
    reconcileDrafts();
    await dropEmptyNewTasks();
    applyTextSize();
    mount();
    bind();
    renderHeader();
    renderSheets(false);
    showRestored();
    maybeAutoCarry();
    updateGhost();
    pinViewport();
    showStorageState();
    // R-37: Enter нажали по нарисованной заранее строке, пока приложение грузилось, — записываем сейчас.
    if (window.__planinSnap && window.__planinSnap.enter) {
      window.__planinSnap.enter = false;
      if (readLine().trim()) commitComposer();
    }
    DB().getReplaceBackup().then((b) => { state.replaceBackupAt = b ? b.at || Date.now() : null; }).catch(() => {});
    requestPersist().then(() => {
      maybeInstallHint();
      renderPanel();
    });
    // SW регистрируется один раз, в index.html; обновление могло прийти до boot.
    window.__planinBooted = Date.now();
    if (window.__planinUpdateReady) onUpdate();
    minuteTick();
    setTimeout(buildSuggest, 1500); // R-33: индекс после первой отрисовки (requestIdleCallback в Safari нет)
    bindChips();
  }

  // R-33: подсказки из своей истории. Индекс пересобирается лениво после изменений данных.
  const Sg = () => window.ListokSuggest;
  let suggestIdx = null;
  let suggestDirty = true;
  function buildSuggest() {
    if (!Sg()) return null;
    if (!suggestIdx || suggestDirty) {
      suggestIdx = Sg().build(state.tasks, state.today);
      suggestDirty = false;
    }
    return suggestIdx;
  }
  const WD_DAT = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"];
  // R-33 (решение UX): у чипа та же льгота, что у R-30. Привычное время сегодня прошло больше часа назад —
  // дело на завтра, и чип заранее говорит «завтра». Сегодня с временем, прошедшим больше часа, не кладём.
  function chipDate(c) {
    if (state.cursor !== state.today || c.startMin == null) return state.cursor;
    const ref = c.endMin != null ? c.endMin : c.startMin;
    return nowMin() - ref > P().GRACE ? D().addDays(state.today, 1) : state.cursor;
  }
  function chipLabel(c) {
    if (c.startMin == null) return c.title;
    const day = chipDate(c) !== state.cursor ? "завтра " : "";
    return `${c.title} ${day}${c.endMin != null ? D().rangeLabel(c.startMin, c.endMin) : D().clockLabel(c.startMin)}`;
  }
  // Текст для строки ввода: парсер понимает «в 19:00» и «19–20», голое «19:00» — нет.
  function lineTime(startMin, endMin) {
    if (startMin == null) return "";
    return endMin != null ? ` ${D().rangeLabel(startMin, endMin)}` : ` в ${D().clockLabel(startMin)}`;
  }
  let chipList = [];
  function paintChips() {
    const box = $("#chips");
    if (!box) return;
    const line = $("#line");
    const show = !!suggestIdx && document.activeElement === line && !readLine().trim() && !state.overlay && !state.editing;
    chipList = show ? Sg().chips(buildSuggest(), state.cursor, tasksOn(state.cursor).map((t) => t.title).concat(visibleHabits(state.cursor).map((v) => v.h.title))) : [];
    if (!chipList.length) {
      if (!box.hidden) { box.hidden = true; box.textContent = ""; delete box.dataset.sig; }
      return;
    }
    // Узлы через DOM (textContent), без нового HTML-синка.
    const head = chipList.every((c) => c.same > 0) ? "обычно" : "недавно"; // batch7: короткий заголовок; «обычно» — только если все чипы из этого дня недели
    const sig = [head].concat(chipList.map(chipLabel)).join("\u0001");
    if (box.dataset.sig !== sig) {
      box.textContent = "";
      const h = document.createElement("span");
      h.className = "chips-h";
      h.textContent = head;
      box.appendChild(h);
      chipList.forEach((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.dataset.chip = String(i);
        b.textContent = chipLabel(c);
        box.appendChild(b);
      });
      box.dataset.sig = sig;
    }
    box.hidden = false;
  }
  // Тап — вписать с типичным временем (клавиатура остаётся: фокус не уходит из строки);
  // удержание 450 мс — текст чипа в строку для правки.
  function bindChips() {
    const box = $("#chips");
    if (!box) return;
    let hold = null;
    let held = false;
    let start = null;
    box.addEventListener("pointerdown", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      e.preventDefault(); // строка не теряет фокус
      held = false;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(hold);
      ringStart(e.clientX, e.clientY);
      hold = setTimeout(() => {
        ringStop();
        held = true;
        const c = chipList[+chip.dataset.chip];
        if (!c) return;
        const text = (chipDate(c) !== state.cursor ? "завтра " : "") + c.title + lineTime(c.startMin, c.endMin);
        writeLine(text);
        pendingCaret = text.length;
        try { setCaret($("#line"), text.length); } catch { /* caret */ }
        setDraft(composerDay, text, text.length);
        updateGhost();
        paintChips();
      }, HIT.gripHold);
    });
    box.addEventListener("pointermove", (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) clearTimeout(hold); // прокрутка ряда
    });
    let moved = false;
    box.addEventListener("pointercancel", () => { clearTimeout(hold); start = null; });
    // Действие на pointerup: после preventDefault у pointerdown WebKit не всегда присылает click.
    box.addEventListener("pointerup", (e) => {
      clearTimeout(hold);
      const chip = e.target.closest(".chip");
      const was = start;
      start = null;
      moved = !!was && Math.hypot(e.clientX - was.x, e.clientY - was.y) > 8;
      if (!chip || !was || moved) return;
      if (held) { held = false; return; }
      tapChip(chip);
    });
    box.addEventListener("click", (e) => {
      // клавиатура / VoiceOver (detail 0) — без pointer-событий
      const chip = e.target.closest(".chip");
      if (chip && e.detail === 0) tapChip(chip);
    });
    function tapChip(chip) {
      const c = chipList[+chip.dataset.chip];
      if (!c) return;
      const kind = c.startMin == null ? "loose" : c.endMin != null ? "window" : "slot";
      Promise.resolve(commitParsed({ ok: true, kind, title: c.title, date: chipDate(c), startMin: c.startMin, endMin: kind === "window" ? c.endMin : null }))
        .then(() => paintChips())
        .catch((err) => offerUndo(writeFailText(err), null));
    }
  }

  // R-32 (решение UX): «сейчас» обновляется раз в минуту, на смене минуты, без анимации цифр.
  function minuteTick() {
    const ms = 60000 - (Date.now() % 60000) + 50;
    setTimeout(() => {
      updateNow();
      minuteTick();
    }, ms);
  }

  // Контекст разбора: «через 20 минут», «полвосьмого» и «после работы» зависят от «сейчас» и конца рабочего дня.
  function parseCtx(today) {
    const now = new Date();
    return {
      today,
      now: now.getHours() * 60 + now.getMinutes(),
      nowDay: D().todayKey(),
      workEndMin: state.settings && state.settings.workEndMin
    };
  }

  function mount() {
    const tpl = document.createElement("template");
    tpl.innerHTML = `
      <header class="top">
        <button type="button" class="date-hit" id="date-hit" aria-describedby="date-help">
          <p class="kicker" id="kicker"></p>
          <p class="date-line"><span id="date-num"></span><span id="date-rest"></span></p>
        </button>
        <button type="button" class="week-btn" id="week-btn" aria-label="неделя" title="неделя">${ico("week")}</button>
        <button type="button" class="gear" id="more" aria-label="Настройки">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <circle cx="8" cy="7" r="2.1" fill="var(--bg)" stroke="currentColor" stroke-width="1.6"/>
            <circle cx="15" cy="12" r="2.1" fill="var(--bg)" stroke="currentColor" stroke-width="1.6"/>
            <circle cx="10" cy="17" r="2.1" fill="var(--bg)" stroke="currentColor" stroke-width="1.6"/>
          </svg>
        </button>
      </header>
      <div class="pager" id="deck">
        <p class="pull-hint" id="pull-hint" aria-hidden="true">↓ писать</p>
        <div class="track" id="track">
          <section class="sheet" id="sheet-prev"></section>
          <section class="sheet" id="sheet-cur"></section>
          <section class="sheet" id="sheet-next"></section>
        </div>
      </div>
      <div class="compose" id="compose">
        <div class="notice" id="notice" role="status" hidden>
          <span class="notice-text" id="notice-text"></span>
          <button type="button" class="notice-act" id="notice-act" hidden></button>
          <button type="button" class="notice-close" id="notice-close" aria-label="Скрыть" hidden>${ico("close")}</button>
        </div>
        <div class="chips" id="chips" hidden></div>
        <div class="many" id="many" hidden></div>
        <p class="ghost" id="ghost"></p>
        <div class="compose-row">
          <button type="button" class="shop-btn" id="shop-btn" aria-label="Список покупок">${ico("bag")}<span class="shop-count" id="shop-count" hidden></span></button>
<div id="line" class="line is-empty" contenteditable="plaintext-only" role="textbox" aria-multiline="false" aria-label="На этот день" data-placeholder="на этот день" enterkeyhint="send" autocorrect="on" autocapitalize="sentences" spellcheck="true"></div>
          <button type="button" class="send" id="send" aria-label="Вписать">${ico("send")}</button>
        </div>
      </div>
      <div class="toast" id="toast" hidden role="status">
        <span id="toast-text"></span>
        <span class="toast-actions">
          <button type="button" id="toast-go" hidden>открыть</button>
          <button type="button" id="toast-undo" hidden>отмена</button>
          <button type="button" id="toast-update" hidden>обновить</button>
        </span>
      </div>
      <div id="rail-close" class="rail-close" hidden>
        <button type="button" data-act="toggle-rail">${ico("list")}к списку</button>
      </div>
      <div id="scrim" class="scrim" hidden></div>
      <div id="sheet-ui" class="sheet-ui" role="dialog" aria-modal="true" hidden></div>
      <p class="sr-only" id="row-help">Двойное касание — править. Меню — двойное касание с удержанием. Все действия — Shift+F10.</p>
      <p class="sr-only" id="date-help">Касание — к сегодняшнему дню, удержание — календарь.</p>
      <p class="sr-only" id="deck-said" role="status"></p>
      <div class="drop-time" id="drop-time" aria-hidden="true" hidden></div>`;
    // R-37: snap.js уже нарисовал строку ввода (#compose[data-snap] > .compose-row > #line) — тогда всё
    // достраивается вокруг неё, а сам узел #line не пересоздаётся (фокус, каретка и набранное остаются).
    const app = $("#app");
    const pre = document.querySelector("#compose[data-snap]");
    const preLine = pre && pre.querySelector(".compose-row > #line");
    if (!preLine) {
      app.replaceChildren(tpl.content);
      return;
    }
    // набранное до загрузки — черновик сегодняшнего дня (дальше syncComposerDay вернёт его в строку)
    const typed = readEditable(preLine);
    const given = (window.__planinSnap && window.__planinSnap.draft) || "";
    if (typed !== given) setDraft(state.cursor || D().todayKey(), typed, typed.length);
    const frag = tpl.content;
    const compose = frag.querySelector("#compose");
    const row = compose.querySelector(".compose-row");
    const line = row.querySelector("#line");
    const preRow = preLine.parentNode;
    [...app.children].forEach((ch) => { if (ch !== pre) ch.remove(); });
    delete pre.dataset.snap;
    let before = true;
    [...frag.childNodes].forEach((n) => {
      if (n === compose) { before = false; return; }
      if (before) app.insertBefore(n, pre);
      else app.appendChild(n);
    });
    [...compose.childNodes].forEach((n) => { if (n !== row) pre.insertBefore(n, preRow); });
    let left = true;
    [...row.childNodes].forEach((n) => {
      if (n === line) { left = false; return; }
      if (left) preRow.insertBefore(n, preLine);
      else preRow.appendChild(n);
    });
    preLine.className = readEditable(preLine) ? "line" : "line is-empty";
  }

  const AX1_PX = 28; // iOS: body на AX1 — 28 pt
  // Клик без касания, мыши и клавиши перед ним (VoiceOver, Switch Control) — включаем кружок «выполнить».
  let assistive = false; // только в памяти: после перезагрузки первый такой клик включит снова
  let lastKeyAt = 0; // lastPointerAt — общий, выше (касание и мышь)
  // batch11 P3: чем пользовались последним — касание/мышь или клавиатура (для кольца фокуса после программного focus()).
  let lastInput = "pointer";
  function bindInputMode() {
    const touched = () => { lastInput = "pointer"; lastPointerAt = Date.now(); };
    document.addEventListener("pointerdown", touched, { capture: true, passive: true });
    document.addEventListener("touchstart", touched, { capture: true, passive: true });
    document.addEventListener("click", (e) => {
      if (assistive || !e.isTrusted) return;
      const now = Date.now();
      if (now - lastPointerAt < 1000 || now - lastKeyAt < 1000) return;
      assistive = true;
      applyTextSize();
    }, { capture: true, passive: true });
    document.addEventListener("keydown", (e) => {
      lastKeyAt = Date.now();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      lastInput = "key";
      document.querySelectorAll(".is-quiet").forEach((el) => el.classList.remove("is-quiet"));
    }, { capture: true });
  }

  function bind() {
    bindInputMode();
    $("#more").addEventListener("click", () => openSettings());
    // batch11 (макет 04): неделя без щипка — для VoiceOver и одной рукой
    $("#week-btn").addEventListener("click", () => { if (!swallowClick) openWeek(); });
    bindDateHit();
    // Клик, синтезированный после удержания, попадает уже на затемнение — меню не должно тут же закрыться.
    $("#scrim").addEventListener("click", () => { if (!swallowClick) closeOverlay(true); });
    bindSheetSwipe();
    // selectstart/contextmenu приходят и на текстовый узел — у него нет closest().
    document.addEventListener("contextmenu", (e) => {
      const el = elementOf(e.target);
      if (!el || !el.closest("input, textarea, #shop-line")) e.preventDefault();
      // batch10 P1-3: правая кнопка мыши (button 2) на строке — шторка действий; касание — своё удержание
      const row = el && e.button === 2 && !el.closest("[data-inline]") && el.closest("#sheet-cur .row[data-id]");
      if (row) openRowSheet(row);
    });
    document.addEventListener("selectstart", (e) => {
      const el = elementOf(e.target);
      if (!el || !el.closest("input, textarea, [contenteditable]")) e.preventDefault();
    });
    bindComposer();
    // Кнопки тоста не забирают фокус у строки (иначе blur впишет её раньше «повторить»).
    $("#toast-undo").addEventListener("mousedown", (e) => e.preventDefault());
    $("#toast-undo").addEventListener("click", () => runUndo());
    $("#toast-go").addEventListener("mousedown", (e) => { if (goFn) e.preventDefault(); });
    $("#toast-go").addEventListener("click", () => {
      if (goFn) {
        const fn = goFn;
        goFn = null;
        closeToast();
        fn();
      } else if (goKey) goTo(goKey);
    });
    bindToast();
    const upd = $("#toast-update");
    // Не забираем фокус у строки: черновик должен остаться в ней до перезагрузки.
    upd.addEventListener("mousedown", (e) => e.preventDefault());
    upd.addEventListener("click", () => applyUpdate({ force: true }));
    document.addEventListener("planin:update", onUpdate);
    // Q-20: холодный старт — новая версия включилась сразу после load. Если пользователь ещё ничего не начал, перезагрузка незаметна.
    document.addEventListener("planin:activated", () => {
      if (window.__planinColdTook && isIdle() && Date.now() - (window.__planinBooted || 0) < 10000) applyUpdate();
    });
    const compose = $("#compose");
    const composeH = () => document.documentElement.style.setProperty("--compose-h", `${compose.offsetHeight}px`);
    if (window.ResizeObserver) new ResizeObserver(composeH).observe(compose);
    composeH();
    $("#notice-act").addEventListener("mousedown", (e) => e.preventDefault());
    $("#notice-act").addEventListener("click", () => { if (noticeAct) noticeAct(); });
    $("#notice-close").addEventListener("click", () => {
      const fn = noticeClose;
      hideNotice();
      if (typeof fn === "function") fn();
    });
    // Любая другая упавшая запись (вычеркнуть, перенести, правка…) — не молча (Q-6).
    window.addEventListener("unhandledrejection", (e) => {
      if (!isWriteError(e.reason)) return;
      e.preventDefault();
      offerUndo(writeFailText(e.reason), null);
    });
    $("#app").addEventListener("click", onClick);
    document.addEventListener("pointerdown", bridgeTap, true);
    document.addEventListener("pointerdown", (e) => {
      lastPointerAt = Date.now();
      lastPointerXY = { x: e.clientX, y: e.clientY };
    }, true);
    document.addEventListener("touchstart", () => { lastPointerAt = Date.now(); }, { capture: true, passive: true });
    document.addEventListener("scroll", () => { lastScrollAt = Date.now(); }, { capture: true, passive: true });
    window.addEventListener("pagehide", () => { if (!reloading) saveDraftNow(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveDraftNow(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { badgeShown = null; syncBadge(); } });
    $("#app").addEventListener("submit", onSubmit);
    $("#app").addEventListener("change", onChange);
    $("#app").addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisible);
    bindPinch();
    const deck = $("#deck");
    deck.addEventListener("touchstart", (e) => begin(e, "touch"), { passive: true });
    deck.addEventListener("touchmove", (e) => move(e, "touch"), { passive: false });
    deck.addEventListener("touchend", (e) => end(e, "touch"));
    deck.addEventListener("touchcancel", () => cancelDrag());
    deck.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      begin(e, "mouse");
    });
    // R-16: шапка тоже листает день (в заполненном дне пустого места на листе почти нет).
    const top = $(".top");
    top.addEventListener("touchstart", (e) => begin(e, "touch"), { passive: true });
    top.addEventListener("touchmove", (e) => move(e, "touch"), { passive: false });
    top.addEventListener("touchend", (e) => end(e, "touch"));
    top.addEventListener("touchcancel", () => cancelDrag());
    top.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      begin(e, "mouse");
    });
    const sheetUi = $("#sheet-ui");
    sheetUi.addEventListener("focusin", (e) => {
      const field = e.target;
      if (!field.matches || !field.matches("input, textarea, [contenteditable]")) return;
      // Клавиатура iOS выезжает ~250 мс; после этого поле показываем над ней.
      setTimeout(() => {
        if (document.activeElement === field && field.isConnected) field.scrollIntoView({ block: "nearest" });
      }, 280);
    });
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

  function pinViewport() {
    const vk = navigator.virtualKeyboard;
    if (vk) {
      try { vk.overlaysContent = false; } catch { /* Safari рисует клавиатуру сам */ }
    }
    const vv = window.visualViewport;
    const app = $("#app");
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      // Высота видимой области без клавиатуры iOS (dvh её не учитывает).
      root.style.setProperty("--vvh", `${vv.height}px`);
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.classList.toggle("kb-open", kb > 120);
      app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
  }

  function onVisible() {
    // R-23: системный размер текста могли поменять, пока приложение было в фоне.
    if (document.visibilityState === "visible" && state.settings) applyTextSize();
    if (document.visibilityState === "visible" && reloading) reloading = false; // перезагрузки не случилось
    if (document.visibilityState === "hidden" && updatePending) {
      // Пользователь ушёл из приложения — лучший момент подменить версию.
      if (!state.editing) applyUpdate();
      return;
    }
    if (document.visibilityState !== "visible") return;
    const today = D().todayKey();
    if (today === state.today) {
      updateNow();
      return;
    }
    const follow = state.cursor === state.today;
    state.today = today;
    state.tailOpen = false;
    if (follow) state.cursor = today;
    renderHeader();
    renderSheets(false);
    maybeAutoCarry();
  }

  function renderHeader(peek) {
    const day = peek || state.cursor;
    const h = D().head(day, state.today);
    const named = h.kicker === "сегодня" || h.kicker === "завтра" || h.kicker === "вчера";
    const kicker = named ? `${h.weekday}, ${h.kicker}` : h.kicker;
    $("#kicker").dataset.plain = kicker;
    paintNowLine(peek);
    $("#date-num").textContent = String(h.day);
    $("#date-rest").textContent = h.month;
    $("#date-hit").classList.toggle("is-today", day === state.today);
    // R-12: VoiceOver слышит сам день, а не «Сегодня» на любой дате.
    const rel = named ? `, ${h.kicker}` : "";
    $("#date-hit").dataset.label = `${h.weekday}, ${h.day} ${h.month}${rel}`;
    $("#date-hit").setAttribute("aria-label", $("#date-hit").dataset.label);
    syncRail();
  }

  // R-32: на сегодняшнем дне строка дня недели заменяется живой строкой той же высоты:
  // «● обед до 14:00 · дальше 15:00 врач» / «дальше 15:00 врач · через 40 мин». Дальше ничего — как было.
  let nowLineIds = null;
  function paintNowLine(peek) {
    const k = $("#kicker");
    if (!k) return;
    const day = peek || state.cursor;
    const d = new Date();
    const line = day === state.today && !peek ? D().nowLine(state.tasks, day, d.getHours() * 60 + d.getMinutes()) : null;
    k.classList.toggle("is-now", !!line);
    if (!line) {
      nowLineIds = null;
      delete k.dataset.now;
      if (k.textContent !== k.dataset.plain || k.children.length) k.textContent = k.dataset.plain || "";
      const hit = $("#date-hit");
      if (hit && hit.dataset.label) hit.setAttribute("aria-label", hit.dataset.label);
      return;
    }
    // Узлы через DOM (textContent), без HTML-синка. batch7: на узком экране (<360) «до 14:00» и «дальше»
    // скрыты (.now-long), остаётся «● обед · 15:00 врач»; VoiceOver читает строку целиком (aria-label).
    const parts = [];
    const nextText = line.next ? `${D().clockLabel(line.next.startMin)} ${line.next.title}` : "";
    if (line.cur) {
      parts.push(["now-dot", ""], ["b", line.cur.title]);
      if (line.cur.kind === "slot") parts.push(["", " · идёт"]);
      else parts.push(["now-long", " до " + D().clockLabel(line.cur.endMin)]);
      if (nextText) parts.push(["", " · "], ["now-long", "дальше "], ["", nextText]);
    } else {
      parts.push(["", "дальше " + nextText + (line.inMin < 60 ? " · через " + line.inMin + " мин" : "")]);
    }
    nowLineIds = { cur: line.cur && line.cur.id, next: line.next && line.next.id };
    const sig = parts.map((x) => x.join("\u0002")).join("\u0001");
    if (k.dataset.now !== sig || !k.firstChild) {
      k.textContent = "";
      for (const [cls, text] of parts) {
        if (cls === "now-dot") { const dot = document.createElement("span"); dot.className = "now-dot"; dot.setAttribute("aria-hidden", "true"); k.appendChild(dot); }
        else if (cls === "b") { const b = document.createElement("b"); b.textContent = text; k.appendChild(b); }
        else if (cls) { const sp = document.createElement("span"); sp.className = cls; sp.textContent = text; k.appendChild(sp); }
        else k.appendChild(document.createTextNode(text));
      }
      k.dataset.now = sig;
    }
    const hit = $("#date-hit");
    if (hit && hit.dataset.label) hit.setAttribute("aria-label", `${hit.dataset.label}. ${k.textContent}`);
  }

  // Тап по живой строке — к делу: прокрутка и подсветка var(--wash) на 600 мс.
  function showNowTask() {
    const id = nowLineIds && (nowLineIds.cur || nowLineIds.next);
    const sheet = $("#sheet-cur");
    if (!id || !sheet) return false;
    const row = [...sheet.querySelectorAll('[data-kind="task"]')].find((el) => el.dataset.id === id && el.getClientRects().length);
    if (!row) return false;
    row.scrollIntoView({ block: "center", behavior: M().reduce() ? "auto" : "smooth" });
    row.classList.remove("is-flash");
    void row.offsetWidth;
    row.classList.add("is-flash");
    setTimeout(() => row.classList.remove("is-flash"), 600);
    return true;
  }

  function swallowUntilRelease() {
    swallowClick = true;
    const safety = setTimeout(() => { swallowClick = false; }, 5000);
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      setTimeout(() => { swallowClick = false; }, 350);
    };
    document.addEventListener("pointerup", up, { capture: true, once: true });
    document.addEventListener("pointercancel", up, { capture: true, once: true });
  }
  function bindDateHit() {
    const hit = $("#date-hit");
    let timer = null;
    let long = false;
    const start = (e) => {
      long = false;
      clearTimeout(timer);
      if (e && e.clientX != null) ringStart(e.clientX, e.clientY);
      timer = setTimeout(() => {
        ringStop();
        long = true;
        haptic("press");
        // batch8 P2-2: шторка открывается под пальцем — click при отпускании попал бы в #scrim и закрыл её.
        // Глотаем клики до отпускания и ещё 350 мс после него.
        swallowUntilRelease();
        // R-34: удержание на живой строке — «разбор дня», на дате — выбор дня.
        if (onNow && state.cursor === state.today) openDeck("day");
        else openDays();
      }, HIT.press);
    };
    const stop = () => clearTimeout(timer);
    let down = null;
    let onNow = false;
    hit.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; onNow = !!(e.target.closest && e.target.closest("#kicker.is-now")); });
    // R-16: свайп по шапке, начатый на дате, — не удержание.
    hit.addEventListener("pointermove", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) stop();
    });
    hit.addEventListener("pointerdown", start);
    hit.addEventListener("pointerup", stop);
    hit.addEventListener("pointerleave", stop);
    hit.addEventListener("pointercancel", stop);
    hit.addEventListener("click", (e) => {
      if (swallowClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (long) {
        long = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (state.cursor !== state.today) goTo(state.today);
      else if (e.target.closest && e.target.closest("#kicker.is-now")) showNowTask();
    });
  }

  function syncRail() {
    const button = $("#rail-close");
    if (!button || !state.settings) return;
    const timed = tasksOn(state.cursor).filter((t) => !t.done && (t.kind === "window" || t.kind === "slot"));
    const full = D().railMode(timed, state.dayMeta[state.cursor]) === "full";
    button.hidden = !full || !!state.overlay;
    document.body.classList.toggle("rail-open", !button.hidden);
  }

  // R-37: снимок сегодняшнего дня для мгновенного старта (snap.js). Через 500 мс после последней отрисовки,
  // не больше 30 строк; только текст (название, время, класс «сделано»), без HTML.
  const SNAP_KEY = "planin:snap";
  let snapTimer = null;
  function scheduleSnap() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(writeSnap, 500);
  }
  function writeSnap() {
    const sheet = [...document.querySelectorAll(".sheet")].find((el) => el.dataset.date === state.today);
    if (!sheet) return;
    const rows = [...sheet.querySelectorAll('.row[data-kind="task"], .row[data-kind="habit"], .row[data-kind="errand"]')].slice(0, 30).map((r) => {
      const title = r.querySelector(".title");
      const tag = title && title.querySelector(".tag");
      const t = title ? (tag ? `${tag.textContent} ${title.textContent.slice(tag.textContent.length)}` : title.textContent) : "";
      const g = r.querySelector(".gutter");
      const d = ["is-done", "is-fade", "is-strike"].filter((c) => r.classList.contains(c)).join(" ");
      return { t: t.slice(0, 200), g: g ? g.textContent.slice(0, 24) : "", d, k: r.dataset.kind };
    });
    // batch10 P2-6: у каждой строки — её место в листе (y), плюс «коробки» над и между строками:
    // полоса часов, плашка хвоста, лента (часы, заливка рабочего дня, блоки). Снимок ставит их туда же,
    // и подмена живым экраном ничего не сдвигает. Только числа и текст, классы — из белого списка snap.js.
    const box0 = sheet.getBoundingClientRect();
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - box0.left), y: Math.round(r.top - box0.top + sheet.scrollTop), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const rowEls = [...sheet.querySelectorAll('.row[data-kind="task"], .row[data-kind="habit"], .row[data-kind="errand"]')].slice(0, 30);
    rowEls.forEach((r, i) => { const b = at(r); rows[i].y = b.y; });
    const boxes = [];
    const add = (k, el, t, t2) => { if (boxes.length < 80) boxes.push(Object.assign({ k, t: String(t || "").slice(0, 120), t2: String(t2 || "").slice(0, 120) }, at(el))); };
    const strip = sheet.querySelector(".strip");
    if (strip) add("strip", strip, (strip.querySelector(".strip-label") || {}).textContent);
    const plate = sheet.querySelector(".row.tail-plate");
    if (plate) add("tail", plate, (plate.querySelector(".t1") || {}).textContent, (plate.querySelector(".t2") || {}).textContent);
    sheet.querySelectorAll(".rail .wash").forEach((el) => add("wash", el));
    sheet.querySelectorAll(".rail .hour").forEach((el) => add("hour", el, el.textContent.trim()));
    sheet.querySelectorAll(".rail .block").forEach((el) => add(el.classList.contains("window") ? "block-window" : el.classList.contains("habit") ? "block-habit" : "block-slot", el,
      (el.querySelector(".block-time") || {}).textContent, (el.querySelector(".block-title") || {}).textContent));
    const first = sheet.querySelector(".row");
    const pad = first ? Math.max(0, Math.min(400, Math.round(first.getBoundingClientRect().top - sheet.getBoundingClientRect().top + sheet.scrollTop))) : 4;
    const h = D().head(state.today, state.today);
    const size = state.settings && state.settings.textSize;
    const snap = { v: 1, day: state.today, at: Date.now(), text: size === "s" || size === "m" || size === "l" ? size : "auto", head: { kicker: `${h.weekday}, ${h.kicker}`, num: String(h.day), rest: h.month }, pad, rows, boxes, sy: Math.round(sheet.scrollTop) };
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch { /* нет места или приватный режим — без снимка */ }
  }

  function renderSheets(animate) {
    if (inline && !inline.closing) return; // R-38: пока строка правится на месте, лист не перерисовываем
    syncComposerDay();
    const cur = $("#sheet-cur");
    if (cur && cur.dataset.date) scrollMemory[cur.dataset.date] = cur.scrollTop;
    const first = animate ? M().measure(cur) : null;
    fillSheet($("#sheet-prev"), D().addDays(state.cursor, -1));
    fillSheet($("#sheet-cur"), state.cursor);
    fillSheet($("#sheet-next"), D().addDays(state.cursor, 1));
    syncSheetA11y();
    ["sheet-prev", "sheet-cur", "sheet-next"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.dataset.date && scrollMemory[el.dataset.date] != null) {
        el.scrollTop = scrollMemory[el.dataset.date];
      }
    });
    if (first) M().play($("#sheet-cur"), first);
    paintNowLine();
    syncBadge();
    suggestDirty = true;
    paintChips();
    paintShopCount();
    scheduleSnap();
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

  // batch5 P2 (R-12): перерисовка листа не роняет фокус на body — возвращаем его на ту же ручку,
  // название или плашку хвоста (Enter / пробел на .grip, раскрытие хвоста).
  function focusMark(el) {
    const a = document.activeElement;
    if (!a || a === document.body || !el.contains(a)) return null;
    const row = a.closest(".row[data-id]");
    if (!row) return null;
    const part = a === row ? "" : a.classList.contains("grip") ? ".grip" : a.getAttribute("role") === "button" ? '[role="button"]' : null;
    return part == null ? null : { id: row.dataset.id, kind: row.dataset.kind, part };
  }
  function focusBack(el, keep) {
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a)) return;
    const row = [...el.querySelectorAll(".row[data-id]")].find((r) => r.dataset.id === keep.id && r.dataset.kind === keep.kind);
    const target = row && (keep.part ? row.querySelector(keep.part) : row);
    if (target) {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    }
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
    const draft = key !== composerDay ? getDraft(key) : null;
    const isToday = key === state.today;
    const tail = isToday ? tailTasks() : [];
    const past = isToday ? pastDrafts() : [];
    el.dataset.date = key;
    const keep = el.id === "sheet-cur" ? focusMark(el) : null;
    el.innerHTML = [
      mode === "full" ? railHTML(key, timed, onRail) : stripHTML(key, liveTimed),
      tailHTML(tail),
      past.length ? '<div class="rows drafts past">' + past.map(([day, d]) => draftRowHTML(day, d, true)).join("") + "</div>" : "",
      draft ? draftRowHTML(key, draft) : "",
      plan.length ? `<div class="rows plan" data-group="plan">${plan.join("")}</div>` : "",
      isToday ? deckLineHTML() : "",
      spaceHTML(!dayTasks.length && !views.length && !draft && !tail.length && !past.length, key)
    ].join("");
    if (keep) focusBack(el, keep);
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
    // R-27 (01-today): «пн 11–20» слева, шкала — правее подписи, метки и «сейчас» подпись не перекрывают.
    const wd = D().WD_SHORT[D().dow(key)];
    const label = work
      ? `${wd} ${D().clockLabel(s.workStartMin, { short: true })}–${D().clockLabel(s.workEndMin, { short: true })}`
      : `${wd} · выходной`;
    // R-32: та же терракотовая точка, что в живой строке, — на текущем времени.
    let nowLeft = "";
    if (key === state.today) {
      const d = new Date();
      const m = d.getHours() * 60 + d.getMinutes();
      if (m >= from && m <= to) nowLeft = String(pos(m));
    }
    return `<button type="button" class="strip" data-act="toggle-rail" aria-label="Часы дня, развернуть расписание"><span class="strip-label">${esc(label)}</span><span class="strip-track">${wash}${ticks}<span class="strip-now" data-strip-now${nowLeft ? "" : " hidden"} style="left:${esc(nowLeft || "0")}%"></span></span></button>`;
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
        const time = b.kind === "habit" ? D().clockLabel(b.start, { short: true }) : D().rangeLabel(b.openStart ? null : b.start, b.kind === "slot" ? null : b.endMin > 24 * 60 ? b.endMin : b.end); // через полночь — «23–1»
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

  // R-22: ручка справа — зона «готово» (тап), ручка порядка (вверх/вниз) и флажок для VoiceOver.
  // R-12 fix: подпись «выполнено: <название>», в фокусе после названия; порядок — через меню «выше / ниже», не голосом.
  function gripHTML(done, label, title) {
    return `<span class="grip" role="checkbox" tabindex="0" aria-checked="${done ? "true" : "false"}" aria-label="${esc(`${label}: ${title}`)}"><i></i><i></i><i></i></span>`;
  }

  function taskRow(task, key, fromTail) {
    const clock = task.kind === "loose"
      ? ""
      : task.kind === "window"
        ? D().rangeLabel(task.startMin, task.endMin)
        : D().clockLabel(task.startMin, { short: true });
    // Строка хвоста: в колонке времени — день («пт», «пт 9»).
    const label = fromTail ? [D().dayTag(task.date, state.today), clock].filter(Boolean).join(" ") : clock;
    const work = !fromTail && inWork(task, key);
    const gutter = label
      ? `<span class="gutter${work ? " in-work" : ""}" aria-hidden="true">${esc(label)}</span>`
      : "";
    const times = Math.floor(Number(task.carried)) || 0;
    const meta = times >= 3 ? `<p class="meta" aria-hidden="true">переносилось ${esc(times)} ${esc(plural(times, "раз", "раза", "раз"))}</p>` : "";
    const sel = state.selected === task.id ? " is-selected" : "";
    const said = [task.title, fromTail ? D().WD[D().dow(task.date)] : "", timeSaid(task), times >= 3 ? `переносилось ${times} ${plural(times, "раз", "раза", "раз")}` : "", task.done ? "сделано" : "не сделано"].filter(Boolean).join(", ");
    return `<article class="row${doneClass(task.done)}${sel}" data-id="${esc(task.id)}" data-kind="task" data-flip="${esc(task.id)}"><p class="title"${rowA11y(said)}>${esc(task.title)}</p>${gutter}${meta}${gripHTML(task.done, "выполнено", task.title)}` + rowActions(task) + '<span class="ink"></span></article>';
  }

  // batch10 P1-3: у дел с правкой на месте — кнопка «действия…» для VoiceOver (жестом-смахиванием),
  // вне порядка Tab (с клавиатуры — Shift+F10 или ContextMenu). Открывает прежнюю шторку.
  function rowActions(task) {
    if (task.done || (task.kind !== "loose" && task.kind !== "slot")) return "";
    return '<button type="button" class="sr-only row-actions" tabindex="-1" data-act="row-actions" data-id="' + esc(task.id) + '" aria-label="' + esc("действия: " + task.title) + '"></button>';
  }

  // R-12: название строки — кнопка с понятной подписью для VoiceOver («врач, в 9, не сделано»).
  // Кнопка — название, а не вся строка: внутри role="button" флажок-ручка стал бы «презентационным» и пропал бы для VoiceOver.
  function rowA11y(label) {
    return ` role="button" tabindex="0" aria-label="${esc(label)}" aria-describedby="row-help"`;
  }

  function timeSaid(task) {
    const c = (m) => D().clockLabel(m, { short: true });
    if (task.kind === "slot" && task.startMin != null) return `в ${c(task.startMin)}`;
    if (task.kind === "window") {
      if (task.startMin != null && task.endMin != null) return `с ${c(task.startMin)} до ${c(task.endMin)}`;
      if (task.endMin != null) return `до ${c(task.endMin)}`;
      if (task.startMin != null) return `с ${c(task.startMin)}`;
    }
    return "";
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  // R-31: «хвост» — незакрытое с прошлых дней (не старше 14 / 30 дней), только на сегодня.
  function tailDepth() {
    return state.settings && +state.settings.tailDays === 30 ? 30 : 14;
  }

  function tailTasks() {
    const from = D().addDays(state.today, -tailDepth());
    const at = (t) => (t.kind === "loose" ? 1e4 : t.startMin ?? t.endMin ?? 1e4);
    return state.tasks
      .filter((t) => !t.done && !t.draft && t.date < state.today && t.date >= from)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : at(a) - at(b) || byOrder(a, b)));
  }

  // R-32: число на иконке — открытые дела сегодня + хвост (R-31). Привычки не входят (решение 9).
  // Без сервера iOS не обновит его в полночь, поэтому хвост в счёте: вчерашние открытые остаются в числе.
  function canBadge() {
    return "setAppBadge" in navigator && isStandalone();
  }
  function badgeCount() {
    return state.tasks.filter((t) => !t.done && !t.draft && t.date === state.today).length + tailTasks().length;
  }
  let badgeShown = null;
  function syncBadge() {
    if (!state.settings || !state.settings.badge || !("setAppBadge" in navigator)) return;
    const n = badgeCount();
    if (n === badgeShown) return;
    badgeShown = n;
    try {
      const p = n ? navigator.setAppBadge(n) : navigator.clearAppBadge();
      if (p && p.catch) p.catch(() => { badgeShown = null; });
    } catch { badgeShown = null; }
  }
  // Разрешение спрашиваем только отсюда — по жесту в настройках, не при запуске.
  async function setBadge(on) {
    let note = "";
    if (on && window.Notification && Notification.permission !== "granted") {
      let perm = "denied";
      try { perm = await Notification.requestPermission(); } catch { /* старый iOS */ }
      if (perm !== "granted") {
        on = false;
        note = "iOS показывает число только с разрешением на уведомления. Сами уведомления Planin не шлёт.";
      }
    }
    state.settings = { ...state.settings, badge: on };
    DB().saveSettings(state.settings);
    badgeShown = null;
    if (on) syncBadge();
    else if ("clearAppBadge" in navigator) {
      try { const p = navigator.clearAppBadge(); if (p && p.catch) p.catch(() => {}); } catch { /* нет API */ }
    }
    state.badgeNote = note;
    if (state.overlay) renderOverlay();
  }

  // Черновики прошлых дней — строкой в хвосте, сами не стираются.
  function pastDrafts() {
    const all = readDrafts();
    return Object.keys(all)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k < state.today && getDraft(k))
      .sort()
      .map((k) => [k, all[k]]);
  }

  function tailHTML(list) {
    if (!list.length) return "";
    const n = list.length;
    const days = [...new Set(list.map((t) => t.date))];
    const names = days.slice(0, 3).map((k) => D().dayTag(k, state.today)).join(" · ") + (days.length > 3 ? " · …" : "");
    const rest = n > 1 ? `, ещё ${n - 1}` : "";
    const open = state.tailOpen;
    const t2 = open ? "тап — свернуть" : `${names} — ${list[0].title}${rest}`;
    const label = `С прошлых дней: ${n}. Тап — ${open ? "свернуть" : "раскрыть"}, вправо — всё в сегодня, влево — всё сделано`;
    const rowsHTML = open ? '<div class="rows tail-rows">' + list.map((t) => taskRow(t, state.today, true)).join("") + "</div>" : "";
    return `<div class="tail${open ? " is-open" : ""}">
      <article class="row tail-plate" data-kind="tail" data-id="tail" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" aria-label="${esc(label)}"><div class="tail-text"><p class="t1">с прошлых дней · ${esc(n)}</p><p class="t2">${esc(t2)}</p></div><span class="go">→ в сегодня</span></article>
      <span class="edge e1"></span><span class="edge e2"></span>
    </div>` + rowsHTML;
  }

  // R-29: пустое место под последней строкой (на пустом дне — весь лист) открывает ввод.
  // R-11: пустой день приглашает написать и даёт 3 примера (тап кладёт фразу в строку, без отправки).
  const EXAMPLES = ["завтра в 14 врач", "купить молоко", "с 12 до 14 обед"];
  function spaceHTML(empty, key) {
    if (!empty) return '<div class="tail-space"></div>';
    const body = key && key < state.today
      ? '<p class="empty-t">В этот день ничего не было</p>'
      : `<p class="empty-t">День пустой</p><p class="empty-s">Напишите внизу, что сделать</p>
        <div class="empty-chips">${EXAMPLES.map((x) => `<button type="button" class="empty-chip" data-example="${esc(x)}">${esc(x)}</button>`).join("")}</div>`;
    return `<div class="tail-space is-empty"><div class="empty">${body}</div></div>`;
  }

  function useExample(text) {
    if (state.overlay || state.editing) return;
    writeLine(text);
    pendingCaret = null;
    openKeyboard();
    updateGhost();
  }

  function draftRowHTML(key, d, past) {
    const pill = past ? `черновик · ${D().dayTag(key, state.today)}` : "черновик";
    const row = `<article class="row draft" data-kind="draft" data-id="${esc(key)}"${past ? ` data-into="today"` : ""} aria-label="${esc(pill)}: ${esc(d.text)}"><p class="title">${esc(d.text)}</p><span class="draft-pill">${esc(pill)}</span></article>`;
    return past ? row : '<div class="rows drafts">' + row + "</div>";
  }

  function habitRow(v) {
    const sel = state.selected === v.h.id ? " is-selected" : "";
    const at = D().habitAt(v.h);
    const when = at != null ? `<span class="gutter" aria-hidden="true">${esc(D().clockLabel(at, { short: true }))}</span>` : "";
    const said = [v.h.title, "привычка", D().habitMeta(v.h, v.st), at != null ? `в ${D().clockLabel(at, { short: true })}` : "", v.st === "done" ? "сделано" : "не сделано"].filter(Boolean).join(", ");
    return `<article class="row habit${doneClass(v.st === "done")}${sel}" data-id="${esc(v.h.id)}" data-kind="habit" data-flip="h-${esc(v.h.id)}"><p class="title"${rowA11y(said)}>${esc(v.h.title)}</p>${when}<p class="meta" aria-hidden="true">${esc(D().habitMeta(v.h, v.st))}</p>${gripHTML(v.st === "done", "выполнено", v.h.title)}<span class="ink"></span></article>`;
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
      <div id="shop-line" class="line shop-line is-empty" contenteditable="plaintext-only" role="textbox" aria-multiline="false" aria-label="В список" data-placeholder="в список" enterkeyhint="next" autocorrect="on" autocapitalize="sentences" spellcheck="true"></div>
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
    const when = item.atMin != null ? `<span class="gutter" aria-hidden="true">${esc(D().clockLabel(item.atMin, { short: true }))}</span>` : "";
    const meta = ready ? `<p class="meta" aria-hidden="true">${esc(ready)}</p>` : "";
    const said = [`${SAY[item.tag] || "купить"} ${item.text}`, ready, item.atMin != null ? `в ${D().clockLabel(item.atMin, { short: true })}` : "", item.done ? "куплено" : "не куплено"].filter(Boolean).join(", ");
    return `<article class="row${doneClass(item.done)}" data-id="${esc(item.id)}" data-kind="errand" data-flip="e-${esc(item.id)}"><p class="title"${rowA11y(said)}><span class="tag">${esc(SAY[item.tag] || "купить")}</span>${esc(item.text)}</p>${when}${meta}${gripHTML(item.done, "куплено", item.text)}<span class="ink"></span></article>`;
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

  function pointAt(el, offset) {
    let left = offset;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (left <= len) return { node, offset: left };
      left -= len;
    }
    return null;
  }

  function paintMarks(line, text) {
    if (!HL) return;
    HL.clear();
    HL_SEP.clear();
    if (!text) return;
    for (const m of text.matchAll(SEP_RE)) {
      const start = m.index + (m[1] ? m[0].length - m[1].length : 0);
      const a = pointAt(line, start);
      const b = pointAt(line, m.index + m[0].length);
      if (!a || !b) continue;
      try {
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        HL_SEP.add(r);
      } catch { /* узел сменился */ }
    }
    P().marks(text).forEach(({ start, end }) => {
      const a = pointAt(line, start);
      const b = pointAt(line, end);
      if (!a || !b) return;
      try {
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        HL.add(r);
      } catch { /* узел сменился под пальцем — подсветим на следующем вводе */ }
    });
  }

  // Только читает строку: ни innerHTML, ни каретки. Поэтому безопасна во время ввода.
  function paintLine() {
    const line = $("#line");
    if (!line || painting) return;
    const text = readEditable(line);
    line.classList.toggle("is-empty", !text);
    paintMarks(line, text);
  }

  // Программная запись (очистка после отправки, Escape) — не во время набора.
  function writeLine(text) {
    const el = $("#line");
    if (!el) return;
    clearTimeout(ghostTimer);
    painting = true;
    el.textContent = text || "";
    painting = false;
    paintLine();
  }

  function scheduleGhost() {
    const line = $("#line");
    if (line) line.classList.toggle("is-empty", !readEditable(line));
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => requestAnimationFrame(updateGhost), 120);
  }

  // R-35: несколько дел одной строкой — разбор частями и превью над строкой.
  const MANY_HINT = /[;\n]|(?:^|\s)(?:потом|затем|ещ[её]|также)(?=\s|$)|,/i;
  const MANY_MAX = 30;
  function manyParts(text) {
    if (!text || !MANY_HINT.test(text)) return null;
    const list = P().parseMany(text, parseCtx(state.cursor));
    return list.length >= 2 ? list : null;
  }
  function manyItem(r) {
    return r.ok ? r : { ok: true, kind: "loose", title: r.text, date: state.cursor, startMin: null, endMin: null };
  }
  function paintMany(list) {
    const box = $("#many");
    if (!box) return;
    if (!list) {
      if (!box.hidden) { box.hidden = true; box.textContent = ""; }
      return;
    }
    // DOM через textContent — без нового HTML-синка.
    box.textContent = "";
    const head = document.createElement("p");
    head.className = "many-h";
    head.textContent = `${list.length} ${plural(list.length, "строка", "строки", "строк")} · Enter — вписать все`;
    box.appendChild(head);
    const ul = document.createElement("ul");
    list.slice(0, 10).forEach((r) => {
      const li = document.createElement("li");
      const it = manyItem(r);
      li.textContent = it.kind === "errand" ? `в список · ${it.title}` : P().describe(it, state.cursor, state.today);
      if (it.done) li.className = "is-done";
      ul.appendChild(li);
    });
    box.appendChild(ul);
    if (list.length > 10) {
      const more = document.createElement("p");
      more.className = "many-more";
      more.textContent = list.length > MANY_MAX ? `и ещё ${list.length - 10} · впишутся первые ${MANY_MAX}, остальное останется в строке` : `и ещё ${list.length - 10}`;
      box.appendChild(more);
    }
    box.hidden = false;
  }

  function updateGhost() {
    paintLine();
    paintChips();
    const ghost = $("#ghost");
    const text = readLine();
    if (ghostComp) { ghost.classList.remove("is-complete"); ghost.removeAttribute("role"); ghost.removeAttribute("aria-label"); }
    const many = manyParts(text.trim());
    paintMany(many);
    if (many) {
      ghostComp = null;
      ghost.classList.remove("is-hint", "is-complete");
      ghost.removeAttribute("role"); ghost.removeAttribute("aria-label");
      ghost.textContent = `${many.length} ${plural(many.length, "дело", "дела", "дел")} одной строкой`;
      return;
    }
    if (!text.trim() && draftNote && Date.now() < draftNote.until) {
      ghost.textContent = `черновик на ${dayWord(draftNote.day)} сохранён · тап — дописать`;
      ghost.classList.add("is-hint");
      return;
    }
    if (!text.trim() && hintNote && Date.now() < hintNote.until) {
      ghost.textContent = hintNote.text;
      ghost.classList.add("is-hint");
      return;
    }
    if (!text.trim()) {
      const legend = legendNow();
      ghost.textContent = legend ? "тап по дате — сегодня" : "";
      ghost.classList.toggle("is-hint", legend);
      return;
    }
    const parsed = P().parse(text, parseCtx(state.cursor));
    ghost.classList.remove("is-hint");
    // R-33: дополнение из истории — серым продолжением, тап по подсказке дописывает.
    ghostComp = suggestIdx && parsed.ok && parsed.kind === "loose" && !parsed.dateSpoken && parsed.title === text.trim()
      ? Sg().complete(buildSuggest(), text, state.cursor)
      : null;
    ghost.classList.toggle("is-complete", !!ghostComp);
    // batch7: VoiceOver — дополнение как кнопка «дописать: спорт 19:00» (активация = тап).
    if (!ghostComp) { ghost.removeAttribute("role"); ghost.removeAttribute("aria-label"); }
    if (ghostComp) {
      const time = ghostComp.startMin == null ? "" : ` ${ghostComp.endMin != null ? D().rangeLabel(ghostComp.startMin, ghostComp.endMin) : D().clockLabel(ghostComp.startMin)}`;
      ghost.textContent = "";
      const typed = document.createElement("span");
      typed.textContent = text.trim();
      const rest = document.createElement("span");
      rest.className = "ghost-rest";
      rest.textContent = ghostComp.rest + time;
      ghost.append(typed, rest, " · тап — дописать");
      ghostComp.text = ghostComp.title + lineTime(ghostComp.startMin, ghostComp.endMin);
      ghost.setAttribute("role", "button");
      ghost.setAttribute("aria-label", `дописать: ${ghostComp.title}${time}`);
      return;
    }
    ghost.textContent = parsed.ok ? P().describe(parsed, state.cursor, state.today) : parsed.reason || "";
  }

  let ghostComp = null;
  let swallowGhostClick = false;
  function acceptCompletion() {
    if (!ghostComp) return false;
    const text = ghostComp.text;
    ghostComp = null;
    writeLine(text);
    pendingCaret = text.length;
    try { setCaret($("#line"), text.length); } catch { /* caret */ }
    setDraft(composerDay, text, text.length);
    updateGhost();
    return true;
  }

  // R-11: «тап по дате — сегодня» — только на чужом дне и не больше 3 показов (показ = новый день в шапке).
  let legendDay = null;
  function legendNow() {
    const s = state.settings;
    if (s.seenLegend || state.cursor === state.today) return false;
    if (legendDay === state.cursor) return true;
    if ((s.legendShown || 0) >= 3) return false;
    legendDay = state.cursor;
    state.settings = { ...s, legendShown: (s.legendShown || 0) + 1 };
    DB().saveSettings(state.settings).catch(() => {});
    return true;
  }

  // R-11: подсказки жестов — каждая один раз (settings.hints), текст в #ghost на 6 с.
  let hintNote = null;
  function hintSeen(name) {
    return !!(state.settings.hints && state.settings.hints[name]);
  }
  function markHint(name) {
    state.settings = { ...state.settings, hints: { ...(state.settings.hints || {}), [name]: true } };
    DB().saveSettings(state.settings).catch(() => {});
  }
  function showHint(text) {
    const until = Date.now() + HIT.hintMs;
    hintNote = { text, until };
    updateGhost();
    setTimeout(() => {
      if (hintNote && hintNote.until === until) {
        hintNote = null;
        updateGhost();
      }
    }, HIT.hintMs + 50);
  }
  function hintAfterAdd(task) {
    if (!hintSeen("swipe")) {
      markHint("swipe");
      if (task.date === state.cursor) wink(task.id);
      showHint("влево — готово · вправо — на завтра");
    } else if (!hintSeen("hold") && (state.settings.addedCount || 0) >= 3) {
      markHint("hold");
      showHint("долгое нажатие — меню");
    }
  }
  function hintAfterMove() {
    if (hintSeen("defer")) return;
    markHint("defer");
    showHint("вправо и вниз — выбрать день");
  }
  // Строка один раз «подмигивает» влево до −56 px, под ней видна зелёная подложка «готово».
  function wink(id) {
    if (M().reduce()) return;
    setTimeout(() => {
      const el = rowEl(id);
      if (!el || drag || state.overlay || state.editing || !el.animate) return;
      const cur = { el, id, rowKind: "task", mode: "done", width: el.offsetWidth };
      showUnder(cur);
      const anim = el.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-56px)", offset: 0.45 }, { transform: "translateX(0)" }],
        { duration: M().dur(4) * 2.5, easing: M().ease("out") } // подсказка: 2,5 × --dur-4
      );
      const done = () => dropUnder(cur, 0);
      anim.onfinish = done;
      anim.oncancel = done;
    }, 420);
  }

  function applyTextSize() {
    const size = state.settings && state.settings.textSize;
    document.documentElement.dataset.text = size === "s" || size === "m" || size === "l" ? size : "auto";
    // R-23: час ленты — из --hour (растёт с текстом); меряем пробником, CSS-переменная сама не вычисляется.
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;height:var(--hour)";
    document.body.appendChild(probe);
    const was = D().HOUR;
    D().setHour(probe.getBoundingClientRect().height);
    probe.remove();
    if (D().HOUR !== was && document.getElementById("sheet-cur")) renderSheets(false);
    // batch11 P3 (решение по R-23): видимый кружок «выполнить» — только на «A++», при системном размере
    // AX1 и больше (-apple-system-body ≥ 28 px) и под VoiceOver; на «A+» и обычных системных — нет.
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    document.documentElement.classList.toggle("large", size === "l" || root >= AX1_PX || assistive);
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
    // R-35: строки вставки — отдельные дела: перенос становится «; » (разделитель частей).
    const lines = data.getData("text/plain").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
    const text = lines.join("; ");
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
    scheduleDraft();
    if (host && host.id === "shop-line") {
      host.classList.toggle("is-empty", !readEditable(host));
      return;
    }
    updateGhost();
  }

  function bindLineHold(el) {
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      cancelLineHold();
      ringStart(e.clientX, e.clientY);
      lineHold = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          ringStop();
          lineHold = null;
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
          sendHold = true;
          swallowClick = true;
          setTimeout(() => { swallowClick = false; }, 500);
          const line = $("#line");
          if (line) line.blur();
          openNewTaskSheet();
        }, HIT.press)
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
        return;
      }
      // R-33 (решение UX): внешняя клавиатура — Tab или → в конце строки принимает дополнение.
      if ((e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) || (e.key === "ArrowRight" && !e.shiftKey && caretOffset(line) >= readLine().length)) {
        if (!e.isComposing) updateGhost();
        if (ghostComp && acceptCompletion()) e.preventDefault();
      }
    });
    line.addEventListener("paste", keepPlainPaste);
    // Диктовка «новая строка» (и перенос в тексте) — разделитель дел, а не перенос в строке ввода.
    line.addEventListener("beforeinput", (e) => {
      const t = e.inputType;
      const nl = t === "insertParagraph" || t === "insertLineBreak" || (t === "insertText" && typeof e.data === "string" && e.data.includes("\n"));
      if (!nl) return;
      e.preventDefault();
      const piece = t === "insertText" ? e.data.split(/\s*\n\s*/).join("; ") : "; ";
      document.execCommand("insertText", false, piece);
    });
    line.addEventListener("input", () => {
      if (painting) return;
      pendingCaret = null;
      if (draftNote) draftNote = null;
      scheduleGhost();
      scheduleDraft();
    });
    line.addEventListener("contextmenu", (e) => e.preventDefault());
    // P2-5: фокус без касания текста (Tab, VoiceOver, программно) — каретка в конец восстановленного черновика.
    line.addEventListener("focus", () => {
      if (pendingCaret == null) return;
      const at = Math.min(pendingCaret, readEditable(line).length);
      pendingCaret = null;
      try { setCaret(line, at); } catch { /* caret */ }
    });
    line.addEventListener("blur", onLineBlur);
    line.addEventListener("focus", () => paintChips());
    const ghostEl = $("#ghost");
    // Тап по дополнению не уводит фокус из строки (клавиатура остаётся).
    ghostEl.addEventListener("pointerdown", (e) => { if (ghostComp) e.preventDefault(); });
    ghostEl.addEventListener("pointerup", (e) => {
      if (ghostComp && acceptCompletion()) { e.preventDefault(); swallowGhostClick = true; setTimeout(() => { swallowGhostClick = false; }, 400); }
    });
    line.addEventListener("blur", () => setTimeout(paintChips, 0));
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
    const at = el.id === "line" && pendingCaret != null ? pendingCaret : readEditable(el).length;
    pendingCaret = null;
    try { setCaret(el, at); } catch { /* caret */ }
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
      if (e.target.closest("#shop-btn, #send, .inline-bar")) return;
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
      else {
        // Свайп вниз по полосе ввода — явное «вписать» (R-15), потом клавиатура уходит.
        if (document.activeElement === $("#line")) commitComposer();
        closeKeyboard();
      }
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
      if (e.target.closest("#ghost") && (swallowGhostClick || acceptCompletion())) return;
      if (draftNote && e.target.closest("#ghost")) {
        const day = draftNote.day;
        draftNote = null;
        goTo(day, false);
        openKeyboard();
        return;
      }
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
    if (!title) task.draft = true; // пустая до первого названия: при запуске такие убираются
    state.tasks.push(task);
    if (!title) drafts.add(task.id);
    await DB().putTask(task);
    renderSheets(true);
    openEdit("task", task.id, { focus: true, force: true });
  }

  function bindShopLine() {
    const shop = $("#shop-line");
    if (!shop) return;
    ensureEditable(shop);
    const seed = (state.overlay && state.overlay.seed) || (getDraft("shop") || {}).text;
    if (seed) {
      shop.textContent = seed;
      shop.classList.remove("is-empty");
      state.overlay.seed = "";
    }
    shop.addEventListener("input", () => {
      shop.classList.toggle("is-empty", !readEditable(shop));
      scheduleDraft();
    });
    shop.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commitShopLine(shop);
    });
    shop.addEventListener("blur", () => {
      if (shopEscaping) { setDraft("shop", readEditable(shop)); return; }
      commitShopLine(shop, true);
    });
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

  // Плашка над строкой ввода: постоянные состояния (резерв хранилища, R-20).
  let noticeAct = null;
  let noticeClose = null;
  function showNotice(text, act, close) {
    const box = $("#notice");
    if (!box) return;
    $("#notice-text").textContent = text;
    const btn = $("#notice-act");
    btn.hidden = !act;
    btn.textContent = act ? act.label : "";
    noticeAct = act ? act.run : null;
    $("#notice-close").hidden = !close;
    noticeClose = close || null;
    box.hidden = false;
  }
  function hideNotice() {
    const box = $("#notice");
    if (box) box.hidden = true;
    noticeAct = null;
    noticeClose = null;
  }

  // Q-8 / R-20: постоянное хранилище и подсказка «на экран Домой» для вкладки Safari.
  function isStandalone() {
    return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches));
  }

  async function requestPersist() {
    const st = navigator.storage;
    if (!st || !st.persisted) {
      state.persisted = null; // браузер не сообщает
      return;
    }
    try {
      state.persisted = await st.persisted();
      if (!state.persisted && st.persist) state.persisted = await st.persist();
    } catch {
      state.persisted = false;
    }
  }

  function noteAdded() {
    state.settings = { ...state.settings, addedCount: (state.settings.addedCount || 0) + 1 };
    DB().saveSettings(state.settings).catch(() => {});
    // После жеста пользователя WebKit охотнее даёт persist().
    if (!state.persisted) requestPersist();
    maybeInstallHint();
  }

  function maybeInstallHint() {
    if (isStandalone() || DB().storageInfo().backend !== "idb") return;
    if ((state.settings.addedCount || 0) < 3) return;
    if (Date.now() < (state.settings.installHintUntil || 0)) return;
    if ($("#notice") && !$("#notice").hidden) return;
    showNotice("Добавьте Planin на экран «Домой» — так iOS не сотрёт записи", { label: "как", run: openInstallHelp }, () => {
      state.settings = { ...state.settings, installHintUntil: Date.now() + 30 * 864e5 };
      DB().saveSettings(state.settings).catch(() => {});
    });
  }

  function openInstallHelp() {
    if (state.editing) closeEdit(true);
    state.overlay = { type: "install" };
    renderOverlay();
  }

  function installHTML() {
    return `<h2 id="sheet-h">на экран «Домой»</h2>
      <ol class="steps">
        <li><span class="step-ico">${ico("share")}</span><span>Нажмите «Поделиться» в панели Safari</span></li>
        <li><span class="step-ico">${ico("addsq")}</span><span>Выберите «На экран „Домой“»</span></li>
        <li><span class="step-ico step-word">Добавить</span><span>Нажмите «Добавить» — Planin появится иконкой</span></li>
      </ol>
      <p class="fine">Записи в Safari и в приложении с экрана «Домой» хранятся раздельно: вписанное здесь в иконке не появится. Перед установкой сделайте экспорт, а в приложении — «вгрузить».</p>
      <div class="io"><button type="button" data-act="export">экспорт</button></div>`;
  }

  function storageLine() {
    const info = DB().storageInfo();
    if (info.backend !== "idb") return "Хранилище недоступно: записи во временном резерве браузера.";
    const kept = state.persisted === true ? "постоянное" : "может очищаться";
    const where = isStandalone()
      ? ""
      : " В Safari записи хранятся отдельно от приложения на экране «Домой» и стираются, если не открывать Planin 7 дней.";
    return `Хранилище: ${kept}.${where} Данные только на этом устройстве — время от времени делайте экспорт.`;
  }

  function showStorageState() {
    const info = DB().storageInfo();
    if (info.backend !== "idb") {
      showNotice("Хранилище недоступно — записи во временном резерве", { label: "повторить", run: () => { updatePending = true; applyUpdate({ force: true }); } });
    } else if (info.merged) {
      offerUndo(`из резерва перенесено: ${info.merged}`, null);
    }
  }

  function onStorage(e) {
    const detail = (e && e.detail) || {};
    if (detail.state === "blocked") {
      const boot = document.querySelector(".boot");
      if (boot) { boot.textContent = "Закройте Planin в другой вкладке — обновляется хранилище"; boot.hidden = false; }
    } else if (detail.state === "fallback") {
      if ($("#notice")) showStorageState();
    } else if (detail.state === "versionchange") {
      // Другая копия обновила схему: перезагрузиться, сохранив черновик.
      updatePending = true;
      applyUpdate({ force: true });
    }
  }

  // R-25: единый тактильный отклик. «tick» — шаг (день на тарелках, порог), «press» — срабатывание
  // (долгое нажатие, начало перетаскивания). Работает на Android; в Safari на iOS Vibration API нет,
  // там no-op. Системный щелчок iOS 18+ даёт только прямое касание <input type="checkbox" switch>
  // (рабочие дни в настройках), программно его не вызвать — жесты компенсируются визуально.
  function haptic(kind) {
    try { if (navigator.vibrate) navigator.vibrate(kind === "tick" ? 6 : 10); } catch { /* нет API */ }
  }

  function isIdle() {
    const a = document.activeElement;
    const typing = !!a && a !== document.body && !!a.closest && !!a.closest("input, textarea, select, [contenteditable]");
    return !typing && !readLine().trim() && !state.overlay && !state.editing;
  }

  // Новый SW уже управляет страницей. Не перезагружаем посреди ввода.
  function onUpdate() {
    if (window.__planinActivated && isIdle() && Date.now() - (window.__planinBooted || 0) < 3000) {
      applyUpdate(); // новая версия включилась сразу после запуска — перезагрузка незаметна
      return;
    }
    if (updatePending) return;
    updatePending = true;
    if (isIdle()) return; // перезагрузимся при уходе в фон (onVisible)
    if (state.overlay || state.editing) {
      updateToastDue = true; // под шторкой тост не виден — покажем, когда она закроется
      return;
    }
    showUpdateToast();
  }

  let updateToastDue = false;
  function showUpdateToast() {
    undoFn = null;
    goKey = null;
    $("#toast-text").textContent = "Planin обновился";
    $("#toast-undo").hidden = true;
    $("#toast-go").hidden = true;
    $("#toast-update").hidden = false;
    toastKind = "update";
    openToast(6000);
  }

  // R-8: тост въезжает и уходит, пока палец на нём — не прячется, смахивание вниз закрывает.
  let toastKind = null;
  let toastLeft = 0;
  let toastAt = 0;
  let toastOutTimer = null;
  function openToast(ms) {
    const el = $("#toast");
    clearTimeout(toastOutTimer);
    const again = !el.hidden && !el.classList.contains("is-out");
    el.hidden = false;
    el.classList.remove("is-out");
    el.style.transform = "";
    if (!again) {
      el.classList.remove("is-in");
      void el.offsetWidth; // перезапуск анимации появления
      el.classList.add("is-in");
    }
    document.body.classList.add("has-toast");
    runToastTimer(ms);
  }
  function runToastTimer(ms) {
    clearTimeout(toastTimer);
    toastLeft = ms;
    toastAt = Date.now();
    toastTimer = setTimeout(() => closeToast(), ms);
  }
  function pauseToast() {
    if (!toastAt) return;
    clearTimeout(toastTimer);
    toastLeft = Math.max(0, toastLeft - (Date.now() - toastAt));
    toastAt = 0;
  }
  function resumeToast() {
    if (toastAt || $("#toast").hidden) return;
    runToastTimer(Math.max(1500, toastLeft));
  }
  function closeToast(now) {
    const el = $("#toast");
    clearTimeout(toastTimer);
    toastAt = 0;
    const kind = toastKind;
    toastKind = null;
    undoFn = null;
    goKey = null;
    document.body.classList.remove("has-toast");
    if (el.hidden) return;
    el.classList.remove("is-in");
    el.classList.add("is-out");
    clearTimeout(toastOutTimer);
    toastOutTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("is-out");
      el.style.transform = "";
    }, now || M().reduce() ? 0 : 160);
    // Ждущее обновление не теряется под тостом «вписано» / «в список» (очередь тостов).
    if (kind !== "update" && updatePending && !reloading && !state.overlay && !state.editing) {
      setTimeout(() => { if (!toastKind && updatePending && !reloading) showUpdateToast(); }, 200);
    }
  }
  function bindToast() {
    const el = $("#toast");
    let y0 = null;
    el.addEventListener("pointerdown", pauseToast);
    el.addEventListener("pointerup", resumeToast);
    el.addEventListener("pointercancel", resumeToast);
    let x0 = 0;
    // Горизонталь по тосту листает день, как по листу: тост не должен отнимать низ листа.
    el.addEventListener("touchstart", (e) => {
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      pauseToast();
      begin(e, "touch");
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      move(e, "touch");
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0 && dy > Math.abs(e.touches[0].clientX - x0)) el.style.transform = `translateY(${dy}px)`;
    }, { passive: false });
    el.addEventListener("touchcancel", () => {
      cancelDrag();
      y0 = null;
      el.style.transform = "";
      resumeToast();
    });
    el.addEventListener("touchend", (e) => {
      const sliding = drag && drag.mode === "x";
      end(e, "touch");
      if (y0 == null) return;
      if (sliding) {
        y0 = null;
        el.style.transform = "";
        resumeToast();
        return;
      }
      const t = e.changedTouches && e.changedTouches[0];
      const dy = t ? t.clientY - y0 : 0;
      y0 = null;
      if (dy > 24) closeToast();
      else {
        el.style.transform = "";
        resumeToast();
      }
    });
  }

  // Q-16: ждущий SW активируется только по просьбе страницы. force — явное «обновить»
  // (кнопка тоста, смена схемы базы): перезагрузка в любом случае. Без force (уход в фон)
  // SW может отказать, если открыта ещё вкладка, — тогда остаёмся как есть.
  async function applyUpdate(opts) {
    if (reloading) return;
    saveDraftNow(); // сразу: дальше может не успеть
    const force = !!(opts && opts.force);
    let settle = false;
    if (state.editing) {
      if (!closeEdit(true)) return; // правка с ошибкой — не теряем её
      settle = true;
    }
    if (inline) {
      // batch10 P1-2: правка на месте сохраняется до перезагрузки (копия edit:<id> уже лежит)
      await endInline("save");
      if (inline) return; // не записалось — остаёмся в правке
      settle = true;
    }
    reloading = true;
    for (let i = 0; committing && i < 40; i += 1) {
      settle = true;
      await wait(50);
    }
    if (settle) await wait(150); // дать IndexedDB дописать начатые транзакции
    saveDraftNow(); // черновик переживает перезагрузку; blur при выгрузке его не вписывает (reloading)
    const took = await activateWaiting(force);
    if (!took && !force && !window.__planinActivated) {
      reloading = false; // SW не согласился (другая вкладка) — обновимся позже
      return;
    }
    location.reload();
  }

  async function activateWaiting(force) {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.getRegistration) return false;
    let reg = null;
    try { reg = await sw.getRegistration(); } catch { return false; }
    if (!reg || !reg.waiting) return false;
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        document.removeEventListener("planin:activated", onTook);
        resolve(ok);
      };
      const onTook = () => done(true);
      const timer = setTimeout(() => done(false), 1500);
      document.addEventListener("planin:activated", onTook);
      reg.waiting.postMessage({ type: "SKIP_WAITING", force });
    });
  }

  async function loadDrafts() {
    try {
      const raw = localStorage.getItem(DRAFTS_KEY);
      localStorage.setItem(DRAFTS_KEY, raw || "{}"); // проверка, что запись возможна
      draftsLS = true;
      return;
    } catch { draftsLS = false; }
    try { draftsMem = (await DB().getDrafts()) || {}; } catch { draftsMem = {}; }
  }

  function readDrafts() {
    if (draftsLS) {
      try {
        const all = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
        if (all && typeof all === "object" && !Array.isArray(all)) return all;
        return {};
      } catch { return { ...draftsMem }; }
    }
    return { ...draftsMem };
  }

  function writeDrafts(all) {
    draftsMem = all;
    if (draftsLS) {
      try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
        return;
      } catch { draftsLS = false; }
    }
    DB().saveDrafts(all).catch(() => { /* останется в памяти до следующей записи */ });
  }

  function getDraft(key) {
    const d = readDrafts()[key];
    return d && typeof d.text === "string" && d.text.trim() ? d : null;
  }

  // У черновика свой id: задача пишется с ним же, поэтому повторный коммит
  // (blur при выгрузке + восстановленный черновик) перезапишет ту же запись, а не создаст дубль.
  function setDraft(key, text, caret) {
    const all = readDrafts();
    const had = !!all[key];
    if (text && text.trim()) {
      const id = (had && all[key].id) || DB().id(key === "shop" ? "e" : "t");
      all[key] = { id, text, caret: caret == null ? text.length : caret, at: Date.now() };
    } else if (had) {
      delete all[key];
    } else return;
    writeDrafts(all);
  }

  // Коммит: черновик уходит в «ожидание записи» (ключ "~id") и удаляется, только когда
  // запись в IndexedDB подтверждена. Строка при этом свободна для нового текста с новым id.
  function parkDraft(key) {
    const all = readDrafts();
    const d = all[key];
    if (!d) return null;
    delete all[key];
    all[`~${d.id}`] = { ...d, day: key, pending: true };
    writeDrafts(all);
    return d;
  }

  function dropParked(d) {
    if (!d) return;
    const all = readDrafts();
    if (!all[`~${d.id}`]) return;
    delete all[`~${d.id}`];
    writeDrafts(all);
  }

  // Запись не удалась: черновик возвращается на своё место.
  function unparkDraft(d) {
    if (!d) return;
    const all = readDrafts();
    delete all[`~${d.id}`];
    if (!all[d.day]) all[d.day] = { id: d.id, text: d.text, caret: d.caret, at: d.at };
    writeDrafts(all);
  }

  function savedWithId(id) {
    const tail = String(id || "").replace(/^[teh]_/, "");
    return !!tail && (state.tasks.some((t) => t.id === `t_${tail}`) || state.errands.some((e) => e.id === `e_${tail}`) || state.habits.some((h) => h.id === `h_${tail}`));
  }

  // P2-4: очередь мыслей дня (ключ "next:<день>"): возвращённое «отменой», пока в строке другое.
  function nextKey(day) {
    return `next:${day}`;
  }
  function nextItems(all, day) {
    const q = all[nextKey(day)];
    return q && Array.isArray(q.items) ? q.items.filter((i) => i && typeof i.text === "string" && i.text.trim()) : [];
  }
  function queueNext(day, text, id) {
    const all = readDrafts();
    const items = nextItems(all, day);
    items.push({ id: id || DB().id("t"), text, at: Date.now() });
    all[nextKey(day)] = { items };
    writeDrafts(all);
  }
  // Строка дня пуста — первая мысль из очереди становится черновиком строки.
  function takeNext(all, day) {
    if (all[day] && typeof all[day].text === "string" && all[day].text.trim()) return null;
    const items = nextItems(all, day);
    if (!items.length && !all[nextKey(day)]) return null;
    const first = items.shift();
    if (items.length) all[nextKey(day)] = { items };
    else delete all[nextKey(day)];
    if (first) all[day] = { id: first.id, text: first.text, caret: first.text.length, at: Date.now() };
    return first || null;
  }
  function promoteNext(day) {
    const all = readDrafts();
    const had = !!all[nextKey(day)];
    const first = takeNext(all, day);
    if (had) writeDrafts(all);
    if (!first || composerDay !== day) return;
    writeLine(first.text);
    pendingCaret = first.text.length;
    if (document.activeElement === $("#line")) {
      try { setCaret($("#line"), first.text.length); } catch { /* caret */ }
    }
    updateGhost();
  }

  // После запуска: запись подтвердилась — ожидание снять; не подтвердилась — вернуть черновик.
  function reconcileDrafts() {
    const all = readDrafts();
    let changed = false;
    Object.keys(all).forEach((key) => {
      const d = all[key];
      if (!d || typeof d !== "object" || key.startsWith("edit:") || key.startsWith("next:")) return;
      if (key.startsWith("~")) {
        delete all[key];
        changed = true;
        if (savedWithId(d.id)) return;
        const day = d.day || "shop";
        const busy = all[day] && typeof all[day].text === "string" && all[day].text.trim();
        // P2-4: в строке дня уже другое — не склеиваем, а ставим в очередь дня.
        if (busy && all[day].text.trim() !== String(d.text || "").trim()) {
          const items = nextItems(all, day);
          items.push({ id: d.id, text: d.text, at: d.at || Date.now() });
          all[nextKey(day)] = { items };
        } else if (!busy) all[day] = { id: d.id, text: d.text, caret: d.caret, at: d.at };
      } else if (d.id && savedWithId(d.id)) {
        delete all[key];
        changed = true;
      }
    });
    // Очередь дня без черновика строки (например, прошлый день в хвосте) — первая мысль становится черновиком.
    Object.keys(all).filter((k) => k.startsWith("next:")).forEach((k) => {
      if (takeNext(all, k.slice(5))) changed = true;
      else if (!nextItems(all, k.slice(5)).length) { delete all[k]; changed = true; }
    });
    if (changed) writeDrafts(all);
  }

  function saveDraftNow() {
    clearTimeout(draftTimer);
    draftTimer = null;
    const line = $("#line");
    if (line && composerDay) {
      setDraft(composerDay, readEditable(line), document.activeElement === line ? caretOffset(line) : null);
    }
    const shop = $("#shop-line");
    if (shop) setDraft("shop", readEditable(shop));
    backupEdit();
  }

  // Шторка правки: набранное пишется синхронно в planin:drafts["edit:<id>"] на каждый ввод
  // и снимается только после подтверждённой записи в IndexedDB. При запуске — применяется.
  function editKey(id) {
    return `edit:${id}`;
  }

  function backupEdit() {
    if (inline && !inline.closing) backupInline();
    if (!state.editing || !state.editDraft) return;
    const { kind, id } = state.editing;
    const field = $("#sheet-title");
    const d = state.editDraft;
    const title = field ? field.value : d.title;
    const all = readDrafts();
    const entry = { kind, id, title: String(title == null ? "" : title), at: Date.now() };
    if (kind === "task") {
      const model = state.tasks.find((t) => t.id === id);
      entry.taskKind = d.kind;
      entry.startMin = d.startMin == null ? null : d.startMin;
      entry.endMin = d.endMin == null ? null : d.endMin;
      if (d.timeText != null && String(d.timeText).trim()) entry.timeText = String(d.timeText);
      entry.date = model ? model.date : state.cursor;
      entry.isNew = drafts.has(id);
    }
    all[editKey(id)] = entry;
    writeDrafts(all);
  }

  // batch10 P1-2: правка на месте — та же копия edit:<id>, но с сырым текстом строки (inline: true):
  // при запуске он разбирается так же, как Enter («… завтра» переносит дело), и применяется с отменой.
  function backupInline() {
    const task = state.tasks.find((t) => t.id === inline.id);
    if (!task) return;
    const text = readEditable(inline.title).replace(/\s+/g, " ").trim();
    const all = readDrafts();
    if (!text || text === inline.before) {
      if (all[editKey(task.id)] && all[editKey(task.id)].inline) { delete all[editKey(task.id)]; writeDrafts(all); }
      return;
    }
    all[editKey(task.id)] = { kind: "task", id: task.id, title: text, inline: true, date: task.date, at: Date.now() };
    writeDrafts(all);
  }

  function dropEditBackup(id, at) {
    const all = readDrafts();
    const cur = all[editKey(id)];
    if (!cur) return;
    if (at != null && cur.at > at) return; // после записи набрали ещё — не снимать
    delete all[editKey(id)];
    writeDrafts(all);
  }

  function cleanEditBackup(raw, key) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.id !== "string" || !raw.id || key !== editKey(raw.id)) return null;
    if (!["task", "habit", "errand"].includes(raw.kind)) return null;
    const minute = (v) => (Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null);
    const b = {
      kind: raw.kind,
      id: raw.id,
      title: typeof raw.title === "string" ? raw.title.slice(0, 1000) : "",
      at: Number.isFinite(raw.at) ? raw.at : Date.now()
    };
    if (raw.kind !== "task") return b;
    if (raw.inline === true) b.inline = true;
    b.isNew = raw.isNew === true;
    b.date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && D().ymdValid(...raw.date.split("-").map(Number)) ? raw.date : null;
    if (typeof raw.timeText === "string") b.timeText = raw.timeText.slice(0, 100);
    const kind = ["loose", "slot", "window"].includes(raw.taskKind) ? raw.taskKind : null;
    const startMin = minute(raw.startMin);
    const endMin = D().windowEndOk(startMin, raw.endMin) ? raw.endMin : null; // Q-26/Q-27: через полночь — до 12:00 и не дольше 14 ч
    // Время без чисел не переносим: «час» без начала или «окно» без границ — это мусор, а не правка.
    if (kind === "loose" || (kind === "slot" && startMin != null) || (kind === "window" && (startMin != null || endMin != null))) {
      b.taskKind = kind;
      b.startMin = startMin;
      b.endMin = endMin;
    }
    return b;
  }

  async function restoreEdits() {
    const all = readDrafts();
    const keys = Object.keys(all).filter((k) => k.startsWith("edit:"));
    const undo = []; // P2-3: как было до восстановления — для «отменить» на тосте
    const snap = (kind, model) => ({ kind, id: model.id, prev: model.draft ? null : JSON.parse(JSON.stringify(model)) });
    for (const key of keys) {
      // Q-18: копия правки проходит те же проверки типов, что импорт; битая — снимается.
      const b = cleanEditBackup(all[key], key);
      if (!b) {
        const cur = readDrafts();
        delete cur[key];
        writeDrafts(cur);
        continue;
      }
      const title = b.title.trim();
      try {
        if (b && b.kind === "task") {
          let model = state.tasks.find((t) => t.id === b.id);
          const before = model ? snap("task", model) : { kind: "task", id: b.id, prev: null };
          if (!model && title && b.isNew && typeof b.date === "string") {
            model = { id: b.id, date: b.date, kind: "loose", title, startMin: null, endMin: null, order: nextOrder(b.date), createdAt: b.at || Date.now() };
            state.tasks.push(model);
          }
          if (b.inline && model && !model.done && title) {
            // правка на месте: текст разбирается, как при Enter
            const was = JSON.stringify([model.title, model.kind, model.startMin, model.endMin, model.date]);
            applyInlineText(model, title);
            if (JSON.stringify([model.title, model.kind, model.startMin, model.endMin, model.date]) !== was) {
              model.updatedAt = Date.now();
              await DB().putTask(model);
              undo.push(before);
            }
            dropEditBackup(b.id);
            continue;
          }
          if (typeof b.timeText === "string") {
            const when = D().parseWhen(b.timeText);
            if (when.ok && !when.empty) Object.assign(b, { taskKind: when.kind, startMin: when.startMin, endMin: when.kind === "window" ? when.endMin : null });
          }
          if (model && (title || !model.draft)) {
            const changed = (title && title !== model.title) || model.draft ||
              (["loose", "slot", "window"].includes(b.taskKind) && (b.taskKind !== model.kind || b.startMin !== model.startMin || b.endMin !== model.endMin));
            if (title) model.title = title;
            if (["loose", "slot", "window"].includes(b.taskKind)) {
              model.kind = b.taskKind;
              model.startMin = b.taskKind === "loose" ? null : b.startMin;
              model.endMin = b.taskKind === "window" ? b.endMin : null;
            }
            delete model.draft;
            model.updatedAt = Date.now();
            await DB().putTask(model);
            if (changed) undo.push(before);
          }
        } else if (b && b.kind === "habit" && title) {
          const model = state.habits.find((h) => h.id === b.id);
          if (model && model.title !== title) {
            const before = snap("habit", model);
            model.title = title;
            model.updatedAt = Date.now();
            await DB().putHabit(model);
            undo.push(before);
          }
        } else if (b && b.kind === "errand" && title) {
          const model = state.errands.find((e) => e.id === b.id);
          if (model && model.text !== title) {
            const before = snap("errand", model);
            model.text = title;
            await DB().putErrand(model);
            undo.push(before);
          }
        }
        dropEditBackup(b && b.id);
      } catch { /* запись не удалась — копия остаётся до следующего запуска */ }
    }
    return undo;
  }

  // P2-3: тост «правка восстановлена» переживает лишнюю перезагрузку (холодный старт с ждущим SW):
  // флаг и снимки «как было» лежат в sessionStorage, пока тост не отжил своё.
  const RESTORED_KEY = "planin:restored";
  function readRestored() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(RESTORED_KEY) || "null");
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.undo) || Date.now() - Number(raw.at) > 60000) return null;
      const undo = raw.undo.filter((u) => u && ["task", "habit", "errand"].includes(u.kind) && typeof u.id === "string" &&
        (u.prev === null || (u.prev && typeof u.prev === "object" && u.prev.id === u.id)));
      return undo.length ? undo : null;
    } catch {
      return null;
    }
  }
  function stashRestored(undo) {
    const old = readRestored() || [];
    try { sessionStorage.setItem(RESTORED_KEY, JSON.stringify({ at: Date.now(), undo: old.concat(undo) })); } catch { /* private mode */ }
  }
  function clearRestored() {
    try { sessionStorage.removeItem(RESTORED_KEY); } catch { /* private mode */ }
  }
  function showRestored() {
    const undo = readRestored();
    if (!undo) {
      clearRestored();
      return;
    }
    offerUndo("правка восстановлена", () => undoRestored(undo), null, "отменить");
    setTimeout(() => { if (!reloading) clearRestored(); }, 5000);
  }
  async function undoRestored(undo) {
    clearRestored();
    const lists = { task: "tasks", habit: "habits", errand: "errands" };
    const put = { task: "putTask", habit: "putHabit", errand: "putErrand" };
    const del = { task: "deleteTask", habit: "deleteHabit", errand: "deleteErrand" };
    for (const u of undo.slice().reverse()) {
      const list = state[lists[u.kind]];
      const at = list.findIndex((x) => x.id === u.id);
      try {
        if (u.prev) {
          if (at >= 0) list[at] = u.prev;
          else list.push(u.prev);
          await DB()[put[u.kind]](u.prev);
        } else {
          if (at >= 0) list.splice(at, 1);
          if (DB()[del[u.kind]]) await DB()[del[u.kind]](u.id);
        }
      } catch { /* запись не удалась — останется восстановленное */ }
    }
    renderSheets(true);
    refreshShop();
    updateGhost();
  }

  // P2 (перепроверка): черновик пишется синхронно на каждый ввод, как backupEdit(), —
  // без окна в 300 мс, в которое iOS может выгрузить PWA и потерять последние буквы.
  function scheduleDraft() {
    saveDraftNow();
  }

  // Строка ввода привязана к дню: при смене дня черновик старого дня сохраняется,
  // в строку встаёт черновик нового (или пусто).
  function syncComposerDay() {
    if (composerDay === state.cursor) return;
    const prev = composerDay;
    endInsertTop();
    const line = $("#line");
    const hadText = !!(prev && line && readEditable(line).trim());
    if (prev) saveDraftNow();
    composerDay = state.cursor;
    if (!line) return;
    { const all = readDrafts(); if (all[nextKey(composerDay)] && takeNext(all, composerDay)) writeDrafts(all); }
    const mine = getDraft(composerDay);
    writeLine(mine ? mine.text : "");
    // P2-5: восстановленный черновик — каретка в конце (дописывают, а не правят начало).
    pendingCaret = mine ? mine.text.length : null;
    if (document.activeElement === line) {
      try { setCaret(line, mine ? mine.text.length : 0); } catch { /* caret */ }
    }
    if (!mine && hadText) showDraftNote(prev);
    else if (draftNote) draftNote = null;
    updateGhost();
  }

  function showDraftNote(day) {
    draftNote = { day, until: Date.now() + 4000 };
    updateGhost();
    setTimeout(() => {
      if (draftNote && draftNote.day === day && Date.now() >= draftNote.until) {
        draftNote = null;
        updateGhost();
      }
    }, 4050);
  }

  function dayWord(key) {
    const diff = D().diffDays(state.today, key);
    if (diff === 0) return "сегодня";
    if (diff === 1) return "завтра";
    if (diff === -1) return "вчера";
    const h = D().head(key, state.today);
    return `${h.short} ${h.day}`;
  }

  // Полная фраза: разбор удался, название ≥2 символов, в конце нет висящего предлога.
  const HANGING = new Set(["в", "во", "на", "к", "ко", "с", "со", "до", "через", "по", "от", "после", "перед", "за", "у", "для", "из", "без", "про", "о", "об", "под", "над"]);
  function completePhrase(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    const parsed = P().parse(raw, parseCtx(state.cursor));
    if (!parsed.ok || String(parsed.title || "").trim().length < 2) return false;
    const last = raw.toLowerCase().split(/\s+/).pop();
    return !HANGING.has(last);
  }

  // blur строки ввода: черновик сохраняется всегда. Задачей он становится, только если
  // клавиатуру закрыли намеренно («Готово»: без касания страницы за 400 мс) и фраза полная.
  function syllables(text) {
    return (String(text).toLowerCase().match(/[аеёиоуыэюяaeiouy]/g) || []).length;
  }
  function onLineBlur() {
    if (reloading) return;
    saveDraftNow();
    if (Date.now() - lastPointerAt < 400 || document.visibilityState !== "visible") {
      endInsertTop();
      return;
    }
    setTimeout(() => {
      const line = $("#line");
      if (!line || document.activeElement === line || reloading) return;
      if (document.visibilityState !== "visible" || Date.now() - lastPointerAt < 460) return;
      // batch7: при видимом дополнении обрывок в один слог («сп», «бас») — черновик, а не дело.
      const text = readLine();
      if (completePhrase(text) && !(ghostComp && syllables(text) <= 1)) commitComposer();
      endInsertTop();
    }, 60);
  }

  // Строка-черновик другого дня: тап — дописать в строке ввода.
  function pullDraft(day, focus) {
    const d = getDraft(day);
    if (!d) return;
    if (day !== state.cursor) {
      setDraft(day, "");
      const cur = readLine().trim();
      const text = cur ? `${cur} ${d.text}` : d.text;
      writeLine(text);
      setDraft(composerDay, text);
      renderSheets(false);
    }
    updateGhost();
    if (focus !== false) openKeyboard();
  }

  // Свайп ← / «вписать»: черновик как есть (без времени, если разбор неполный).
  function commitDraft(day, intoToday) {
    const d = getDraft(day);
    if (!d) return;
    const text = d.text.trim();
    // Черновик прошлого дня из хвоста вписывается в сегодня.
    const into = intoToday ? state.today : day;
    const parsed = P().parse(text, parseCtx(into));
    const base = parsed.ok ? parsed : { ok: true, kind: "loose", title: text, date: into, startMin: null, endMin: null };
    const parked = parkDraft(day);
    const item = { ...base, id: d.id };
    Promise.resolve(commitParsed(item, () => { setDraft(day, d.text, d.caret); renderSheets(false); }))
      .then(() => dropParked(parked))
      .catch((err) => {
        unparkDraft(parked);
        renderSheets(false);
        offerUndo(writeFailText(err), null);
      });
  }

  function eraseDraft(day) {
    const d = getDraft(day);
    if (!d) return;
    setDraft(day, "");
    renderSheets(false);
    offerUndo("черновик стёрт", () => {
      setDraft(day, d.text, d.caret);
      renderSheets(false);
    });
  }

  // Запись в IndexedDB упала: убрать из state то, чего нет на диске, и пробросить ошибку.
  async function saveOrDrop(promise, drop) {
    try {
      return await promise;
    } catch (err) {
      drop();
      renderSheets(false);
      throw err;
    }
  }

  function writeFailText(err) {
    return err && err.quota ? "не сохранилось: на устройстве нет места" : "не сохранилось на устройстве";
  }

  function isWriteError(err) {
    return !!err && err.name === "PlaninWriteError";
  }

  function offerUndo(text, fn, key, undoLabel, ms) {
    undoFn = fn || null;
    goKey = key || null;
    $("#toast-update").hidden = true;
    $("#toast-text").textContent = text;
    $("#toast-undo").textContent = undoLabel || "отмена";
    $("#toast-undo").hidden = !fn;
    $("#toast-go").hidden = !key;
    $("#toast-go").textContent = "открыть";
    goFn = null;
    toastKind = "undo";
    openToast(ms || 5000);
  }

  async function runUndo() {
    const fn = undoFn;
    closeToast();
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

  function idFor(draftId, prefix) {
    return draftId ? `${prefix}_${String(draftId).replace(/^[teh]_/, "")}` : DB().id(prefix);
  }

  // R-35: все части одной строки — одной записью в истории: тост «вписано 4 · отмена» убирает все сразу.
  async function commitMany(items, onUndo) {
    const before = snapshot();
    for (const it of items) await commitParsed(it, null, { quiet: true });
    renderSheets(true);
    refreshShop();
    // Все дела ушли в один другой день — тост называет его и даёт «открыть»; иначе просто «вписано N».
    const days = new Set(items.filter((it) => it.kind !== "errand" && it.kind !== "habit").map((it) => it.date));
    const only = days.size === 1 ? [...days][0] : null;
    const away = only && only !== state.cursor ? only : null;
    offerUndo(`вписано ${items.length}${away ? ` · ${D().moveLabel(state.cursor, D().diffDays(state.cursor, away))}` : ""}`, () => {
      const back = restore(before);
      if (onUndo) onUndo();
      return back;
    }, away);
    noteAdded();
  }

  async function commitParsed(parsed, onUndo, opts) {
    if (!parsed || !parsed.ok) return;
    const quiet = !!(opts && opts.quiet);
    const before = snapshot();
    const now = Date.now();
    let label = "вписано";
    let open = null;
    let added = null;
    if (parsed.kind === "errand") {
      const item = {
        id: idFor(parsed.id, "e"),
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
      await saveOrDrop(DB().putErrand(item), () => { state.errands = state.errands.filter((e) => e !== item); });
      label = "в список";
    } else if (parsed.kind === "habit") {
      const habit = {
        id: idFor(parsed.id, "h"),
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
      await saveOrDrop(DB().putHabit(habit), () => { state.habits = state.habits.filter((h) => h !== habit); });
      label = D().habitPhrase(habit);
    } else {
      const task = {
        id: idFor(parsed.id, "t"),
        kind: parsed.kind,
        title: parsed.title,
        date: parsed.date,
        order: parsed.top ? topOrder(parsed.date) : nextOrder(parsed.date),
        startMin: parsed.startMin,
        endMin: parsed.endMin,
        done: parsed.done === true, // R-35: «[x]» из вставленного списка
        doneAt: parsed.done === true ? now : null,
        createdAt: now,
        updatedAt: now
      };
      if (parsed.top && state.insertTop) state.insertTop.last = task.order;
      state.tasks.push(task);
      added = task;
      await saveOrDrop(DB().putTask(task), () => { state.tasks = state.tasks.filter((t) => t !== task); added = null; });
      if (parsed.date !== state.cursor) {
        label = D().moveLabel(state.cursor, D().diffDays(state.cursor, parsed.date));
        open = parsed.date;
      }
    }
    if (quiet) return;
    renderSheets(true);
    refreshShop();
    offerUndo(label, () => {
      const back = restore(before);
      if (onUndo) onUndo();
      return back;
    }, open);
    noteAdded();
    if (added && !open && offerHabit(added)) return;
    if (added) hintAfterAdd(added);
  }

  // R-33: после ≥ 3 записей с ровным ритмом тост предлагает «сделать привычкой?».
  // Один раз на название: показ сам по себе считается ответом (отказ — просто не нажать).
  let goFn = null;
  function offerHabit(task) {
    if (!suggestIdx || !Sg().habitOffer) return false;
    const key = Sg().norm(task.title);
    if (!key || (state.settings.habitAsked && state.settings.habitAsked[key])) return false;
    if (state.habits.some((h) => Sg().norm(h.title) === key)) return false;
    const idx = buildSuggest();
    if (!idx.get(key) || !idx.get(key).dates.includes(task.date)) Sg().add(idx, task, state.today);
    const offer = Sg().habitOffer(idx.get(key));
    if (!offer) return false;
    state.settings = { ...state.settings, habitAsked: { ...(state.settings.habitAsked || {}), [key]: 1 } };
    DB().saveSettings(state.settings).catch(() => {});
    const habitLike = { ...offer, anchor: null };
    const go = $("#toast-go");
    $("#toast-text").textContent = `вписано · похоже на ${D().habitPhrase(habitLike)}`;
    go.textContent = "сделать привычкой";
    go.hidden = false;
    goFn = () => makeHabitFrom(task, offer);
    toastKind = "undo";
    openToast(6000);
    return true;
  }
  async function makeHabitFrom(task, offer) {
    // Сегодняшнее дело остаётся; привычка начинается со следующего раза.
    await commitParsed({
      ok: true,
      kind: "habit",
      title: task.title,
      date: D().addDays(task.date, offer.everyMin),
      habit: { everyMin: offer.everyMin, everyMax: offer.everyMax, weekday: offer.weekday, anchor: null, timeMin: offer.timeMin }
    });
  }

  // batch2 п.10: Enter во время записи предыдущего дела — снимок {text, day} в очередь.
  // Строка сразу свободна; набранное после Enter остаётся в ней и не уходит с предыдущим.
  const commitQueue = [];
  function commitComposer(keepAnyway) {
    const text = readLine().trim();
    const many = manyParts(text);
    const parsed = many ? { ok: true } : P().parse(text, parseCtx(state.cursor));
    if (!parsed.ok) {
      if (!keepAnyway || !text) {
        updateGhost();
        return;
      }
    }
    const day = composerDay;
    clearTimeout(draftTimer);
    // batch8 P3: больше MANY_MAX частей — остаток не теряется, а остаётся в строке (и в черновике).
    const rest = many && many.length > MANY_MAX ? many.slice(MANY_MAX).map((x) => x.text).join("; ") : "";
    const sent = rest ? many.slice(0, MANY_MAX).map((x) => x.text).join("; ") : text;
    setDraft(day, rest ? sent : readLine(), null); // свежий текст — в черновик, id остаётся
    const parked = parkDraft(day); // «~id» переживёт перезапуск, пока запись не подтверждена
    writeLine(rest);
    pendingCaret = rest ? rest.length : null;
    if (rest) setDraft(day, rest, rest.length);
    updateGhost();
    const base = parsed.ok ? parsed : {
      ok: true,
      kind: "loose",
      title: text,
      date: state.cursor,
      startMin: null,
      endMin: null
    };
    const top = !!(state.insertTop && state.insertTop.day === base.date && base.kind === "loose");
    const snap = { text: sent, rest, day, parked, item: { ...base, id: parked ? parked.id : null, top } };
    if (many) {
      snap.items = many.slice(0, MANY_MAX).map((r, i) => ({ ...manyItem(r), id: i === 0 && parked ? parked.id : null }));
      delete snap.item;
    }
    if (committing) {
      commitQueue.push(snap);
      return;
    }
    runCommit(snap);
  }

  function runCommit(snap) {
    const { day, parked, item } = snap;
    let text = snap.text;
    committing = true;
    // «отмена» у тоста «вписано» возвращает текст в строку (а не выбрасывает набранное).
    // P2-4: если в строке уже новая мысль — не склеиваем: возвращённое встаёт в очередь дня и придёт в строку следующим.
    const giveBack = () => {
      const cur = composerDay === day ? readLine().trim() : ((getDraft(day) || {}).text || "").trim();
      // batch8 P3: в строке только остаток сверх 30 — отмена собирает строку обратно целиком.
      if (snap.rest && cur === snap.rest) text = `${snap.text}; ${snap.rest}`;
      if (cur && cur !== text && !(snap.rest && cur === snap.rest)) {
        queueNext(day, text);
        offerUndo(`«${text.length > 28 ? `${text.slice(0, 27)}…` : text}» — следующей строкой`, null, null, null, 3500);
        return;
      }
      if (composerDay === day) {
        writeLine(text);
        pendingCaret = text.length;
        const line = $("#line");
        if (document.activeElement === line) {
          try { setCaret(line, text.length); } catch { /* caret */ }
        }
      }
      setDraft(day, text, text.length);
      updateGhost();
    };
    const write = snap.items ? () => commitMany(snap.items, giveBack) : () => commitParsed(item, giveBack);
    Promise.resolve(write())
      .then(() => dropParked(parked))
      .catch((err) => {
        unparkDraft(parked);
        lineWriteFailed(err, text, () => Promise.resolve(write()).then(() => setDraft(composerDay, "")));
        // Запись не идёт — снимки из очереди не теряем: они ждут в очереди мыслей своего дня.
        while (commitQueue.length) {
          const q = commitQueue.shift();
          dropParked(q.parked);
          queueNext(q.day, q.text, q.parked ? q.parked.id : undefined);
        }
      })
      .finally(() => {
        committing = false;
        if (commitQueue.length) {
          runCommit(commitQueue.shift());
          return;
        }
        if (composerDay === day && !readLine().trim()) promoteNext(day);
      });
  }

  // Запись не удалась: текст возвращается в строку, в тосте «повторить» (Q-6).
  function lineWriteFailed(err, text, retry) {
    const restored = !readLine().trim();
    if (restored) writeLine(text);
    saveDraftNow();
    updateGhost();
    offerUndo(writeFailText(err), async () => {
      if (restored && readLine().trim() !== text) return; // уже вписано (blur) или изменено
      // Текст уходит из строки до записи: иначе его же впишет blur (дубль).
      if (readLine().trim() === text) writeLine("");
      try {
        await retry();
        updateGhost();
      } catch (again) {
        lineWriteFailed(again, text, retry);
      }
    }, null, "повторить");
  }

  // Решение исследователя: на blur покупка вписывается сама, кроме одной буквы и висящего предлога —
  // такое остаётся черновиком «shop» («м», «хлеб в»).
  function shopBlurReady(text) {
    if (text.length < 2) return false;
    return !HANGING.has(text.toLowerCase().split(/\s+/).pop());
  }

  let shopEscaping = false;
  function commitShopLine(shop, onBlur) {
    if (!shop || committing) return;
    const text = readEditable(shop).trim();
    if (!text) return;
    if (onBlur && !shopBlurReady(text)) {
      setDraft("shop", readEditable(shop));
      return;
    }
    committing = true;
    clearTimeout(draftTimer);
    setDraft("shop", readEditable(shop));
    const parked = parkDraft("shop");
    shop.textContent = "";
    shop.classList.add("is-empty");
    Promise.resolve(addErrandFrom(text, parked && parked.id, onBlur))
      .then(() => dropParked(parked))
      .catch((err) => {
        unparkDraft(parked);
        const cur = $("#shop-line");
        if (cur && !readEditable(cur).trim()) {
          cur.textContent = text;
          cur.classList.remove("is-empty");
        }
        offerUndo(writeFailText(err), null);
      })
      .finally(() => { committing = false; });
  }

  async function addErrandFrom(text, draftId, onBlur) {
    const raw = text.trim();
    if (!raw) return;
    const parsed = P().parse(raw, parseCtx(state.cursor));
    const before = snapshot();
    const item = {
      id: idFor(draftId, "e"),
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
    await saveOrDrop(DB().putErrand(item), () => { state.errands = state.errands.filter((e) => e !== item); });
    // batch5 5b п.2: на blur клавиатуру не поднимаем снова — человек ушёл из строки.
    if (!onBlur) state.focusShop = true;
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

  // batch5 P3 (R-10): черта анимации — по ширине текста, как черта в покое, а не на всю колонку.
  function inkToText(el) {
    const title = el && el.querySelector(".title");
    if (!title) return;
    const row = el.getBoundingClientRect();
    const box = title.getBoundingClientRect();
    let left = box.left;
    let right = box.right;
    let mid = null;
    try {
      const range = document.createRange();
      range.selectNodeContents(title);
      // batch6 P3: название в две строки — черта по первой строке, а не между строками общего прямоугольника.
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const first = rects.length ? rects.filter((r) => Math.abs(r.top - rects[0].top) < 2) : [];
      if (first.length) {
        left = Math.max(box.left, Math.min(...first.map((r) => r.left)));
        right = Math.min(box.right, Math.max(...first.map((r) => r.right)));
        if (rects.some((r) => r.top - rects[0].top >= 2)) mid = (first[0].top + first[0].bottom) / 2 - row.top;
      }
    } catch { /* без Range — по блоку названия */ }
    if (mid == null) el.style.removeProperty("--ink-top");
    else el.style.setProperty("--ink-top", `${Math.round(mid)}px`);
    el.style.setProperty("--ink-l", `${Math.round(left - row.left)}px`);
    el.style.setProperty("--ink-w", `${Math.max(0, Math.round(right - left))}px`);
  }

  async function strike(id) {
    const el = rowEl(id);
    if (!el || M().reduce()) return;
    inkToText(el);
    el.classList.add("is-striking");
    el.style.setProperty("--strike", "1");
    await wait(170);
  }

  async function fly(id, dir) {
    const el = rowEl(id);
    if (!el || M().reduce()) return;
    const width = $("#deck").clientWidth || 320;
    const sign = dir < 0 ? -1 : 1;
    el.style.transition = M().tr("transform", 2, "out");
    el.style.transform = `translateX(${sign * width}px)`;
    await wait(M().dur(2) - 10);
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

  // R-31: дело из прошлого переносится от сегодня: быстрый «→» ставит его в сегодня, а не на день после его даты.
  async function moveTask(id, days, opts) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    await fly(id, days);
    const before = snapshot();
    const past = task.date < state.today;
    const base = past ? state.today : task.date;
    const dest = past && opts && opts.quick ? state.today : D().addDays(base, days);
    const label = dest === state.today ? "в сегодня" : D().moveLabel(base, days);
    if (past) {
      task.carried = (task.carried || 0) + 1;
      if (dest === state.today) keepTimeAhead(task);
    }
    task.date = dest;
    task.order = nextOrder(dest);
    task.updatedAt = Date.now();
    await DB().putTask(task);
    state.editing = null;
    renderSheets(true);
    offerUndo(label, () => restore(before), dest);
    hintAfterMove();
  }

  async function removeTask(id) {
    const before = snapshot();
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.editing = null;
    await DB().deleteTask(id);
    renderSheets(true);
    offerUndo("удалено", () => restore(before));
  }

  function nowMin() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  // Время остаётся, если оно впереди больше чем на 15 минут; иначе дело — «без времени».
  function keepTimeAhead(task) {
    if (task.kind === "loose") return true;
    const ref = task.kind === "window" ? task.endMin ?? task.startMin : task.startMin;
    if (ref != null && ref > nowMin() + 15) return true;
    task.kind = "loose";
    task.startMin = null;
    task.endMin = null;
    return false;
  }

  function tailBusy() {
    const plate = rowEl("tail");
    if (plate) snap(plate);
  }

  // Свайп → по плашке: всё в сегодня. Дела без времени — наверх, в порядке исходных дней.
  async function carryTail(opts) {
    const list = tailTasks();
    if (!list.length) return 0;
    const auto = !!(opts && opts.auto);
    if (!auto) await fly("tail", 1);
    const before = snapshot();
    const today = state.today;
    const stamp = Date.now();
    const loose = [];
    list.forEach((t) => {
      const wasLoose = t.kind === "loose";
      const timed = keepTimeAhead(t) && !wasLoose;
      t.date = today;
      t.carried = (t.carried || 0) + 1;
      t.updatedAt = stamp;
      if (timed) t.order = nextOrder(today);
      else loose.push(t);
    });
    const others = state.tasks.filter((t) => t.date === today && !loose.includes(t) && t.kind === "loose");
    const low = others.reduce((m, t) => Math.min(m, t.order || 0), Infinity);
    const start = (Number.isFinite(low) ? low : 1) - loose.length;
    loose.forEach((t, i) => { t.order = start + i; });
    const meta = state.dayMeta[today];
    if (meta && Array.isArray(meta.planOrder)) {
      state.dayMeta[today] = { ...meta, planOrder: [...loose.map((t) => `t:${t.id}`), ...meta.planOrder] };
    }
    state.tailOpen = false;
    try {
      await Promise.all(list.map((t) => DB().putTask(t)));
      if (meta && Array.isArray(meta.planOrder)) await DB().saveDayMeta(state.dayMeta);
    } catch (err) {
      await restore(before);
      offerUndo(writeFailText(err), null);
      return 0;
    }
    state.editing = null;
    renderSheets(true);
    const n = list.length;
    const undo = () => restore(before);
    if (auto) {
      showNotice(`перенесено с прошлых дней · ${n}`, { label: "вернуть", run: () => { hideNotice(); undo(); } }, () => {});
    } else offerUndo(`в сегодня ${n}`, undo);
    return n;
  }

  // Свайп ← по плашке: «я это сделал, просто не отметил». Отмена — 6 с.
  async function tailDone() {
    const list = tailTasks();
    if (!list.length) return;
    const before = snapshot();
    const stamp = Date.now();
    list.forEach((t) => {
      t.done = true;
      t.doneAt = stamp;
      t.updatedAt = stamp;
    });
    state.tailOpen = false;
    try {
      await Promise.all(list.map((t) => DB().putTask(t)));
    } catch (err) {
      await restore(before);
      offerUndo(writeFailText(err), null);
      return;
    }
    renderSheets(true);
    offerUndo(`сделано ${list.length}`, () => restore(before), null, null, 6000);
  }

  async function tailDelete() {
    const list = tailTasks();
    if (!list.length) return;
    const before = snapshot();
    const ids = new Set(list.map((t) => t.id));
    state.tasks = state.tasks.filter((t) => !ids.has(t.id));
    state.tailOpen = false;
    try {
      await Promise.all(list.map((t) => DB().deleteTask(t.id)));
    } catch (err) {
      await restore(before);
      offerUndo(writeFailText(err), null);
      return;
    }
    renderSheets(true);
    offerUndo(`удалено ${list.length}`, () => restore(before), null, null, 6000);
  }

  function toggleTail() {
    state.tailOpen = !state.tailOpen;
    renderSheets(true);
  }

  // Автоперенос (настройка, по умолчанию выключен): один раз в новый день.
  function maybeAutoCarry() {
    const s = state.settings;
    if (!s || !s.autoCarry || s.carriedOn === state.today) return;
    state.settings = { ...s, carriedOn: state.today };
    DB().saveSettings(state.settings).catch(() => {});
    if (tailTasks().length) carryTail({ auto: true });
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

  // Название новой задачи пишется на диск по ходу набора (флаг draft), чтобы пережить
  // перезагрузку при открытой шторке. Пустые draft-задачи убираются при запуске.
  let titleTimer = null;
  function persistNewTitle() {
    if (!state.editing || state.editing.kind !== "task" || !drafts.has(state.editing.id)) return;
    const id = state.editing.id;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      const model = state.tasks.find((t) => t.id === id);
      if (!model || !state.editDraft || !state.editing || state.editing.id !== id) return;
      model.title = String(state.editDraft.title || "").trim();
      model.draft = true;
      model.updatedAt = Date.now();
      DB().putTask(model).catch(() => { /* повторим на закрытии шторки */ });
    }, 300);
  }

  async function dropEmptyNewTasks() {
    const stale = state.tasks.filter((t) => t.draft);
    if (!stale.length) return;
    for (const t of stale) {
      try {
        if (!String(t.title || "").trim()) {
          await DB().deleteTask(t.id);
          state.tasks = state.tasks.filter((x) => x !== t);
        } else {
          delete t.draft;
          await DB().putTask(t);
        }
      } catch { /* уберём при следующем запуске */ }
    }
  }

  function emptyDraft() {
    if (!state.editing || state.editing.kind !== "task" || !drafts.has(state.editing.id)) return false;
    const field = $("#sheet-title");
    const text = field ? field.value : (state.editDraft && state.editDraft.title) || "";
    const model = state.tasks.find((t) => t.id === state.editing.id);
    return !!model && !String(text).trim();
  }

  // P2-2: запись правки не удалась — не молчим. Копия правки в planin:drafts остаётся
  // (применится при следующем запуске), а «повторить» пишет ещё раз сейчас.
  // batch4 P3: копия снимается с меткой времени — если за эти 8 с правку открыли и набрали снова, новая копия остаётся.
  function saveFailed(retry, id, at) {
    const again = () => retry()
      .then(() => {
        dropEditBackup(id, at);
        offerUndo("сохранено", null);
      })
      .catch(() => saveFailed(retry, id, at));
    offerUndo("не сохранилось", again, null, "повторить", 8000);
  }

  // batch11 P2-2: перенос (время, день, «без времени») не записался — память откатывается к before,
  // экран и база снова совпадают; «повторить» пишет тот же перенос ещё раз и применяет его.
  async function putMoved(task, before, redraw) {
    const want = JSON.parse(JSON.stringify(task));
    try {
      await DB().putTask(task);
      return true;
    } catch {
      state.tasks = before.tasks;
      renderSheets(true);
      if (redraw) redraw();
      saveFailed(async () => {
        await DB().putTask(want);
        state.tasks = state.tasks.some((t) => t.id === want.id) ? state.tasks.map((t) => (t.id === want.id ? want : t)) : state.tasks.concat(want);
        renderSheets(true);
        if (redraw) redraw();
      }, null, null);
      return false;
    }
  }

  function closeEdit(save) {
    if (state.editing && state.editDraft && save !== false && emptyDraft()) {
      // Новая строка закрыта без текста: пустую строку не оставляем в дне.
      const id = state.editing.id;
      state.tasks = state.tasks.filter((t) => t.id !== id);
      DB().deleteTask(id).then(() => dropEditBackup(id)).catch(() => {});
    } else if (state.editing && state.editDraft && save !== false) {
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
          delete model.draft;
          const at = Date.now();
          DB().putTask(model).then(() => dropEditBackup(id, at)).catch(() => saveFailed(() => DB().putTask(model), id, at));
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
          const at = Date.now();
          DB().putHabit(model).then(() => dropEditBackup(id, at)).catch(() => saveFailed(() => DB().putHabit(model), id, at));
        }
      } else if (kind === "errand") {
        const model = state.errands.find((e) => e.id === id);
        if (model) {
          model.text = draft.title.trim() || model.text;
          model.tag = draft.tag || "buy";
          model.from = model.tag === "pickup" || model.tag === "order" ? draft.from || null : null;
          const at = Date.now();
          DB().putErrand(model).then(() => dropEditBackup(id, at)).catch(() => saveFailed(() => DB().putErrand(model), id, at));
        }
      }
    }
    if (state.editing && save === false) dropEditBackup(state.editing.id); // правку отменили сознательно
    if (state.editing) drafts.delete(state.editing.id);
    clearTimeout(titleTimer);
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

  // R-9: шторка уезжает вниз. Состояние закрывается сразу (hidden, пустое содержимое),
  // а уезжает её снимок без id и обработчиков — касания проходят сквозь него.
  function ghostOut(sheet, scrim) {
    if (!sheet || sheet.hidden || !sheet.firstChild) return;
    const reduce = M().reduce();
    const g = sheet.cloneNode(true);
    g.removeAttribute("id");
    g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    g.classList.add("is-ghost");
    g.setAttribute("aria-hidden", "true");
    g.setAttribute("inert", "");
    sheet.after(g);
    g.scrollTop = sheet.scrollTop;
    const from = sheet.style.transform || "translateY(0px)";
    const done = () => g.remove();
    if (reduce) g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: M().dur(1), fill: "forwards" }).onfinish = done;
    else g.animate([{ transform: from }, { transform: "translateY(100%)" }], { duration: M().dur(3), easing: M().ease("in"), fill: "forwards" }).onfinish = done;
    setTimeout(done, M().dur(4) + 40);
    if (scrim && !scrim.hidden) {
      const sg = scrim.cloneNode(false);
      sg.removeAttribute("id");
      sg.classList.add("is-ghost");
      scrim.after(sg);
      const op = scrim.style.opacity || "1";
      const rm = () => sg.remove();
      sg.animate([{ opacity: op }, { opacity: 0 }], { duration: M().dur(reduce ? 1 : 3), easing: "ease", fill: "forwards" }).onfinish = rm;
      setTimeout(rm, M().dur(4) + 40);
    }
  }

  function hideOverlay() {
    const scrim = $("#scrim");
    const sheet = $("#sheet-ui");
    ghostOut(sheet, scrim);
    if (scrim) {
      scrim.hidden = true;
      scrim.style.opacity = "";
    }
    if (sheet) {
      sheet.hidden = true;
      sheet.innerHTML = "";
      sheet.style.transform = "";
      sheet.style.transition = "";
    }
    releaseDialog();
    syncRail();
    liftToast();
    if (updateToastDue && updatePending && !reloading) {
      updateToastDue = false;
      showUpdateToast();
    }
  }

  function showOverlay(html) {
    const scrim = $("#scrim");
    const sheet = $("#sheet-ui");
    const fresh = sheet.hidden;
    scrim.hidden = false;
    sheet.hidden = false;
    const keep = sheet.scrollTop;
    sheet.innerHTML = `<div class="grab"></div>${html}`;
    // R-9: новая шторка выезжает снизу, смена содержимого открытой — только лёгкий кроссфейд.
    if (fresh) {
      if (M().reduce()) {
        sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M().dur(1) });
        scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M().dur(1) });
      } else {
        sheet.animate([{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], { duration: M().dur(4), easing: M().ease("sheet") });
        scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M().dur(3), easing: "ease" });
      }
    } else if (!M().reduce()) {
      sheet.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: M().dur(2), easing: "ease" });
    }
    const keepScroll = state.overlay && (state.overlay.type === "habit" || state.overlay.type === "shop");
    sheet.scrollTop = keepScroll ? keep : 0;
    labelDialog(sheet, fresh);
    syncRail();
    liftToast();
  }

  // batch4 P1: при открытой шторке тост (сбой записи, «куплено · отмена») — над ней, у её верхнего края.
  let sheetWatch = null;
  function liftToast() {
    const sheet = $("#sheet-ui");
    const open = !!sheet && !sheet.hidden;
    document.body.classList.toggle("has-sheet", open);
    const put = () => document.documentElement.style.setProperty("--sheet-h", `${open ? sheet.offsetHeight : 0}px`);
    put();
    if (open && !sheetWatch && window.ResizeObserver) {
      sheetWatch = new ResizeObserver(() => { if (!sheet.hidden) put(); });
      sheetWatch.observe(sheet);
    }
  }

  // R-12: шторка — модальный диалог. Фон inert, фокус на заголовок, после закрытия — назад на строку.
  const DIALOG_NAMES = { settings: "настройки", menu: "действия со строкой", days: "выбор дня", move: "на какой день", triage: "разбор дня" };
  let dialogReturn = null;
  function labelDialog(sheet, fresh) {
    const type = state.overlay && state.overlay.type;
    const h = sheet.querySelector("h2");
    const named = DIALOG_NAMES[type];
    if (h && !named) {
      h.id = "sheet-h";
      h.tabIndex = -1;
      sheet.setAttribute("aria-labelledby", "sheet-h");
      sheet.removeAttribute("aria-label");
    } else {
      sheet.removeAttribute("aria-labelledby");
      sheet.setAttribute("aria-label", named || "шторка");
    }
    if (!fresh) return;
    const from = document.activeElement;
    const row = from && from.closest && from.closest(".row[data-id], .block[data-id]");
    const opened = state.editing || (state.overlay && state.overlay.id);
    dialogReturn = row ? row.dataset.id : opened ? (state.editing ? state.editing.id : state.overlay.id) : from && from.id ? `#${from.id}` : null;
    // по id: у «разбора дня» тоже есть класс .deck (b9de0e3 — пейджер теперь .pager)
    ["#app > .top", "#deck", "#compose"].forEach((q) => { const el = $(q); if (el) el.inert = true; });
    const target = h && !named ? h : sheet;
    if (target === sheet) sheet.tabIndex = -1;
    // Фокус на заголовок, только если его не заберёт поле (правка с фокусом на названии или времени).
    if (!state.focusTitle && !state.focusTime) {
      try { target.focus({ preventScroll: true }); } catch { /* focus */ }
    }
  }

  function releaseDialog() {
    ["#app > .top", "#deck", "#compose"].forEach((q) => { const el = $(q); if (el) el.inert = false; });
    const back = dialogReturn;
    dialogReturn = null;
    if (!back) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest("#sheet-ui")) return; // фокус уже увели (строка ввода и т. п.)
      const at = back[0] === "#" ? $(back) : $(`#sheet-cur [data-id="${CSS.escape(back)}"]`);
      const el = at && !at.hasAttribute("tabindex") && at.querySelector('[role="button"]') || at;
      if (el && !el.closest("[inert]")) {
        try { el.focus({ preventScroll: true }); } catch { /* focus */ }
      }
    });
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
    state.focusTime = !!(opts && opts.focusTime);
    renderOverlay();
  }

  function applyClockField(input) {
    if (!state.editDraft) return;
    const value = D().parseClockText(input.value);
    if (input.dataset.field === "start") state.editDraft.startMin = value;
    if (input.dataset.field === "end") state.editDraft.endMin = value;
    backupEdit();
  }

  async function changeKind(kind) {
    if (!state.editing || state.editing.kind !== "task") return;
    const id = state.editing.id;
    const titleEl = $("#sheet-title");
    if (titleEl) state.editDraft.title = titleEl.value;
    const timeEl = $("#edit-time");
    if (timeEl) {
      // Набранное в поле времени не терять при смене «окно / час / привычка».
      const typed = D().parseWhen(timeEl.value);
      if (typed.ok && !typed.empty) {
        state.editDraft.startMin = typed.startMin;
        state.editDraft.endMin = typed.endMin;
      }
    }
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
    backupEdit();
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
      const want = { ...habit };
      try {
        await DB().putHabit(habit);
      } catch {
        state.habits = before.habits; // batch11 P2-2: как у дел — откат и «не сохранилось · повторить»
        renderSheets(true);
        saveFailed(async () => {
          await DB().putHabit(want);
          state.habits = state.habits.map((h) => (h.id === want.id ? want : h));
          renderSheets(true);
        }, null, null);
        return;
      }
    } else {
      const task = state.tasks.find((t) => t.id === dragState.id);
      if (!task) return;
      // R-39: блок, стянутый с ленты вниз в список, становится делом без времени.
      const rail = dragState.el && dragState.el.closest(".rail");
      if (rail && dragState.y > rail.getBoundingClientRect().bottom + 24) {
        task.kind = "loose";
        task.startMin = null;
        task.endMin = null;
        task.updatedAt = Date.now();
        if (!(await putMoved(task, before))) return;
        renderSheets(true);
        offerUndo("без времени", () => restore(before));
        return;
      }
      if (task.kind === "slot" || task.startMin == null) {
        const origin = task.startMin == null ? task.endMin : task.startMin;
        const next = clamp((origin || 0) + delta, 0, 23 * 60 + 45);
        if (task.kind === "slot") task.startMin = next;
        else task.endMin = clamp((task.endMin || 0) + delta, 15, 24 * 60);
      } else {
        // Окно может идти через полночь: конец до 36:00 (12:00 следующих суток), и тогда оно не дольше 14 ч;
        // начало — в пределах своего дня (Q-25: «с 22 до 7» вверх на час → 21–6, а не 15–24).
        const END_MAX = D().NIGHT_END_MAX;
        const LEN_MAX = D().NIGHT_LEN_MAX;
        const START_MAX = 23 * 60 + 45;
        const DAY = 24 * 60;
        const end0 = task.endMin || task.startMin + 60;
        const endCap = (st) => Math.max(DAY, Math.min(END_MAX, st + LEN_MAX)); // самый поздний конец для начала st
        if (dragState.zone === "start") {
          const lo = end0 > DAY ? end0 - LEN_MAX : 0;
          task.startMin = clamp(task.startMin + delta, Math.max(0, lo), Math.min(end0 - 15, START_MAX));
        } else if (dragState.zone === "end") {
          task.endMin = clamp(end0 + delta, task.startMin + 15, endCap(task.startMin));
        } else {
          const dur = end0 - task.startMin;
          const hi = dur > LEN_MAX ? DAY - dur : END_MAX - dur; // длинное дневное окно за полночь не уходит
          task.startMin = clamp(task.startMin + delta, 0, Math.min(START_MAX, hi));
          if (task.endMin != null) task.endMin = task.startMin + dur;
        }
      }
      task.updatedAt = Date.now();
      if (!(await putMoved(task, before))) return;
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
      const cur = $("#sheet-cur"); // R-28: без сдвига, только мягкое появление
      if (cur && cur.animate) cur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: M().dur(1), easing: "ease" });
      return;
    }
    state.sliding = true;
    const token = ++slideToken;
    const track = $("#track");
    track.style.transition = M().tr("transform", 3, "out");
    track.style.transform = `translateX(${delta > 0 ? "-66.666666%" : "0%"})`;
    const finish = () => {
      if (slideToken !== token) return;
      slideToken += 1;
      commitCursor(delta);
    };
    track.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, M().dur(3) + 60);
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

  function peekHeader(delta) {
    renderHeader(delta ? D().addDays(state.cursor, delta) : null);
    const hit = $("#date-hit");
    if (hit && hit.animate && !M().reduce()) hit.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: M().dur(1), easing: M().ease("out") });
  }

  // batch5 P1 (R-12): соседние дни за экраном — не в порядке Tab и не в дереве доступности.
  function syncSheetA11y() {
    ["sheet-prev", "sheet-cur", "sheet-next"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const off = id !== "sheet-cur";
      el.inert = off;
      if (off) el.setAttribute("aria-hidden", "true");
      else el.removeAttribute("aria-hidden");
    });
  }

  function settleDay(dx, dt) {
    const width = $("#deck").clientWidth || 1;
    const v = dx / Math.max(dt, 1);
    let delta = 0;
    if (dx < -width * 0.18 || v < -0.5) delta = 1;
    else if (dx > width * 0.18 || v > 0.5) delta = -1;
    const track = $("#track");
    if (!delta) {
      track.style.transition = M().tr("transform", 3, "out");
      track.style.transform = "translateX(-33.333333%)";
      state.sliding = false;
      renderHeader(); // шапка могла показать соседний день
      return;
    }
    state.sliding = true;
    const token = ++slideToken;
    track.style.transition = M().tr("transform", 2, "out");
    track.style.transform = `translateX(${delta > 0 ? "-66.666666%" : "0%"})`;
    const finish = () => {
      if (slideToken !== token) return;
      slideToken += 1;
      commitCursor(delta);
    };
    track.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, M().dur(2) + 60);
  }

  // R-13 fix: блок ленты виден на 36 px, а ловит касание на 44 (::before, inset -4px 0).
  // Где зоны соседей перекрываются: касание внутри видимого блока — его; в полосе -4px — у того, чей центр ближе.
  function pickBlock(block, point) {
    if (!block || !point || point.x == null) return block;
    const rail = block.closest(".rail");
    if (!rail) return block;
    let best = null;
    let bestD = Infinity;
    for (const el of rail.querySelectorAll(".block")) {
      const r = el.getBoundingClientRect();
      if (point.x < r.left || point.x > r.right || point.y < r.top - 4 || point.y > r.bottom + 4) continue;
      if (point.y >= r.top && point.y <= r.bottom) return el;
      const d = Math.abs(point.y - (r.top + r.height / 2));
      if (d < bestD) { bestD = d; best = el; }
    }
    return best || block;
  }

  function begin(e, input) {
    if (e.touches && e.touches.length > 1) return;
    if (state.sliding || drag) return;
    const target = e.target;
    if (target.closest("input, textarea, [contenteditable]")) return;
    const point = xy(e);
    const row = target.closest(".row");
    const inSheet = !!target.closest("#sheet-ui");
    const head = target.closest(".group-h");
    const block = pickBlock(target.closest(".block"), point);
    const base = {
      input,
      x0: point.x,
      y0: point.y,
      x: point.x,
      y: point.y,
      t0: Date.now(),
      samples: [{ x: point.x, t: Date.now() }],
      mode: null,
      timer: null,
      target
    };
    if (row && row.classList.contains("is-edit")) return;
    // R-16: в Safari-вкладке свайп от левого края (0–24 px) — системное «назад», строку не трогаем.
    if ((row || block) && !inSheet && point.x < 24 && !target.closest(".grip") && !isStandalone()) return;
    if (row && target.closest(".grip")) {
      const grip = target.closest(".grip");
      grip.classList.add("is-pressed"); // отклик в том же кадре
      // Касание, которым останавливают инерционную прокрутку, не выполняет дело.
      const noTap = Date.now() - lastScrollAt < HIT.scrollCalm;
      drag = { ...base, kind: "row", el: row, id: row.dataset.id, rowKind: row.dataset.kind, fromGrip: true, grip, noTap };
      drag.timer = setTimeout(() => armMenu(drag), HIT.gripHold); ringStart(point.x, point.y);
      return;
    }
    if (inSheet) {
      if (!row || target.closest("[data-act]")) return;
      drag = { ...base, kind: "row", el: row, id: row.dataset.id, rowKind: row.dataset.kind };
      drag.timer = setTimeout(() => armMenu(drag), HIT.press); ringStart(point.x, point.y);
      pressLater(drag);
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
      drag.timer = setTimeout(() => armMenu(drag), HIT.press); ringStart(point.x, point.y);
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
      drag.timer = setTimeout(() => armMenu(drag), HIT.press); ringStart(point.x, point.y);
      pressLater(drag);
      return;
    }
    drag = { ...base, kind: "day" };
  }

  // R-6: нажатое состояние строки — через 70 мс без сдвига, чтобы прокрутка не мигала строками.
  function pressLater(current) {
    const el = current.el;
    if (!el || !el.classList) return;
    current.pressEl = el;
    current.pressTimer = setTimeout(() => {
      if (drag === current && !current.mode) el.classList.add("is-pressed");
    }, HIT.pressShow);
    // R-26: видимый прогресс удержания — с 150 до 450 мс строка плавно «вдавливается» (scale 1 → .97)
    if (!current.rowKind || !["task", "habit", "errand", "draft"].includes(current.rowKind)) return;
    el.style.setProperty("--hold-ms", `${HIT.press - HIT.holdShow}ms`);
    current.holdTimer = setTimeout(() => {
      if (drag === current && !current.mode) el.classList.add("is-holding");
    }, HIT.holdShow);
  }

  function unpress(current) {
    if (!current || !current.pressEl) return;
    clearTimeout(current.pressTimer);
    clearTimeout(current.holdTimer);
    current.pressEl.classList.remove("is-pressed", "is-holding");
    current.pressEl = null;
  }

  // R-26: в момент срабатывания строка возвращается к 1.0 за 120 мс с лёгким перелётом
  function popHold(el) {
    if (!el || !el.classList.contains("is-holding")) return;
    el.classList.remove("is-holding");
    el.classList.add("is-hold-pop");
    setTimeout(() => el.classList.remove("is-hold-pop"), 200);
  }

  function armMenu(current) {
    ringStop();
    if (!drag || drag !== current || drag.mode) return;
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 8) return;
    if (!current.rowKind) return;
    drag.mode = "menu";
    haptic("press");
    clearTimeout(current.holdTimer);
    popHold(current.el);
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
    haptic("press");
  }

  function move(e, input) {
    // R-40: второй палец — это щипок (неделя), а не листание дня или свайп строки
    if (drag && e.touches && e.touches.length > 1) { cancelDrag(); return; }
    if (!drag || drag.input !== input) return;
    const point = xy(e);
    drag.x = point.x;
    drag.y = point.y;
    const dx = point.x - drag.x0;
    const dy = point.y - drag.y0;
    G().pushSample(drag.samples, point.x, Date.now());
    if (drag.pressEl && (drag.mode || Math.hypot(dx, dy) > HIT.pressSlop)) unpress(drag);
    if (drag.kind === "day") {
      if (!drag.mode) {
        if (Math.abs(dx) < HIT.claim && Math.abs(dy) < HIT.claim) return;
        if (Math.abs(dy) > Math.abs(dx) && dy > 0 && canPull(drag)) {
          drag.mode = "pull";
        } else if (Math.abs(dy) > Math.abs(dx) || (drag.x0 < 28 && dx > 0)) {
          drag = null;
          return;
        }
      }
      if (drag.mode === "pull") {
        if (e.cancelable) e.preventDefault();
        paintPull(dy);
        return;
      }
      if (!drag.mode) {
        drag.mode = "x";
        state.sliding = true;
      }
      if (drag.mode === "x") {
        if (e.cancelable) e.preventDefault();
        const track = $("#track");
        track.style.transition = "none";
        track.style.transform = `translateX(calc(-33.333333% + ${dx}px))`;
        // R-16: с половины порога шапка уже показывает день, куда ведёт жест.
        const half = (($("#deck").clientWidth || 1) * 0.18) / 2;
        const peek = dx < -half ? 1 : dx > half ? -1 : 0;
        if (peek !== (drag.peek || 0)) {
          drag.peek = peek;
          peekHeader(peek);
        }
      }
      return;
    }
    if (drag.kind === "block") {
      if (!drag.mode) {
        const ax = G().axis(dx, dy);
        if (!ax) return;
        if (ax === "x") {
          // Горизонталь блока — как у строки: сразу после порога, без задержки.
          claimSwipe(dx);
          drag.kind = "row";
          paintSwipe(dx, dy, point);
          return;
        }
        if (Date.now() - drag.t0 < HIT.dragDelay) {
          if (Math.abs(dy) > 14) drag = null;
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
    if (drag.fromGrip && !drag.mode) {
      const horizontal = Math.abs(dx) > HIT.claim && Math.abs(dx) > HIT.axis * Math.abs(dy);
      if (horizontal) {
        // Горизонталь с ручки — обычный свайп строки (раньше был мёртвый grip-hold).
        clearTimeout(drag.timer);
        drag.grip.classList.remove("is-pressed");
        drag.fromGrip = false;
      } else {
        if (!drag.held) {
          // Порядок — только после удержания 170 мс почти на месте; раньше и дальше 8 px —
          // это прокрутка: жест отдаём браузеру (без preventDefault, .grip { touch-action: pan-y }).
          if (Date.now() - drag.t0 < HIT.gripDrag) {
            if (Math.hypot(dx, dy) > HIT.gripSlop) {
              clearTimeout(drag.timer);
              drag.grip.classList.remove("is-pressed");
              lastScrollAt = Date.now();
              drag = null;
            }
            return;
          }
          drag.held = true;
        }
        if (Math.abs(dy) <= 6) return;
        clearTimeout(drag.timer);
        drag.grip.classList.remove("is-pressed");
        const group = drag.el.closest("[data-group]");
        if (!group || drag.el.classList.contains("is-done")) {
          drag = null;
          return;
        }
        drag.mode = "reorder";
        drag.group = group;
        drag.el.classList.add("is-lifted");
        document.body.classList.add("is-dragging");
        haptic("press");
      }
    }
    if (!drag.mode) {
      const ax = G().axis(dx, dy);
      if (!ax) return;
      if (ax === "y") {
        clearTimeout(drag.timer);
        if (dy > 0 && canPull(drag)) {
          // Вниз от самого верха, начав на строке, — тоже «потянуть, чтобы писать».
          drag.kind = "day";
          drag.mode = "pull";
          if (e.cancelable) e.preventDefault();
          paintPull(dy);
          return;
        }
        drag = null;
        return;
      }
      claimSwipe(dx);
    }
    if (e.cancelable && drag.mode !== "scroll") e.preventDefault();
    if (drag.mode === "done" || drag.mode === "defer" || drag.mode === "depth") {
      paintSwipe(dx, dy, point);
      return;
    }
    if (drag.mode === "reorder") {
      if (e.cancelable) e.preventDefault();
      const el = drag.el;
      // R-39: дело без времени, поднесённое к часам дня, получает время там, где его отпустили.
      if (scheduleHover(drag, point)) return;
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
        drag.swapped = true;
        drag.y0 += h;
        el.style.transform = `translateY(${point.y - drag.y0}px) scale(1.02)`;
      } else if (prev && mid < prev.getBoundingClientRect().top + prev.offsetHeight * 0.45) {
        const h = prev.getBoundingClientRect().height;
        drag.group.insertBefore(el, prev);
        drag.swapped = true;
        drag.y0 -= h;
        el.style.transform = `translateY(${point.y - drag.y0}px) scale(1.02)`;
      }
    }
  }

  function claimSwipe(dx) {
    clearTimeout(drag.timer);
    drag.mode = dx > 0 ? "defer" : "done";
    // Строка идёт от точки захвата, а не прыгает на накопленные 10 px.
    drag.claimX = dx > 0 ? HIT.claim : -HIT.claim;
    drag.width = (drag.el && drag.el.offsetWidth) || 346;
    drag.el.style.transition = "none";
    document.body.classList.add("is-dragging");
    showUnder(drag);
  }

  // R-7: подложка свайпа — под строкой видно, что случится, и где порог.
  function underSpec(current, mode) {
    const kind = current.rowKind;
    const done = current.el.classList.contains("is-done");
    if (mode === "done") {
      if (kind === "tail") return { cls: "done", icon: "check", word: "всё сделано" };
      if (kind === "draft") return { cls: "done", icon: "check", word: current.el.dataset.into === "today" ? "в сегодня" : "вписать" };
      if (kind === "errand-head") return { cls: "done", icon: "check", word: "сходил" };
      if (done || kind === "habit-done") return { cls: "undo", icon: "undo", word: "вернуть" };
      return { cls: "done", icon: "check", word: kind === "errand" ? "куплено" : "готово" };
    }
    if (kind === "tail") return { cls: "defer", icon: "arrow", word: "в сегодня" };
    if (["errand", "errand-head", "draft", "habit-done"].includes(kind)) return null;
    if (mode === "depth") return { cls: "defer", icon: "calendar", word: "выбрать день" };
    if (kind === "task") {
      const task = state.tasks.find((t) => t.id === current.id);
      if (task && task.date < state.today) return { cls: "defer", icon: "arrow", word: "в сегодня" };
    }
    return { cls: "defer", icon: "sun", word: "завтра" };
  }

  function paintUnderSpec(u, spec) {
    u.className = `swipe-under is-${spec.cls}${spec.cls === "defer" ? " at-left" : " at-right"}`;
    u.innerHTML = `<span class="su-mark">${ico(spec.icon)}<span class="su-word">${esc(spec.word)}</span></span>`;
    u.dataset.spec = `${spec.cls}:${spec.word}`;
  }

  function showUnder(current) {
    const el = current.el;
    const host = el && el.offsetParent;
    if (!host) return;
    const spec = underSpec(current, current.mode);
    if (!spec) return;
    const u = document.createElement("div");
    u.setAttribute("aria-hidden", "true");
    paintUnderSpec(u, spec);
    u.style.left = `${el.offsetLeft}px`;
    u.style.top = `${el.offsetTop}px`;
    u.style.width = `${el.offsetWidth}px`;
    u.style.height = `${el.offsetHeight}px`;
    host.insertBefore(u, host.firstChild);
    el.classList.add("is-swiping");
    current.under = u;
  }

  // batch3 P3: слово под строкой показываем, только когда оно открылось целиком (иначе
  // «всё сделано» наполовину под строкой). До того — одна иконка. shown — видимый сдвиг строки.
  const UNDER_PAD = 18;
  function paintUnder(current, off, shown) {
    const u = current.under;
    if (!u) return;
    if (current.mode === "depth" && !u.dataset.depth) {
      const spec = underSpec(current, "depth");
      if (spec) paintUnderSpec(u, spec);
      u.dataset.depth = "1";
      delete u.dataset.need;
    }
    const armed = current.mode === "depth" || Math.abs(off) >= G().threshold(current.width);
    u.classList.toggle("is-armed", armed);
    if (!u.dataset.need) {
      const mark = u.firstElementChild;
      u.dataset.need = String(mark ? Math.ceil(mark.scrollWidth + UNDER_PAD) : 0);
    }
    u.classList.toggle("is-roomy", Math.abs(shown == null ? off : shown) >= Number(u.dataset.need));
  }

  function dropUnder(current, delay) {
    const u = current && current.under;
    const el = current && current.el;
    if (!u) return;
    current.under = null;
    u.classList.add("is-leaving");
    setTimeout(() => {
      u.remove();
      if (el) el.classList.remove("is-swiping");
    }, delay == null ? 280 : delay);
  }

  function swipeOffset(current, dx) {
    return dx - (current.claimX || 0);
  }

  function paintSwipe(dx, dy, point) {
    const el = drag.el;
    const off = swipeOffset(drag, dx);
    if (drag.mode === "done") {
      const pull = G().resist(Math.min(0, off), drag.width);
      el.style.transform = `translateX(${pull}px)`;
      if (!el.style.getPropertyValue("--ink-w")) inkToText(el);
      el.style.setProperty("--strike", String(Math.min(1, -pull / G().threshold(drag.width))));
      paintUnder(drag, off, pull);
      return;
    }
    const held = Date.now() - drag.t0;
    const noDepth = ["errand", "errand-head", "draft", "tail"].includes(drag.rowKind);
    if (drag.mode === "defer" && !noDepth) {
      if (dx >= HIT.depthMin && (dy > HIT.depthDy || (held > HIT.hold && off > G().threshold(drag.width) && dy > 12))) {
        openDepth(drag);
        drag.mode = "depth";
      }
    }
    if (drag.mode === "depth") {
      el.style.transform = `translateX(${Math.min(dx, 120)}px) scale(0.98)`;
      paintUnder(drag, off, Math.min(dx, 120));
      pickPlate(drag, point.y);
      return;
    }
    const shown = G().resist(Math.max(0, off), drag.width);
    el.style.transform = `translateX(${shown}px)`;
    paintUnder(drag, off, shown);
  }

  function neighborTask(el, dir) {
    const node = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    if (!node || !node.classList.contains("row")) return null;
    if (node.dataset.kind !== "task" && node.dataset.kind !== "habit") return null;
    return node;
  }

  // R-39: над лентой часов (развёрнутый день) время — по высоте (шаг 15 мин), над полосой часов — по ширине (6–24).
  // Палец должен задержаться над часами 250 мс — пролёт мимо при перестановке время не ставит.
  function scheduleZone(point) {
    const sheet = $("#sheet-cur");
    if (!sheet) return null;
    const q = (m) => clamp(Math.round(m / 15) * 15, 0, 23 * 60 + 45);
    const rail = sheet.querySelector(".rail");
    if (rail) {
      const r = rail.getBoundingClientRect();
      if (point.y >= r.top && point.y <= r.bottom && point.x >= r.left && point.x <= r.right) return q((+rail.dataset.from || 0) + ((point.y - r.top) / D().HOUR) * 60);
      return null;
    }
    const track = sheet.querySelector(".strip-track");
    if (!track) return null;
    const r = track.getBoundingClientRect();
    const band = track.closest(".strip").getBoundingClientRect();
    if (point.y < band.top - 12 || point.y > band.bottom + 12 || point.x < r.left || point.x > r.right) return null;
    return q(6 * 60 + ((point.x - r.left) / r.width) * 18 * 60);
  }
  function scheduleHover(d, point) {
    const row = d.el;
    if (!row || row.dataset.kind !== "task") return false;
    const task = state.tasks.find((t) => t.id === row.dataset.id);
    if (!task || task.done || task.kind !== "loose") return false;
    const min = scheduleZone(point);
    if (min == null) {
      clearTimeout(d.schedTimer);
      d.schedTimer = null;
      d.sched = null;
      d.schedAt = null;
      d.schedHour = null;
      row.classList.remove("is-scheduling");
      dropTime(null);
      return false;
    }
    row.style.transform = `translate(${point.x - d.x0}px, ${point.y - d.y0}px) scale(.9)`;
    if (d.schedAt == null) d.schedAt = Date.now();
    if (Date.now() - d.schedAt < 250) {
      if (!d.schedTimer) d.schedTimer = setTimeout(() => { if (drag === d && d.schedAt != null) scheduleHover(d, d.lastPoint || point); }, 260);
      d.lastPoint = point;
      return true;
    }
    d.lastPoint = point;
    // UX (R-39): щелчок на каждом целом часе, через который прошёл палец
    const hour = Math.floor(min / 60);
    if (d.schedHour != null && hour !== d.schedHour) haptic("tick");
    d.schedHour = hour;
    d.sched = min;
    // batch11 P3: поднятое дело не закрывает полосу под пальцем — строка ждёт на своём месте (бледно),
    // а над пальцем и полосой — карточка: название и крупное время, с подложкой и тенью (и в тёмной теме).
    row.style.transform = "";
    row.classList.add("is-scheduling");
    dropTime(min, point, task.title);
    return true;
  }
  function dropTime(min, point, title) {
    const tag = $("#drop-time");
    if (!tag) return;
    if (min == null) { tag.hidden = true; return; }
    let name = tag.querySelector(".drop-title");
    let clock = tag.querySelector(".drop-clock");
    if (!name || !clock) {
      tag.textContent = "";
      name = document.createElement("span");
      name.className = "drop-title";
      clock = document.createElement("b");
      clock.className = "drop-clock";
      tag.append(name, clock);
    }
    name.textContent = title || "";
    name.hidden = !title;
    clock.textContent = D().clockLabel(min);
    tag.hidden = false;
    const half = (tag.offsetWidth || 104) / 2;
    const x = clamp(point.x, half + 8, window.innerWidth - half - 8); // карточка целиком на экране и у края
    const y = Math.max(8, point.y - 28 - (tag.offsetHeight || 56)); // низ — в 28 px над пальцем
    tag.style.transform = `translate(${Math.round(x - half)}px, ${Math.round(y)}px)`;
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
        { duration: M().dur(2), easing: M().ease("out") }
      );
    }
  }

  function plateName(current, days) {
    let from = state.cursor;
    if (current.rowKind === "task") {
      const task = state.tasks.find((t) => t.id === current.id);
      if (task) from = task.date < state.today ? state.today : task.date;
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
      if (current.pick !== 0) haptic("tick");
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
    if (current.pick !== current.days[best]) haptic("tick");
    current.pick = current.days[best];
  }

  function end(e, input) {
    if (!drag || drag.input !== input) return;
    const current = drag;
    clearTimeout(current.timer);
    const raw = xy(e);
    // Без changedTouches (синтетические и некоторые отменённые касания) — последняя точка из move().
    const point = Number.isFinite(raw.x) && Number.isFinite(raw.y) ? raw : { x: current.x, y: current.y };
    const dx = point.x - current.x0;
    const dy = point.y - current.y0;
    const dt = Date.now() - current.t0;
    G().pushSample(current.samples, point.x, Date.now());
    drag = null;
    unpress(current);
    document.body.classList.remove("is-dragging");
    if (current.grip) current.grip.classList.remove("is-pressed");
    if (current.fromGrip && current.mode !== "reorder") {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 320);
      if (!current.mode && !current.noTap && Math.hypot(dx, dy) <= 8 && dt <= HIT.gripTap) tapGrip(current);
      return;
    }
    if (current.mode === "menu") {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
      return;
    }
    if (current.mode === "pull") {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      endPull(dy >= HIT.pullArm); // синхронно в touchend — клавиатура откроется
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
      current.el.classList.remove("is-lifted", "is-scheduling");
      current.el.style.transform = "";
      const sched = current.sched;
      dropTime(null);
      if (sched != null) {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 350);
        setMenuTime(current.id || current.el.dataset.id, String(sched));
        return;
      }
      // dy считается от y0, который сдвигается при каждой перестановке,
      // поэтому «отпустил ровно на новом месте» даёт dy≈0. Решает факт перестановки.
      if (!current.swapped && Math.hypot(dx, dy) < 8) return;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      if (!current.swapped) return;
      const rows = [...current.group.querySelectorAll(".row")];
      const ids = current.group.dataset.group === "errand"
        ? rows.filter((row) => row.dataset.kind === "errand").map((row) => row.dataset.id)
        : rows.filter((row) => row.dataset.kind === "task" || row.dataset.kind === "habit").map((row) => `${row.dataset.kind === "habit" ? "h" : "t"}:${row.dataset.id}`);
      const date = (current.el.closest(".sheet") || {}).dataset;
      persistOrder(current.group.dataset.group, ids, date && date.date);
      return;
    }
    if (current.el) current.el.classList.remove("is-stay");
    if (current.depth) current.depth.remove();
    const el = current.el;
    const verdict = G().decideSwipe({ dx: swipeOffset(current, dx), v: G().velocity(current.samples), W: current.width });
    const commitDone = current.mode === "done" && verdict === "done";
    const quickDefer = current.mode === "defer" && verdict === "defer" && dy < HIT.depthDy;
    const deep = current.mode === "depth" && current.pick;
    // Выполнено — строка возвращается на место, подложка гаснет вместе с возвратом;
    // перенос — строка улетает, подложка уходит после неё (или вместе с перерисовкой).
    dropUnder(current, commitDone ? 280 : quickDefer || deep ? 420 : 280);
    if (commitDone || quickDefer || deep) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
      // «Выполнить» оставляет строку на месте: возвращаем её, пока идёт черта.
      if (commitDone) snap(el);
      resolveRow(current, commitDone ? "done" : "defer", deep ? current.pick : 1, !deep);
      return;
    }
    if (current.mode) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 300);
      snap(el);
      el.style.removeProperty("--strike"); // в покое у сделанного черта — text-decoration названия
    }
  }

  function resolveRow(current, action, days, quick) {
    const kind = current.rowKind;
    const id = current.id;
    if (kind === "tail") {
      if (action === "done") {
        snap(current.el);
        tailDone();
      } else carryTail();
      return;
    }
    if (kind === "draft") {
      if (action === "done") commitDraft(id, !!(current.el && current.el.dataset.into === "today"));
      else snap(current.el);
      return;
    }
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
    } else moveTask(id, days, { quick: !!quick });
  }

  function snap(el) {
    if (!el) return;
    // Возврат с лёгким перелётом, как у iOS; Reduce Motion гасит переход в CSS.
    el.style.transition = M().tr("transform", 3, "spring");
    el.style.transform = "";
  }

  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    unpress(drag);
    if (drag.grip) drag.grip.classList.remove("is-pressed");
    if (drag.depth) drag.depth.remove();
    dropUnder(drag);
    if (drag.el) {
      if (drag.mode === "done" || drag.mode === "defer" || drag.mode === "depth") {
        // touchcancel (звонок, Пункт управления) посреди свайпа: строка пружинит назад, черта гаснет.
        snap(drag.el);
        drag.el.style.removeProperty("--strike");
      } else drag.el.style.transform = "";
      drag.el.classList.remove("is-lifted", "is-stay");
    }
    if (drag.mode === "pull") endPull(false);
    drag = null;
    document.body.classList.remove("is-dragging");
    state.sliding = false;
    const track = $("#track");
    track.style.transition = "none";
    track.style.transform = "translateX(-33.333333%)";
    renderHeader();
  }

  function onClick(e) {
    if (swallowClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const grip = e.target.closest(".grip");
    if (grip) {
      // Сюда доходит только click без касания (VoiceOver, Switch Control): касание ручки решает end().
      const row = grip.closest(".row");
      if (row && row.dataset.kind) tapGrip({ el: row, id: row.dataset.id, rowKind: row.dataset.kind, grip });
      return;
    }
    const example = e.target.closest("[data-example]");
    if (example && example.closest("#sheet-cur")) {
      useExample(example.dataset.example);
      return;
    }
    const space = e.target.closest(".tail-space");
    if (space && space.closest("#sheet-cur")) {
      tapSpace(e, space);
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "hour-add" && !calmTap(e)) return;
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
    const block = pickBlock(e.target.closest(".block"), xy(e));
    if (block) {
      tapRow(block.dataset.kind === "task" ? "task" : "habit", block.dataset.id, e);
      return;
    }
    if (e.target.closest("input, textarea, button")) return;
    const row = e.target.closest(".row");
    if (!row || !row.dataset.kind || row.dataset.kind === "habit-done" || row.dataset.kind === "errand-head") return;
    if (row.dataset.kind === "draft") {
      pullDraft(row.dataset.id);
      return;
    }
    if (row.dataset.kind === "tail") {
      toggleTail();
      return;
    }
    tapRow(row.dataset.kind, row.dataset.id, e, { focusTime: !!e.target.closest(".gutter") });
  }

  // Тап (≤8 px, ≤350 мс) по пустому месту: фокус синхронно в том же обработчике —
  // только так iOS откроет клавиатуру. Черта var(--ring) на 120 мс: «здесь появится строка».
  // R-14: пустой час на ленте создаёт дело только от спокойного тапа (≤ 6 px, ≤ 350 мс),
  // а не от касания в начале прокрутки. Клик без касания (VoiceOver, клавиатура) проходит.
  function openRowSheet(row) {
    const k = row.dataset.kind;
    if (!k || !["task", "habit", "errand"].includes(k) || state.overlay || state.editing || (inline && inline.id === row.dataset.id)) return false;
    openEdit(k, row.dataset.id);
    return true;
  }

  function calmTap(e) {
    // batch4 P3: клик без координат (клавиатура, VoiceOver, Switch Control) — не след прокрутки, пропускаем.
    if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return true;
    const since = Date.now() - lastPointerAt;
    if (since > 1500) return true;
    return since <= HIT.spaceTap && Math.hypot(e.clientX - lastPointerXY.x, e.clientY - lastPointerXY.y) <= 6;
  }

  function tapSpace(e, space) {
    if (state.overlay || state.editing) return;
    if (Date.now() - lastPointerAt > HIT.spaceTap || Math.hypot(e.clientX - lastPointerXY.x, e.clientY - lastPointerXY.y) > 8) return;
    openKeyboard();
    const mark = document.createElement("span");
    mark.className = "space-mark";
    mark.style.top = `${Math.max(0, e.clientY - space.getBoundingClientRect().top)}px`;
    space.appendChild(mark);
    setTimeout(() => mark.remove(), 120);
  }

  // Потянуть лист вниз от самого верха: с 40 px проявляется «↓ писать», на 72 px порог взят.
  function canPull(current) {
    const sheet = $("#sheet-cur");
    if (!sheet || state.overlay || state.editing || state.sliding) return false;
    if (!current.target || !current.target.closest || !current.target.closest("#sheet-cur")) return false;
    return sheet.scrollTop <= 0;
  }

  function paintPull(dy) {
    const hint = $("#pull-hint");
    const sheet = $("#sheet-cur");
    const pull = Math.max(0, dy);
    if (sheet) sheet.style.transform = `translateY(${Math.min(pull * 0.5, 56)}px)`;
    if (!hint) return;
    hint.style.opacity = String(clamp((pull - HIT.pullShow) / (HIT.pullArm - HIT.pullShow), 0, 1));
    const armed = pull >= HIT.pullArm;
    if (armed !== hint.classList.contains("is-armed")) {
      hint.classList.toggle("is-armed", armed);
      if (armed) haptic("tick");
    }
  }

  function endPull(armed) {
    const hint = $("#pull-hint");
    const sheet = $("#sheet-cur");
    if (sheet) {
      sheet.style.transition = M().tr("transform", 2, "out");
      sheet.style.transform = "";
      setTimeout(() => { sheet.style.transition = ""; }, M().dur(2) + 20);
    }
    if (hint) {
      hint.style.opacity = "0";
      hint.classList.remove("is-armed");
    }
    if (!armed) return;
    state.insertTop = { day: state.cursor, last: null };
    const line = $("#line");
    if (line) line.dataset.placeholder = "в начало дня";
    openKeyboard();
  }

  function endInsertTop() {
    if (!state.insertTop) return;
    state.insertTop = null;
    const line = $("#line");
    if (line) line.dataset.placeholder = "на этот день";
  }

  // Порядок для «в начало дня»: первое дело встаёт первым, следующие — за ним.
  function topOrder(date) {
    const loose = state.tasks
      .filter((t) => t.date === date && t.kind === "loose")
      .map((t) => t.order || 0)
      .sort((a, b) => a - b);
    const top = state.insertTop;
    if (!loose.length) return nextOrder(date);
    if (top.last == null) return loose[0] - 1;
    const next = loose.find((o) => o > top.last);
    return next == null ? top.last + 1 : (top.last + next) / 2;
  }

  // R-22: тап по тексту — правка сразу, без ожидания второго тапа.
  // batch5 P3: мост считает по e.timeStamp (момент касания), а не Date.now() в обработчике — пока
  // открывается шторка, главный поток занят, и второй тап «опаздывал» за 300 мс (Chromium, 290 мс).
  let lastTap = null;
  function tapRow(kind, id, e, opts) {
    if (inline && inline.id === id) return; // тап внутри поля правки — это каретка, не шторка
    lastTap = { kind, id, at: Date.now(), ts: e && e.timeStamp, x: e.clientX, y: e.clientY };
    // batch10 P1-3 (R-12): клик без координат (Enter/пробел, el.click(), Switch Control) — шторка действий, как раньше
    const keyed = !e || e.detail === 0 || (e.clientX === 0 && e.clientY === 0);
    if (!(opts && opts.focusTime) && !keyed && startInline(kind, id, e)) return;
    openEdit(kind, id, opts && opts.focusTime ? { focusTime: true } : undefined);
  }

  // R-38: правка на месте. Тап по тексту дела (без времени или с часом) делает сам текст полем:
  // каретка там, куда ткнули, разбор тот же, что в строке ввода («врач в 16» + Enter → 16:00).
  // Время в колонке остаётся, пока его не назвали заново. Enter или тап мимо сохраняет, Escape или
  // свайп вниз по строке отменяет. Окна, привычки, покупки — по-прежнему шторка (и «править» в меню).
  let inline = null;
  function caretAt(el, x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    const sel = window.getSelection();
    const range = document.createRange();
    if (node && el.contains(node)) range.setStart(node, offset);
    else { range.selectNodeContents(el); range.collapse(false); }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function startInline(kind, id, e) {
    if (kind !== "task" || inline || state.editing || state.overlay || !e || !e.target || !e.target.closest) return false;
    const title = e.target.closest(".row[data-kind=task] > .title");
    const task = state.tasks.find((t) => t.id === id);
    if (!title || !task || task.done || (task.kind !== "loose" && task.kind !== "slot")) return false;
    const row = title.parentNode;
    const saved = ["role", "tabindex", "aria-label", "aria-describedby"].map((k) => [k, title.getAttribute(k)]);
    saved.forEach(([k]) => title.removeAttribute(k));
    title.setAttribute("contenteditable", "plaintext-only");
    ensureEditable(title);
    title.setAttribute("role", "textbox");
    title.setAttribute("aria-label", `правка: ${task.title}`);
    title.setAttribute("enterkeyhint", "done");
    title.dataset.inline = "1";
    row.classList.add("is-inline");
    // batch10 P3: панель правки — над клавиатурой, в полосе ввода (#compose прижат к visualViewport)
    const bar = inlineBar(task);
    const compose = $("#compose");
    compose.insertBefore(bar, compose.querySelector(".compose-row"));
    compose.classList.add("is-inline");
    inline = { id, row, title, bar, saved, before: task.title, y0: null };
    // фокус синхронно в том же жесте — иначе iOS не поднимет клавиатуру
    try { title.focus({ preventScroll: true }); } catch { /* focus */ }
    caretAt(title, e.clientX, e.clientY);
    title.addEventListener("keydown", inlineKey);
    title.addEventListener("input", inlineInput);
    title.addEventListener("blur", inlineBlur);
    title.addEventListener("pointerdown", inlineDown);
    title.addEventListener("pointerup", inlineUp);
    inlineSay();
    return true;
  }
  function inlineBar(task) {
    const bar = document.createElement("div");
    bar.className = "inline-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "быстрая правка");
    const say = document.createElement("p");
    say.className = "inline-say";
    say.setAttribute("aria-live", "polite");
    bar.appendChild(say);
    // один ряд с прокруткой вбок и затуханием справа; чип текущего дня не показываем; «удалить» — последним
    const row = document.createElement("div");
    row.className = "inline-chips";
    const tomorrow = D().addDays(state.today, 1);
    const chips = [["more", "ещё…"], ["today", "сегодня"], ["tomorrow", "завтра"], ["hour", "+1 ч"], ["loose", "без времени"], ["list", "в список"], ["delete", "удалить"]]
      .filter(([k]) => !(k === "today" && task.date === state.today) && !(k === "tomorrow" && task.date === tomorrow) && !(k === "loose" && task.kind === "loose"));
    chips.forEach(([k, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip inline-chip" + (k === "delete" ? " is-danger" : "");
      b.dataset.inline = k;
      b.textContent = label;
      row.appendChild(b);
    });
    bar.appendChild(row);
    const edge = () => row.classList.toggle("at-end", row.scrollLeft + row.clientWidth >= row.scrollWidth - 2);
    row.addEventListener("scroll", edge, { passive: true });
    requestAnimationFrame(edge);
    // batch10 P1-1: действие на pointerup, как в bindChips. preventDefault на pointerdown держит фокус
    // в поле (blur сохранил бы правку раньше чипа), но после него WebKit не присылает click.
    // click остаётся для клавиатуры и VoiceOver (detail 0); поздний click мыши после pointerup глушим.
    let down = null;
    bar.addEventListener("pointerdown", (ev) => {
      ev.preventDefault(); // и мимо чипов: фокус остаётся в поле
      const b = ev.target.closest(".inline-chip");
      down = b ? { b, x: ev.clientX, y: ev.clientY } : null;
    });
    bar.addEventListener("pointercancel", () => { down = null; });
    bar.addEventListener("pointerup", (ev) => {
      const was = down;
      down = null;
      const b = ev.target.closest(".inline-chip");
      if (!was || b !== was.b || Math.hypot(ev.clientX - was.x, ev.clientY - was.y) > 8) return; // прокрутка ряда
      ev.preventDefault();
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      inlineChip(b.dataset.inline);
    });
    bar.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const b = ev.target.closest(".inline-chip");
      if (b && ev.detail === 0) inlineChip(b.dataset.inline);
    });
    return bar;
  }
  // Текст правки на месте → дело: названное в тексте — время и день; без него остаётся прежнее.
  function applyInlineText(task, text, parsed) {
    if (parsed === undefined) parsed = parseInline(text, task);
    task.title = parsed ? parsed.title || text : text;
    if (parsed && (parsed.kind === "slot" || parsed.kind === "window")) {
      task.kind = parsed.kind;
      task.startMin = parsed.startMin;
      task.endMin = parsed.endMin;
    }
    if (parsed && parsed.date && (parsed.dateSpoken || parsed.date !== task.date)) task.date = parsed.date;
    return task;
  }
  function dropBar(bar) {
    bar.remove();
    const compose = $("#compose");
    if (compose) compose.classList.remove("is-inline");
  }
  function inlineChip(k) {
    if (k === "more") {
      // «ещё…» — прежняя шторка действий (− день / + день, вписать после, на другой день…); набранное сохраняется
      const id = inline.id;
      Promise.resolve(endInline("save")).then(() => { if (!inline && state.tasks.some((t) => t.id === id)) openEdit("task", id); });
      return;
    }
    endInline("chip", k);
  }
  function inlineParse() {
    const task = inline && state.tasks.find((t) => t.id === inline.id);
    const text = inline ? readEditable(inline.title).replace(/\s+/g, " ").trim() : "";
    if (!task || !text) return { task, text, parsed: null };
    return { task, text, parsed: parseInline(text, task) };
  }
  // Разбор текста правки на месте. batch10 P3: весь текст — время или день («в 17», «завтра в 9») —
  // применяем их, а название оставляем прежним (разбор с невидимым названием-заглушкой).
  const INLINE_STUB = "\u2063";
  function parseInline(text, task) {
    const ok = (p) => p && p.ok && ["loose", "slot", "window"].includes(p.kind);
    const parsed = P().parse(text, parseCtx(task.date));
    if (ok(parsed)) return parsed;
    const stub = P().parse(`${text} ${INLINE_STUB}`, parseCtx(task.date));
    if (ok(stub) && stub.title.trim() === INLINE_STUB && (stub.kind !== "loose" || stub.dateSpoken)) return { ...stub, title: task.title, timeOnly: true };
    return null;
  }
  function inlineSay() {
    if (!inline) return;
    const { task, parsed: raw } = inlineParse();
    const say = inline.bar.querySelector(".inline-say");
    // batch10 P3: время не названо заново — в превью прежний час дела («врач завтра» → «завтра · 15 · врач»)
    const parsed = raw && raw.kind === "loose" && task.kind !== "loose" && task.startMin != null
      ? { ...raw, kind: task.kind, startMin: task.startMin, endMin: task.endMin }
      : raw;
    const timed = parsed && (parsed.kind !== "loose" || parsed.dateSpoken);
    // подсказка «Enter — сохранить» — только в первый раз, дальше строка пустая (место чипам)
    say.textContent = timed ? P().describe(parsed, task.date, state.today) : hintSeen("inline") ? "" : "Enter — сохранить";
  }
  function inlineInput() {
    inlineSay();
    if (inline) backupInline(); // синхронно на каждый ввод: перезагрузка через 0 мс не теряет набранное
  }
  function inlineKey(e) {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); endInline("save"); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endInline("cancel"); }
  }
  function inlineBlur() {
    // тап мимо сохраняет (R-15: не теряем); чипы фокус не забирают
    setTimeout(() => { if (inline && document.activeElement !== inline.title) endInline("save"); }, 0);
  }
  function inlineDown(e) { if (inline) inline.y0 = e.clientY; }
  function inlineUp(e) {
    if (!inline || inline.y0 == null) return;
    const dy = e.clientY - inline.y0;
    inline.y0 = null;
    if (dy > 40) endInline("cancel"); // свайп вниз по строке — отмена
  }
  async function endInline(how, chip) {
    if (!inline || inline.closing) return;
    inline.closing = true;
    if (!hintSeen("inline")) markHint("inline");
    const cur = inline;
    const { task, text, parsed } = inlineParse();
    cur.title.removeEventListener("blur", inlineBlur);
    const done = () => {
      inline = null;
      dropBar(cur.bar);
      dropEditBackup(cur.id);
      renderSheets(true);
    };
    if (!task || how === "cancel" || (how === "save" && (!text || (text === cur.before && !parsed)))) {
      done();
      return;
    }
    const before = snapshot();
    if (how === "chip" && chip === "delete") {
      // batch10 P3: «удалить» с одного тапа, но всегда с тостом «удалено · вернуть»; ошибка записи — дело на месте
      inline = null;
      dropBar(cur.bar);
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      try {
        await DB().deleteTask(task.id);
      } catch (err) {
        state.tasks = before.tasks;
        keepInlineText(cur, text);
        renderSheets(true);
        offerUndo(writeFailText(err), null);
        return;
      }
      dropEditBackup(task.id);
      renderSheets(true);
      offerUndo("удалено", () => restore(before), null, "вернуть");
      return;
    }
    if (text) applyInlineText(task, text, parsed);
    if (how === "chip" && chip === "list") {
      const item = { id: DB().id("e"), text: task.title, tag: "buy", from: null, atMin: null, done: false, doneOn: null, doneAt: null, order: nextErrandOrder(), createdAt: Date.now() };
      state.errands.push(item);
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      inline = null;
      dropBar(cur.bar);
      try {
        await saveOrDrop(DB().putErrand(item), () => { state.errands = state.errands.filter((x) => x !== item); });
      } catch (err) {
        // batch10 P1-4: покупка не записалась — дело остаётся, набранное — в черновике edit:<id>
        state.tasks = before.tasks; // в базе ничего не менялось — только память
        keepInlineText(cur, text);
        renderSheets(true);
        offerUndo(writeFailText(err), null);
        return;
      }
      DB().deleteTask(task.id).catch(() => saveFailed(() => DB().deleteTask(task.id), null, null));
      dropEditBackup(task.id);
      renderSheets(true);
      offerUndo("в список", () => restore(before));
      return;
    }
    if (how === "chip" && chip === "today") task.date = state.today;
    if (how === "chip" && chip === "tomorrow") task.date = D().addDays(task.date < state.today ? state.today : task.date, 1);
    if (how === "chip" && chip === "loose") { task.kind = "loose"; task.startMin = null; task.endMin = null; }
    if (how === "chip" && chip === "hour") {
      if (task.kind === "loose") {
        task.kind = "slot";
        task.startMin = Math.min(23 * 60 + 45, Math.ceil((nowMin() + 60) / 15) * 15);
      } else {
        task.startMin = Math.min(23 * 60 + 45, task.startMin + 60);
        if (task.endMin != null) task.endMin += 60;
      }
    }
    task.updatedAt = Date.now();
    inline = null;
    dropBar(cur.bar);
    const at = Date.now();
    try {
      await DB().putTask(task);
    } catch {
      // batch10 P1-4 (R-15): запись не удалась — набранное остаётся в черновике edit:<id>
      // (вернётся при следующем запуске), тост «не сохранилось · повторить»
      keepInlineText(cur, text);
      renderSheets(true);
      saveFailed(() => DB().putTask(task), task.id, Date.now());
      return;
    }
    dropEditBackup(task.id, at);
    renderSheets(true);
    offerUndo("исправлено", () => restore(before));
  }
  function keepInlineText(cur, text) {
    if (!text || text === cur.before) return;
    const all = readDrafts();
    all[editKey(cur.id)] = { kind: "task", id: cur.id, title: text, inline: true, date: (state.tasks.find((t) => t.id === cur.id) || {}).date, at: Date.now() };
    writeDrafts(all);
  }

  // Мост старой привычки: второй тап ≤250 мс и ≤24 px от первого (он попадает уже
  // на затемнение или шторку) закрывает шторку без сохранения и выполняет дело.
  function bridgeTap(e) {
    const tap = lastTap;
    if (!tap || e.isPrimary === false) return;
    const gap = tap.ts && e.timeStamp && e.timeStamp >= tap.ts ? e.timeStamp - tap.ts : Date.now() - tap.at;
    if (gap > HIT.bridgeMs || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > HIT.bridgePx) return;
    lastTap = null;
    const inlineHit = inline && inline.id === tap.id;
    if (!inlineHit && (!state.editing || state.editing.id !== tap.id)) return;
    e.preventDefault();
    e.stopPropagation();
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);
    if (inlineHit) {
      // старая привычка «двойной тап — готово» и для правки на месте
      inline.closing = true;
      dropBar(inline.bar);
      inline = null;
    } else closeEdit(false);
    resolveRow({ rowKind: tap.kind, id: tap.id, el: rowEl(tap.id) }, "done");
  }

  // Тап по ручке: «готово» / «вернуть» сразу; повторный тап ≤400 мс игнорируется,
  // чтобы двойной тап по ручке не вернул дело обратно.
  let lastGrip = null;
  function tapGrip(current) {
    const now = Date.now();
    if (lastGrip && lastGrip.id === current.id && now - lastGrip.at < HIT.gripRepeat) return;
    lastGrip = { id: current.id, at: now };
    if (current.grip) {
      current.grip.classList.add("is-fired");
      setTimeout(() => current.grip.classList.remove("is-fired"), 200);
    }
    resolveRow(current, "done");
  }

  function onAct(el) {
    const act = el.dataset.act;
    if (act === "toggle-shop" || act === "open-shop") {
      openShop();
      return;
    }
    if (act === "row-actions") {
      const row = el.closest(".row[data-id]");
      if (row) openRowSheet(row);
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
      state.settings = { ...state.settings, textSize: el.dataset.size || "auto" };
      DB().saveSettings(state.settings);
      applyTextSize();
      renderOverlay();
      return;
    }
    if (act === "pick-day") {
      goTo(el.dataset.date, true);
      return;
    }
    if (act === "open-week") {
      openWeek();
      return;
    }
    if (act === "week-prev" || act === "week-next") {
      shiftWeek(act === "week-next" ? 1 : -1);
      return;
    }
    if (act === "week-open") {
      closeWeek(el.dataset.date);
      return;
    }
    if (act === "week-add") {
      // R-40: тап по пустому месту дня — строка ввода с этим днём.
      // batch11 P2-1: всё синхронно в самом тапе, без View Transitions (их колбэк асинхронный, и closeOverlay
      // снимал фокус) — иначе iPhone не поднимет клавиатуру. Шторка уходит своей тенью (ghostOut).
      const key = el.dataset.date;
      closeOverlay(true);
      if (key && key !== state.cursor) goTo(key, true);
      const line = $("#line");
      if (line) try { line.focus({ preventScroll: true }); } catch { /* focus */ }
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
    if (act === "tail-deck") {
      openDeck("tail");
      return;
    }
    if (act === "deck-open") {
      openDeck("day");
      return;
    }
    if (act.startsWith("deck-")) {
      deckAct(act, el);
      return;
    }
    if (act === "tail-carry" || act === "tail-open" || act === "tail-done" || act === "tail-delete") {
      closeOverlay(true);
      if (act === "tail-carry") carryTail();
      else if (act === "tail-done") tailDone();
      else if (act === "tail-delete") tailDelete();
      else toggleTail();
      return;
    }
    if (act === "badge") {
      setBadge(el.dataset.on === "1");
      return;
    }
    if (act === "tail-days" || act === "auto-carry") {
      state.settings = act === "tail-days"
        ? { ...state.settings, tailDays: +el.dataset.days === 30 ? 30 : 14 }
        : { ...state.settings, autoCarry: el.dataset.on === "1" };
      DB().saveSettings(state.settings);
      renderOverlay();
      renderSheets(false);
      if (act === "auto-carry") maybeAutoCarry();
      return;
    }
    if (act === "menu-time") {
      const id = el.dataset.id || (state.overlay && state.overlay.id);
      closeOverlay(true);
      setMenuTime(id, el.dataset.t);
      return;
    }
    if (act === "menu-done" || act === "menu-today" || act === "menu-tomorrow" || act === "menu-move" || act === "menu-edit" || act === "menu-insert" || act === "menu-delete" || act === "menu-up" || act === "menu-down" || act === "pick-shift") {
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
    if (act === "edit-done" && state.editing) {
      const { kind, id } = state.editing;
      const emptyNew = kind === "task" && emptyDraft();
      if (closeEdit(true) === false) return;
      if (emptyNew) return;
      resolveRow({ rowKind: kind, id, el: rowEl(id) }, "done", 1);
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
      const emptyNew = kind === "task" && emptyDraft();
      // Сначала сохранить набранное (раньше closeEdit(false) выбрасывал название).
      if (closeEdit(true) === false) return;
      if (emptyNew) return; // пустая новая строка убрана, переносить нечего
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
    else if (act === "install-help") openInstallHelp();
    else if (act === "replace-go") replaceGo();
    else if (act === "replace-cancel") {
      state.pendingImport = null;
      closeOverlay(true);
    } else if (act === "replace-undo") replaceUndo();
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
    if (e.target.id === "sheet-title") {
      state.editDraft.title = e.target.value;
      backupEdit(); // синхронно: перезагрузка через 0 мс не теряет набранное
      persistNewTitle();
    }
    if (e.target.id !== "edit-time") return;
    state.editDraft.timeText = e.target.value;
    backupEdit();
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
    if (act === "menu-edit" && kind === "draft") {
      closeOverlay(true);
      pullDraft(id);
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
    else if (act === "menu-today") moveTask(id, 1, { quick: true });
    else if (act === "menu-tomorrow") {
      if (kind === "habit") shiftHabit(id, 1);
      else moveTask(id, 1);
    } else if (act === "menu-insert") insertAfter(id);
    else if (act === "menu-up" || act === "menu-down") {
      const dir = act === "menu-up" ? -1 : 1;
      if ((kind === "task" || kind === "habit") && manualOrderOn(state.cursor) && planNudge(kind, id, dir)) return;
      nudge(id, dir);
    }
    else if (act === "menu-delete") {
      if (kind === "draft") eraseDraft(id);
      else if (kind === "habit") removeHabit(id);
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
    created.draft = true; // R-14: пустая до первого названия — при запуске такие убираются
    state.tasks.push(created);
    drafts.add(created.id);
    await DB().putTask(created);
    renderSheets(true);
    openEdit("task", created.id, { focus: true, force: true });
    offerUndo("строка после", () => restore(before));
  }

  function manualOrderOn(date) {
    return !!(state.dayMeta[date] && state.dayMeta[date].manualOrder);
  }

  // Сдвиг на одну позицию в общем порядке дня (тот же путь, что у перетаскивания).
  function planNudge(kind, id, dir) {
    const rows = [...document.querySelectorAll("#sheet-cur .rows.plan > .row[data-id]")];
    const list = rows.map((r) => `${r.dataset.kind === "habit" ? "h" : "t"}:${r.dataset.id}`);
    const i = list.indexOf(`${kind === "habit" ? "h" : "t"}:${id}`);
    if (i < 0) return false;
    const j = i + dir;
    if (j < 0 || j >= list.length) return true;
    [list[i], list[j]] = [list[j], list[i]];
    persistOrder("plan", list, state.cursor);
    return true;
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

  // R-9: шторка идёт за пальцем 1:1, закрывается по расстоянию (96 px) или по скорости (0.6 px/мс).
  function bindSheetSwipe() {
    const sheet = $("#sheet-ui");
    if (!sheet) return;
    let y0 = 0;
    let x0 = 0;
    let tracking = false;
    let pulling = false;
    let samples = [];
    let lastY = 0;
    const scrim = () => $("#scrim");
    sheet.addEventListener("touchstart", (e) => {
      if (!state.overlay || e.touches.length !== 1) return;
      if (e.target.closest("input, textarea, [contenteditable]")) {
        tracking = false;
        return;
      }
      if (e.target.closest(".deck-card")) {
        tracking = false; // у карточки разбора свои жесты, вниз по ней шторка не закрывается
        return;
      }
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      pulling = false;
      samples = [{ x: y0, t: Date.now() }];
      lastY = y0;
      tracking = sheet.scrollTop <= 0;
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const y = e.touches[0].clientY;
      lastY = y;
      const dy = y - y0;
      const dx = e.touches[0].clientX - x0;
      G().pushSample(samples, y, Date.now());
      if (!pulling) {
        if (dy > 10 && dy > Math.abs(dx)) pulling = true;
        else if (dy < -10 || Math.abs(dx) > 10) {
          tracking = false;
          return;
        } else return;
      }
      // Вверх от исходной точки — сопротивление ×0.2.
      const off = dy >= 0 ? dy : dy * 0.2;
      sheet.style.transition = "none";
      sheet.style.transform = `translateY(${off}px)`;
      const s = scrim();
      if (s) s.style.opacity = String(clamp(1 - Math.max(0, off) / (sheet.offsetHeight || 400), 0, 1));
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    const release = (e, cancel) => {
      if (!tracking) return;
      tracking = false;
      if (!pulling) return;
      pulling = false;
      // Без changedTouches (синтетические касания) — последняя точка из touchmove.
      const t = e && e.changedTouches && e.changedTouches[0];
      const y = t && Number.isFinite(t.clientY) ? t.clientY : lastY;
      const dy = y - y0;
      if (y !== lastY) G().pushSample(samples, y, Date.now());
      const v = G().velocity(samples);
      if (!cancel && (dy > HIT.sheetClose || (v > HIT.sheetFlickV && dy > HIT.sheetFlickMin))) {
        closeOverlay(true);
        if (!state.overlay) return; // правка с ошибкой не закрылась — шторка возвращается
      }
      sheet.style.transition = M().tr("transform", 3, "spring");
      sheet.style.transform = "";
      const s = scrim();
      if (s) {
        s.style.transition = M().tr("opacity", 2, "out");
        s.style.opacity = "";
      }
    };
    sheet.addEventListener("touchend", (e) => release(e, false));
    sheet.addEventListener("touchcancel", (e) => release(e, true));
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
    task.draft = true; // R-14: пустая до первого названия — при запуске такие убираются
    state.tasks.push(task);
    drafts.add(task.id);
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
    else if (type === "install") html = installHTML();
    else if (type === "replace") html = replaceHTML();
    else if (type === "triage") html = deckHTML();
    else if (type === "week") html = weekHTML();
    else html = editSheetHTML();
    showOverlay(html);
    if (type === "days") bindCalendarSwipe();
    if (type === "shop") bindShopLine();
    if (type === "triage") bindDeck();
    if (type === "week") bindWeek();
    const title = $("#sheet-title");
    if (title && state.focusTitle) {
      state.focusTitle = false;
      title.focus();
    }
    const time = $("#edit-time");
    if (state.focusTime) {
      state.focusTime = false;
      if (time) time.focus(); // синхронно в обработчике тапа — iOS откроет клавиатуру
    }
    const form = $("#open-form");
    if (form) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const text = $("#open-line").value.trim();
        if (!text) return;
        const marked = P().parse(`${text} день`, parseCtx(state.cursor));
        if (marked.ok && marked.dateSpoken) {
          closeOverlay(true);
          goTo(marked.date);
        } else setGhost("не разобрал дату", true);
      });
    }
  }

  // ---------- R-34: «разбор дня» — колода, одно дело = одно решение ----------
  // Решения пишутся в модель сразу (без тостов), «шаг назад» возвращает прошлое состояние дела.
  function deckIds(source) {
    const tail = tailTasks().map((t) => t.id);
    if (source === "tail") return tail;
    const at = (t) => (t.kind === "loose" ? 1e4 : t.startMin ?? t.endMin ?? 1e4);
    const today = state.tasks
      .filter((t) => !t.done && !t.draft && t.date === state.today)
      .sort((a, b) => at(a) - at(b) || byOrder(a, b))
      .map((t) => t.id);
    return tail.concat(today);
  }
  let deckLineShown = 0;
  // Тихая строка после конца рабочего дня, раз в день (решение 12): не окно и не уведомление.
  function deckLineCount() {
    if (!state.settings || state.settings.deckOn === state.today) return 0;
    const end = state.settings.workEndMin != null ? state.settings.workEndMin : 20 * 60;
    if (nowMin() < end) return 0;
    const n = deckIds("day").length;
    return n >= 2 ? n : 0;
  }
  function deckLineHTML() {
    const n = deckLineCount();
    deckLineShown = n;
    return n ? `<button type="button" class="deck-line" data-act="deck-open">${esc(`разобрать день · ${n}`)}</button>` : "";
  }
  function syncDeckLine() {
    const n = deckLineCount();
    if (n !== deckLineShown && state.cursor === state.today && !state.sliding) {
      deckLineShown = n;
      renderSheets(false);
    }
  }
  function openDeck(source) {
    const ids = deckIds(source);
    deckSay(true);
    if (state.editing || state.overlay) closeOverlay(true);
    if (!ids.length) {
      offerUndo("разбирать нечего", null);
      return;
    }
    if (source === "day" && state.settings.deckOn !== state.today) {
      state.settings = { ...state.settings, deckOn: state.today }; // разобрали — тихая строка сегодня больше не нужна
      DB().saveSettings(state.settings).catch(() => {});
    }
    state.overlay = { type: "triage", source, ids, pos: 0, log: [], pick: false, arm: false, end: false };
    renderOverlay();
  }
  function deckTask() {
    const o = state.overlay;
    if (!o || o.type !== "triage") return null;
    while (o.pos < o.ids.length) {
      const t = state.tasks.find((x) => x.id === o.ids[o.pos]);
      if (t && !t.done) return t;
      o.pos += 1; // уже решено в другом месте
    }
    return null;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function tomorrowSummary() {
    const key = D().addDays(state.today, 1);
    const list = state.tasks.filter((t) => !t.done && !t.draft && t.date === key);
    if (!list.length) return "на завтра пусто";
    const timed = list.filter((t) => t.kind !== "loose" && (t.startMin ?? t.endMin) != null)
      .sort((a, b) => (a.startMin ?? a.endMin) - (b.startMin ?? b.endMin));
    const head = `завтра ${list.length} ${plural(list.length, "дело", "дела", "дел")}`;
    if (!timed.length) return head;
    const f = timed[0];
    return `${head} · первое в ${D().clockLabel(f.startMin ?? f.endMin)} — ${f.title}`;
  }
  function deckWhen(t) {
    const h = D().head(t.date, state.today);
    const day = t.date === state.today ? "сегодня" : t.date < state.today ? `${h.short} ${h.day}` : h.kicker;
    const c = (m) => D().clockLabel(m);
    let time = "без времени";
    if (t.kind === "slot" && t.startMin != null) time = c(t.startMin);
    else if (t.kind === "window") time = t.startMin != null && t.endMin != null ? `${c(t.startMin)}–${c(t.endMin)}` : t.endMin != null ? `до ${c(t.endMin)}` : time;
    return `${day} · ${time}`;
  }
  const DECK_DAYS = [1, 2, 3, 4, 5, 6, 7, 14];
  function deckHTML() {
    const o = state.overlay;
    const t = o.end ? null : deckTask();
    if (!t) o.end = true;
    const n = o.ids.length;
    const back = `<button type="button" class="deck-back" data-act="deck-back"${o.log.length ? "" : " disabled"}>шаг назад</button>`;
    if (o.end) {
      return `<div class="deck">` + `<div class="deck-top">` + back
        + `<h2 class="deck-title">разобрано · ${esc(n)} из ${esc(n)}</h2></div>`
        + `<p class="deck-sum is-end">${esc(tomorrowSummary())}</p>`
        + `<button type="button" class="sheet-action deck-close" data-act="deck-close">готово</button></div>`;
    }
    let dots = "";
    for (let i = 0; i < n; i += 1) dots += `<i class="${esc(i < o.pos ? "is-past" : i === o.pos ? "is-cur" : "")}"></i>`;
    const carried = t.carried ? `<p class="deck-carried">${esc(`переносилось ${t.carried} ${plural(t.carried, "раз", "раза", "раз")}`)}</p>` : "";
    const arm = o.arm
      ? `<div class="deck-arm"><button type="button" class="deck-del" data-act="deck-delete">удалить</button><button type="button" data-act="deck-keepit">не удалять</button></div>`
      : "";
    const left = n - o.pos - 1;
    const under = (left > 1 ? `<div class="deck-card is-under is-u2" aria-hidden="true"></div>` : "")
      + (left > 0 ? `<div class="deck-card is-under is-u1" aria-hidden="true"></div>` : "");
    const card = `<div class="deck-stack"><div class="deck-bed" aria-hidden="true"><span class="deck-bed-l"></span></div>` + under
      + `<div class="deck-card is-top" data-id="${esc(t.id)}" role="group" tabindex="-1" aria-label="${esc(`${t.title}, ${deckWhen(t)}`)}">`
      + `<p class="deck-when">${esc(deckWhen(t))}</p><p class="deck-name">${esc(t.title)}</p>` + carried + arm + `</div></div>`;
    let actions;
    if (o.pick) {
      actions = `<div class="deck-days">` + DECK_DAYS.map((d) => `<button type="button" class="deck-day" data-act="deck-shift" data-days="${esc(d)}">${esc(deckDayName(d))}</button>`).join("")
        + `</div><button type="button" class="deck-unpick" data-act="deck-unpick">назад к колоде</button>`;
    } else {
      actions = `<div class="deck-btns">`
        + `<button type="button" class="deck-btn" data-act="deck-done"><b aria-hidden="true">←</b><span>сделано</span></button>`
        + `<button type="button" class="deck-btn is-go" data-act="deck-tomorrow"><b aria-hidden="true">→</b><span>завтра</span></button>`
        + `<button type="button" class="deck-btn" data-act="deck-pick"><b aria-hidden="true">→↓</b><span>день…</span></button>`
        + `<button type="button" class="deck-btn" data-act="deck-keep"><b aria-hidden="true">↑</b><span>оставить</span></button></div>`
        // batch8 P3: удаление без удержания — для VoiceOver и клавиатуры (видно только им).
        // batch9 п.5: видна с клавиатуры (:focus-visible), для VoiceOver — как раньше.
        + `<button type="button" class="deck-armkey" data-act="deck-arm">удалить…</button>`;
    }
    return `<div class="deck">` + `<div class="deck-top">` + back + `<h2 class="deck-title">разбор дня · ${esc(o.pos + 1)} из ${esc(n)}</h2></div>`
      + `<div class="deck-dots" aria-hidden="true">` + dots + `</div>` + card + actions
      + `<p class="deck-sum">${esc(`после разбора: ${tomorrowSummary()}`)}</p></div>`;
  }
  function deckDayName(days) {
    const key = D().addDays(state.today, days);
    const h = D().head(key, state.today);
    const name = days === 1 ? "завтра" : days === 2 ? "послезавтра" : `${h.short} ${h.day}`;
    return days <= 2 ? `${name} · ${h.short} ${h.day}` : name;
  }

  let deckTimer = null;
  async function deckDecide(how, days) {
    const o = state.overlay;
    // batch8 P2-1: пока карточка улетает, кнопки и жесты молчат (двойной тап не решает следующее дело вслепую).
    if (!o || o.busy) return;
    const t = deckTask();
    if (!t) return;
    o.busy = true;
    const before = { ...t };
    o.log.push({ id: t.id, pos: o.pos, before, deleted: how === "delete" });
    const stamp = Date.now();
    if (how === "delete") {
      state.tasks = state.tasks.filter((x) => x !== t);
      // batch8 P2-5: сбой записи — тост «не сохранилось · повторить», а не молча.
      DB().deleteTask(t.id).catch(() => saveFailed(() => DB().deleteTask(t.id), null, null));
    } else {
      if (how === "done") {
        t.done = true;
        t.doneAt = stamp;
      } else {
        const past = t.date < state.today;
        const dest = how === "keep" ? state.today : D().addDays(state.today, days || 1);
        if (past) t.carried = (t.carried || 0) + 1;
        if (how === "keep") keepTimeAhead(t); // время прошло — остаётся без времени
        if (dest !== t.date) {
          t.date = dest;
          t.order = nextOrder(dest);
        }
      }
      t.updatedAt = stamp;
      DB().putTask(t).catch(() => saveFailed(() => DB().putTask(t), null, null));
    }
    o.pos += 1;
    o.pick = false;
    o.arm = false;
    // batch8 P2-4: VoiceOver слышит, что решено и что дальше; фокус — на новой карточке.
    const next = deckTask();
    const said = { done: "сделано", keep: "оставлено на сегодня", delete: "удалено" }[how] || `на ${deckDayName(days || 1).split(" · ")[0]}`;
    o.said = `${said}: ${t.title}${next ? ` · дальше: ${next.title}` : ""}`;
    renderSheets(true);
    try { await deckFly(how); } finally { o.busy = false; }
    if (state.overlay !== o) return;
    renderOverlay();
    deckFocus();
    if (!deckTask()) deckFinish();
  }
  function deckFinish() {
    clearTimeout(deckTimer);
    const o = state.overlay;
    // Итог висит 1.5 с и закрывается сам, если за это время ничего не нажали.
    deckTimer = setTimeout(() => { if (state.overlay === o && o.end) closeOverlay(true); }, 1500);
  }
  function deckFly(how) {
    const card = $("#sheet-ui .deck-card.is-top");
    if (!card || M().reduce() || !card.animate) return Promise.resolve();
    const to = how === "done" ? "translateX(-130%) rotate(-8deg)" : how === "keep" ? "translateY(-120%)" : how === "delete" ? "scale(.85)" : "translateX(130%) rotate(8deg)";
    const from = card.style.transform || "none";
    const a = card.animate([{ transform: from }, { transform: to, opacity: how === "delete" ? 0 : 1 }], { duration: M().dur(2), easing: M().ease("in"), fill: "forwards" });
    return new Promise((res) => { a.onfinish = res; a.oncancel = res; setTimeout(res, M().dur(2) + 60); });
  }
  async function deckBack() {
    const o = state.overlay;
    if (!o || o.busy) return;
    const last = o.log.pop();
    if (!last) return;
    clearTimeout(deckTimer);
    const cur = state.tasks.find((x) => x.id === last.id);
    if (cur) Object.keys(cur).forEach((k) => { if (!(k in last.before)) delete cur[k]; });
    const model = cur ? Object.assign(cur, last.before) : { ...last.before };
    if (!cur) state.tasks.push(model);
    await DB().putTask(model).catch(() => saveFailed(() => DB().putTask(model), null, null));
    o.pos = last.pos;
    o.end = false;
    o.pick = false;
    o.arm = false;
    o.said = `вернулось: ${model.title}`;
    renderSheets(true);
    renderOverlay();
    deckFocus();
  }
  function deckFocus() {
    const el = $("#sheet-ui .deck-card.is-top") || $("#sheet-ui .deck-close");
    if (el) try { el.focus({ preventScroll: true }); } catch { /* focus */ }
    deckSay();
  }
  // batch9 п.5: одна постоянная область role=status вне листа — её не пересоздаём, меняем только текст.
  function deckSay(clear) {
    const live = $("#deck-said");
    const o = state.overlay;
    if (!live) return;
    const text = clear || !o || o.type !== "triage" ? "" : o.end ? [o.said, tomorrowSummary()].filter(Boolean).join(". ") : o.said || "";
    if (live.textContent !== text) live.textContent = text;
  }
  // batch9 п.5: Tab не уходит из разбора — по кругу между его кнопками.
  function deckTrap(e) {
    const ui = $("#sheet-ui");
    const list = ui ? [...ui.querySelectorAll("button:not([disabled]), [tabindex=\"0\"]")].filter((el) => !el.closest("[hidden], [inert]")) : [];
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const cur = document.activeElement;
    const inside = ui.contains(cur) && list.includes(cur);
    if (e.shiftKey && (!inside || cur === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside ? !ui.contains(cur) : cur === last)) { e.preventDefault(); first.focus(); }
  }
  function deckAct(act, el) {
    const o = state.overlay;
    if (!o || o.type !== "triage" || o.busy) return;
    clearTimeout(deckTimer);
    if (act === "deck-close") closeOverlay(true);
    else if (act === "deck-back") deckBack();
    else if (act === "deck-done") deckDecide("done");
    else if (act === "deck-tomorrow") deckDecide("move", 1);
    else if (act === "deck-shift") deckDecide("move", +el.dataset.days || 1);
    else if (act === "deck-keep") deckDecide("keep");
    else if (act === "deck-delete") deckDecide("delete");
    else if (act === "deck-arm") {
      o.arm = true;
      o.pick = false;
      renderOverlay();
      const del = $("#sheet-ui .deck-del");
      if (del) try { del.focus(); } catch { /* focus */ }
    } else if (act === "deck-pick" || act === "deck-unpick" || act === "deck-keepit") {
      o.pick = act === "deck-pick";
      o.arm = false;
      renderOverlay();
    }
  }
  // Жесты карточки: ← сделано, → завтра, → и вниз — плитки дней, ↑ оставить. Пороги — HIT строки.
  function bindDeck() {
    const card = $("#sheet-ui .deck-card.is-top");
    if (!card) return;
    const bed = $("#sheet-ui .deck-bed");
    const bedLabel = bed && bed.firstChild;
    let g = null;
    const G0 = G().HIT;
    const guess = (dx, dy) => {
      if (dx > 40 && dy > 40) return "pick";
      if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "done" : "move";
      return dy < 0 ? "keep" : null;
    };
    const LABEL = { done: "← сделано", move: "→ завтра", pick: "→↓ выбрать день", keep: "↑ оставить сегодня" };
    const paint = (dir) => {
      if (!bed) return;
      bed.className = `deck-bed${dir ? ` is-${dir}` : ""}`;
      if (bedLabel) bedLabel.textContent = dir ? LABEL[dir] : "";
    };
    card.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || state.overlay.arm) return;
      g = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, id: e.pointerId, samples: [{ x: e.clientX, t: e.timeStamp }], ys: [{ x: e.clientY, t: e.timeStamp }], moved: false };
      try { card.setPointerCapture(e.pointerId); } catch { /* capture */ }
      ringStart(e.clientX, e.clientY);
      g.hold = setTimeout(() => {
        ringStop();
        if (!g || g.moved) return;
        g = null;
        haptic("press");
        state.overlay.arm = true;
        renderOverlay();
      }, HIT.gripHold);
    });
    card.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      g.dx = e.clientX - g.x0;
      g.dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(g.dx, g.dy) > HIT.gripSlop) { g.moved = true; clearTimeout(g.hold); }
      if (!g.moved) return;
      G().pushSample(g.samples, e.clientX, e.timeStamp);
      G().pushSample(g.ys, e.clientY, e.timeStamp);
      card.style.transform = `translate(${g.dx}px, ${g.dy}px) rotate(${g.dx / 24}deg)`;
      paint(guess(g.dx, g.dy));
    });
    const end = (e) => {
      if (!g || (e && e.pointerId !== g.id)) return;
      clearTimeout(g.hold);
      const { dx, dy } = g;
      const vx = G().velocity(g.samples);
      const vy = G().velocity(g.ys);
      g = null;
      const far = (d, v) => Math.abs(d) >= G0.commit || (Math.abs(v) >= G0.flickV && Math.abs(d) >= G0.flickMin);
      let dir = null;
      if (dx > 60 && dy > 60) dir = "pick";
      else if (Math.abs(dx) >= Math.abs(dy) && far(dx, vx)) dir = dx < 0 ? "done" : "move";
      else if (dy < 0 && Math.abs(dy) > Math.abs(dx) && far(dy, vy)) dir = "keep";
      if (!dir) {
        paint(null);
        if (card.animate && !M().reduce()) card.animate([{ transform: card.style.transform || "none" }, { transform: "none" }], { duration: M().dur(2), easing: M().ease("out") });
        card.style.transform = "";
        return;
      }
      clearTimeout(deckTimer);
      if (dir === "pick") {
        card.style.transform = "";
        state.overlay.pick = true;
        renderOverlay();
        return;
      }
      deckDecide(dir, 1);
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", () => {
      if (!g) return;
      clearTimeout(g.hold);
      g = null;
      card.style.transform = "";
      paint(null);
    });
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
    return `<button type="button" class="sheet-action cal-week-btn" data-act="open-week">неделя</button>
      <div class="cal-head">
        <button type="button" class="step" data-act="cal-prev" aria-label="Предыдущий месяц">${ico("chevron")}</button>
        <strong>${MONTH_NOM[m]} ${y}</strong>
        <button type="button" class="step" data-act="cal-next" aria-label="Следующий месяц">${ico("chevron")}</button>
      </div>
      <div class="cal-swipe" id="cal-swipe">
        <div class="cal-week">${names.map((name) => `<span>${name}</span>`).join("")}</div>
        <div class="cal-grid">${cells.join("")}</div>
      </div>`;
  }

  // R-40: неделя — 7 строк-дней (пн–вс), в каждой до 4 дел чипами, «+N» для остальных.
  function weekStart(key) {
    return D().addDays(key, -((D().dow(key) + 6) % 7));
  }
  function openWeek(from) {
    const start = weekStart(from || state.cursor);
    const go = () => {
      if (state.editing || (state.overlay && state.overlay.type !== "days")) closeOverlay(true);
      state.overlay = { type: "week", start };
      renderOverlay();
      const cur = $("#sheet-ui .week-day.is-cursor .week-head") || $("#sheet-ui .week-head");
      // batch11 P3: фокус программный — кольцо только если неделю открыли с клавиатуры (:focus-visible),
      // после касания или щипка его не видно; первая клавиша возвращает кольцо.
      if (cur && lastInput !== "key") {
        cur.classList.add("is-quiet");
        cur.addEventListener("blur", () => cur.classList.remove("is-quiet"), { once: true });
      }
      if (cur) try { cur.focus({ preventScroll: true, focusVisible: lastInput === "key" }); } catch { /* focus */ }
    };
    viewMorph(go);
  }
  function closeWeek(key) {
    viewMorph(() => {
      closeOverlay(true);
      if (key && key !== state.cursor) goTo(key, true);
    });
  }
  // Переход «день ↔ неделя» через View Transitions (Safari 18+), без них — как обычная шторка.
  function viewMorph(fn) {
    if (document.startViewTransition && !M().reduce()) {
      try { document.startViewTransition(fn); return; } catch { /* нет перехода */ }
    }
    fn();
  }
  function shiftWeek(dir) {
    const o = state.overlay;
    if (!o || o.type !== "week") return;
    o.start = D().addDays(o.start, dir * 7);
    renderOverlay();
  }
  function weekChip(t) {
    const time = t.kind === "slot" ? D().clockLabel(t.startMin, { short: true }) : t.kind === "window" ? D().rangeLabel(t.startMin, t.endMin) : "";
    const label = [time, t.title].filter(Boolean).join(" ") + (t.done ? ", сделано" : "");
    return '<span class="week-chip' + (t.done ? " is-done" : "") + `" data-id="${esc(t.id)}" role="listitem" aria-label="${esc(label)}">`
      + (time ? `<b>${esc(time)}</b> ` : "") + esc(t.title) + "</span>";
  }
  const WEEK_HINT_MOVES = 3;
  function weekHTML() {
    const o = state.overlay;
    const days = [];
    for (let i = 0; i < 7; i += 1) days.push(D().addDays(o.start, i));
    const head = (k) => D().head(k, state.today);
    const rows = days.map((key) => {
      const h = head(key);
      const list = tasksOn(key).slice().sort((x, y) => (x.done - y.done) || ((x.startMin ?? x.endMin ?? 9999) - (y.startMin ?? y.endMin ?? 9999)) || byOrder(x, y));
      const more = list.length > 4 ? `<span class="week-more" role="listitem">${esc(`+${list.length - 4}`)}</span>` : "";
      const cls = "week-day" + (key === state.today ? " is-today" : "") + (key === state.cursor ? " is-cursor" : "");
      const said = `${D().WD[D().dow(key)]}, ${h.day}${key === state.today ? ", сегодня" : ""}: ${list.length ? `${list.length} ${plural(list.length, "дело", "дела", "дел")}` : "пусто"}`;
      return '<div class="' + cls + `" data-date="${esc(key)}">`
        + `<button type="button" class="week-head" data-act="week-open" data-date="${esc(key)}" aria-label="${esc(said)}"><span>${esc(h.short)}</span><b>${esc(h.day)}</b></button>`
        + '<div class="week-chips" role="list">' + list.slice(0, 4).map(weekChip).join("") + more + "</div>"
        + `<button type="button" class="week-add" data-act="week-add" data-date="${esc(key)}" aria-label="${esc(`вписать на ${h.short} ${h.day}`)}"></button>`
        + "</div>";
    }).join("");
    // batch11 (макет 04): на весь экран, «неделя 40» и под ней «28 сен – 4 окт»; подсказка жестов внизу —
    // пока не сделано 3 переноса в неделе.
    const md = (k) => { const dt = D().parseKey(k); return `${dt.getDate()} ${D().MONTHS_SHORT[dt.getMonth()]}`; };
    const moves = (state.settings.hints && Number(state.settings.hints.weekMoves)) || 0;
    const hint = moves < WEEK_HINT_MOVES ? '<p class="week-hint" aria-hidden="true">щипок наружу или тап по дню — обратно в день · держать и тянуть — перенести</p>' : "";
    return '<div class="week" id="week">'
      + `<div class="week-top"><div class="week-name"><h2 class="week-title">${esc(`неделя ${D().isoWeek(o.start)}`)}</h2>`
      + `<p class="week-range">${esc(`${md(days[0])} – ${md(days[6])}`)}</p></div>`
      + `<div class="week-steps"><button type="button" class="step" data-act="week-prev" aria-label="Предыдущая неделя">${ico("chevron")}</button>`
      + `<button type="button" class="step" data-act="week-next" aria-label="Следующая неделя">${ico("chevron")}</button></div></div>`
      + '<div class="week-days">' + rows + "</div>" + hint + "</div>";
  }
  // R-40: щипок внутрь на дне (scale < 0.8) — неделя, наружу в неделе (scale > 1.25) — обратно в день.
  // Safari: gesturestart/gesturechange (e.scale); остальные — расстояние между двумя пальцами.
  function pinchTo(scale) {
    const o = state.overlay;
    const open = scale < 0.8 && !o && !state.editing && !inline;
    const close = scale > 1.25 && o && o.type === "week";
    if (!open && !close) return false;
    swallowUntilRelease(); // клик от отпускания пальцев не должен закрыть неделю (затемнение) или открыть строку
    if (open) openWeek();
    else closeWeek(null);
    return true;
  }
  function bindPinch() {
    let done = false;
    document.addEventListener("gesturestart", (e) => { e.preventDefault(); done = false; });
    document.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      if (!done && pinchTo(e.scale)) done = true;
    });
    let d0 = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    document.addEventListener("touchstart", (e) => { d0 = e.touches.length === 2 ? dist(e.touches) : null; }, { passive: true, capture: true });
    document.addEventListener("touchmove", (e) => {
      if (d0 == null || e.touches.length !== 2 || typeof e.scale === "number") return; // в Safari — gesturechange
      if (pinchTo(dist(e.touches) / d0)) d0 = null;
    }, { passive: true, capture: true });
    document.addEventListener("touchend", (e) => { if (e.touches.length < 2) d0 = null; }, { passive: true, capture: true });
  }
  function bindWeek() {
    const box = $("#week");
    if (!box) return;
    let start = null;
    // R-40: удержание 300 мс на чипе — поднять, тянуть в другой день, отпустить — дело переехало (время то же).
    let lift = null;
    const dropDay = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit && hit.closest ? hit.closest(".week-day") : null;
    };
    const endLift = async (e, cancel) => {
      const l = lift;
      lift = null;
      if (!l) return;
      clearTimeout(l.timer);
      if (!l.up) return;
      box.querySelectorAll(".week-day.is-drop").forEach((d) => d.classList.remove("is-drop"));
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 350);
      const day = cancel ? null : dropDay(e.clientX, e.clientY);
      const to = day && day.dataset.date;
      const task = state.tasks.find((t) => t.id === l.id);
      if (!to || !task || to === task.date) { renderOverlay(); return; }
      const before = snapshot();
      task.date = to;
      task.order = nextOrder(to);
      task.updatedAt = Date.now();
      const redraw = () => { if (state.overlay && state.overlay.type === "week") renderOverlay(); };
      if (!(await putMoved(task, before, redraw))) return;
      const hints = state.settings.hints || {};
      const moved = (Number(hints.weekMoves) || 0) + 1;
      if (moved <= WEEK_HINT_MOVES) {
        state.settings = { ...state.settings, hints: { ...hints, weekMoves: moved } };
        DB().saveSettings(state.settings).catch(() => {});
      }
      renderSheets(true);
      redraw();
      const h = D().head(to, state.today);
      offerUndo(`на ${h.short} ${h.day}`, () => restore(before).then(() => { if (state.overlay && state.overlay.type === "week") renderOverlay(); }));
    };
    box.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary) return;
      start = { x: e.clientX, y: e.clientY };
      const chip = e.target.closest(".week-chip");
      if (!chip) return;
      lift = { id: chip.dataset.id, chip, x0: e.clientX, y0: e.clientY, up: false };
      lift.timer = setTimeout(() => {
        if (!lift || lift.chip !== chip) return;
        const r = chip.getBoundingClientRect();
        lift.up = true;
        lift.dx = e.clientX - r.left;
        lift.dy = e.clientY - r.top;
        chip.style.width = `${Math.round(r.width)}px`;
        chip.style.left = `${Math.round(r.left)}px`;
        chip.style.top = `${Math.round(r.top)}px`;
        chip.classList.add("is-lifted");
        try { chip.setPointerCapture(e.pointerId); } catch { /* capture */ }
        haptic("press");
      }, HIT.gripDrag); // batch11 P3: как ручка строки — 170 мс на месте, раньше сдвиг — это прокрутка
    });
    // batch11 P3: у чипов touch-action: pan-y — неделю можно листать, начав с чипа; поднятый чип
    // прокрутку и шторку не двигает.
    box.addEventListener("touchmove", (e) => {
      if (!lift || !lift.up) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
    box.addEventListener("pointermove", (e) => {
      if (!lift) return;
      if (!lift.up) {
        if (Math.hypot(e.clientX - lift.x0, e.clientY - lift.y0) > HIT.gripSlop) { clearTimeout(lift.timer); lift = null; }
        return;
      }
      e.preventDefault();
      lift.chip.style.left = `${Math.round(e.clientX - lift.dx)}px`;
      lift.chip.style.top = `${Math.round(e.clientY - lift.dy)}px`;
      const day = dropDay(e.clientX, e.clientY);
      box.querySelectorAll(".week-day.is-drop").forEach((d) => { if (d !== day) d.classList.remove("is-drop"); });
      if (day) day.classList.add("is-drop");
    });
    box.addEventListener("pointercancel", (e) => { start = null; endLift(e, true); });
    box.addEventListener("pointerup", (e) => {
      if (lift && lift.up) { start = null; endLift(e, false); return; }
      if (lift) { clearTimeout(lift.timer); lift = null; }
      const s0 = start;
      start = null;
      if (!s0) return;
      const dx = e.clientX - s0.x;
      const dy = e.clientY - s0.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 350);
        shiftWeek(dx < 0 ? 1 : -1);
      }
    });
  }

  const MENU_TIMES = [["plus1", "+1 ч"], ["evening", "вечером"], ["none", "без времени"], ["540", "9"], ["720", "12"], ["900", "15"], ["1140", "19"]];
  // R-39: «+1 ч» сдвигает время (у дела без времени — через час от сейчас), «вечером» — после работы.
  async function setMenuTime(id, t) {
    const task = state.tasks.find((x) => x.id === id);
    if (!task) return;
    const before = snapshot();
    const q = (m) => Math.min(23 * 60 + 45, Math.ceil(m / 15) * 15);
    const at = (m) => { task.kind = "slot"; task.startMin = m; task.endMin = null; };
    if (t === "none") { task.kind = "loose"; task.startMin = null; task.endMin = null; }
    else if (t === "plus1") {
      if (task.startMin == null) at(q(nowMin() + 60));
      else {
        const dur = task.endMin != null ? task.endMin - task.startMin : null;
        task.startMin = Math.min(23 * 60 + 45, task.startMin + 60);
        if (dur != null) task.endMin = D().windowEndOk(task.startMin, task.startMin + dur) ? task.startMin + dur : null;
        if (task.kind === "window" && task.endMin == null) task.kind = "slot";
      }
    } else if (t === "evening") at(q(((state.settings && state.settings.workEndMin) || 18 * 60) + 30));
    else if (/^\d+$/.test(t)) at(Math.min(23 * 60 + 45, +t));
    else return;
    task.updatedAt = Date.now();
    if (!(await putMoved(task, before))) return;
    renderSheets(true);
    offerUndo(task.startMin == null ? "без времени" : `в ${D().clockLabel(task.startMin)}`, () => restore(before));
  }

  function menuHTML() {
    const { kind, id } = state.overlay;
    const item = (act, label, icon) => `<button type="button" class="menu-item" data-act="${act}" data-id="${esc(id)}" data-kind="${esc(kind)}">${ico(icon)}<span>${label}</span></button>`;
    const parts = [];
    // R-26: первая строка меню — сама строка (название и время), чтобы было видно, к чему меню
    const head = menuHead(kind, id);
    if (head) parts.push(head);
    if (kind === "task") {
      const task = state.tasks.find((t) => t.id === id);
      // R-39 (быстрый шаг): время без полей — чипы в меню удержания.
      if (task && !task.done) {
        const times = MENU_TIMES.filter(([v]) => !(v === "none" && task.kind === "loose"));
        parts.push('<div class="menu-times" role="group" aria-label="время">' + times.map(([v, label]) => `<button type="button" class="chip menu-time" data-act="menu-time" data-t="${esc(v)}" data-id="${esc(id)}" data-kind="task">${esc(label)}</button>`).join("") + "</div>");
      }
      parts.push(item("menu-done", task && task.done ? "снова в дне" : "выполнить", "check"));
      if (task && !task.done && task.date < state.today) parts.push(item("menu-today", "в сегодня", "sun"));
      parts.push(item("menu-tomorrow", "на завтра", "sun"));
      parts.push(item("menu-move", "на другой день", "calendar"));
      parts.push(item("menu-edit", "править", "pencil"));
      parts.push(item("menu-insert", "вписать после", "plus"));
      // R-12: «выше / ниже» — альтернатива перетаскиванию; для строк со временем — в ручном порядке дня.
      if (task && (task.kind === "loose" || manualOrderOn(task.date))) {
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
      if (manualOrderOn(state.cursor)) {
        parts.push(item("menu-up", "выше", "up"));
        parts.push(item("menu-down", "ниже", "down"));
      }
      parts.push(item("menu-delete", "удалить", "trash"));
    } else if (kind === "tail") {
      const n = tailTasks().length;
      parts.push(item("tail-carry", `всё в сегодня · ${n}`, "sun"));
      parts.push(item("tail-deck", "разобрать по одному", "down"));
      if (state.tailOpen) parts.push(item("tail-open", "свернуть", "up"));
      parts.push(item("tail-done", "всё сделано", "check"));
      parts.push(item("tail-delete", "удалить всё", "trash"));
    } else if (kind === "draft") {
      parts.push(item("menu-done", "вписать", "check"));
      parts.push(item("menu-edit", "дописать", "pencil"));
      parts.push(item("menu-delete", "стереть", "trash"));
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

  function menuHead(kind, id) {
    let title = "", time = "";
    if (kind === "task") {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return "";
      title = t.title;
      time = t.kind === "loose" ? "" : D().rangeLabel(t.startMin, t.kind === "window" ? t.endMin : null);
    } else if (kind === "habit") {
      const h = state.habits.find((x) => x.id === id);
      if (!h) return "";
      title = h.title;
      time = D().clockLabel(D().habitAt(h), { short: true });
    } else if (kind === "errand") {
      const e = state.errands.find((x) => x.id === id);
      if (!e) return "";
      title = e.text;
    } else return "";
    return '<div class="menu-head"><p class="menu-head-title">' + esc(title) + "</p>" + (time ? '<p class="menu-head-time">' + esc(time) + "</p>" : "") + "</div>";
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
        `<button type="button" class="choice${tag === value ? " is-on" : ""}" aria-pressed="${esc(tag === value)}" data-act="errand-tag" data-tag="${value}">${label}</button>`;
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
        days.push(`<button type="button" class="choice${d.from === key ? " is-on" : ""}" aria-pressed="${esc(d.from === key)}" data-act="from-set" data-date="${key}">${label}</button>`);
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
      ${doneActionHTML()}
      <div class="sheet-row shift-row">
        <button type="button" class="sheet-action" data-act="shift-minus">− день</button>
        <button type="button" class="sheet-action" data-act="shift-plus">+ день</button>
      </div>
      <button type="button" class="sheet-action" data-act="insert-after">${ico("plus")}<span>вписать после</span></button>
      <button type="button" class="sheet-action" data-act="delete">${ico("trash")}<span>удалить</span></button>`;
  }

  // R-11: видимая альтернатива свайпу — «выполнить» / «сделано» первой кнопкой шторки.
  function doneActionHTML() {
    const ed = state.editing;
    if (!ed) return "";
    let label;
    if (ed.kind === "habit") {
      const habit = state.habits.find((h) => h.id === ed.id);
      const st = habit ? D().habitState(habit, state.cursor, state.today) : null;
      label = st === "done" ? "снова в дне" : "сделано";
    } else {
      const task = state.tasks.find((t) => t.id === ed.id);
      label = task && task.done ? "снова в дне" : "выполнить";
    }
    return `<button type="button" class="sheet-action" data-act="edit-done">${ico("check")}<span>${label}</span></button>`;
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
      return `<button type="button" class="choice${on ? " is-on" : ""}" aria-pressed="${on ? "true" : "false"}" data-act="every-preset" data-every="${n}">${label}</button>`;
    };
    const names = [1, 2, 3, 4, 5, 6, 0];
    const days = names.map((dow) => {
      const on = d.weekday === dow ? " is-on" : "";
      return `<button type="button" class="day-toggle${on}" data-weekday="${dow}" aria-pressed="${d.weekday === dow}">${D().WD_SHORT[dow]}</button>`;
    }).join("");
    return `<h2>привычка</h2>
      <input id="sheet-title" class="field" value="${esc(d.title)}" placeholder="что повторять" />
      ${doneActionHTML()}
      <h2>как часто</h2>
      <p class="field-hint">${esc(habitRhythm(d))}. ${esc(habitPreviewText(d))}.</p>
      <div class="kinds">${preset(1, "каждый день")}${preset(2, "раз в 2")}${preset(3, "раз в 3")}${preset(7, "раз в неделю")}</div>
      <div class="sheet-row">
        <button type="button" class="sheet-action" data-act="every-step" data-delta="-1">чаще</button>
        <span class="clock-read">каждые ${esc(early)}</span>
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
      <button type="button" class="day-toggle day-any${d.weekday == null ? " is-on" : ""}" data-weekday="" aria-pressed="${d.weekday == null}">любой</button>
      <div class="weekdays">${days}</div>
      <h2>время суток</h2>
      <div class="kinds habit-anchors">${anchor("", "без часа")}${anchor("morning", "утро")}${anchor("day", "день")}${anchor("evening", "вечер")}${anchor("night", "ночь")}</div>
      <h2>ближайший раз</h2>
      <p class="field-hint">Сдвигает следующее появление и дни после него.</p>
      <div class="sheet-row shift-row">
        <button type="button" class="sheet-action" data-act="shift-minus">на день раньше</button>
        <button type="button" class="sheet-action" data-act="shift-plus">на день позже</button>
      </div>
      <button type="button" class="sheet-action" data-act="delete">${ico("trash")}<span>удалить привычку</span></button>`;
  }

  function settingsHTML() {
    const s = state.settings;
    // R-25: рабочие дни — настоящие переключатели: прямое касание <input switch> даёт тактильный щелчок iOS 18+.
    // batch11 P3: неделя с понедельника (RU), dow — как в базе (0 — вс)
    const days = [1, 2, 3, 4, 5, 6, 0].map((i) => {
      const name = D().WD_SHORT[i];
      const on = s.workDays.includes(i);
      return '<label class="day-toggle' + (on ? " is-on" : "") + '"><input type="checkbox" switch class="day-switch" data-act="work-day" data-dow="' + i + '"' +
        (on ? " checked" : "") + ' aria-label="' + esc(D().WD[i]) + '" /><span aria-hidden="true">' + esc(name) + "</span></label>";
    }).join("");
    const done = (value, label) =>
      `<button type="button" class="choice${s.doneStyle === value ? " is-on" : ""}" aria-pressed="${esc(s.doneStyle === value)}" data-act="done-style" data-style="${value}">${label}</button>`;
    // UX (R-23): размер текста — один сегментный переключатель в строку (и на 320 pt, зоны ≥ 44 px):
    // «система · A · A+ · A++», буквы растут; полные названия — в aria-label.
    const size = (value, label, full) => {
      const on = (s.textSize || "auto") === value;
      return '<button type="button" class="seg-btn seg-' + value + (on ? " is-on" : "") + '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="' + esc(full) + '" data-act="text-size" data-size="' + value + '">' + esc(label) + "</button>";
    };
    const depth = (value, label) => {
      const on = tailDepth() === value;
      return `<button type="button" class="choice${on ? " is-on" : ""}" aria-pressed="${on ? "true" : "false"}" data-act="tail-days" data-days="${esc(value)}">${esc(label)}</button>`;
    };
    const carry = (auto, label) => {
      const on = !!s.autoCarry === auto;
      return `<button type="button" class="choice${on ? " is-on" : ""}" aria-pressed="${on ? "true" : "false"}" data-act="auto-carry" data-on="${auto ? "1" : "0"}">${esc(label)}</button>`;
    };
    const info = DB().storageInfo();
    return `<h2>текст</h2>
      <div class="seg" role="group" aria-label="размер текста">` + size("auto", "система", "как в системе") + size("s", "A", "меньше") + size("m", "A+", "обычно") + size("l", "A++", "крупнее") + `</div>
      <h2>сделанное</h2>
      <div class="kinds">${done("fade", "тускнеет")}${done("strike", "черта")}${done("both", "и то и то")}</div>
      <h2>рабочие часы</h2>
      <div class="hours-edit">
        <span class="hours-pair">
          <button type="button" class="step" data-act="work-start" data-delta="-30">−</button>
          <span class="clock-read">${esc(D().clockLabel(s.workStartMin))}</span>
          <button type="button" class="step" data-act="work-start" data-delta="30">+</button>
        </span>
        <span class="hours-pair">
          <span class="hours-dash">до</span>
          <button type="button" class="step" data-act="work-end" data-delta="-30">−</button>
          <span class="clock-read">${esc(D().clockLabel(s.workEndMin))}</span>
          <button type="button" class="step" data-act="work-end" data-delta="30">+</button>
        </span>
      </div>
      <div class="weekdays">${days}</div>
      <h2>с прошлых дней</h2>` +
      '<div class="kinds">' + carry(false, "ждут на плашке") + carry(true, "сами в сегодня") + "</div>" +
      '<div class="kinds">' + depth(14, "за 14 дней") + depth(30, "за 30 дней") + "</div>" +
      (canBadge()
        ? `<h2>число на иконке</h2>
      <p class="field-hint">Открытые дела сегодня и с прошлых дней. Нужно разрешение на уведомления; уведомлений не будет.</p>
      <div class="kinds"><button type="button" class="choice${s.badge ? "" : " is-on"}" aria-pressed="${s.badge ? "false" : "true"}" data-act="badge" data-on="0">нет</button><button type="button" class="choice${s.badge ? " is-on" : ""}" aria-pressed="${s.badge ? "true" : "false"}" data-act="badge" data-on="1">показывать</button></div><p class="field-hint"${state.badgeNote ? "" : " hidden"}>${esc(state.badgeNote || "")}</p>`
        : "") +
      `<h2>открыть день</h2>
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
        <li><b>плашка «с прошлых дней»</b> — вправо: всё в сегодня, влево: всё сделано, тап: по одному, долго: меню</li>
      </ul>
      <h2>строка</h2>
      <ul class="legend">
        <li><b>вправо</b> — на завтра. Строка уезжает вправо</li>
        <li><b>вправо и вниз</b> — выбрать день. Палец обратно на строку — оставить</li>
        <li><b>тап по чёрточкам справа</b> — выполнить сразу (или влево, или двойной тап). Строка остаётся на месте</li>
        <li><b>тап по тексту</b> — править, тап по времени — сразу к времени</li>
        <li><b>чёрточки вверх или вниз</b> — поменять местами</li>
        <li><b>долгое нажатие</b> — меню: править, перенести, удалить</li>
        <li><b>удалить</b> — единственный способ стереть строку</li>
      </ul>
      <h2>ввод</h2>
      <ul class="legend">
        <li><b>тап по пустому месту под строками</b> — писать, клавиатура сразу</li>
        <li><b>потянуть лист вниз от верха</b> — писать в начало дня</li>
        <li><b>Enter</b> — вписать; клавиатура остаётся для следующего дела</li>
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
        <li><b>через 20 минут выйти</b> — от «сейчас», вверх до 5 минут</li>
        <li><b>полвосьмого врач</b> — и «без пятнадцати 9», «в 3 часа дня»</li>
        <li><b>после работы спорт</b> — и «в обед», «перед сном»</li>
        <li><b>к пятнице отчёт</b> — и «на выходных», «в конце месяца»</li>
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
      <div class="io"${state.replaceBackupAt ? "" : " hidden"}><button type="button" data-act="replace-undo">вернуть как было (до замены ${esc(backupWhen(state.replaceBackupAt || Date.now()))})</button></div>
      <p class="fine" id="storage-line">${esc(storageLine())}${info.quota ? " Место заканчивается." : ""}</p>
      ${isStandalone() ? "" : `<div class="io"><button type="button" data-act="install-help">как установить на экран «Домой»</button></div>`}`;
  }

  function backupWhen(at) {
    const d = new Date(at);
    const h = D().head(D().dayKey(d), state.today);
    return `${h.day} ${h.month}, ${D().clockLabel(d.getHours() * 60 + d.getMinutes())}`;
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
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Safari начинает загрузку не сразу: отозванная тут же ссылка давала пустой файл или ошибку.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function importFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    // Q-2: большой файл целиком читается и парсится в главном потоке — на iPhone это подвешивает PWA.
    if (file.size > DB().MAX_FILE) {
      offerUndo("файл больше 5 МБ — это не копия Planin", null);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      offerUndo("это не json", null);
      return;
    }
    if (state.importMode === "replace") {
      // Q-15: замена — только после подтверждения с числами; текущее уходит в резервную копию.
      if (!payload || typeof payload !== "object" || payload.kit !== "listok") {
        offerUndo("Это не резервная копия Planin", null);
        return;
      }
      state.pendingImport = payload;
      if (state.editing) closeEdit(true);
      state.overlay = { type: "replace" };
      renderOverlay();
      return;
    }
    await applyImport(payload, true);
  }

  function replaceHTML() {
    const p = state.pendingImport || {};
    const n = (x) => (Array.isArray(x) ? x.length : 0);
    const now = `${state.tasks.length} ${plural(state.tasks.length, "задача", "задачи", "задач")}, ${state.errands.length} в списке, ${state.habits.length} ${plural(state.habits.length, "привычка", "привычки", "привычек")}`;
    const file = `${n(p.tasks)} ${plural(n(p.tasks), "задача", "задачи", "задач")}, ${n(p.errands)} в списке, ${n(p.habits)} ${plural(n(p.habits), "привычка", "привычки", "привычек")}`;
    return `<h2>заменить всё файлом?</h2>
      <p class="fine">Сейчас: ${esc(now)}.<br>В файле: ${esc(file)}.</p>
      <p class="fine">Текущие записи сохранятся копией — «вернуть как было» в настройках, до следующей замены.</p>
      <button type="button" class="sheet-action" data-act="replace-go">${ico("check")}<span>заменить</span></button>
      <button type="button" class="sheet-action" data-act="replace-cancel">${ico("close")}<span>не заменять</span></button>`;
  }

  async function replaceGo() {
    const payload = state.pendingImport;
    state.pendingImport = null;
    closeOverlay(true);
    if (!payload) return;
    try {
      await DB().saveReplaceBackup();
    } catch {
      offerUndo("не удалось сохранить копию — ничего не заменено", null);
      return;
    }
    state.replaceBackupAt = Date.now();
    await applyImport(payload, false);
  }

  async function replaceUndo() {
    const backup = await DB().getReplaceBackup();
    if (!backup) {
      state.replaceBackupAt = null;
      renderOverlay();
      return;
    }
    closeOverlay(true);
    const ok = await applyImport(backup.data, false, "вернул как было");
    if (ok) {
      await DB().clearReplaceBackup().catch(() => {});
      state.replaceBackupAt = null;
    }
  }

  async function applyImport(payload, merge, label) {
    const before = snapshot();
    let result;
    try {
      result = await DB().importAll(payload, { merge });
    } catch (err) {
      offerUndo(err.message || "не та копия", null);
      return false;
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
    const skipped = (result && result.skipped) || 0;
    const said = label || (merge ? "вгружено" : "заменено");
    offerUndo(skipped ? `${said} · пропущено ${skipped}` : said, () => restore(before));
    return true;
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
    if (e.key === "Tab" && state.overlay && state.overlay.type === "triage") { deckTrap(e); return; }
    if (e.key === "Escape") {
      // batch5 5b P3: Escape из списка покупок — текст строки остаётся черновиком в обоих движках
      // (Chromium присылал blur при удалении узла и вписывал, WebKit — нет).
      const shopLine = $("#shop-line");
      if (shopLine && state.overlay && state.overlay.type === "shop" && readEditable(shopLine).trim()) {
        setDraft("shop", readEditable(shopLine));
        shopEscaping = true;
        setTimeout(() => { shopEscaping = false; }, 0);
      }
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
    // batch10 P1-3: ContextMenu и Shift+F10 на строке — сразу шторка действий.
    const menuRow = e.target && e.target.closest && e.target.closest(".row[data-id]");
    if (menuRow && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && openRowSheet(menuRow)) {
      e.preventDefault();
      return;
    }
    // R-12: название строки (role="button") и ручка-флажок: Enter и пробел — как касание (правка / «готово»).
    const focusRow = e.target && e.target.closest && e.target.closest('.row [role="button"], .row[role="button"], .row .grip');
    if (focusRow && (e.key === "Enter" || e.key === " ") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      focusRow.click();
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
    paintNowLine();
    syncDeckLine();
    document.querySelectorAll("[data-strip-now]").forEach((el) => {
      const d = new Date();
      const m = d.getHours() * 60 + d.getMinutes();
      el.style.left = `${clamp(((m - 360) / (1440 - 360)) * 100, 0, 100)}%`;
    });
    document.querySelectorAll("[data-now]").forEach((el) => {
      const rail = el.closest(".rail");
      if (!rail) return;
      const from = +rail.dataset.from || 0;
      const d = new Date();
      const mins = d.getHours() * 60 + d.getMinutes();
      el.style.top = `${((mins - from) / 60) * D().HOUR}px`;
    });
  }

  window.addEventListener("planin:storage", onStorage);
  boot().catch(() => {
    const app = document.getElementById("app");
    if (app) app.textContent = "Не удалось открыть хранилище на устройстве";
  });
})();
