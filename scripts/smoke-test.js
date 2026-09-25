const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(" ✓", name);
  else {
    console.error(" ✗", name, detail || "");
    failed += 1;
  }
};

[
  "index.html",
  "sw.js",
  "manifest.json",
  "css/styles.css",
  "js/day.js",
  "js/parse.js",
  "js/db.js",
  "js/motion.js",
  "js/app.js",
  "icons/icon-192.svg",
  "icons/icon-512.svg",
  "icons/icon-maskable.svg"
].forEach((file) => ok(file, fs.existsSync(path.join(root, file))));

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
const dbSrc = fs.readFileSync(path.join(root, "js/db.js"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
ok("no remote scripts", !/src="https?:/.test(html));
ok("indexedDB", dbSrc.includes("indexedDB"));
ok("app does not fetch remote APIs", !/fetch\((['"])https?:/.test(app));
ok("export and import", app.includes("exportJson") && app.includes("importAll") && html.includes('id="import-file"'));
ok("gesture language is in the sheet", app.includes("влево и вниз") || app.includes("openDepth"));
ok("work hours default live in settings flow", app.includes("workStartMin") && app.includes("toggle-rail"));
ok("service worker cache", sw.includes("listok-v1.0.21") && sw.includes("./js/parse.js") && sw.includes("function isNav") && sw.includes("matchCache") && sw.includes("function precache") && !sw.includes("return cached || net") && !sw.includes("fetch(req)"));
ok("double tap completes a habit", app.includes("function tapHabit"));
ok("reorder grip", app.includes('class="grip"') && app.includes('data-group="plan"') && app.includes("fromGrip"));
ok("double tap completes", app.includes("function tapTask"));
ok("done task is not deleted by a swipe", !/task\.done\) removeTask/.test(app));

const ctx = {
  localStorage: (() => {
    const store = {};
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      }
    };
  })()
};
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "js/day.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(root, "js/parse.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(root, "js/db.js"), "utf8"), ctx);

const D = ctx.ListokDay;
const P = ctx.ListokParse;
const DB = ctx.ListokDB;
const today = "2026-09-23";

ok("23 Sep 2026 is Wednesday", D.dow(today) === 3);
ok("add days", D.addDays(today, 1) === "2026-09-24" && D.diffDays(today, "2026-10-01") === 8);
ok("workday", D.workOn(today, D.defaultSettings()) && !D.workOn("2026-09-26", D.defaultSettings()));
ok("text size default", D.defaultSettings().textSize === "m");
ok("composer is not a form field", app.includes('id="line"') && app.includes("plaintext-only") && app.includes('id="shop-btn"'));
ok("tasks share one list", app.includes('class="rows plan"') && app.includes('class="gutter"'));
ok("head today", D.head(today, today).kicker === "сегодня" && D.head(today, today).day === 23);
ok("weekday beside today", D.head(today, today).weekday === "среда");
ok("weekday beside tomorrow", D.head("2026-09-24", today).kicker === "завтра" && D.head("2026-09-24", today).weekday === "четверг");
ok("clock", D.clock(14, 30) === 870 && D.clockLabel(840, { short: true }) === "14");
ok("time 1430", D.parseClockText("1430") === 14 * 60 + 30);
ok("time 14.30", D.parseClockText("14.30") === 14 * 60 + 30);
ok("time 14 30", D.parseClockText("14 30") === 14 * 60 + 30);
ok("time 9", D.parseClockText("9") === 9 * 60);
ok("time typo minute", D.parseClockText("14:3") === 14 * 60 + 30);
ok("window 12-14", D.parseWhen("12-14").kind === "window" && D.parseWhen("12-14").endMin === 14 * 60);
ok("until 16", D.parseWhen("до 16").startMin == null && D.parseWhen("до 16").endMin === 16 * 60);
ok("bad time", D.parseWhen("утром").ok === false);
ok("range до", D.rangeLabel(null, 16 * 60) === "до 16");

const monday = D.nextDow(today, 1, false);
ok("next monday", monday === "2026-09-28");
ok("strict monday from monday", D.nextDow(monday, 1, true) === D.addDays(monday, 7));

function phrase(text, extra) {
  const parsed = P.parse(text, { today });
  if (!parsed.ok) return parsed;
  return Object.assign(parsed, extra || {});
}

const cases = [
  ["написать отчёт", (r) => r.ok && r.kind === "loose" && r.title === "написать отчёт" && r.date === today && !r.dateSpoken],
  ["завтрак дома", (r) => r.ok && r.kind === "loose" && r.title === "завтрак дома" && !r.dateSpoken],
  ["завтра позвонить маме", (r) => r.ok && r.date === "2026-09-24" && r.title === "позвонить маме"],
  ["послезавтра спорт", (r) => r.ok && r.date === "2026-09-25" && r.title === "спорт"],
  ["через три сдать книгу", (r) => r.ok && r.date === "2026-09-26" && r.title === "сдать книгу"],
  ["+2 отчёт", (r) => r.ok && r.date === "2026-09-25" && r.title === "отчёт"],
  ["пн планёрка", (r) => r.ok && r.date === "2026-09-28" && r.kind === "loose" && r.title === "планёрка"],
  ["в среду стоматолог", (r) => r.ok && r.date === today && r.title === "стоматолог"],
  ["23.10 анализы", (r) => r.ok && r.date === "2026-10-23" && r.title === "анализы"],
  ["14:30 стоматолог", (r) => r.ok && r.kind === "slot" && r.startMin === 14 * 60 + 30 && r.title === "стоматолог"],
  ["в 14 созвон", (r) => r.ok && r.kind === "slot" && r.startMin === 14 * 60 && r.title === "созвон"],
  ["завтра в четырнадцать тридцать стоматолог", (r) => r.ok && r.date === "2026-09-24" && r.kind === "slot" && r.startMin === 14 * 60 + 30 && r.title === "стоматолог"],
  ["8 вечера зарядка", (r) => r.ok && r.kind === "slot" && r.startMin === 20 * 60 && r.title === "зарядка"],
  ["в 8 вечера зарядка", (r) => r.ok && r.kind === "slot" && r.startMin === 20 * 60 && r.title === "зарядка"],
  ["с 12 до 14 обед", (r) => r.ok && r.kind === "window" && r.startMin === 12 * 60 && r.endMin === 14 * 60 && r.title === "обед"],
  ["12-14 обед", (r) => r.ok && r.kind === "window" && r.startMin === 12 * 60 && r.endMin === 14 * 60],
  ["до 16 отчёт", (r) => r.ok && r.kind === "window" && r.startMin == null && r.endMin === 16 * 60 && r.title === "отчёт"],
  ["вечером позвонить маме", (r) => r.ok && r.kind === "slot" && r.startMin === 21 * 60 && r.title === "позвонить маме"],
  ["купить молоко", (r) => r.ok && r.kind === "errand" && r.errandTag === "buy" && r.title === "молоко"],
  ["купить 2 пакета", (r) => r.ok && r.kind === "errand" && r.atMin == null && r.title === "2 пакета"],
  ["забрать заказ озон", (r) => r.ok && r.kind === "errand" && r.errandTag === "pickup" && r.title === "заказ озон"],
  ["забрать озон в пятницу", (r) => r.ok && r.errandTag === "pickup" && r.dateSpoken && r.date === "2026-09-25" && r.title === "озон"],
  ["заказ витамины с пятницы", (r) => r.ok && r.errandTag === "order" && r.dateSpoken && r.date === "2026-09-25" && r.title === "витамины"],
  ["озон забрать со среды", (r) => r.ok && r.errandTag === "pickup" && r.date === today && r.title === "озон"],
  ["завтра купить молоко", (r) => r.ok && r.kind === "errand" && r.date === "2026-09-24" && r.title === "молоко"],
  ["привычка мазь раз в 2-3 вечером", (r) => r.ok && r.kind === "habit" && r.title === "мазь" && r.habit.everyMin === 2 && r.habit.everyMax === 3 && r.habit.anchor === "evening"],
  ["привычка мазь раз в два-три вечером", (r) => r.ok && r.kind === "habit" && r.habit.everyMin === 2 && r.habit.everyMax === 3 && r.habit.anchor === "evening" && r.title === "мазь"],
  ["мазь каждые 2-3 дня вечером", (r) => r.ok && r.kind === "habit" && r.habit.everyMin === 2 && r.habit.everyMax === 3 && r.title === "мазь"],
  ["каждый день витамин", (r) => r.ok && r.kind === "habit" && r.habit.everyMin === 1 && r.title === "витамин"],
  ["каждый пн спорт", (r) => r.ok && r.kind === "habit" && r.habit.weekday === 1 && r.habit.everyMin === 7 && r.date === "2026-09-28" && r.title === "спорт"],
  ["", (r) => !r.ok],
  ["купить", (r) => !r.ok],
  ["14", (r) => !r.ok]
];

cases.forEach(([text, check]) => {
  const parsed = P.parse(text, { today });
  ok(`parse «${text || "пусто"}»`, check(parsed), JSON.stringify(parsed));
});

const fromMonday = P.parse("след пн спорт", { today: monday });
ok("след пн shifts a week", fromMonday.ok && fromMonday.date === D.addDays(monday, 7) && fromMonday.title === "спорт", JSON.stringify(fromMonday));

const described = P.parse("завтра в 14 врач", { today });
ok("describe", P.describe(described, today).includes("завтра") && P.describe(described, today).includes("врач"));
function marked(text) {
  return P.marks(text).map((r) => text.slice(r.start, r.end));
}
ok("mark завтра and купить", marked("завтра купить молоко").indexOf("завтра") >= 0 && marked("завтра купить молоко").indexOf("купить") >= 0);
ok("mark в 14", marked("в 14 врач").indexOf("в 14") >= 0 && marked("в 14 врач").indexOf("врач") < 0);
ok("mark dangling в", marked("завтра в").indexOf("в") >= 0);
ok("завтрак is not a keyword", marked("завтрак дома").length === 0);
ok("купить inside a sentence stays plain", marked("надо купить молоко").indexOf("купить") < 0);

let habit = {
  everyMin: 2,
  everyMax: 3,
  weekday: null,
  anchor: "evening",
  timeMin: null,
  nextDue: today,
  lastDone: null,
  history: []
};
ok("due today", D.habitState(habit, today, today) === "open");
ok("not before", D.habitState(habit, "2026-09-22", today) === null);
habit = D.markHabitDone(habit, today);
ok("done shifts by min interval", habit.nextDue === "2026-09-25" && habit.lastDone === today);
ok("quiet the next day", D.habitState(habit, "2026-09-24", "2026-09-24") === null);
ok("opens on the early edge", D.habitState(habit, "2026-09-25", "2026-09-25") === "open");
ok("still in the window", D.habitState(habit, "2026-09-26", "2026-09-26") === "due");
ok("overdue after the window", D.habitState(habit, "2026-09-27", "2026-09-27") === "overdue");
ok("overdue is not copied onto tomorrow", D.habitState(habit, "2026-09-28", "2026-09-27") === null);
ok("rhythm shows ahead", D.habitState(habit, "2026-09-29", today) === "open");
const daily = { everyMin: 1, everyMax: 1, weekday: null, nextDue: today, history: [], lastDone: null };
ok("daily shows tomorrow", D.habitState(daily, "2026-09-24", today) === "open");
const undone = D.undoHabitDone(habit, today);
ok("undo completion", undone.nextDue === today && !undone.lastDone);

const weekly = { everyMin: 7, everyMax: 7, weekday: 1, nextDue: "2026-09-28", history: [], lastDone: null };
const moved = D.shiftHabit(weekly, 1, today);
ok("postpone moves the due day", moved.nextDue === "2026-09-29");
ok("weekly rhythm follows the new day", moved.weekday === D.dow("2026-09-29"));
const late = D.shiftHabit({ ...weekly, nextDue: "2026-09-20" }, 1, today);
ok("overdue postpone starts from today", late.nextDue === "2026-09-24");

const lanes = D.layoutLanes([
  { id: "a", startMin: 10 * 60, endMin: 11 * 60 },
  { id: "b", startMin: 10 * 60 + 30, endMin: 11 * 60 + 30 },
  { id: "c", startMin: 12 * 60, endMin: 13 * 60 }
]);
ok("overlap uses two lanes", lanes.find((x) => x.id === "a").lane !== lanes.find((x) => x.id === "b").lane);
ok("later block reuses a lane", lanes.find((x) => x.id === "c").lanes === 2);
ok("three timed tasks open the day", D.railMode([1, 2, 3], null) === "full");
ok("one timed task stays a row", D.railMode([1], null) === "list");
ok("explicit list wins", D.railMode([1, 2, 3, 4], { rail: "list" }) === "list");
const dayGrid = D.railBounds([], D.defaultSettings());
ok("grid is 6 to midnight", dayGrid.from === 6 * 60 && dayGrid.to === 24 * 60);
ok("work hours stay 11 to 20", D.defaultSettings().workStartMin === 11 * 60 && D.defaultSettings().workEndMin === 20 * 60);

const basket = D.errandsFor(
  [
    { id: "1", text: "молоко", done: false, order: 1 },
    { id: "2", text: "хлеб", done: false, from: "2026-09-24", order: 2 },
    { id: "3", text: "озон", done: true, doneOn: today, order: 3 }
  ],
  today
);
ok("basket is one list", basket.open.length === 2 && basket.doneToday.length === 1);
const carried = D.errandsFor(
  [
    { id: "1", text: "молоко", done: false, order: 1 },
    { id: "2", text: "хлеб", done: false, from: "2026-09-24", order: 2 },
    { id: "3", text: "озон", done: true, doneOn: today, order: 3 }
  ],
  "2026-09-24"
);
ok("basket carries to the next day", carried.open.length === 2 && carried.doneToday.length === 1);
const orders = [
  { id: "m", text: "молоко", tag: "buy", done: false, order: 1 },
  { id: "o", text: "озон", tag: "pickup", from: "2026-09-24", done: false, order: 2 }
];
ok("order waits until its day", D.errandsFor(orders, today).open.length === 1);
ok("order arrives on its day", D.errandsFor(orders, "2026-09-24").open.length === 2);
ok("order stays after its day", D.errandsFor(orders, "2026-09-25").open.some((e) => e.id === "o"));

async function roundtrip() {
  await DB.init();
  const task = await DB.putTask({
    id: "t1",
    kind: "loose",
    title: "отчёт",
    date: today,
    order: 1,
    done: false,
    createdAt: 1,
    updatedAt: 1
  });
  await DB.putErrand({ id: "e1", text: "молоко", tag: "buy", done: false, order: 1, createdAt: 1 });
  await DB.putHabit({
    id: "h1",
    title: "мазь",
    everyMin: 2,
    everyMax: 3,
    nextDue: today,
    history: [],
    createdAt: 1,
    updatedAt: 1
  });
  await DB.saveSettings({ workStartMin: 11 * 60, workEndMin: 20 * 60, seenLegend: true });
  await DB.saveDayMeta({ [today]: { went: true, rail: "list" } });
  const dump = await DB.exportAll();
  ok("export kit", dump.kit === "listok" && dump.tasks.length === 1 && dump.errands.length === 1 && dump.habits.length === 1);
  ok("task saved", task.title === "отчёт");
  await DB.wipe();
  ok("wipe", (await DB.listTasks()).length === 0 && (await DB.listHabits()).length === 0);
  const imported = await DB.importAll(dump, { merge: false });
  ok("import counts", imported.tasks === 1 && imported.errands === 1 && imported.habits === 1);
  ok("settings back", (await DB.getSettings()).workStartMin === 11 * 60);
  ok("day meta back", (await DB.getDayMetaAll())[today].went === true);
  try {
    await DB.importAll({ kit: "hours-private" });
    ok("reject foreign json", false);
  } catch (err) {
    ok("reject foreign json", /Planin/.test(err.message));
  }
}

roundtrip()
  .then(() => {
    console.log(failed ? `FAILED ${failed}` : "ALL PASSED");
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    ok("roundtrip", false, err.stack || err.message);
    console.log(`FAILED ${failed}`);
    process.exit(1);
  });
