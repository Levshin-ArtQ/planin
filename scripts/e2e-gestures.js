/**
 * QA: регрессии жестов на синтетических touch-событиях (Chromium и WebKit, эмуляция iPhone 14).
 * Запуск: node scripts/e2e-gestures.js [--strict]
 * Не заменяет реальный iPhone: системные жесты iOS (свайп «назад» от края, Home indicator) так не воспроизвести.
 * Проверяется: строка влево -> выполнено (остаётся на месте), строка вправо -> на завтра, лист влево -> следующий
 * день, свайп от левого края (x<28) не листает день (оставлен iOS «назад»), touchcancel посреди свайпа ничего не
 * меняет, горизонтальный свайп строки делает preventDefault (иначе iOS начнёт скролл), долгое нажатие -> меню.
 * Ручка (R-22/D-3): быстрое движение — прокрутка, удержание 170 мс — порядок (переживает перезагрузку), тап — выполнить.
 * Блоки расписания (D-10): touch-action pan-y, быстрая вертикаль не перехватывается, удержание — время, в сторону — как строка.
 */
const { staticServer, loadPlaywright, reporter, qaContext } = require("./qa-lib");

const T = reporter("e2e-gestures");
T.watchdog(+process.env.QA_WATCHDOG_MS || 9 * 60 * 1000, "браузер завис; см. Q-20");

// Синтетический жест внутри страницы: touchstart -> серия touchmove -> touchend|touchcancel.
async function swipe(page, from, to, { ms = 320, steps = 12, cancel = false, hold = 0 } = {}) {
  return page.evaluate(async ({ from, to, ms, steps, cancel, hold }) => {
    const target = document.elementFromPoint(from.x, from.y);
    if (!target) return { error: "no target" };
    const mk = (x, y) => new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 4, radiusY: 4, force: 1 });
    const fire = (type, x, y) => {
      const t = mk(x, y);
      const live = type === "touchend" || type === "touchcancel" ? [] : [t];
      const ev = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: live, targetTouches: live, changedTouches: [t] });
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const sleep = (n) => new Promise((r) => setTimeout(r, n));
    fire("touchstart", from.x, from.y);
    if (hold) await sleep(hold);
    let prevented = false;
    for (let i = 1; i <= steps; i += 1) {
      await sleep(ms / steps);
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      prevented = fire("touchmove", x, y) || prevented;
    }
    fire(cancel ? "touchcancel" : "touchend", to.x, to.y);
    return { prevented, target: target.className };
  }, { from, to, ms, steps, cancel, hold });
}

