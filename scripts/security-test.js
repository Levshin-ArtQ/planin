/**
 * QA: безопасность Planin. Запуск: node scripts/security-test.js [--strict] [--no-browser]
 *
 * 1) Статика: все ${...} внутри HTML-шаблонов app.js либо через esc()/ico(), либо в списке проверенных
 *    числовых/константных выражений. Новое неэкранированное выражение = FAIL (нужно esc() или ревью).
 * 2) esc() экранирует & < > " '.
 * 3) CSP и защитные заголовки (index.html meta / vercel.json).
 * 4) Нет eval/new Function/внешних доменов.
 * 5) Импорт (db.js в vm, резервный путь без IndexedDB): схема, прототип, мусорные типы.
 * 6) Playwright (Chromium + WebKit iPhone 14), если установлен: реальный ввод XSS-payload'ов в UI,
 *    импорт вредоносного JSON, «кирпич» после импорта, потеря данных при частично битом «заменить файлом».
 *
 * Падения из-за известных багов помечены «KNOWN BUG Q-N» и не валят прогон (exit 0), пока не указан --strict.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, staticServer, loadPlaywright, reporter, qaContext } = require("./qa-lib");

const T = reporter("security-test");
T.watchdog(+process.env.QA_WATCHDOG_MS || 9 * 60 * 1000, "браузер завис; см. Q-20");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const app = read("js/app.js");
const html = read("index.html");
const vercel = JSON.parse(read("vercel.json"));

// ---------- 1. Интерполяции в HTML-шаблонах ----------
// Выражения, которые проверены вручную: числа, булевы, константы, вложенные шаблоны из esc()-частей.
const REVIEWED = new Set([
  "stroke", 'paths[name] || ""', 'plan.join("")', "pos(s.workStartMin)", "Math.max(0, pos(s.workEndMin) - pos(s.workStartMin))",
  "pos(m)", "wash", "ticks", "label", "m", "top(m)", "D().clockLabel(m, { short: true })", 'ico("plus")', "top(bounds.to)",
  "top(a)", "top(b) - top(a)", "top(mins)", "doneClass(b.done)", 'b.kind === "habit" ? "habit" : "task"',
  "y", "h", "b.lane", "b.lanes", "bounds.height", "bounds.from", 'inWork(task, key) ? " in-work" : ""', "doneClass(task.done)",
  "sel", "gutter", 'doneClass(v.st === "done")', "when", 'state.shopOld ? "скрыть купленное" : `куплено раньше · ${old.length}`',
  "old.length", 'state.shopWait ? "скрыть будущие" : `приедет позже · ${waiting.length}`', "waiting.length",
  'err.open.sort(byOrder).map((item) => errandRow(item)).join("")', "doneClass(item.done)", "meta", "hidden", "rows",
  "kind", "d.kind === kind", "times", "name", '(d.anchor || "") === name', "html", "n", "key", "day", 'cls.join(" ")',
  "MONTH_NOM[m]", 'names.map((name) => `<span>${name}</span>`).join("")', 'cells.join("")', "act", "buttons",
  'tag === value ? " is-on" : ""', "value", 'd.from === key ? " is-on" : ""', 'days.join("")', "dayRow", "d.kind === value",
  "on", 'on ? " is-on" : ""', "dow", "d.weekday === dow", "D().WD_SHORT[dow]", "slack", 'slack ? `+${slack}` : "ровно"',
  'd.weekday == null ? " is-on" : ""', "d.weekday == null", "i", "s.workDays.includes(i)", 's.doneStyle === value ? " is-on" : ""',
  '(s.textSize || "m") === value ? " is-on" : ""', "days", 'info.quota ? " · место заканчивается" : ""', "y",
  'fresh.length ? `<div class="rows plan">${fresh.map((item) => errandRow(item)).join("")}</div>` : ""', "oldBlock", "waitBlock",
  'fresh.map((item) => errandRow(item)).join("")', "more", "chip", "anchor", "preset", "size", "done", "stroke"
]);
// Известные небезопасные места (баг-репорт). Когда их экранируют — тест скажет «исправлен?».
const KNOWN_UNSAFE = {
  early: "Q-1", // habitSheetHTML: <span class="clock-read">каждые ${early}</span>, early = habit.everyMin из импорта
  "d.everyMin": "Q-1",
  'd.everyMax !== d.everyMin ? `–${d.everyMax}` : ""': "Q-1",
  "d.everyMax": "Q-1"
};

function interpolations(src) {
  // грубый, но достаточный разбор: вытаскиваем ${...} с учётом вложенных скобок и шаблонов
  const out = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!/<[a-z]/i.test(line) && !/^\s*\$\{/.test(line) && !/^\s*<\//.test(line)) return;
    let at = 0;
    while ((at = line.indexOf("${", at)) !== -1) {
      let depth = 1;
      let j = at + 2;
      while (j < line.length && depth) {
        if (line[j] === "{") depth += 1;
        else if (line[j] === "}") depth -= 1;
        j += 1;
      }
      // ${…} внутри аргумента esc(`…`) экранируется целиком вместе с шаблоном (R-12: aria-label="${esc(`${item.title}, …`)}")
      const e = line.lastIndexOf("esc(`", at);
      const insideEsc = e !== -1 && !line.slice(e + 5, at).includes("`");
      if (!insideEsc) out.push({ line: i + 1, expr: line.slice(at + 2, j - 1).trim() });
      at = at + 2;
    }
  });
  return out;
}
// Вызовы локальных HTML-сборщиков, внутри которых всё идёт через esc() (проверено чтением кода).
const REVIEWED_RE = [
  /^(chip|anchor|preset|size|done|item)\((["'][^"']*["'],\s*)*["'][^"']*["'](,\s*["'][^"']*["'])*\)$/,
  /^[\w.]+\.map\(\(item\) => errandRow\(item\)\)\.join\(""\)$/,
  /^state\.shop(Old|Wait) \? `<div class="rows plan"( data-group="errand")?>\$\{\w+\.map\(\(item\) => errandRow\(item\)\)\.join\(""\)\}<\/div>` : ""$/,
  /^b\.kind === "habit" \? `h-\$\{esc\(b\.id\)\}` : esc\(b\.id\)$/,
  /^hours\.join\(""\)$/, /^now$/, /^blocks$/,
  /^preset\(\d+, "[^"]*"\)$/,
  /^d\.everyMax !== d\.everyMin \? `–\$\{esc\(d\.everyMax\)\}` : ""$/,
  /^showTime \? `<input id="edit-time"[^$]*value="\$\{esc\(timeText\(d\)\)\}"[^$]*` : ""$/,
  // gripHTML(флаг, "литерал"): внутри aria-label="${label}" без esc — безопасно, пока второй аргумент всегда литерал (R-22).
  /^gripHTML\([^,()`$]+(\([^()]*\))?[^,()`$]*, "[^"$`]*"\)$/,
  // Тернарник, обе ветки которого — литералы без интерполяций (константный текст/разметка): безопасно при любом условии.
  /^[\w.()!]+ \? ("[^"$`]*"|`[^$`]*`) : ("[^"$`]*"|`[^$`]*`)$/,
  // R-11 (36629c5): примеры пустого дня — константный массив EXAMPLES через esc(); body в spaceHTML — литерал или этот же шаблон;
  // doneActionHTML() — кнопка «выполнить/сделано/снова в дне», подпись только из литералов (проверено чтением кода).
  /^EXAMPLES\.map\(\(x\) => `<button type="button" class="empty-chip" data-example="\$\{esc\(x\)\}">\$\{esc\(x\)\}<\/button>`\)\.join\(""\)$/,
  /^body$/, /^doneActionHTML\(\)$/,
  // R-12 (8f6a40d): rowA11y(label) — атрибуты-литералы, подпись через esc() внутри функции.
  /^rowA11y\(\w+\)$/,
  /^slack \? `после первого дня можно ещё \$\{slack\} \$\{esc\(D\(\)\.daysWord\(slack\)\)\}` : "ровно в рассчитанный день"$/
];
// R-12 fix (6623290): gripHTML(флаг, "литерал", <выражение>.title|.text) — подпись идёт в esc(`${label}: ${title}`).
// Разрешаем эту форму ТОЛЬКО если тело gripHTML действительно экранирует: все ${} в нём — esc(…) или тернарник-литерал по флагу.
// Негативный контроль: если gripHTML перестанет вызывать esc(), форма не попадёт в белый список и вызовы будут пойманы.
function gripBodySafe(src) {
  const m = src.match(/function gripHTML\(([^)]*)\) \{\n([\s\S]*?)\n  \}/);
  if (!m) return false;
  const flag = m[1].split(",")[0].trim();
  const exprs = interpolations(m[2]).map((x) => x.expr);
  if (!exprs.length) return false;
  return exprs.every((e) => /^esc\(/.test(e) || e === `${flag} ? "true" : "false"`);
}
const GRIP_SAFE = gripBodySafe(app);
if (/gripHTML\([^)]*,[^)]*,/.test(app)) T.ok("gripHTML экранирует подпись и название (все ${} в теле — esc() или тернарник-литерал по флагу)", GRIP_SAFE, "в теле gripHTML есть неэкранированная интерполяция — вызовы с названием не считаются безопасными");
if (GRIP_SAFE) REVIEWED_RE.push(/^gripHTML\((?:[\w.]+|[\w.]+ === "[^"$`]*"), "[^"$`]*", [\w]+(?:\.[\w]+)*\.(?:title|text)\)$/);
// самопроверка сторожа на подменённом теле (без esc) — должен вернуть false
T.ok("негативный контроль: gripHTML без esc() не считается безопасным", !gripBodySafe("  function gripHTML(done, label, title) {\n    return `<span aria-checked=\"${done ? \"true\" : \"false\"}\" aria-label=\"${label}: ${title}\"></span>`;\n  }\n") && gripBodySafe("  function gripHTML(done, label, title) {\n    return `<span aria-checked=\"${done ? \"true\" : \"false\"}\" aria-label=\"${esc(`${label}: ${title}`)}\"></span>`;\n  }\n"));
const unknown = [];
const knownHits = {};
for (const { line, expr } of interpolations(app)) {
  if (/^(esc|ico)\(/.test(expr)) continue;
  if (REVIEWED.has(expr) || REVIEWED_RE.some((re) => re.test(expr))) continue;
  if (KNOWN_UNSAFE[expr]) {
    (knownHits[KNOWN_UNSAFE[expr]] = knownHits[KNOWN_UNSAFE[expr]] || []).push(`app.js:${line} \${${expr}}`);
    continue;
  }
  // строки из вложенного шаблона, где всё содержимое — esc(...)
  if (/^[`'"]/.test(expr) && !/\$\{(?!esc\()/.test(expr.replace(/\$\{esc\([^}]*\)\}/g, ""))) continue;
  unknown.push(`app.js:${line} \${${expr}}`);
}
T.ok("все интерполяции в HTML-шаблонах экранированы или проверены вручную", unknown.length === 0, unknown.slice(0, 12).join("; "));
T.bug("Q-1", "нет неэкранированных числовых полей привычки (everyMin/everyMax) в HTML", !knownHits["Q-1"], (knownHits["Q-1"] || []).join("; "));

const sinks = (app.match(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(/g) || []).length;
T.ok(`HTML-синки учтены (innerHTML/insertAdjacentHTML/outerHTML/document.write: ${sinks})`, sinks <= 8, "появились новые синки — проверьте экранирование");
T.ok("нет eval / new Function / setTimeout со строкой", !/\beval\(|new Function\(|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/.test(app + read("js/db.js") + read("js/parse.js") + read("js/day.js") + read("js/motion.js") + read("sw.js")));
T.ok("нет динамических href/src/on*-атрибутов с данными (кроме blob: экспорта)", !/\.(src|href)\s*=\s*(?!url;)/.test(app.replace(/a\.href = url;/, "")) && !/setAttribute\(\s*["'](href|src|style|on\w+)["']/.test(app));

// ---------- 2. esc() ----------
const escSrc = app.match(/function esc\(s\) \{[\s\S]*?\n  \}/);
if (T.ok("esc() найден", !!escSrc)) {
  const esc = vm.runInNewContext(`(${escSrc[0]})`);
  T.ok("esc() экранирует & < > \" '", esc(`<img src=x onerror="a('1')">&`) === "&lt;img src=x onerror=&quot;a(&#39;1&#39;)&quot;&gt;&amp;");
  T.ok("esc(null/undefined) = ''", esc(null) === "" && esc(undefined) === "");
}

// ---------- 3. CSP и заголовки ----------
const headerList = (vercel.headers || []).flatMap((h) => (h.headers || []).map((x) => ({ source: h.source, key: String(x.key).toLowerCase(), value: String(x.value) })));
const globalHeader = (key) => headerList.find((h) => h.key === key && /^\/\(\.\*\)$|^\/:path\*$|^\/\(.*\)$|^\/\*\*?$|^\/(.*)$/.test(h.source) && !/sw\.js/.test(h.source));
// content="..." может содержать одинарные кавычки ('self'), поэтому разбираем по той кавычке, которой открыто значение.
const metaCsp = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i.exec(html);
const headerCsp = (headerList.find((h) => h.key === "content-security-policy") || {}).value || "";
const csp = (metaCsp && (metaCsp[1] || metaCsp[2])) || headerCsp;
if (metaCsp && headerCsp) T.ok("CSP в meta и в заголовке совпадают (кроме frame-ancestors, который в meta не действует)", (metaCsp[1] || metaCsp[2]).replace(/\s+/g, " ").trim() === headerCsp.replace(/;\s*frame-ancestors[^;]*/, "").replace(/\s+/g, " ").trim(), `meta: ${metaCsp[1] || metaCsp[2]} | header: ${headerCsp}`);
T.bug("Q-5", "есть Content-Security-Policy (meta или заголовок vercel.json)", !!csp, "ни meta, ни заголовка нет");
if (csp) {
  T.ok("CSP: default-src 'self' или 'none'", /default-src[^;]*('self'|'none')/.test(csp), csp);
  T.ok("CSP: нет 'unsafe-eval'", !/unsafe-eval/.test(csp), csp);
  T.ok("CSP: script-src без 'unsafe-inline' (inline-скрипт через hash/вынесен)", !/script-src[^;]*unsafe-inline/.test(csp) && !(/default-src[^;]*unsafe-inline/.test(csp) && !/script-src/.test(csp)), csp);
  T.ok("CSP: connect-src ограничен", /connect-src[^;]*'self'|connect-src[^;]*'none'|default-src[^;]*'(self|none)'/.test(csp), csp);
  T.ok("CSP: frame-ancestors 'none' (только в заголовке, meta его игнорирует)", /frame-ancestors\s+'none'/.test((headerList.find((h) => h.key === "content-security-policy") || {}).value || ""), "frame-ancestors в meta не работает");
}
T.bug("Q-5", "X-Content-Type-Options: nosniff", !!globalHeader("x-content-type-options"));
T.bug("Q-5", "защита от встраивания во фрейм (X-Frame-Options или frame-ancestors в заголовке)", !!globalHeader("x-frame-options") || /frame-ancestors/.test((globalHeader("content-security-policy") || {}).value || ""));
T.ok("Referrer-Policy: no-referrer (meta в index.html)", /<meta name="referrer" content="no-referrer"/.test(html) || !!globalHeader("referrer-policy"));
T.bug("Q-5", "Permissions-Policy (камера/гео и т.п. выключены)", !!globalHeader("permissions-policy"));

