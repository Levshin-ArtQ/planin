// R-37: мгновенный старт. Грузится сразу после #app, до остальных скриптов: рисует снимок сегодняшнего дня
// из localStorage «planin:snap» и строку ввода, чтобы тап и набор работали с первого кадра.
// Только textContent/DOM-узлы, никакого HTML из хранилища. app.js потом достраивает всё вокруг этой строки
// (сам узел #line не пересоздаётся — фокус и набранное остаются).
(function () {
  var app = document.getElementById("app");
  if (!app) return;
  function dayKey(d) {
    var m = d.getMonth() + 1, n = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (n < 10 ? "0" : "") + n;
  }
  function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  var today = dayKey(new Date());
  var snap = null, draft = "";
  // ?day=ГГГГ-ММ-ДД открывает другой день — сегодняшний снимок и черновик тогда не рисуем.
  var asked = /(?:^|[?&])day=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search);
  if (asked && asked[1] !== today) today = null;
  try {
    var raw = JSON.parse(localStorage.getItem("planin:snap") || "null");
    if (raw && raw.v === 1 && raw.day === today && Array.isArray(raw.rows)) snap = raw;
  } catch (e) { snap = null; }
  try {
    var drafts = JSON.parse(localStorage.getItem("planin:drafts") || "{}");
    var mine = drafts && drafts[today];
    if (mine && typeof mine.text === "string") draft = mine.text.slice(0, 2000);
  } catch (e) { draft = ""; }
  var DONE = { "": "", "is-done": "is-done", "is-done is-fade": "is-done is-fade", "is-done is-strike": "is-done is-strike", "is-done is-fade is-strike": "is-done is-fade is-strike" };
  if (snap) {
    if (snap.text === "s" || snap.text === "m" || snap.text === "l") document.documentElement.dataset.text = snap.text;
    app.textContent = "";
    var head = snap.head || {};
    var top = el("header", "top snap-top");
    var hit = el("div", "date-hit is-today");
    hit.appendChild(el("p", "kicker", str(head.kicker, 80)));
    var line = el("p", "date-line");
    line.appendChild(el("span", "", str(head.num, 8)));
    var rest = el("span", "", str(head.rest, 40));
    rest.id = "snap-rest";
    line.appendChild(rest);
    hit.appendChild(line);
    top.appendChild(hit);
    app.appendChild(top);
    var sheet = el("div", "snap-sheet");
    sheet.setAttribute("aria-hidden", "true");
    function num(v, max) { return typeof v === "number" && isFinite(v) && v >= -2000 && v <= max ? Math.round(v) : null; }
    // batch10 P2-6: строки и «коробки» (полоса часов, плашка хвоста, лента) — на своих местах из живого листа
    var placed = snap.rows.some(function (r) { return r && num(r.y, 20000) != null; });
    var inner = el("div", placed ? "snap-place" : "");
    var sy = num(snap.sy, 20000) || 0;
    if (placed && sy) inner.style.transform = "translateY(-" + sy + "px)";
    var BOX = {
      strip: function (b) { var e = el("div", "strip snap-box"); e.appendChild(el("span", "strip-label", str(b.t, 40))); return e; },
      tail: function (b) {
        // обёртка .tail (стили текста), плашка — .snap-tail (не .row: строки снимка — только дела)
        var e = el("div", "tail snap-box"), plate = el("div", "tail-plate snap-tail"), tx = el("div", "tail-text");
        tx.appendChild(el("p", "t1", str(b.t, 120)));
        tx.appendChild(el("p", "t2", str(b.t2, 120)));
        plate.appendChild(tx);
        plate.appendChild(el("span", "go", "→ в сегодня"));
        e.appendChild(plate);
        return e;
      },
      wash: function () { return el("div", "wash snap-box"); },
      hour: function (b) { var e = el("div", "hour snap-box"); e.appendChild(el("span", "", str(b.t, 8))); return e; },
      block: function (b, kind) {
        var e = el("div", "block " + kind + " snap-box");
        e.appendChild(el("p", "block-time", str(b.t, 24)));
        e.appendChild(el("p", "block-title", str(b.t2, 120)));
        return e;
      }
    };
    if (placed && Array.isArray(snap.boxes)) {
      snap.boxes.slice(0, 80).forEach(function (b) {
        if (!b || typeof b.k !== "string") return;
        var x = num(b.x, 4000), y = num(b.y, 20000), w = num(b.w, 4000), h = num(b.h, 4000);
        if (x == null || y == null || w == null || h == null) return;
        var m = /^block-(slot|window|habit)$/.exec(b.k);
        var make = m ? function (bb) { return BOX.block(bb, m[1]); } : Object.prototype.hasOwnProperty.call(BOX, b.k) && b.k !== "block" ? BOX[b.k] : null;
        if (!make) return;
        var e = make(b);
        e.style.cssText = "position:absolute;margin:0;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px;min-height:0";
        inner.appendChild(e);
      });
    }
    // без мест (старый снимок) — первая строка там, где будет в живом дне
    if (!placed && typeof snap.pad === "number" && snap.pad >= 0 && snap.pad <= 400) sheet.style.paddingTop = Math.round(snap.pad) + "px";
    var rows = el("div", "rows");
    snap.rows.slice(0, 30).forEach(function (r) {
      if (!r || typeof r.t !== "string") return;
      var cls = DONE[typeof r.d === "string" ? r.d : ""];
      var row = el("article", "row" + (cls ? " " + cls : ""));
      row.appendChild(el("p", "title", str(r.t, 200)));
      var g = str(r.g, 24);
      if (g) row.appendChild(el("span", "gutter", g));
      var y = num(r.y, 20000);
      if (placed && y != null) { row.style.position = "absolute"; row.style.top = y + "px"; row.style.left = "22px"; row.style.right = "22px"; }
      rows.appendChild(row);
    });
    if (placed) { inner.appendChild(rows); sheet.appendChild(inner); } else sheet.appendChild(rows);
    // место для «Закройте Planin в другой вкладке…» (app.js, onStorage), пока день не открыт
    var wait = el("div", "boot");
    wait.hidden = true;
    app.appendChild(sheet);
    app.appendChild(wait);
  } else {
    var boot = app.querySelector(".boot");
    if (boot) boot.classList.add("snap-boot");
  }
  var compose = el("div", "compose");
  compose.id = "compose";
  compose.dataset.snap = "1";
  var row = el("div", "compose-row");
  var input = el("div", "line" + (draft ? "" : " is-empty"));
  input.id = "line";
  // те же атрибуты, что в mount() (app.js) — строка одна и та же
  input.setAttribute("contenteditable", "plaintext-only");
  if (input.contentEditable !== "plaintext-only") input.setAttribute("contenteditable", "true");
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-multiline", "false");
  input.setAttribute("aria-label", "На этот день");
  input.setAttribute("data-placeholder", "на этот день");
  input.setAttribute("enterkeyhint", "send");
  input.setAttribute("autocorrect", "on");
  input.setAttribute("autocapitalize", "sentences");
  input.setAttribute("spellcheck", "true");
  if (draft) input.textContent = draft;
  input.addEventListener("input", function () {
    var was = input.classList.contains("is-empty");
    input.classList.toggle("is-empty", !input.textContent);
    // Q-29: WebKit после снятия плейсхолдера (::before) оставляет каретку в начале — первая буква уезжала в конец.
    if (was && input.textContent) {
      try {
        var r = document.createRange();
        r.selectNodeContents(input);
        r.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (e) { /* каретка */ }
    }
  });
  // Enter до загрузки приложения не теряется: app.js запишет строку сразу после mount().
  input.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing || window.__planinBooted) return;
    e.preventDefault();
    if (window.__planinSnap) window.__planinSnap.enter = true;
  });
  row.appendChild(input);
  compose.appendChild(row);
  app.appendChild(compose);
  window.__planinSnap = { at: Date.now(), shown: !!snap, draft: draft };
})();
