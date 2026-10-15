/**
 * QA: обновление service worker при открытых вкладках (к R-4 п.4 — skipWaiting безусловно или по SKIP_WAITING).
 * Запуск: node scripts/e2e-sw-update.js [--strict]   (QA_ROOT=/путь — прогон на другой копии)
 * Сценарий (Chromium и WebKit/iPhone 14): вкладка A открыта и не в покое (в строке набран текст) -> «деплой» v2
 * в памяти сервера (новый CACHE, DB_VERSION 2 в db.js, маркер window.__QA_BUILD=2 в app.js) -> reg.update() ->
 * открываем вкладку B. Проверяем, что клиенты не расходятся по версиям и B открывается.
 * Контроль: тот же сценарий с sw.js без skipWaiting в install — B получает ту же версию, что и A, и открывается.
 * Файлы на диске не меняются.
 */
const fs = require("fs");
const path = require("path");
const { ROOT, staticServer, loadPlaywright, reporter, qaContext } = require("./qa-lib");

const T = reporter("e2e-sw-update");
T.watchdog(+process.env.QA_WATCHDOG_MS || 9 * 60 * 1000, "браузер завис; см. Q-20");
const SKIP_RE = /precache\(\)\.then\(\(\) => self\.skipWaiting\(\)\)/;

async function scenario(pw, engine, variant) {
  const sw1 = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const db1 = fs.readFileSync(path.join(ROOT, "js/db.js"), "utf8");
  const app1 = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
  const srv = await staticServer({ root: ROOT });
  const browser = await pw[engine].launch();
  try {
    const ctx = await qaContext(browser, engine === "webkit" ? { ...pw.devices["iPhone 14"] } : {});
    const A = await ctx.newPage();
    await A.goto(srv.origin + "/");
    await A.waitForSelector("#line");
    await A.evaluate(() => navigator.serviceWorker.ready);
    await A.waitForTimeout(800);
    await A.reload();
    await A.waitForSelector("#line");
    await A.click("#line");
    await A.keyboard.type("печатаю", { delay: 15 });
    let sw2 = sw1.replace(/const CACHE = "[^"]+"/, 'const CACHE = "listok-v2-qa"');
    if (variant === "control") sw2 = sw2.replace(SKIP_RE, "precache()");
    srv.state.overrides["sw.js"] = sw2;
    srv.state.overrides["js/db.js"] = db1.replace(/const DB_VERSION = \d+;/, (m) => m.replace(/\d+/, (n) => String(+n + 1)));
    srv.state.overrides["js/app.js"] = app1 + "\n;window.__QA_BUILD = 2;\n";
    await A.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.update())).catch(() => {});
    await A.waitForTimeout(2500);
    const a = await A.evaluate(async () => ({ build: window.__QA_BUILD || 1, caches: await caches.keys(), line: document.querySelector("#line").textContent }));
    const B = await ctx.newPage();
    await B.goto(srv.origin + "/");
    const bOpened = await B.waitForSelector("#line", { timeout: 8000 }).then(() => true, () => false);
    const b = await B.evaluate(() => ({ build: window.__QA_BUILD || 1, screen: document.querySelector("#app").textContent.trim().replace(/\s+/g, " ").slice(0, 30) }));
    return { a, b, bOpened };
  } finally {
    await browser.close();
    await srv.close();
  }
}