async function run() {
  const pw = loadPlaywright();
  if (!pw) {
    T.skip("жесты", "playwright не найден");
    return;
  }
  const srv = await staticServer();
  for (const engine of ["chromium", "webkit"]) {
    let browser;
    try {
      browser = await pw[engine].launch();
    } catch (e) {
      T.skip(engine, e.message.split("\n")[0]);
      continue;
    }
    const L = engine === "webkit" ? "WebKit/iPhone 14" : "Chromium/iPhone 14";
    const dev = { ...pw.devices["iPhone 14"] };
    if (engine === "chromium") delete dev.defaultBrowserType;
    const context = await qaContext(browser, dev);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(srv.origin + "/");
      await page.waitForSelector("#line");
      console.log(`   i ${L}: часы браузера ${await page.evaluate(() => new Date().toTimeString().slice(0, 5))} (QA_CLOCK / QA_REAL_CLOCK)`);
      // дождаться установки SW: на старых версиях первая установка перезагружала страницу (Q-11)
      await page.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForSelector("#line");
      const canTouch = await page.evaluate(() => { try { new TouchEvent("touchstart", { touches: [new Touch({ identifier: 1, target: document.body, clientX: 1, clientY: 1 })] }); return true; } catch (_) { return false; } });
      if (!canTouch) {
        T.skip(L, "конструктор Touch/TouchEvent недоступен");
        continue;
      }
      const add = async (t) => { await page.click("#line"); await page.keyboard.type(t, { delay: 15 }); await page.keyboard.press("Enter"); await page.waitForTimeout(300); };
      await add("альфа строка");
      await add("бета строка");
      await add("гамма строка");
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(700);
      const rowBox = async (title) => page.evaluate((t) => {
        const el = [...document.querySelectorAll("#sheet-cur .row")].find((r) => r.textContent.includes(t));
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, done: el.classList.contains("is-done") };
      }, title);
      const idb = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open("listok-private"); r.onsuccess = () => { const q = r.result.transaction("tasks").objectStore("tasks").getAll(); q.onsuccess = () => { res(q.result); r.result.close(); }; }; }));
      const W = await page.evaluate(() => innerWidth);

      // 1. строка влево -> выполнено
      let b = await rowBox("альфа строка");
      const r1 = await swipe(page, { x: b.x, y: b.y }, { x: b.x - 120, y: b.y });
      await page.waitForTimeout(700);
      let rows = await idb();
      const doneTask = rows.find((t) => t.title === "альфа строка");
      T.ok(`${L}: строка влево -> выполнено`, doneTask && doneTask.done, JSON.stringify(doneTask));
      T.ok(`${L}: горизонтальный свайп строки отменяет прокрутку (preventDefault в touchmove)`, r1.prevented, JSON.stringify(r1));
      b = await rowBox("альфа строка");
      T.ok(`${L}: выполненная строка остаётся в дне`, !!b);

      // 2. touchcancel посреди свайпа -> ничего не меняется
      b = await rowBox("гамма строка");
      await swipe(page, { x: b.x, y: b.y }, { x: b.x + 110, y: b.y }, { cancel: true });
      await page.waitForTimeout(600);
      rows = await idb();
      const today = rows.find((t) => t.title === "альфа строка").date;
      const c = rows.find((t) => t.title === "гамма строка");
      const tr = await page.evaluate(() => { const el = [...document.querySelectorAll("#sheet-cur .row")].find((r) => r.textContent.includes("гамма строка")); return el ? el.style.transform : "нет строки"; });
      T.ok(`${L}: touchcancel посреди свайпа — строка на месте, дата не изменилась`, c && c.date === today && !c.done && (!tr || tr === "none" || tr === "translateX(0px)"), `date=${c && c.date} transform=${tr}`);

      // 3. строка вправо -> на завтра
      b = await rowBox("бета строка");
      if (!b) throw new Error("нет строки «бета строка»; в листе: " + JSON.stringify(await page.$$eval("#sheet-cur .row", (els) => els.map((e) => e.textContent.trim()))) + " overlay=" + (await page.evaluate(() => !document.querySelector("#sheet-ui").hidden)));
      await swipe(page, { x: b.x - 40, y: b.y }, { x: b.x + 90, y: b.y }, { ms: 360 });
      await page.waitForTimeout(800);
      rows = await idb();
      const moved = rows.find((t) => t.title === "бета строка");
      const tomorrow = await page.evaluate((d) => { const [y, m, dd] = d.split("-").map(Number); const x = new Date(y, m - 1, dd + 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; }, today);
      T.ok(`${L}: строка вправо -> на завтра`, moved && moved.date === tomorrow, `date=${moved && moved.date}, ждали ${tomorrow}`);

      // 4. свайп от самого левого края -> день не листается (iOS «назад»)
      const head0 = await page.textContent("#kicker");
      const emptyY = await page.evaluate(() => { const s = document.querySelector("#sheet-cur").getBoundingClientRect(); return s.bottom - 40; });
      await swipe(page, { x: 10, y: emptyY }, { x: 200, y: emptyY });
      await page.waitForTimeout(700);
      T.ok(`${L}: свайп вправо от края экрана (x<28) не листает день`, (await page.textContent("#kicker")) === head0, `было «${head0}», стало «${await page.textContent("#kicker")}»`);

      // 5. лист влево -> следующий день
      await swipe(page, { x: W - 60, y: emptyY }, { x: 40, y: emptyY }, { ms: 250 });
      await page.waitForTimeout(900);
      const head1 = await page.textContent("#kicker");
      T.ok(`${L}: лист влево -> следующий день`, head1 !== head0 && /завтра/.test(head1), `«${head0}» -> «${head1}»`);
      await page.click("#date-hit");
      await page.waitForTimeout(600);

      // 6. долгое нажатие -> меню
      b = await rowBox("гамма строка");
      await swipe(page, { x: b.x, y: b.y }, { x: b.x + 1, y: b.y }, { hold: 600, steps: 1, ms: 20 });
      await page.waitForTimeout(400);
      const menu = await page.evaluate(() => document.querySelectorAll("#sheet-ui .menu-item").length);
      T.ok(`${L}: долгое нажатие на строку открывает меню`, menu > 0, `пунктов меню: ${menu}`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      if (await page.evaluate(() => document.querySelectorAll("#sheet-ui .menu-item").length)) { await page.mouse.click(5, 5); await page.waitForTimeout(300); }

      // 7–9. ручка (R-22, D-3): порядок — только после удержания 170 мс; быстрое движение — прокрутка; тап — выполнить
      await add("дельта строка");
      await add("эпсилон строка");
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(600);
      const order = () => page.$$eval("#sheet-cur .rows.plan .row .title", (e) => e.map((x) => x.textContent));
      const grip = (title) => page.evaluate((t) => {
        const el = [...document.querySelectorAll("#sheet-cur .row")].find((r) => r.textContent.includes(t));
        const g = el && el.querySelector(".grip");
        if (!g) return null;
        const b = g.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, h: el.getBoundingClientRect().height };
      }, title);
      const o0 = await order();
      let g = await grip("гамма строка");
      if (g) {
        const fast = await swipe(page, { x: g.x, y: g.y }, { x: g.x, y: g.y + g.h * 1.4 }, { ms: 120, steps: 8 });
        await page.waitForTimeout(600);
        const o1 = await order();
        rows = await idb();
        T.ok(`${L}: ручка — быстрое движение без удержания не меняет порядок и не выполняет (отдано прокрутке)`, JSON.stringify(o1) === JSON.stringify(o0) && !rows.find((t) => t.title === "гамма строка").done && !fast.prevented, `${JSON.stringify(o0)} -> ${JSON.stringify(o1)}, preventDefault=${fast.prevented}`);
        g = await grip("гамма строка");
        await swipe(page, { x: g.x, y: g.y }, { x: g.x, y: g.y + g.h * 1.4 }, { hold: 260, ms: 420, steps: 14 });
        await page.waitForTimeout(700);
        const o2 = await order();
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(700);
        const o3 = await order();
        const gi = (o) => o.indexOf("гамма строка");
        T.ok(`${L}: ручка — после удержания 170 мс строка перетаскивается вниз, порядок переживает перезагрузку (D-3, R-22)`, gi(o2) === gi(o0) + 1 && JSON.stringify(o3) === JSON.stringify(o2), `${JSON.stringify(o0)} -> ${JSON.stringify(o2)} -> после перезагрузки ${JSON.stringify(o3)}`);
        g = await grip("эпсилон строка");
        await swipe(page, { x: g.x, y: g.y }, { x: g.x, y: g.y }, { steps: 1, ms: 40 });
        await page.waitForTimeout(700);
        rows = await idb();
        T.ok(`${L}: тап по ручке выполняет дело сразу (R-22)`, !!(rows.find((t) => t.title === "эпсилон строка") || {}).done);
      } else T.skip(`${L}: ручка`, "нет .grip у строки");

      // (числительные словами в названии парсер превращает в цифры и время — Q-19, поэтому «север/юг/запад»)
      // 10. D-10: блоки расписания — touch-action: pan-y (вертикаль отдаётся прокрутке листа),
      // перетаскивание времени после удержания 170 мс и свайп в сторону — как у строки (R-1).
      // «сегодня …»: день назван — время не уходит на завтра при любом времени суток (146e385)
      for (const t of ["сегодня в 14 блок север", "сегодня в 16 блок юг", "сегодня в 18 блок запад"]) await add(t);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(800);
      const blk = (title) => page.evaluate((t) => {
        const el = [...document.querySelectorAll("#sheet-cur .block")].find((b) => b.textContent.includes(t));
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        // точка, где сверху именно этот блок (не кнопка/подпись поверх)
        for (let fy = 0.5; fy > 0.05; fy -= 0.1) {
          for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
            const x = b.left + b.width * fx;
            const y = b.top + Math.min(b.height * fy, 24);
            const hit = document.elementFromPoint(x, y);
            if (hit && hit.closest(".block") === el) return { x, y, ta: getComputedStyle(el).touchAction };
          }
        }
        return { covered: true, ta: getComputedStyle(el).touchAction, top: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.className };
      }, title);
      const task = async (t) => (await idb()).find((x) => x.title === t) || {};
      let k = await blk("блок север");
      if (k && k.covered) T.ok(`${L}: блоки расписания доступны для касания (D-10)`, false, `блок перекрыт: ${k.top}`);
      else if (k) {
        T.ok(`${L}: .block — touch-action: pan-y (D-10)`, /pan-y/.test(k.ta), k.ta);
        const flick = await swipe(page, { x: k.x, y: k.y }, { x: k.x, y: k.y - 90 }, { ms: 90, steps: 6 });
        await page.waitForTimeout(500);
        T.ok(`${L}: быстрый вертикальный свайп по блоку не перехватывается (без preventDefault, время не меняется)`, !flick.prevented && (await task("блок север")).startMin === 14 * 60, `preventDefault=${flick.prevented}, startMin=${(await task("блок север")).startMin}`);
        k = await blk("блок север");
        await swipe(page, { x: k.x, y: k.y }, { x: k.x, y: k.y + 48 }, { hold: 230, ms: 260, steps: 10 });
        await page.waitForTimeout(800);
        T.ok(`${L}: удержание 170 мс и вниз на час — время блока 14:00 -> 15:00 (D-10 не сломал перетаскивание)`, (await task("блок север")).startMin === 15 * 60, `startMin=${(await task("блок север")).startMin}`);
        k = await blk("блок юг");
        await swipe(page, { x: k.x + 40, y: k.y }, { x: k.x - 100, y: k.y }, { ms: 220 });
        await page.waitForTimeout(800);
        T.ok(`${L}: свайп блока влево -> выполнено (как у строки, R-1)`, !!(await task("блок юг")).done, JSON.stringify(await task("блок юг")));
        // 4ef2f7a/9255373: окно через полночь на ленте — перетаскивание на час вверх сдвигает окно целиком (длина та же)
        for (const t of ["сегодня с 22 до 7 блок смена", "сегодня с 23 до 1 блок дежурство"]) await add(t);
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.waitForTimeout(800);
        for (const [t, s0, e0] of [["блок смена", 22 * 60, 31 * 60], ["блок дежурство", 23 * 60, 25 * 60]]) {
          const before = await task(t);
          const kb = await blk(t);
          if (!kb || kb.covered || before.startMin !== s0 || before.endMin !== e0) { T.ok(`${L}: окно через полночь «${t}» на ленте для перетаскивания`, false, JSON.stringify({ kb, before })); continue; }
          await swipe(page, { x: kb.x, y: kb.y }, { x: kb.x, y: kb.y - 48 }, { hold: 230, ms: 260, steps: 10 });
          await page.waitForTimeout(800);
          const after = await task(t);
          if (t === "блок дежурство") {
            // и обратно вниз на два часа: начало остаётся в своём дне (≤ 23:45), длина 2 ч не обрезается по 24:00
            const kb2 = await blk(t);
            if (kb2 && !kb2.covered) {
              await swipe(page, { x: kb2.x, y: kb2.y }, { x: kb2.x, y: kb2.y + 96 }, { hold: 230, ms: 300, steps: 12 });
              await page.waitForTimeout(800);
              const down = await task(t);
              T.ok(`${L}: Q-25: «${t}» вниз на 2 часа — длина 2 ч сохраняется, начало ≤ 23:45, конец за полночь`, down.endMin - down.startMin === 120 && down.startMin >= 23 * 60 && down.startMin <= 23 * 60 + 45 && down.endMin > 24 * 60, `стало ${down.startMin}–${down.endMin}`);
            }
          }
          ((n, m) => T.ok(n, m[0], m[1]))(`${L}: Q-25 (4a90a62): «${t}» ${s0 / 60}–${(e0 / 60) % 24}: удержание и вверх на час → ${s0 / 60 - 1}–${(e0 / 60 - 1) % 24}, длина та же`, [after.startMin === s0 - 60 && after.endMin === e0 - 60, `было ${before.startMin}–${before.endMin}, стало ${after.startMin}–${after.endMin}`]);
        }
      } else {
        // не пропуск, а провал: без блоков D-10 не проверен (так было после 18:00 на 146e385 — «в 14» уходило на завтра)
        const where = await page.evaluate(() => [...document.querySelectorAll("#sheet-cur .row .title, #sheet-cur .block")].map((e) => e.textContent.trim()).slice(0, 8)).catch(() => []);
        const dates = (await idb()).filter((x) => /^блок /.test(x.title)).map((x) => `${x.title}: ${x.date} ${x.startMin}`);
        T.ok(`${L}: на дне есть блоки расписания для проверки D-10`, false, `блоков нет; на листе: ${JSON.stringify(where)}; в IndexedDB: ${JSON.stringify(dates)}; часы: ${new Date(await page.evaluate(() => Date.now())).toString().slice(0, 21)}`);
      }
      // 11. D-11: selectstart на текстовом узле строки — без TypeError, выделение запрещено
      const d11 = await page.evaluate(() => {
        const title = document.querySelector("#sheet-cur .row .title");
        const node = title && [...title.childNodes].find((n) => n.nodeType === 3);
        if (!node) return { skip: true };
        let err = null;
        const onErr = (e) => { err = e.message; };
        window.addEventListener("error", onErr);
        const ev = new Event("selectstart", { bubbles: true, cancelable: true });
        node.dispatchEvent(ev);
        const cm = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        node.dispatchEvent(cm);
        window.removeEventListener("error", onErr);
        return { prevented: ev.defaultPrevented, err };
      });
      await page.waitForTimeout(100);
      if (d11.skip) T.skip(`${L}: D-11`, "нет текстового узла в строке");
      else T.ok(`${L}: selectstart/contextmenu на текстовом узле строки — без TypeError, выделение запрещено (D-11)`, !d11.err && d11.prevented && !errors.some((e) => /closest/.test(e)), JSON.stringify(d11));

      // 12. R-29: тап по пустому месту под строками фокусирует строку ввода
      const space = await page.evaluate(() => {
        const el = document.querySelector("#sheet-cur .tail-space");
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 30) };
      });
      if (space) {
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.touchscreen.tap(space.x, space.y);
        await page.waitForTimeout(300);
        T.ok(`${L}: тап по пустому месту под строками — фокус в строке ввода (R-29)`, await page.evaluate(() => document.activeElement && document.activeElement.id === "line"), await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className)));
      } else T.skip(`${L}: R-29`, "нет .tail-space");

      // 13. R-31: незакрытое дело с прошлого дня — плашка «с прошлых дней», свайп вправо — всё в сегодня
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      const past = await page.evaluate(async () => {
        const D = window.ListokDay;
        const date = D.addDays(D.todayKey(), -2);
        await window.ListokDB.putTask({ id: window.ListokDB.id("t"), date, kind: "loose", title: "хвост прошлого", startMin: null, endMin: null, order: 1, createdAt: Date.now() });
        return date;
      });
      await page.reload();
      await page.waitForSelector("#line");
      await page.waitForTimeout(700);
      const plate = await page.evaluate(() => {
        const el = document.querySelector("#sheet-cur .tail-plate");
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, text: el.textContent.replace(/\s+/g, " ").trim() };
      });
      T.ok(`${L}: незакрытое с прошлых дней — плашка «с прошлых дней · N» на сегодня (R-31)`, !!plate && /с прошлых дней · 1/.test(plate.text), JSON.stringify(plate));
      if (plate) {
        await swipe(page, { x: plate.x - 60, y: plate.y }, { x: plate.x + 90, y: plate.y }, { ms: 300 });
        await page.waitForTimeout(900);
        const moved = (await idb()).find((t) => t.title === "хвост прошлого") || {};
        const todayKey = await page.evaluate(() => window.ListokDay.todayKey());
        T.ok(`${L}: свайп плашки вправо — дело из прошлого в сегодня (R-31)`, moved.date === todayKey, `было ${past}, стало ${moved.date}`);
      }
      T.ok(`${L}: без JS-ошибок`, errors.length === 0, errors.join(" | "));
      // 14. D-12: MediaQueryList без addEventListener (iOS < 14) — приложение запускается
      const c12 = await qaContext(browser, dev);
      await c12.addInitScript(() => {
        if (window.MediaQueryList) { delete MediaQueryList.prototype.addEventListener; MediaQueryList.prototype.addEventListener = undefined; }
      });
      const p12 = await c12.newPage();
      const e12 = [];
      p12.on("pageerror", (e) => e12.push(e.message));
      await p12.goto(srv.origin + "/");
      const ok12 = await p12.waitForSelector("#line", { timeout: 8000 }).then(() => true, () => false);
      T.ok(`${L}: без MediaQueryList.addEventListener (iOS < 14) приложение открывается без ошибок (D-12)`, ok12 && e12.length === 0, e12.join(" | "));
      await c12.close();
    } catch (e) {
      T.ok(`${L}: сценарий без исключений`, false, e.message.split("\n")[0]);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await srv.close();
}

run().then(() => process.exit(T.summary())).catch((e) => { console.error(e); process.exit(1); });