// ---------- 4. Внешние зависимости ----------
const allSrc = [html, read("css/styles.css"), app, read("js/db.js"), read("js/parse.js"), read("js/day.js"), read("js/motion.js"), read("sw.js"), read("manifest.json")].join("\n");
const remote = (allSrc.match(/(?:src|href|url)\s*[=(]\s*["']?https?:\/\/[^"')\s]+/gi) || []).concat(allSrc.match(/@import\s+url\(\s*["']?https?:/gi) || []);
T.ok("нет внешних скриптов/стилей/шрифтов (всё с того же origin)", remote.length === 0, remote.join(", "));

// ---------- 5. Импорт в vm (db.js, резервный путь localStorage) ----------
function makeCtx() {
  const store = {};
  const ctx = {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    }
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  ["js/day.js", "js/parse.js", "js/db.js"].forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  return ctx;
}

async function vmImport() {
  const ctx = makeCtx();
  const DB = ctx.ListokDB;
  const D = ctx.ListokDay;
  await DB.init();
  const rejects = async (payload) => { try { await DB.importAll(payload); return false; } catch (_) { return true; } };
  T.ok("импорт: null отклоняется", await rejects(null));
  T.ok("импорт: массив отклоняется", await rejects([{ kit: "listok" }]));
  T.ok("импорт: чужой kit отклоняется", await rejects({ kit: "other", tasks: [] }));
  T.ok("импорт: строка отклоняется", await rejects("listok"));

  await DB.importAll(JSON.parse('{"kit":"listok","settings":{"__proto__":{"polluted":1},"constructor":{"prototype":{"p2":1}}},"dayMeta":{"__proto__":{"x":1}},"tasks":[{"id":"t","title":"a","__proto__":{"y":1}}]}'));
  T.ok("импорт: нет прототип-загрязнения (__proto__/constructor)", ({}).polluted === undefined && ({}).p2 === undefined && ({}).x === undefined && vm.runInContext("({}).polluted === undefined && ({}).p2 === undefined && ({}).y === undefined", ctx));

  await DB.wipe();
  await DB.importAll({
    kit: "listok",
    tasks: [{ id: "t1", title: { html: "<b>" }, kind: "<img>", date: "2026-99-99", startMin: "<svg onload=1>", order: "x", extra: "z".repeat(10) }],
    habits: [{ id: "h1", title: "a", everyMin: "<img src=x onerror=alert(1)>", everyMax: -5, history: "not-array", nextDue: 42 }],
    errands: [{ id: "e1", text: "x".repeat(200000) }],
    settings: { workDays: 5, workStartMin: "<img>", textSize: "<x>" },
    dayMeta: { "2026-09-28": { planOrder: "t:t1" } }
  });
  const tasks = await DB.listTasks();
  const habits = await DB.listHabits();
  const errands = await DB.listErrands();
  const settings = await DB.getSettings();
  T.bug("Q-2", "импорт: title задачи приводится к строке", typeof (tasks[0] && tasks[0].title) === "string", JSON.stringify(tasks[0] && tasks[0].title));
  T.bug("Q-2", "импорт: kind задачи из белого списка loose|window|slot", ["loose", "window", "slot"].includes(tasks[0] && tasks[0].kind), String(tasks[0] && tasks[0].kind));
  T.bug("Q-2", "импорт: startMin — число 0..1440 или null", tasks[0] && (tasks[0].startMin == null || (Number.isInteger(tasks[0].startMin) && tasks[0].startMin >= 0 && tasks[0].startMin <= 1440)), String(tasks[0] && tasks[0].startMin));
  T.bug("Q-2", "импорт: date — корректная дата YYYY-MM-DD", tasks[0] && /^\d{4}-\d{2}-\d{2}$/.test(tasks[0].date) && D.ymdValid(...tasks[0].date.split("-").map(Number)), String(tasks[0] && tasks[0].date));
  T.bug("Q-2", "импорт: everyMin привычки — целое 1..30", habits[0] && Number.isInteger(habits[0].everyMin), String(habits[0] && habits[0].everyMin));
  T.bug("Q-2", "импорт: history привычки — массив", habits[0] && Array.isArray(habits[0].history), typeof (habits[0] && habits[0].history));
  T.bug("Q-2", "импорт: длина строк ограничена (текст 200 000 символов обрезан/отклонён)", errands[0] && errands[0].text.length <= 1000, `длина ${errands[0] && errands[0].text.length}`);
  T.bug("Q-2", "импорт: неизвестные поля отброшены", tasks[0] && !("extra" in tasks[0]), "поле extra сохранено");
  // Q-2 (4106dbb): границы — ровно на лимите и лимит+1
  if (DB.MAX_FILE) {
    await DB.wipe();
    const mk = (n, len) => Array.from({ length: n }, (_, i) => ({ id: "b" + i, kind: "loose", title: "x".repeat(len), date: "2026-09-28", order: i }));
    await DB.importAll({ kit: "listok", tasks: mk(1, 1000), errands: [{ id: "e1000", text: "y".repeat(1000) }, { id: "e1001", text: "y".repeat(1001) }] });
    const t1 = await DB.listTasks();
    const e1 = await DB.listErrands();
    const len = (id) => ((e1.find((e) => e.id === id) || {}).text || "").length;
    T.ok("Q-2 граница: строка ровно 1000 символов сохраняется целиком", t1[0] && t1[0].title.length === 1000 && len("e1000") === 1000, `${t1[0] && t1[0].title.length}, ${len("e1000")}`);
    T.ok("Q-2 граница: 1001 символ обрезается до 1000", len("e1001") === 1000, String(len("e1001")));
    await DB.wipe();
    await DB.importAll({ kit: "listok", tasks: mk(10000, 1) });
    const n1 = (await DB.listTasks()).length;
    await DB.wipe();
    await DB.importAll({ kit: "listok", tasks: mk(10001, 1) });
    const n2 = (await DB.listTasks()).length;
    T.ok("Q-2 граница: ровно 10 000 записей в таблице импортируются все", n1 === 10000, String(n1));
    T.ok("Q-2 граница: 10 001 запись — импортируется не больше 10 000", n2 === 10000, String(n2));
    await DB.wipe();
    await DB.importAll({ kit: "listok", tasks: [{ id: "bd", kind: "loose", title: "битая дата", date: "2026-02-30", createdAt: Date.UTC(2026, 8, 20, 9) }] });
    const bd = (await DB.listTasks())[0];
    T.ok("Q-2: задача с невозможной датой (2026-02-30) ставится на день создания, а не теряется", bd && bd.date === "2026-09-20", JSON.stringify(bd && bd.date));
    T.ok("Q-2: лимит файла 5 МБ (DB.MAX_FILE)", DB.MAX_FILE === 5 * 1024 * 1024, String(DB.MAX_FILE));
  } else T.skip("Q-2 границы", "в этой копии лимитов ещё нет");
  T.bug("Q-3", "импорт: settings.workDays остаётся массивом (иначе приложение не открывается)", Array.isArray(settings.workDays), JSON.stringify(settings.workDays));
  let renders = true;
  try { D.workOn("2026-09-28", settings); } catch (_) { renders = false; }
  T.bug("Q-3", "после импорта day.workOn() не падает (рендер дня)", renders, "TypeError: workDays.includes is not a function");
}

// ---------- 6. Браузер ----------
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function browserChecks() {
  if (process.argv.includes("--no-browser")) return T.skip("Playwright-проверки", "--no-browser");
  const pw = loadPlaywright();
  if (!pw) return T.skip("Playwright-проверки", "playwright не найден (npm i playwright в /workspace/planin-qa-tools или PLAYWRIGHT_DIR)");
  const srv = await staticServer();
  const today = todayKey();
  try {
    for (const engine of ["chromium", "webkit"]) {
      let browser;
      try {
        browser = await pw[engine].launch();
      } catch (e) {
        T.skip(`${engine}`, `не запускается: ${e.message.split("\n")[0]}`);
        continue;
      }
      const label = engine === "webkit" ? "WebKit/iPhone 14" : "Chromium";
      const open = async () => {
        const context = await qaContext(browser, engine === "webkit" ? { ...pw.devices["iPhone 14"] } : {});
        const page = await context.newPage();
        page.dialogs = [];
        page.errors = [];
        page.on("dialog", async (d) => { page.dialogs.push(d.message()); await d.dismiss(); });
        page.on("pageerror", (e) => page.errors.push(e.message));
        await page.goto(srv.origin + "/");
        await page.waitForSelector("#line");
        return { context, page };
      };
      const typeLine = async (page, text) => {
        await page.click("#line");
        await page.keyboard.type(text, { delay: 15 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(350);
      };
      const importFile = async (page, obj, mode, confirm) => {
        await page.click("#more");
        await page.waitForSelector(`[data-act=import-${mode}]`);
        const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click(`[data-act=import-${mode}]`)]);
        await fc.setFiles({ name: "planin-qa.json", mimeType: "application/json", buffer: Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)) });
        await page.waitForTimeout(700);
        // Q-15 (7057e77): «заменить файлом» сначала показывает шторку «сейчас / в файле» — подтверждаем, если она есть
        if (mode === "replace" && confirm !== false) {
          const go = await page.waitForSelector("[data-act=replace-go]", { timeout: 1500 }).catch(() => null);
          if (go) { await go.click(); await page.waitForTimeout(700); }
        }
      };
      const idbTitles = (page) => page.evaluate(() => new Promise((res) => {
        const r = indexedDB.open("listok-private");
        r.onsuccess = () => { const q = r.result.transaction("tasks").objectStore("tasks").getAll(); q.onsuccess = () => { res(q.result.map((t) => t.title)); r.result.close(); }; };
      }));

      // 6a. XSS через ввод
      let { context, page } = await open();
      const payloads = ["<img src=x onerror=alert('ui1')>", "\"><svg onload=alert('ui2')>", "javascript:alert('ui3')", "купить <img src=x onerror=alert('ui4')>", "<b onmouseover=alert('ui5')>жирный</b>"];
      for (const p of payloads) await typeLine(page, p);
      await page.click("#shop-btn").catch(() => {});
      await page.waitForTimeout(400);
      const injectedShop = await page.evaluate(() => document.querySelectorAll("#sheet-ui img, #sheet-ui [onerror]").length);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const injected0 = await page.evaluate(() => document.querySelectorAll("#app img, #app b, [onerror], [onload], [onmouseover]").length);
      const injected = injected0 + injectedShop;
      const titles = await page.$$eval("#sheet-cur .row .title", (els) => els.map((e) => e.textContent));
      T.ok(`${label}: payload'ы из строки ввода не исполняются и не создают элементов`, page.dialogs.length === 0 && injected === 0, `dialogs=${page.dialogs} injected=${injected}`);
      T.ok(`${label}: payload сохранён как текст`, titles.includes("<img src=x onerror=alert('ui1')>"), JSON.stringify(titles));
      // правка названия через шторку
      const row = await page.$("#sheet-cur .row[data-kind=task]");
      if (row) {
        await row.click();
        await page.waitForSelector("#sheet-title", { timeout: 3000 }).catch(() => {});
        if (await page.$("#sheet-title")) {
          await page.fill("#sheet-title", "\"><img src=x onerror=alert('edit')>");
          await page.keyboard.press("Enter");
          await page.waitForTimeout(400);
          await page.reload();
          await page.waitForSelector("#line");
          await page.waitForTimeout(300);
          T.ok(`${label}: payload в названии через «править» не исполняется после перезагрузки`, page.dialogs.length === 0 && (await page.evaluate(() => document.querySelectorAll("#app img").length)) === 0, `dialogs=${page.dialogs}`);
        }
      }
      await context.close();

      // 6a'. R-32: живая строка в шапке («● <текущее> до … · дальше <следующее>») — названия из IndexedDB в innerHTML
      ({ context, page } = await open());
      {
        const nowMin = await page.evaluate(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
        const s0 = Math.max(0, nowMin - 10), e0 = Math.min(1439, nowMin + 40), s1 = Math.min(1439, nowMin + 55);
        await importFile(page, { kit: "listok", tasks: [
          { id: "now1", kind: "window", title: "<img src=x onerror=alert('now-cur')>", date: today, startMin: s0, endMin: e0, order: 1 },
          { id: "now2", kind: "slot", title: "\"><svg onload=alert('now-next')>", date: today, startMin: s1, order: 2 }
        ] }, "merge");
        await page.keyboard.press("Escape").catch(() => {});
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(1200);
        const k = await page.evaluate(() => { const el = document.querySelector("#kicker"); return el ? { now: el.classList.contains("is-now"), text: el.textContent, tags: el.querySelectorAll("img,svg").length } : null; });
        if (!k || !k.now) T.skip(`${label}: R-32 живая строка`, `строка не показана (${JSON.stringify(k)}; часы ${nowMin})`);
        else T.ok(`${label}: R-32 живая строка: названия с HTML показаны текстом, код не выполняется`, page.dialogs.length === 0 && k.tags === 0 && k.text.includes("<img") , `dialogs=${JSON.stringify(page.dialogs)}, тегов ${k.tags}, текст «${k.text.slice(0, 80)}»`);
      }
      await context.close();

      // 6a''. R-33: подсказки из истории (чипы над пустой строкой и серое дополнение) — названия с HTML
      ({ context, page } = await open());
      if (await page.evaluate(() => !!window.ListokSuggest)) {
        const ago = (n) => page.evaluate((k) => window.ListokDay.addDays(window.ListokDay.todayKey(), -k), n);
        const XS = ["спорт <img src=x onerror=alert('chip')>", "сон \" onfocus=alert('focus') autofocus x=\"", "сок <svg onload=alert('svg')>"];
        const hist = [];
        for (const [i, t] of XS.entries()) for (const w of [7, 14, 21]) hist.push({ id: `sg${i}-${w}`, kind: "slot", title: t, date: await ago(w), startMin: 19 * 60 + i, order: w, done: true, createdAt: Date.now() - w * 864e5 });
        await importFile(page, { kit: "listok", version: 1, tasks: hist, errands: [], habits: [], dayMeta: {}, settings: {} }, "merge");
        await page.keyboard.press("Escape").catch(() => {});
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(2200); // индекс строится через 1,5 с после отрисовки
        await page.click("#line");
        await page.waitForTimeout(500);
        const chips = await page.evaluate(() => { const b = document.querySelector("#chips"); return b ? { hidden: b.hidden, n: b.querySelectorAll(".chip").length, text: b.textContent, tags: b.querySelectorAll("img,svg,[onfocus]").length } : null; });
        const onAny = await page.evaluate(() => document.querySelectorAll("[onfocus],[onerror],[onload],[autofocus]").length);
        if (!chips || chips.hidden || !chips.n) T.ok(`${label}: R-33 чипы из истории показаны (для проверки XSS)`, false, JSON.stringify(chips));
        else T.ok(`${label}: R-33 чипы: названия с <img onerror>, " onfocus=, <svg onload> — текстом, код не выполняется`, page.dialogs.length === 0 && chips.tags === 0 && onAny === 0 && chips.text.includes("<img") && chips.text.includes("onfocus") && chips.text.includes("<svg"), `чипов ${chips.n}, тегов ${chips.tags}, on*-атрибутов ${onAny}, dialogs ${JSON.stringify(page.dialogs)}, текст «${chips.text.slice(0, 120)}»`);
        await page.keyboard.type("спо", { delay: 30 });
        await page.waitForTimeout(600);
        const ghost = await page.evaluate(() => { const g = document.querySelector("#ghost"); return g ? { comp: g.classList.contains("is-complete"), text: g.textContent, tags: g.querySelectorAll("img,svg").length } : null; });
        if (!ghost || !ghost.comp) T.ok(`${label}: R-33 дополнение «спо» → «спорт …» показано`, false, JSON.stringify(ghost));
        else {
          T.ok(`${label}: R-33 дополнение: название с <img onerror> текстом, код не выполняется`, page.dialogs.length === 0 && ghost.tags === 0 && ghost.text.includes("<img"), `тегов ${ghost.tags}, текст «${ghost.text.slice(0, 80)}»`);
          await page.click("#ghost").catch(() => {});
          await page.waitForTimeout(400);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(800);
        }
        const tags = await page.evaluate(() => document.querySelectorAll("#app img, [onerror], [onload], [onfocus]").length);
        T.ok(`${label}: R-33 после принятия дополнения и Enter — код не выполняется, без JS-ошибок`, page.dialogs.length === 0 && page.errors.length === 0 && tags === 0, `dialogs ${JSON.stringify(page.dialogs)}, errors ${JSON.stringify(page.errors)}, img/on* ${tags}`);
      } else T.skip(`${label}: R-33 подсказки`, "в этой копии нет js/suggest.js");
      await context.close();

      // 6a'''. Окна через полночь (конец 24:00+N): подпись, порядок, старые данные, правка, экспорт, лимит импорта
      ({ context, page } = await open());
      {
        const NEW_NIGHT = await page.evaluate(() => !!(window.ListokDay && window.ListokDay.NIGHT_END_MAX));
        const NIGHT_MAX = NEW_NIGHT ? 36 * 60 : 32 * 60;
        const tasks = [
          { id: "mn1", kind: "window", title: "смена ночь", date: today, startMin: 23 * 60, endMin: 25 * 60, order: 1 },
          { id: "old1", kind: "window", title: "старое окно", date: today, startMin: 10 * 60, endMin: 11 * 60, order: 2 },
          { id: "old2", kind: "slot", title: "старый час", date: today, startMin: 9 * 60, order: 3 },
          // 9255373: конец до 8:00 следующих суток (32·60) — «с 22 до 7 смена» = 22–7 (1320–1860)
          // 42ea8ae (UX, Q-27): конец до 36:00 (12:00 след. суток), через полночь не дольше 14 ч; до него (9255373) — до 32:00
          { id: "lim1", kind: "window", title: "предел", date: today, startMin: 22 * 60, endMin: NIGHT_MAX, order: 4 },
          { id: "lim2", kind: "window", title: "за пределом", date: today, startMin: 22 * 60, endMin: NIGHT_MAX + 1, order: 5 },
          { id: "len14", kind: "window", title: "ровно 14 ч", date: today, startMin: 21 * 60, endMin: 35 * 60, order: 10 },
          { id: "len14p", kind: "window", title: "14 ч и минута", date: today, startMin: 20 * 60 + 59, endMin: 35 * 60, order: 11 },
          { id: "shift", kind: "window", title: "ночная смена", date: today, startMin: 22 * 60, endMin: 31 * 60, order: 6 },
          // бессмысленные окна: длиннее 24 ч и конец не позже начала
          { id: "long", kind: "window", title: "окно 31 час", date: today, startMin: 60, endMin: 32 * 60, order: 7 },
          { id: "rev", kind: "window", title: "окно наоборот", date: today, startMin: 10 * 60, endMin: 9 * 60, order: 8 },
          { id: "zero", kind: "window", title: "окно нулевое", date: today, startMin: 10 * 60, endMin: 10 * 60, order: 9 }
        ];
        await importFile(page, { kit: "listok", version: 1, tasks, errands: [], habits: [], dayMeta: {}, settings: {} }, "merge");
        await page.keyboard.press("Escape").catch(() => {});
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(800);
        // при нескольких делах со временем день может открыться расписанием (D-10: блоки), иначе — списком
        const view = await page.evaluate(() => [...document.querySelectorAll("#sheet-cur .row, #sheet-cur .rail .block")].map((r) => ({ t: (r.querySelector(".title, .block-title") || {}).textContent, g: (r.querySelector(".gutter, .block-time") || {}).textContent, top: parseFloat(r.style.top) || 0 })).sort((a, b) => a.top - b.top));
        const byT = (t) => view.find((v) => v.t === t) || {};
        const mid = byT("смена ночь");
        if (!mid.t) T.skip(`${label}: окна через полночь`, `в этой копии не отображаются: ${JSON.stringify(view).slice(0, 160)}`);
        else {
          T.ok(`${label}: окно 23:00–25:00 подписано «23–1»`, /23\s*[\u2013-]\s*1(?!\d)/.test(mid.g || ""), JSON.stringify(mid));
          const order = view.map((v) => v.t);
          const railH = await page.evaluate(() => { const r = document.querySelector("#sheet-cur .rail"); const b = r && [...r.querySelectorAll(".block")].find((x) => x.textContent.includes("смена ночь")); return r && b ? { rail: r.offsetHeight, bottom: b.offsetTop + b.offsetHeight } : null; });
          if (railH) T.ok(`${label}: D-10 блок окна через полночь не вылезает за шкалу (обрезан по 24)`, railH.bottom <= railH.rail + 1, JSON.stringify(railH));
          T.ok(`${label}: старые данные читаются, порядок по времени (9 → 10–11 → 23–1)`, order.indexOf("старый час") < order.indexOf("старое окно") && order.indexOf("старое окно") < order.indexOf("смена ночь") && !!byT("старое окно").g && !!byT("старый час").g, JSON.stringify(view));
          const storedAll = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open("listok-private"); r.onsuccess = () => { const q = r.result.transaction("tasks").objectStore("tasks").getAll(); q.onsuccess = () => { res(Object.fromEntries(q.result.map((t) => [t.id, { k: t.kind, s: t.startMin, e: t.endMin }]))); r.result.close(); }; }; r.onerror = () => res(null); }));
          const stored = async () => { const a = await storedAll(); return a && Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.e])); };
          const st = await stored();
          const all = await storedAll();
          if (NEW_NIGHT) {
            T.ok(`${label}: Q-27 (42ea8ae): импорт: конец 36:00 (12:00 след. суток) при 22:00 (14 ч) принят, 36:01 отброшен`, !!st && st.mn1 === 1500 && st.lim1 === 2160 && st.lim2 == null, JSON.stringify(st));
            T.ok(`${label}: Q-27 (42ea8ae): импорт: окно через полночь ровно 14 ч (21:00–11:00) принято, 14 ч + 1 мин (20:59–11:00) — конец отброшен`, !!st && st.len14 === 2100 && st.len14p == null, JSON.stringify({ len14: st && st.len14, len14p: st && st.len14p }));
          } else T.ok(`${label}: импорт: конец 32:00 (8:00 след. суток) принят, 32:01 отброшен (лимит Q-2, 9255373)`, !!st && st.mn1 === 1500 && st.lim1 === 1920 && st.lim2 == null, JSON.stringify(st));
          const sh = byT("ночная смена");
          T.ok(`${label}: импорт ночной смены 22:00–31:00 → хранится 1320/1860, подпись «22–7»`, !!all && all.shift && all.shift.s === 1320 && all.shift.e === 1860 && /22\s*[\u2013-]\s*7(?!\d)/.test(sh.g || ""), JSON.stringify({ db: all && all.shift, view: sh }));
          // Осмысленно: окно длиннее 24 ч или с концом не позже начала не хранится как есть (конец отброшен, либо запись отброшена)
          const sane = (v) => !v || v.e == null || (v.s != null && v.e > v.s && v.e - v.s <= 24 * 60);
          T.ok(`${label}: Q-26 (0649d81): импорт окна 1:00–32:00 (31 ч) не хранится как окно длиннее суток`, !!all && sane(all.long), JSON.stringify(all && all.long));
          T.ok(`${label}: Q-26 (0649d81): импорт окна 10:00–9:00 и 10:00–10:00 (конец не позже начала) не хранится как есть`, !!all && sane(all.rev) && sane(all.zero), JSON.stringify(all && { rev: all.rev, zero: all.zero }));
          await page.click("#sheet-cur :is(.row, .block):has-text('смена ночь')");
          await page.waitForTimeout(700);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(700);
          const st2 = await stored();
          T.ok(`${label}: открыть и закрыть правку окна через полночь — конец остаётся 25:00`, !!st2 && st2.mn1 === 1500, JSON.stringify(st2));
          await page.click("#more");
          await page.waitForSelector("[data-act=export]");
          const dl2 = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), page.click("[data-act=export]")]).then(([d]) => d, () => null);
          if (!dl2) T.skip(`${label}: экспорт окна через полночь`, "загрузка не пришла");
          else {
            const dump2 = JSON.parse(fs.readFileSync(await dl2.path(), "utf8"));
            const m = (dump2.tasks || []).find((t) => t.id === "mn1") || {};
            T.ok(`${label}: экспорт сохраняет окно через полночь (startMin 1380, endMin 1500)`, m.endMin === 1500 && m.startMin === 1380, JSON.stringify(m));
          }
          T.ok(`${label}: окна через полночь — без JS-ошибок`, page.errors.length === 0, page.errors.join(" | "));
        }
      }
      await context.close();

      // 6a''''. R-34 «разбор дня» (колода) и R-35 (несколько дел одной строкой): названия с HTML, данные после решений
      ({ context, page } = await open());
      {
        const tmr = await page.evaluate(() => window.ListokDay.addDays(window.ListokDay.todayKey(), 1));
        const todayApp = await page.evaluate(() => window.ListokDay.todayKey());
        await importFile(page, {
          kit: "listok", version: 1,
          tasks: [
            { id: "dk1", kind: "slot", title: "колода <img src=x onerror=alert('deck')>", date: todayApp, startMin: 23 * 60, order: 1 },
            { id: "dk2", kind: "loose", title: 'колода " onfocus=alert(\'deckf\') autofocus x="', date: todayApp, order: 2, carried: 2 },
            { id: "dk3", kind: "slot", title: "завтра <svg onload=alert('sum')>", date: tmr, startMin: 9 * 60, order: 3 }
          ],
          errands: [], habits: [], dayMeta: {}, settings: { workEndMin: 0 } // тихая строка — «после конца рабочего дня»: при любых часах
        }, "replace");
        await page.keyboard.press("Escape").catch(() => {});
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(800);
        const line = await page.$("[data-act=deck-open]");
        if (!line) T.skip(`${label}: R-34 колода`, "нет тихой строки «разобрать день» (в этой копии нет R-34 или не прошёл конец рабочего дня)");
        else {
          await line.click();
          await page.waitForTimeout(600);
          const deckInfo = () => page.evaluate(() => { const d = document.querySelector(".deck:not(#deck)"); return d ? { text: d.textContent, tags: d.querySelectorAll("img,svg:not(.ico),[onerror],[onload],[onfocus],[autofocus]").length, id: (d.querySelector(".deck-card.is-top") || {}).dataset?.id } : null; });
          const d1 = await deckInfo();
          T.ok(`${label}: R-34 колода: названия с <img onerror>, " onfocus=, <svg onload> (и в итоге «завтра … — …») — текстом, код не выполняется`, !!d1 && d1.tags === 0 && page.dialogs.length === 0 && /<img/.test(d1.text) && /<svg/.test(d1.text), JSON.stringify({ d1: d1 && { ...d1, text: d1.text.slice(0, 160) }, dialogs: page.dialogs }));
          const idbT = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open("listok-private"); r.onsuccess = () => { const q = r.result.transaction("tasks").objectStore("tasks").getAll(); q.onsuccess = () => { res(Object.fromEntries(q.result.map((t) => [t.id, { date: t.date, s: t.startMin, done: !!t.done }]))); r.result.close(); }; }; }));
          const first = (d1 && d1.id) || (await page.evaluate(() => { const c = document.querySelector(".deck-card.is-top[data-id]"); return c ? c.getAttribute("data-id") : null; })) || "dk1"; // порядок колоды: сначала дела со временем (dk1 23:00)
          const before = await idbT();
          await page.click("[data-act=deck-tomorrow]");
          await page.waitForTimeout(600);
          const mid = await idbT();
          T.ok(`${label}: R-34 «→ завтра»: дело на завтра с тем же временем (IndexedDB)`, !!first && mid[first].date === tmr && mid[first].s === before[first].s, JSON.stringify({ first, before: before[first], after: mid[first] }));
          await page.click("[data-act=deck-back]");
          await page.waitForTimeout(600);
          const back = await idbT();
          T.ok(`${label}: R-34 «шаг назад» возвращает дело на сегодня`, !!first && back[first].date === before[first].date && back[first].s === before[first].s, JSON.stringify(back[first]));
          await page.click("[data-act=deck-done]");
          await page.waitForTimeout(600);
          const dn = await idbT();
          T.ok(`${label}: R-34 «← сделано» пишет done в IndexedDB`, !!first && dn[first].done === true, JSON.stringify(dn[first]));
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(400);
          T.ok(`${label}: R-34 колода — без JS-ошибок и alert`, page.errors.length === 0 && page.dialogs.length === 0, JSON.stringify({ errors: page.errors, dialogs: page.dialogs }));
        }
        // R-35: несколько дел одной строкой, каждое с HTML в названии
        const many = "звонок <img src=x onerror=alert('m1')>; купить <svg onload=alert('m2')>, хлеб и молоко потом встреча \" onfocus=alert('m3') autofocus x=\"";
        await page.click("#line");
        await page.keyboard.type(many, { delay: 5 });
        await page.waitForTimeout(500);
        const prev = await page.evaluate(() => { const a = document.querySelector("#app"); return { tags: a.querySelectorAll("img,[onerror],[onload],[onfocus],[autofocus]").length, ghost: (document.querySelector("#ghost") || {}).textContent || "" }; });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(900);
        const after = await page.evaluate(() => document.querySelectorAll("#app img, [onerror], [onload], [onfocus], [autofocus]").length);
        const names = await page.evaluate(() => [...document.querySelectorAll("#sheet-cur .title, #sheet-cur .block-title")].map((e) => e.textContent).filter((t) => /alert/.test(t)));
        T.ok(`${label}: R-35 несколько дел одной строкой с HTML: превью и вписанные дела — текстом, код не выполняется`, prev.tags === 0 && after === 0 && page.dialogs.length === 0 && page.errors.length === 0 && names.length >= 2, JSON.stringify({ prev, after, names, dialogs: page.dialogs, errors: page.errors }));
      }
      await context.close();

      // 6a'''''. R-37: снимок дня из localStorage «planin:snap» до загрузки (js/snap.js) и ссылка ?day=
      if (fs.existsSync(path.join(ROOT, "js/snap.js"))) {
        // без SW: иначе js/app.js приходит из кэша SW мимо page.route и задержку не поставить
        context = await qaContext(browser, { ...(engine === "webkit" ? pw.devices["iPhone 14"] : {}), serviceWorkers: "block" });
        page = await context.newPage();
        page.dialogs = [];
        page.errors = [];
        page.on("dialog", async (d) => { page.dialogs.push(d.message()); await d.dismiss(); });
        page.on("pageerror", (e) => page.errors.push(e.message));
        await page.goto(srv.origin + "/");
        await page.waitForSelector("#line");
        await page.waitForTimeout(800);
        const tk = await page.evaluate(() => window.ListokDay.todayKey());
        // подменённый снимок: HTML в строках, шапке, классах и отступе
        await page.evaluate((day) => localStorage.setItem("planin:snap", JSON.stringify({ v: 1, day, at: Date.now(), text: "m\" onload=\"alert(1)",
          head: { kicker: "<img src=x onerror=alert('kick')>", num: "<b>1</b>", rest: "<svg onload=alert('rest')>" }, pad: "10px; background:url(x)",
          rows: [{ t: "снимок <img src=x onerror=alert('snap')>", g: "<svg onload=alert('g')>", d: "is-done\" onmouseover=\"alert(2)", k: "task" }, { t: 5 }, null] })), tk);
        // app.js приходит с задержкой — видно, что рисует сам snap.js
        let release;
        const gate = new Promise((r) => { release = r; });
        await page.route("**/js/app.js", async (route) => { await gate; await route.continue().catch(() => {}); });
        await page.reload({ waitUntil: "commit" });
        await page.waitForSelector("#line", { timeout: 5000 }).catch(() => {});
        const pre = await page.evaluate(() => { const a = document.querySelector("#app"); return { text: a.textContent, tags: a.querySelectorAll("img,svg,b,[onerror],[onload],[onmouseover]").length, rows: a.querySelectorAll(".row").length, pad: (a.querySelector(".snap-sheet") || {}).style?.paddingTop || "", cls: [...a.querySelectorAll(".row")].map((r) => r.className), line: !!document.querySelector("#line") }; });
        T.ok(`${label}: R-37 снимок до загрузки: HTML из planin:snap (строки, шапка, классы, отступ) — текстом, код не выполняется`, pre.line && pre.rows === 1 && pre.tags === 0 && page.dialogs.length === 0 && /<img/.test(pre.text) && pre.pad === "" && pre.cls.every((c) => c === "row"), JSON.stringify({ ...pre, text: pre.text.slice(0, 120), dialogs: page.dialogs }));
        // набор и Enter до загрузки не теряются и не вписываются дважды
        // focus(), а не click: в WebKit Playwright до загрузки клик ждёт «стабильности» и не проходит
        await page.evaluate(() => { const l = document.querySelector("#line"); if (l) l.focus(); });
        const EARLY = "до загрузки <img src=x onerror=alert('early')>";
        await page.keyboard.type(EARLY, { delay: 10 });
        const typedEarly = await page.evaluate(() => (document.querySelector("#line") || {}).textContent || "");
        await page.keyboard.press("Enter");
        release();
        await page.waitForFunction(() => window.__planinBooted || document.querySelector("#sheet-cur"), null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const early = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("listok-private"); r.onsuccess = () => { const q = r.result.transaction("tasks").objectStore("tasks").getAll(); q.onsuccess = () => { res(q.result.filter((t) => /загрузки/.test(t.title))  /* не «до загрузки»: при Q-29 первая буква уезжает в конец */.map((t) => ({ title: t.title, draft: !!t.draft }))); r.result.close(); }; }; r.onerror = () => res(null); }));
        const lineText = await page.evaluate(() => (document.querySelector("#line") || {}).textContent || "");
        T.ok(`${label}: R-37 Enter до загрузки: дело вписано один раз после загрузки, строка пуста, код не выполняется`, !!early && early.filter((t) => !t.draft).length === 1 && !lineText.trim() && page.dialogs.length === 0, JSON.stringify({ early, lineText, dialogs: page.dialogs }));
        T.ok(`${label}: R-37 набор до загрузки: текст в строке-снимке ровно как набран (Q-29, исправлено в 8f460a4)`, typedEarly === EARLY && !!early && early.some((t) => t.title === EARLY), JSON.stringify({ typedEarly, early }));
        const snapNow = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("planin:snap")); } catch { return "bad"; } });
        await page.waitForTimeout(800);
        const snap2 = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("planin:snap")); } catch { return "bad"; } });
        T.ok(`${label}: R-37 после загрузки снимок переписан настоящим днём (подмена не живёт дальше)`, !!snap2 && snap2.v === 1 && Array.isArray(snap2.rows) && !snap2.rows.some((r) => /alert\('snap'\)/.test(r.t)) && typeof snap2.pad === "number", JSON.stringify({ before: snapNow && snapNow.rows && snapNow.rows.length, after: snap2 && snap2.rows }).slice(0, 300));
        T.ok(`${label}: R-37 снимок — без JS-ошибок`, page.errors.length === 0, page.errors.join(" | "));
        // ссылка ?day=: открывает день, параметр уходит из адреса; неверная дата — сегодня
        const other = await page.evaluate(() => window.ListokDay.addDays(window.ListokDay.todayKey(), 3));
        await page.goto(`${srv.origin}/?day=${other}&utm=x`);
        await page.waitForSelector("#sheet-cur");
        await page.waitForTimeout(600);
        const d1 = await page.evaluate(() => ({ day: document.querySelector("#sheet-cur").dataset.date, url: location.search }));
        T.ok(`${label}: R-37 ?day=${other} открывает этот день, параметр убран, остальные на месте`, d1.day === other && !/day=/.test(d1.url) && /utm=x/.test(d1.url), JSON.stringify(d1));
        await page.goto(`${srv.origin}/?day=2026-02-30`);
        await page.waitForSelector("#sheet-cur");
        await page.waitForTimeout(600);
        const d2 = await page.evaluate(() => ({ day: document.querySelector("#sheet-cur").dataset.date, url: location.search, today: window.ListokDay.todayKey() }));
        T.ok(`${label}: R-37 ?day=2026-02-30 (неверная дата) → сегодня, параметр убран`, d2.day === d2.today && !/day=/.test(d2.url), JSON.stringify(d2));
        await page.goto(`${srv.origin}/?day=%3Cimg%20src%3Dx%20onerror%3Dalert('day')%3E`);
        await page.waitForSelector("#sheet-cur");
        await page.waitForTimeout(600);
        T.ok(`${label}: R-37 ?day=<img onerror> — сегодня, код не выполняется`, page.dialogs.length === 0 && page.errors.length === 0 && (await page.evaluate(() => document.querySelectorAll("#app img").length)) === 0, JSON.stringify({ dialogs: page.dialogs, errors: page.errors }));
        await context.close();
      } else T.skip(`${label}: R-37 снимок дня`, "в этой копии нет js/snap.js");

      // 6b. Импорт: XSS через everyMin
      ({ context, page } = await open());
      await importFile(page, {
        kit: "listok",
        version: 1,
        tasks: [{ id: "t1", kind: "loose", title: "<img src=x onerror=alert('title')>", date: today, order: 1, done: false }],
        errands: [{ id: "e1", text: "<img src=x onerror=alert('errand')>", tag: "<img src=x onerror=alert('tag')>", done: false, order: 1 }],
        habits: [{ id: "h1", title: "мазь", everyMin: "<img src=x onerror=alert('everyMin')>", everyMax: 2, nextDue: today, history: [], anchor: "evening" }],
        dayMeta: {},
        settings: {}
      }, "merge");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const listDialogs = page.dialogs.length;
      T.ok(`${label}: импорт с HTML в title/text/tag не исполняется в списке`, listDialogs === 0, String(page.dialogs));
      const habitRow = await page.$("#sheet-cur .row[data-kind=habit]");
      if (habitRow) {
        await habitRow.click();
        await page.waitForTimeout(800);
      }
      T.bug("Q-1", `${label}: импорт привычки с everyMin="<img onerror>" не исполняет код при открытии шторки`, page.dialogs.length === 0, `alert(${page.dialogs.join(",")}) сработал`);
      await context.close();

      // 6c. «Кирпич» после импорта
      ({ context, page } = await open());
      await typeLine(page, "моя важная задача");
      await importFile(page, { kit: "listok", settings: { workDays: 5 } }, "merge");
      await page.reload();
      await page.waitForTimeout(1200);
      const booted = !!(await page.$("#line"));
      const text = booted ? "" : (await page.textContent("#app")).trim();
      T.bug("Q-3", `${label}: после импорта settings.workDays=5 приложение открывается`, booted, `на экране: «${text}»`);
      await context.close();

      // 6d. «Заменить файлом», когда запись посреди транзакции падает (эмуляция ошибки put: квота/битая запись).
      //     Ожидаемо: транзакция откатывается, старые данные на месте.
      ({ context, page } = await open());
      await typeLine(page, "задача А");
      await typeLine(page, "задача Б");
      await page.evaluate(() => {
        const orig = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, ...rest) {
          if (value && value.title === "__QA_THROW__") throw new DOMException("QA: simulated put failure", "DataError");
          return orig.call(this, value, ...rest);
        };
      });
      await importFile(page, { kit: "listok", tasks: [{ id: "ok1", kind: "loose", title: "из файла", date: today, order: 1 }, { id: "bad1", kind: "loose", title: "__QA_THROW__", date: today, order: 2 }] }, "replace");
      const left = await idbTitles(page);
      const toastText = (await page.textContent("#toast-text").catch(() => "")) || "";
      T.bug("Q-4", `${label}: сбой посреди «заменить файлом» не стирает текущие данные (транзакция откатывается)`, left.includes("задача А") && left.includes("задача Б") && !left.includes("из файла"), `в IndexedDB осталось: ${JSON.stringify(left)}; тост: «${toastText.slice(0, 80)}»`);
      await context.close();

      // 6d'. Та же «замена» с записью, у которой id не строка (id: true) — не должна стирать данные.
      ({ context, page } = await open());
      await typeLine(page, "задача В");
      await importFile(page, { kit: "listok", tasks: [{ id: true, title: "битая строка", date: today }] }, "replace");
      const left2 = await idbTitles(page);
      T.bug("Q-4", `${label}: «заменить файлом» с id=true не приводит к исключению посреди транзакции`, !left2.includes("битая строка") && (left2.includes("задача В") || (await page.isVisible("#toast-undo"))), `в IndexedDB: ${JSON.stringify(left2)}`);
      await context.close();

      // 6f. Q-15: «заменить файлом» — подтверждение и «вернуть как было»
      ({ context, page } = await open());
      await typeLine(page, "до замены альфа");
      await typeLine(page, "до замены бета");
      const repl = { kit: "listok", tasks: [{ id: "r1", kind: "loose", title: "из файла замены", date: today, order: 1 }] };
      await importFile(page, repl, "replace", false);
      const sheet = await page.isVisible("[data-act=replace-go]").catch(() => false);
      T.bug("Q-15", `${label}: «заменить файлом» сначала спрашивает подтверждение`, sheet, "шторки подтверждения нет — замена сразу");
      if (sheet) {
        await page.click("[data-act=replace-cancel]");
        await page.waitForTimeout(600);
        const kept = await idbTitles(page);
        T.ok(`${label}: «не заменять» оставляет данные как были (Q-15)`, kept.includes("до замены альфа") && kept.includes("до замены бета") && !kept.includes("из файла замены"), JSON.stringify(kept));
        await page.keyboard.press("Escape").catch(() => {});
        await importFile(page, repl, "replace");
        const replaced = await idbTitles(page);
        T.ok(`${label}: после подтверждения данные заменены файлом (Q-15)`, replaced.includes("из файла замены") && !replaced.includes("до замены альфа"), JSON.stringify(replaced));
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(1000); // тост «отмена» уже не поможет: проверяем именно «вернуть как было» после перезагрузки
        await page.click("#more");
        const undoBtn = await page.waitForSelector("[data-act=replace-undo]", { state: "visible", timeout: 3000 }).catch(() => null);
        T.bug("Q-15", `${label}: после «заменить файлом» в настройках есть «вернуть как было» (и после перезагрузки)`, !!undoBtn, "кнопки нет");
        if (undoBtn) {
          await undoBtn.click();
          await page.waitForTimeout(1000);
          const back = await idbTitles(page);
          T.bug("Q-15", `${label}: «вернуть как было» восстанавливает прежние задачи`, back.includes("до замены альфа") && back.includes("до замены бета") && !back.includes("из файла замены"), JSON.stringify(back));
        }
      }
      await context.close();

      // 6g. Q-2: размер файла — ровно 5 МБ принимается, 5 МБ + 1 байт отклоняется (данные не меняются)
      ({ context, page } = await open());
      const sized = (bytes, title) => {
        const base = JSON.stringify({ kit: "listok", tasks: [{ id: "big-" + bytes, kind: "loose", title, date: today, order: 1, pad: "" }] });
        const str = base.replace('"pad":""', `"pad":"${"p".repeat(bytes - Buffer.byteLength(base))}"`);
        return str;
      };
      const LIM = 5 * 1024 * 1024;
      const f1 = sized(LIM, "файл ровно 5 мб");
      const f2 = sized(LIM + 1, "файл больше 5 мб");
      if (Buffer.byteLength(f1) !== LIM || Buffer.byteLength(f2) !== LIM + 1) T.ok(`${label}: Q-2 подготовка файлов на границе`, false, `${Buffer.byteLength(f1)} / ${Buffer.byteLength(f2)}`);
      await importFile(page, f1, "merge");
      await page.keyboard.press("Escape").catch(() => {});
      await importFile(page, f2, "merge");
      const sizeToast = (await page.textContent("#toast-text").catch(() => "")) || "";
      const got5 = await idbTitles(page);
      T.bug("Q-2", `${label}: файл ровно 5 МБ импортируется`, got5.includes("файл ровно 5 мб"), JSON.stringify(got5));
      T.bug("Q-2", `${label}: файл 5 МБ + 1 байт отклоняется, данные не меняются`, !got5.includes("файл больше 5 мб"), `тост: «${sizeToast.slice(0, 60)}»`);
      await context.close();

      // 6e. Экспорт -> импорт в чистый профиль
      ({ context, page } = await open());
      await typeLine(page, "экспорт задача");
      await typeLine(page, "купить экспорт-молоко");
      await typeLine(page, "привычка экспорт-мазь раз в 2-3 вечером");
      await page.click("#more");
      await page.waitForSelector("[data-act=export]");
      const dl = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), page.click("[data-act=export]")]).then(([d]) => d, () => null);
      if (!dl) {
        T.skip(`${label}: экспорт -> импорт`, "скачивание не случилось (share sheet?)");
        await context.close();
      } else {
        const fsPath = await dl.path();
        const buf = fs.readFileSync(fsPath);
        const dump = JSON.parse(buf.toString("utf8"));
        T.ok(`${label}: экспорт — валидный JSON kit=listok, имя planin-YYYY-MM-DD.json`, dump.kit === "listok" && /^planin-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
        await context.close();
        ({ context, page } = await open());
        await importFile(page, buf.toString("utf8"), "replace");
        await page.keyboard.press("Escape");
        const got = await page.evaluate(() => new Promise((res) => {
          const r = indexedDB.open("listok-private");
          r.onsuccess = () => {
            const tx = r.result.transaction(["tasks", "errands", "habits"]);
            const out = {};
            let n = 0;
            ["tasks", "errands", "habits"].forEach((s) => { const q = tx.objectStore(s).getAll(); q.onsuccess = () => { out[s] = q.result; if (++n === 3) res(out); }; });
          };
        }));
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const byId = (xs) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
        T.ok(`${label}: экспорт -> «заменить файлом» восстанавливает задачи/покупки/привычки байт-в-байт`, same(byId(got.tasks), byId(dump.tasks)) && same(byId(got.errands), byId(dump.errands)) && same(byId(got.habits), byId(dump.habits)), `tasks ${got.tasks.length}/${dump.tasks.length}, errands ${got.errands.length}/${dump.errands.length}, habits ${got.habits.length}/${dump.habits.length}`);
        await context.close();
      }

      await browser.close();
    }
  } finally {
    await srv.close();
  }
}

(async () => {
  await vmImport();
  await browserChecks();
  process.exit(T.summary());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