// ---- Применение подтверждаемого обновления (Q-16): новая версия не должна застревать навсегда ----
async function applyPaths(pw, engine) {
  const L = engine === "webkit" ? "WebKit/iPhone 14" : "Chromium";
  const sw1 = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const app1 = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
  const srv = await staticServer({ root: ROOT });
  const browser = await pw[engine].launch();
  let v = 1;
  const deploy = () => {
    v += 1;
    srv.state.overrides["sw.js"] = sw1.replace(/const CACHE = "[^"]+"/, `const CACHE = "listok-qa-apply-${v}"`);
    srv.state.overrides["js/app.js"] = `${app1}\n;window.__QA_BUILD = ${v};\n`;
    return v;
  };
  const build = (p) => p.evaluate(() => window.__QA_BUILD || 1).catch(() => -1);
  const waitBuild = async (p, want, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await build(p)) === want) return true;
      await p.waitForTimeout(250);
    }
    return false;
  };
  const updateAndWait = async (p) => {
    await p.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.update())).catch(() => {});
    await p.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !!(r && r.waiting)), null, { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(300);
  };
  const hide = (p) => p.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  try {
    const ctx = await qaContext(browser, engine === "webkit" ? { ...pw.devices["iPhone 14"] } : {});
    const A = await ctx.newPage();
    await A.goto(srv.origin + "/");
    await A.waitForSelector("#line");
    await A.evaluate(() => navigator.serviceWorker.ready);
    await A.waitForTimeout(800);

    // 1) ввод -> тост -> кнопка «обновить»
    await A.click("#line");
    await A.keyboard.type("черновик мысли", { delay: 15 });
    let want = deploy();
    await updateAndWait(A);
    const toast = await A.evaluate(() => !document.querySelector("#toast").hidden && !document.querySelector("#toast-update").hidden && document.querySelector("#toast-text").textContent);
    T.ok(`${L}: при вводе новая версия ждёт и показывает тост «Planin обновился»`, /обновил/.test(String(toast)) && (await build(A)) === 1, `тост: ${JSON.stringify(toast)}, build ${await build(A)}`);
    await A.click("#toast-update").catch(() => {});
    const okBtn = await waitBuild(A, want);
    await A.waitForSelector("#line");
    await A.waitForTimeout(500);
    const line = await A.textContent("#line");
    const rows = await A.$$eval(".row .title", (e) => e.map((x) => x.textContent));
    T.ok(`${L}: кнопка тоста применяет новую версию`, okBtn, `build ${await build(A)}`);
    T.ok(`${L}: черновик пережил обновление и не вписан задачей (R-15 + R-4)`, line === "черновик мысли" && !rows.includes("черновик мысли"), `строка «${line}», строки ${JSON.stringify(rows)}`);
    await A.click("#line");
    await A.keyboard.press("End");
    await A.keyboard.press("Enter").catch(() => {});
    await A.waitForTimeout(600);
    const rows2 = await A.$$eval(".row .title", (e) => e.map((x) => x.textContent));
    T.ok(`${L}: после Enter черновик вписан ровно один раз`, rows2.filter((t) => t === "черновик мысли").length === 1, JSON.stringify(rows2));

    // 2) покой -> обновление -> уход в фон
    await A.evaluate(() => document.activeElement && document.activeElement.blur());
    await A.waitForTimeout(300);
    want = deploy();
    await updateAndWait(A);
    await hide(A);
    T.ok(`${L}: в покое новая версия применяется при уходе в фон`, await waitBuild(A, want), `build ${await build(A)}`);

    // 3) «холодный старт» при уже скачанной ждущей версии (reg.waiting) — без действий пользователя
    await A.waitForSelector("#line");
    await A.evaluate(() => document.activeElement && document.activeElement.blur());
    want = deploy();
    await updateAndWait(A);
    const waiting = await A.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!(r && r.waiting)));
    await A.reload({ timeout: 15000 }).catch(() => {});
    const cold = waiting && (await waitBuild(A, want, 8000));
    // Chromium: SKIP_WAITING из boot.js до события load подвешивает навигацию (Q-20)
    (engine === "chromium" ? (n, c, d) => T.bug("Q-20", n, c, d) : (n, c, d) => T.ok(n, c, d))(`${L}: перезапуск при ждущей версии включает её сам (reg.waiting -> SKIP_WAITING), вкладка не зависает`, cold, `waiting до перезапуска: ${waiting}, build ${await build(A)}`);
    if (!cold && engine === "chromium") {
      T.skip(`${L}: две вкладки`, "вкладка зависла на Q-20 — сценарий дальше не проверяем");
      await ctx.close().catch(() => {});
      return;
    }

    // 4) две вкладки: мягкий запрос из фона не разводит версии; явная кнопка — переключает; не застревает
    await A.waitForSelector("#line");
    const B = await ctx.newPage();
    await B.goto(srv.origin + "/");
    await B.waitForSelector("#line");
    await A.evaluate(() => document.activeElement && document.activeElement.blur());
    const before = await build(A);
    want = deploy();
    await updateAndWait(A);
    await hide(A);
    await A.waitForTimeout(2500);
    const aSoft = await build(A);
    const bSoft = await build(B);
    T.ok(`${L}: две вкладки — уход в фон одной не переключает версию (вкладки не расходятся)`, aSoft === before && bSoft === before, `A ${aSoft}, B ${bSoft}`);
    await B.close();
    await A.bringToFront().catch(() => {});
    await A.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await A.waitForTimeout(300);
    await hide(A);
    const after = await waitBuild(A, want, 8000);
    T.ok(`${L}: после закрытия второй вкладки следующий уход в фон применяет версию (не застревает)`, after, `build ${await build(A)}`);
    await ctx.close();
  } catch (e) {
    T.ok(`${L}: сценарии применения без исключений`, false, e.message.split("\n")[0]);
  } finally {
    await browser.close();
    await srv.close();
  }
}

async function run() {
  const pw = loadPlaywright();
  if (!pw || process.argv.includes("--no-browser")) return T.skip("браузерные проверки", "playwright не найден или --no-browser");
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const hasSkip = SKIP_RE.test(sw);
  for (const engine of ["chromium", "webkit"]) {
    const L = engine === "webkit" ? "WebKit/iPhone 14" : "Chromium";
    const r = await scenario(pw, engine, "current");
    const d = `A: build ${r.a.build}, кэши ${JSON.stringify(r.a.caches)}; B: build ${r.b.build}, экран «${r.b.screen}»`;
    T.ok(`${L}: обновление SW не стирает набранный текст в открытой вкладке`, r.a.line === "печатаю", `строка «${r.a.line}»`);
    T.bug("Q-16", `${L}: после выкладки новой версии открытые вкладки не расходятся по версиям (старая страница не остаётся без своего кэша, новая — на другом JS)`, r.a.build === r.b.build, d);
    T.bug("Q-16", `${L}: при повышении DB_VERSION новая вкладка открывается, пока старая открыта (onversionchange/onblocked)`, r.bOpened, d);
    if (hasSkip) {
      const c = await scenario(pw, engine, "control");
      T.ok(`${L}: контроль — без skipWaiting в install новая вкладка получает ту же версию, что и старая, и открывается`, c.bOpened && c.a.build === c.b.build && c.a.caches.length === 2, `A build ${c.a.build}, B build ${c.b.build}, B открылась ${c.bOpened}, кэши ${JSON.stringify(c.a.caches)}`);
    } else T.skip(`${L}: контроль`, "в sw.js нет безусловного skipWaiting — сценарий «current» уже контрольный");
  }
}
run().then(async () => { const pw = loadPlaywright(); if (pw && !process.argv.includes("--no-browser")) for (const e of ["chromium", "webkit"]) await applyPaths(pw, e); }).then(() => process.exit(T.summary())).catch((e) => { console.error(e); process.exit(1); });
