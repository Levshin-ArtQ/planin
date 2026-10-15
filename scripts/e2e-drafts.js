/**
 * QA: черновики строки ввода (R-15, localStorage "planin:drafts") — безопасность и устойчивость.
 * Запуск: node scripts/e2e-drafts.js [--strict]   (QA_ROOT=/путь — прогон на другой копии)
 * Chromium и WebKit/iPhone 14:
 *  1. XSS-payload, набранный в строке, переживает перезагрузку как текст (без выполнения);
 *  2. подменённый localStorage: payload в черновике сегодня, прошлого дня и «припаркованном» (~id), мусорный caret;
 *  3. битый/чужой JSON в planin:drafts ("{", "[]", "null", "\"x\"", число) — приложение открывается, ввод работает,
 *     ключ снова становится корректным объектом;
 *  4. ключ не растёт: 12 записей подряд (Enter) и набор+стирание не оставляют хвостов.
 *  5. шторка правки (edit:<id>): набранное переживает перезагрузку без закрытия шторки, ключ снимается;
 *  6. подменённый edit:<id> с XSS-payload — текст, без выполнения; edit:<несуществующий id> не копится;
 *  7. «отмена» у тоста «вписано» возвращает текст в строку, он переживает перезагрузку и вписывается один раз;
 *  8. обновление SW при открытой шторке правки не перезагружает и не теряет набранное; после закрытия — тост.
 * Без Playwright — SKIP и exit 0.
 */
const fs = require("fs");
const path = require("path");
const { ROOT, staticServer, loadPlaywright, reporter, qaContext } = require("./qa-lib");
const SW1 = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const APP1 = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");

const T = reporter("e2e-drafts");
T.watchdog(+process.env.QA_WATCHDOG_MS || 9 * 60 * 1000, "браузер завис; см. Q-20");
const KEY = "planin:drafts";
// R-38 (cd3c492): правка прямо в строке по тапу — распознаём по сборке, чтобы тест шёл и на старых снимках
const INLINE = (() => { try { return /function startInline\(/.test(fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8")); } catch { return false; } })();
const PAY = ["<img src=x onerror=window.__xss=1>", "\"><svg onload=window.__xss=2>", "<script>window.__xss=3</script>"];

async function run() {
  const pw = loadPlaywright();
  if (!pw || process.argv.includes("--no-browser")) return T.skip("браузерные проверки", "playwright не найден или --no-browser");
  const srv = await staticServer({ root: ROOT });
  for (const engine of ["chromium", "webkit"]) {
    const L = engine === "webkit" ? "WebKit/iPhone 14" : "Chromium";
    const browser = await pw[engine].launch();
    try {
      const ctx = await qaContext(browser, engine === "webkit" ? { ...pw.devices["iPhone 14"] } : {});
      const page = await ctx.newPage();
      const errors = [];
      let dialogs = 0;
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => { dialogs += 1; d.dismiss().catch(() => {}); });
      const xss = () => page.evaluate(() => window.__xss || 0);
      const today = () => page.evaluate(() => window.ListokDay.todayKey());
      const clearLine = async () => {
        await page.click("#line");
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(500);
      };
      // Подмена ключа: с не-приложения того же origin (manifest.json), иначе pagehide приложения перезапишет ключ
      // текущим (пустым) черновиком, и подмена до приложения не дойдёт.
      const setLS = async (value) => {
        await page.goto(srv.origin + "/manifest.json");
        await page.evaluate(({ KEY, value }) => (value == null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, value)), { KEY, value });
        await page.goto(srv.origin + "/");
        await page.waitForSelector("#line", { timeout: 8000 });
      };
      await page.goto(srv.origin + "/");
      await page.waitForSelector("#line");

      // 1. набранный payload
      for (const p of PAY) {
        await page.click("#line");
        await page.keyboard.type(p, { delay: 10 });
        await page.waitForTimeout(600); // черновик пишется с задержкой 300 мс
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(300);
        const line = await page.textContent("#line");
        T.ok(`${L}: черновик «${p.slice(0, 22)}…» после перезагрузки — текст, без выполнения`, line === p && (await xss()) === 0 && dialogs === 0, `строка «${line}», __xss=${await xss()}`);
        await clearLine();
      }

      // 2. подменённый localStorage
      const t = await today();
      const past = await page.evaluate((k) => window.ListokDay.addDays(k, -3), t);
      await setLS(JSON.stringify({
        [t]: { id: "t_qa1", text: PAY[0], caret: 99999 },
        [past]: { id: "t_qa2", text: PAY[1], caret: "abc" },
        "~t_qa3": { id: "t_qa3", text: PAY[2], day: past, pending: true },
        "<img src=x onerror=window.__xss=4>": { text: PAY[0] },
        junk: 5, shop: { text: 7 }
      }));
      await page.waitForTimeout(600);
      const shown = await page.evaluate(() => ({ line: document.querySelector("#line").textContent, drafts: [...document.querySelectorAll(".row.draft .title")].map((e) => e.textContent), imgs: document.querySelectorAll("#app img, #app svg[onload], #app script").length }));
      T.ok(`${L}: подменённые черновики (сегодня, прошлый день, ~id, ключ-payload, мусор) не выполняют код`, (await xss()) === 0 && dialogs === 0 && shown.imgs === 0, JSON.stringify({ xss: await xss(), shown }));
      T.ok(`${L}: черновик сегодня встал в строку как текст (мусорный caret не ломает)`, shown.line === PAY[0], JSON.stringify(shown));
      T.ok(`${L}: черновик прошлого дня виден строкой как текст`, shown.drafts.some((x) => x.includes(PAY[1]) || x.includes(PAY[2])), JSON.stringify(shown.drafts));
      T.ok(`${L}: нет JS-ошибок на подменённых черновиках`, errors.length === 0, errors.slice(0, 2).join(" | "));
      await clearLine();
      await setLS(null);

      // 3. битый JSON
      for (const raw of ["{", "[]", "null", "\"x\"", "42", "{\"a\":"]) {
        errors.length = 0;
        const opened = await setLS(raw).then(() => true, () => false);
        await page.click("#line").catch(() => {});
        await page.keyboard.type("после битого", { delay: 10 });
        await page.waitForTimeout(600);
        const after = await page.evaluate((KEY) => { try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v === "object" && !Array.isArray(v) ? "object" : typeof v; } catch { return "broken"; } }, KEY);
        const line = await page.textContent("#line").catch(() => "");
        T.ok(`${L}: planin:drafts = ${raw} — приложение открывается, ввод работает, ключ снова объект`, opened && line === "после битого" && after === "object" && errors.length === 0, JSON.stringify({ opened, line, after, errors: errors.slice(0, 1) }));
        await clearLine();
      }

      // 4. рост ключа
      await setLS(null);
      for (let i = 0; i < 12; i += 1) {
        await page.click("#line");
        await page.keyboard.type(`дело номер ${i}`, { delay: 5 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(800);
      await page.click("#line");
      await page.keyboard.type("набрал и стёр", { delay: 5 });
      await page.waitForTimeout(500);
      await clearLine();
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(500);
      const size = await page.evaluate((KEY) => ({ raw: localStorage.getItem(KEY) || "" }), KEY);
      const keys = (() => { try { return Object.keys(JSON.parse(size.raw || "{}")); } catch { return ["broken"]; } })();
      T.ok(`${L}: после 12 записей и «набрал-стёр» в planin:drafts не остаётся хвостов (~id, пустых дней)`, keys.length === 0, `${size.raw.length} байт: ${size.raw.slice(0, 200)}`);
      const rows = await page.$$eval(".row .title", (e) => e.map((x) => x.textContent));
      T.ok(`${L}: все 12 записей на месте, без дублей`, [...Array(12)].every((_, i) => rows.filter((r) => r === `дело номер ${i}`).length === 1), JSON.stringify(rows));

      // 5. шторка правки
      const rowTitles = () => page.$$eval("#sheet-cur .row .title", (e) => e.map((x) => x.textContent));
      const openEdit = async (title) => {
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.waitForTimeout(300);
        // R-38 (cd3c492): тап по тексту дела без времени правит прямо в строке — шторку открывает «править» в меню
        // (долгое нажатие). До R-38 тап открывал шторку сразу.
        const el = page.locator(`#sheet-cur .row .title >> text=${title}`).first();
        if (INLINE) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(300);
          const b = await el.boundingBox();
          await page.mouse.move(b.x + 10, b.y + b.height / 2);
          await page.mouse.down();
          await page.waitForTimeout(700);
          await page.mouse.up();
          await page.waitForSelector('#sheet-ui [data-act="menu-edit"]', { timeout: 4000 });
          await page.waitForTimeout(600); // после долгого нажатия клики 400 мс глотаются (swallowClick) — как у пальца
          await page.click('#sheet-ui [data-act="menu-edit"]');
        } else await el.click();
        await page.waitForSelector("#sheet-title", { timeout: 4000 });
        await page.waitForTimeout(300);
      };
      const retitle = async (text) => {
        await page.fill("#sheet-title", "");
        await page.click("#sheet-title");
        await page.keyboard.type(text, { delay: 10 });
      };
      await setLS(null);
      await page.click("#line");
      await page.keyboard.type("правка старая", { delay: 10 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      await openEdit("правка старая");
      await retitle("правка новая");
      await page.reload();
      await page.waitForSelector("#line");
      await page.waitForTimeout(700);
      const e1 = { rows: await rowTitles(), toast: await page.evaluate(() => !document.querySelector("#toast").hidden && document.querySelector("#toast-text").textContent), keys: await page.evaluate((KEY) => Object.keys(JSON.parse(localStorage.getItem(KEY) || "{}")), KEY) };
      T.ok(`${L}: правка в шторке переживает перезагрузку без закрытия (тост «правка восстановлена»)`, e1.rows.includes("правка новая") && !e1.rows.includes("правка старая") && /восстановлен/.test(String(e1.toast)), JSON.stringify(e1));
      T.ok(`${L}: после восстановления правки ключ edit:<id> снят`, !e1.keys.some((k) => k.startsWith("edit:")), JSON.stringify(e1.keys));
      T.ok(`${L}: восстановленная правка не создала дубль`, e1.rows.filter((r) => r === "правка новая").length === 1, JSON.stringify(e1.rows));

      // 5b. R-38 (cd3c492): правка прямо в строке — тап по тексту, тот же разбор, Enter/тап мимо сохраняет, Escape отменяет
      if (INLINE) {
        const idbTask = (re) => page.evaluate(async (src) => { const all = await window.ListokDB.listTasks(); const x = all.find((y) => new RegExp(src).test(y.title)); return x ? { id: x.id, title: x.title, kind: x.kind, s: x.startMin, e: x.endMin, date: x.date } : null; }, re);
        const tapTitle = async (title) => {
          await page.evaluate(() => document.activeElement && document.activeElement.blur());
          await page.waitForTimeout(300);
          await page.click(`#sheet-cur .row .title >> text=${title}`);
          await page.waitForTimeout(400);
          return page.evaluate(() => { const a = document.activeElement; return { inline: !!document.querySelector("#sheet-cur .row.is-inline"), focused: !!(a && a.dataset && a.dataset.inline === "1"), sheet: !!document.querySelector("#sheet-title") && !document.querySelector("#sheet-ui").hidden, bar: [...document.querySelectorAll(".inline-bar .inline-chip")].map((c) => c.textContent) }; });
        };
        const replaceText = async (text) => {
          await page.evaluate(() => { const a = document.activeElement; const r = document.createRange(); r.selectNodeContents(a); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
          await page.keyboard.type(text, { delay: 10 });
        };
        await page.click("#line");
        await page.keyboard.type("инлайн дело", { delay: 10 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(600);
        const i0 = await tapTitle("инлайн дело");
        T.ok(`${L}: R-38 тап по тексту дела без времени — правка в строке (поле в фокусе, чипы), шторка не открывается`, i0.inline && i0.focused && !i0.sheet && i0.bar.includes("завтра") && i0.bar.includes("удалить"), JSON.stringify(i0));
        await replaceText(`инлайн ${PAY[0]} в 16`);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(800);
        const i1 = { db: await idbTask("^инлайн"), xss: await xss(), dialogs, rows: await rowTitles(), inline: await page.evaluate(() => !!document.querySelector(".row.is-inline, .inline-bar")) };
        T.ok(`${L}: R-38 «… в 16» + Enter: в IndexedDB название с HTML как текст и 16:00, строка снова обычная, код не выполняется`, !!i1.db && i1.db.title === `инлайн ${PAY[0]}` && i1.db.kind === "slot" && i1.db.s === 960 && i1.xss === 0 && i1.dialogs === 0 && i1.rows.includes(`инлайн ${PAY[0]}`) && !i1.inline, JSON.stringify(i1));
        // Escape — отмена: ни текст, ни время не меняются
        const i2a = await tapTitle("инлайн");
        await replaceText(`испорчено ${PAY[1]} в 18`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(700);
        const i2 = { tapped: i2a.inline && !i2a.sheet, db: await idbTask("^инлайн|^испорчено"), rows: await rowTitles(), xss: await xss() };
        T.ok(`${L}: R-38 Escape отменяет правку в строке (IndexedDB и строка как были)`, i2.tapped && !!i2.db && i2.db.title === `инлайн ${PAY[0]}` && i2.db.s === 960 && !i2.rows.some((r) => /испорчено/.test(r)) && i2.xss === 0, JSON.stringify(i2));
        // тап мимо сохраняет (R-15: не теряем); дело с часом тоже правится в строке, время остаётся
        const i3a = await tapTitle("инлайн");
        await replaceText(`инлайн правка ${PAY[2]}`);
        await page.mouse.click(5, 5);
        await page.waitForTimeout(900);
        const i3 = { tapped: i3a.inline && !i3a.sheet, db: await idbTask("^инлайн"), rows: await rowTitles(), xss: await xss(), dialogs };
        T.ok(`${L}: R-38 дело с часом: тап мимо сохраняет новый текст, время 16:00 остаётся, <script> — текст`, i3.tapped && !!i3.db && i3.db.title === `инлайн правка ${PAY[2]}` && i3.db.s === 960 && i3.rows.filter((r) => r === `инлайн правка ${PAY[2]}`).length === 1 && i3.xss === 0 && i3.dialogs === 0, JSON.stringify(i3));
        // R-15 для правки в строке: уход в фон и перезагрузка посреди правки (iOS выгружает PWA из фона)
        await tapTitle("инлайн правка");
        // каретка в конец через Range: End в WebKit — конец видимой строки, а название переносится
        await page.evaluate(() => { const a = document.activeElement; const r = document.createRange(); r.selectNodeContents(a); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
        await page.keyboard.type(" дописано", { delay: 10 });
        await page.waitForTimeout(400);
        await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
        await page.reload();
        await page.waitForSelector("#line");
        await page.waitForTimeout(1000);
        const i5 = { db: await idbTask("^инлайн"), rows: await rowTitles(), xss: await xss() };
        T.ok(`${L}: R-38 правка в строке переживает уход в фон и перезагрузку (как шторка, R-15; Q-30 исправлено в 5a14a17)`, !!i5.db && /дописано$/.test(i5.db.title) && i5.xss === 0, JSON.stringify(i5));
        const i4 = await page.evaluate((KEY) => Object.keys(JSON.parse(localStorage.getItem(KEY) || "{}")), KEY);
        T.ok(`${L}: R-38 после правки в строке в planin:drafts не остаётся хвостов`, !i4.some((k) => k.startsWith("edit:")), JSON.stringify(i4));
      }

      // 6. подменённый edit:<id>
      const tid = await page.evaluate(async () => { const all = await window.ListokDB.listTasks(); const t = all.find((x) => x.title === "правка новая"); return t && t.id; }).catch(() => null);
      if (tid) {
        await setLS(JSON.stringify({
          [`edit:${tid}`]: { kind: "task", id: tid, title: PAY[0], at: Date.now(), taskKind: "slot", startMin: "<b>", endMin: {}, date: t },
          "edit:t_nope_1": { kind: "task", id: "t_nope_1", title: "удалённая", at: 1, date: t },
          "edit:h_nope": { kind: "habit", id: "h_nope", title: PAY[1] },
          "edit:y": "мусор"
        }));
        await page.waitForTimeout(700);
        const e2 = { xss: await xss(), rows: await rowTitles(), keys: await page.evaluate((KEY) => Object.keys(JSON.parse(localStorage.getItem(KEY) || "{}")), KEY), errors: errors.slice(0, 2) };
        T.ok(`${L}: подменённый edit:<id> с payload — текст, без выполнения`, e2.xss === 0 && dialogs === 0 && e2.rows.includes(PAY[0]), JSON.stringify(e2));
        T.ok(`${L}: edit:<id> удалённых/несуществующих задач и привычек не копятся после запуска`, !e2.keys.includes("edit:t_nope_1") && !e2.keys.includes("edit:h_nope") && !e2.keys.includes(`edit:${tid}`), JSON.stringify(e2.keys));
        T.bug("Q-18", `${L}: битое значение edit:<id> (не объект) снимается при запуске, а не живёт вечно`, !e2.keys.includes("edit:y"), JSON.stringify(e2.keys));
        const bad = await page.evaluate(async (id) => { const all = await window.ListokDB.listTasks(); const x = all.find((y) => y.id === id); return x ? { kind: x.kind, s: x.startMin, e: x.endMin } : null; }, tid);
        T.bug("Q-18", `${L}: мусорное время в edit:<id> не записано в задачу (типы из planin:drafts не проверяются)`, bad && (bad.s === null || Number.isFinite(bad.s)) && (bad.e === null || Number.isFinite(bad.e)), JSON.stringify(bad));
      } else T.skip(`${L}: подмена edit:<id>`, "не удалось прочитать id задачи через ListokDB");
      await setLS(null);

      // 7. «отмена» после «вписано»
      await page.click("#line");
      await page.keyboard.type("верну отменой", { delay: 10 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const undoVisible = await page.isVisible("#toast-undo").catch(() => false);
      if (undoVisible) await page.click("#toast-undo");
      await page.waitForTimeout(600);
      const u1 = { line: await page.textContent("#line"), rows: await rowTitles() };
      T.ok(`${L}: «отмена» у «вписано» возвращает текст в строку и убирает задачу`, undoVisible && u1.line === "верну отменой" && !u1.rows.includes("верну отменой"), JSON.stringify({ undoVisible, ...u1 }));
      await page.reload();
      await page.waitForSelector("#line");
      await page.waitForTimeout(500);
      const u2 = await page.textContent("#line");
      T.ok(`${L}: текст после «отмены» переживает перезагрузку`, u2 === "верну отменой", `строка «${u2}»`);
      await page.click("#line");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      await page.reload();
      await page.waitForSelector("#line");
      await page.waitForTimeout(500);
      const u3 = await rowTitles();
      T.ok(`${L}: после «отмены» и повторного Enter задача ровно одна`, u3.filter((r) => r === "верну отменой").length === 1, JSON.stringify(u3));

      // 8. обновление SW при открытой шторке правки
      await page.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready);
      await openEdit("верну отменой");
      await retitle("правлю при обновлении");
      srv.state.overrides["sw.js"] = SW1.replace(/const CACHE = "[^"]+"/, 'const CACHE = "listok-qa-drafts-2"');
      srv.state.overrides["js/app.js"] = `${APP1}\n;window.__QA_BUILD = 2;\n`;
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.update())).catch(() => {});
      await page.waitForTimeout(2500);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(1500);
      const s1 = await page.evaluate(() => ({ build: window.__QA_BUILD || 1, field: document.querySelector("#sheet-title") && document.querySelector("#sheet-title").value }));
      T.ok(`${L}: обновление SW при открытой шторке не перезагружает и не теряет набранное`, s1.build === 1 && s1.field === "правлю при обновлении", JSON.stringify(s1));
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      if (await page.isVisible("#sheet-title").catch(() => false)) await page.mouse.click(5, 5);
      await page.waitForTimeout(800);
      const s2 = await page.evaluate(() => ({ toast: !document.querySelector("#toast").hidden && document.querySelector("#toast-text").textContent, rows: [...document.querySelectorAll("#sheet-cur .row .title")].map((e) => e.textContent) }));
      T.ok(`${L}: после закрытия шторки правка записана и показан тост «Planin обновился»`, s2.rows.includes("правлю при обновлении") && /обновил/.test(String(s2.toast)), JSON.stringify(s2));
      if (await page.isVisible("#toast-update").catch(() => false)) await page.click("#toast-update");
      await page.waitForTimeout(2500);
      const s3 = await page.evaluate(() => ({ build: window.__QA_BUILD || 1, rows: [...document.querySelectorAll("#sheet-cur .row .title")].map((e) => e.textContent) })).catch((e) => ({ err: e.message }));
      T.ok(`${L}: «обновить» применяет версию, правка на месте`, s3.build === 2 && s3.rows.includes("правлю при обновлении"), JSON.stringify(s3));
      delete srv.state.overrides["sw.js"];
      delete srv.state.overrides["js/app.js"];
      await ctx.close();

      // 9. batch10 (R-38): чипы пальцем (P1-1), шторка без жестов (P1-3), отказ записи (P1-4 / Q-31).
      // Отдельный контекст iPhone 14 (390×844, касания) в обоих движках — как у Dev (touchscreen.tap).
      if (INLINE && /data-act="row-actions"|row-actions/.test(APP1)) {
        const tctx = await qaContext(browser, { ...pw.devices["iPhone 14"] });
        const tp = await tctx.newPage();
        const terr = [];
        let tdlg = 0;
        tp.on("pageerror", (e) => terr.push(e.message));
        tp.on("dialog", (d) => { tdlg += 1; d.dismiss().catch(() => {}); });
        await tp.goto(srv.origin + "/");
        await tp.waitForSelector("#line");
        await tp.waitForTimeout(800);
        const tapEl = async (sel) => { const b = await tp.locator(sel).first().boundingBox(); if (!b) return false; await tp.touchscreen.tap(b.x + Math.min(20, b.width / 2), b.y + b.height / 2); return true; };
        const titleSel = (t) => `#sheet-cur .row .title >> text=${t}`;
        const add = async (text) => { await tp.click("#line"); await tp.keyboard.type(text, { delay: 5 }); await tp.keyboard.press("Enter"); await tp.waitForTimeout(500); await tp.evaluate(() => document.activeElement && document.activeElement.blur()); await tp.waitForTimeout(300); };
        const dbT = (title) => tp.evaluate(async (t) => { const x = (await window.ListokDB.listTasks()).find((y) => y.title === t); return x ? { id: x.id, kind: x.kind, s: x.startMin, date: x.date } : null; }, title);
        const toast = () => tp.evaluate(() => ({ text: !document.querySelector("#toast").hidden && document.querySelector("#toast-text").textContent, undo: !document.querySelector("#toast-undo").hidden && document.querySelector("#toast-undo").textContent }));
        const sheetOpen = () => tp.evaluate(() => { const f = document.querySelector("#sheet-title"); return { sheet: !!f && !document.querySelector("#sheet-ui").hidden, value: f ? f.value : null, inline: !!document.querySelector(".row.is-inline") }; });
        const closeSheet = async () => { await tp.keyboard.press("Escape").catch(() => {}); await tp.waitForTimeout(400); if ((await sheetOpen()).sheet) { await tp.touchscreen.tap(5, 5); await tp.waitForTimeout(400); } };
        const today = await tp.evaluate(() => window.ListokDay.todayKey());
        const tomorrow = await tp.evaluate(() => window.ListokDay.addDays(window.ListokDay.todayKey(), 1));
        const nowMin = await tp.evaluate(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });

        // P1-1 (16874f2): чип «+1 ч» и «завтра» пальцем
        await add("позвонить маме");
        await tapEl(titleSel("позвонить маме"));
        await tp.waitForTimeout(400);
        const chips = await tp.evaluate(() => [...document.querySelectorAll(".inline-chip")].map((c) => c.textContent));
        await tapEl('.inline-chip[data-inline="hour"]');
        await tp.waitForTimeout(800);
        const h1 = { chips, db: await dbT("позвонить маме"), toast: await toast() };
        const want = Math.min(23 * 60 + 45, Math.ceil((nowMin + 60) / 15) * 15);
        T.ok(`${L}: batch10 P1-1: касание по чипу «+1 ч» ставит время (IndexedDB: slot ≈ сейчас + 1 ч) и тост «исправлено»`, !!h1.db && h1.db.kind === "slot" && Math.abs(h1.db.s - want) <= 15 && /исправлено/.test(String(h1.toast.text)), JSON.stringify({ ...h1, want }));
        await tapEl(titleSel("позвонить маме"));
        await tp.waitForTimeout(400);
        await tapEl('.inline-chip[data-inline="tomorrow"]');
        await tp.waitForTimeout(800);
        const h2 = { db: await dbT("позвонить маме"), toast: await toast() };
        T.ok(`${L}: batch10 P1-1: касание по чипу «завтра» переносит дело на завтра (IndexedDB) и тост «исправлено»`, !!h2.db && h2.db.date === tomorrow && /исправлено/.test(String(h2.toast.text)), JSON.stringify(h2));

        // P1-3 (58c7686): шторка без жестов
        await add("шторка дело");
        await tapEl(titleSel("шторка дело"));
        await tp.waitForTimeout(400);
        await tp.evaluate(() => { const a = document.activeElement; const r = document.createRange(); r.selectNodeContents(a); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
        await tp.keyboard.type(" дописано", { delay: 10 });
        const firstChip = await tp.evaluate(() => { const c = document.querySelector(".inline-chip"); return c && c.dataset.inline; });
        await tapEl('.inline-chip[data-inline="more"]');
        await tp.waitForTimeout(900);
        const m1 = { firstChip, ...(await sheetOpen()), db: await dbT("шторка дело дописано") };
        T.ok(`${L}: batch10 P1-3: первый чип «ещё…» — шторка, в #sheet-title набранное с дописанным, правка записана`, m1.firstChip === "more" && m1.sheet && m1.value === "шторка дело дописано" && !m1.inline && !!m1.db, JSON.stringify(m1));
        await closeSheet();
        const T2 = "шторка дело дописано";
        const ways = [
          ["фокус + Enter", async () => { await tp.locator(titleSel(T2)).first().focus(); await tp.keyboard.press("Enter"); }],
          ["фокус + пробел", async () => { await tp.locator(titleSel(T2)).first().focus(); await tp.keyboard.press(" "); }],
          ["el.click() без координат", async () => { await tp.evaluate((t) => { const e = [...document.querySelectorAll("#sheet-cur .row .title")].find((x) => x.textContent === t); e.click(); }, T2); }],
          ["Shift+F10", async () => { await tp.locator(titleSel(T2)).first().focus(); await tp.keyboard.press("Shift+F10"); }],
          ["ContextMenu", async () => { await tp.locator(titleSel(T2)).first().focus(); await tp.keyboard.press("ContextMenu"); }],
          ["правая кнопка мыши", async () => { await tp.locator(titleSel(T2)).first().click({ button: "right" }); }],
          [".row-actions click()", async () => { await tp.evaluate((t) => { const r = [...document.querySelectorAll("#sheet-cur .row")].find((x) => (x.querySelector(".title") || {}).textContent === t); r.querySelector(".row-actions").click(); }, T2); }],
        ];
        for (const [name, how] of ways) {
          await tp.evaluate(() => document.activeElement && document.activeElement.blur());
          await tp.waitForTimeout(300);
          let err = null;
          await how().catch((e) => { err = e.message.split("\n")[0]; });
          await tp.waitForTimeout(700);
          const r = await sheetOpen();
          T.ok(`${L}: batch10 P1-3: ${name} на деле — шторка (#sheet-title), не правка на месте`, !err && r.sheet && r.value === T2 && !r.inline, JSON.stringify({ err, ...r }));
          await closeSheet();
        }
        const ra = await tp.evaluate(() => { const b = document.querySelector("#sheet-cur .row-actions"); return b ? { tab: b.tabIndex, label: b.getAttribute("aria-label"), size: [b.getBoundingClientRect().width, b.getBoundingClientRect().height] } : null; });
        T.ok(`${L}: batch10 P1-3: .row-actions — вне Tab (tabindex -1), aria-label «действия: …», пальцем не видна (sr-only)`, !!ra && ra.tab === -1 && /^действия: /.test(ra.label) && ra.size[0] <= 2 && ra.size[1] <= 2, JSON.stringify(ra));

        // P1-4 (f560403) / Q-31: отказ записи
        const failPut = (on) => tp.evaluate((flag) => {
          if (flag) { window.__qaPut = window.__qaPut || IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException("quota", "QuotaExceededError"); }; }
          else if (window.__qaPut) IDBObjectStore.prototype.put = window.__qaPut;
        }, on);
        const edits = () => tp.evaluate((KEY) => { const all = JSON.parse(localStorage.getItem(KEY) || "{}"); return Object.values(all).filter((v) => v && v.inline).map((v) => v.title); }, KEY);
        await add("отказ записи");
        await tapEl(titleSel("отказ записи"));
        await tp.waitForTimeout(400);
        await tp.evaluate(() => { const a = document.activeElement; const r = document.createRange(); r.selectNodeContents(a); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
        await tp.keyboard.type(" раз", { delay: 10 });
        await failPut(true);
        await tp.keyboard.press("Enter");
        await tp.waitForTimeout(800);
        const f1 = { toast: await toast(), edits: await edits() };
        await failPut(false);
        T.ok(`${L}: batch10 P1-4: Enter при отказе записи — тост «не сохранилось · повторить», набранное в edit:<id>`, /не сохранилось/.test(String(f1.toast.text)) && f1.toast.undo === "повторить" && f1.edits.includes("отказ записи раз"), JSON.stringify(f1));
        await tapEl("#toast-undo");
        await tp.waitForTimeout(800);
        const f1b = { db: await dbT("отказ записи раз"), toast: await toast(), edits: await edits() };
        T.ok(`${L}: batch10 P1-4: «повторить» записывает правку и снимает копию`, !!f1b.db && /сохранено/.test(String(f1b.toast.text)) && !f1b.edits.includes("отказ записи раз"), JSON.stringify(f1b));
        await tapEl(titleSel("отказ записи раз"));
        await tp.waitForTimeout(400);
        await tp.evaluate(() => { const a = document.activeElement; const r = document.createRange(); r.selectNodeContents(a); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
        await tp.keyboard.type(" два", { delay: 10 });
        await failPut(true);
        await tapEl('.inline-chip[data-inline="list"]');
        await tp.waitForTimeout(900);
        const f2 = { rows: await tp.$$eval("#sheet-cur .row .title", (e) => e.map((x) => x.textContent)), toast: await toast(), edits: await edits(), db: await dbT("отказ записи раз") };
        await failPut(false);
        T.ok(`${L}: Q-31 / P1-4: «в список» при отказе записи — дело остаётся на экране и в IndexedDB, тост «не сохранилось», набранное в edit:<id>`, f2.rows.some((r) => /^отказ записи раз/.test(r)) && !!f2.db && /не сохранилось/.test(String(f2.toast.text)) && f2.edits.includes("отказ записи раз два"), JSON.stringify(f2));
        await tp.reload();
        await tp.waitForSelector("#line");
        await tp.waitForTimeout(1200);
        const f3 = { rows: await tp.$$eval("#sheet-cur .row .title", (e) => e.map((x) => x.textContent)), toast: await toast() };
        T.ok(`${L}: P1-4: после перезагрузки набранное при отказе возвращается («правка восстановлена»), без дублей`, f3.rows.filter((r) => /^отказ записи/.test(r)).length === 1 && f3.rows.includes("отказ записи раз два") && /восстановлен/.test(String(f3.toast.text)), JSON.stringify(f3));
        T.ok(`${L}: batch10 (касания): без JS-ошибок и alert`, terr.length === 0 && tdlg === 0, JSON.stringify(terr.slice(0, 3)));
        await tctx.close();
      } else if (INLINE) T.skip(`${L}: batch10 P1-1/P1-3/P1-4`, "в этой сборке нет .row-actions (до 58c7686)");
    } catch (e) {
      T.ok(`${L}: сценарий без исключений`, false, e.message.split("\n")[0]);
    } finally {
      await browser.close();
    }
  }
  await srv.close();
}
run().then(() => process.exit(T.summary())).catch((e) => { console.error(e); process.exit(1); });
