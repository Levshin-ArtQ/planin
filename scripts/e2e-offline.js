/**
 * QA: офлайн и service worker. Запуск: node scripts/e2e-offline.js [--strict] [--no-browser]
 *
 * Статика: precache совпадает с файлами, index.html/manifest ссылаются только на precache, версия кэша,
 * activate/skipWaiting/claim, версия кэша по git (без файла-замка): если файлы из precache изменились,
 * а CACHE — нет, установленные копии никогда не получат новую версию (Q-9).
 * Браузер (Chromium + WebKit с эмуляцией iPhone 14), сервер эмулирует Vercel (cleanUrls: /index.html -> 308 /):
 * первый визит, отсутствие перенаправленных копий в кэше, офлайн-перезагрузка, данные офлайн, обновление SW
 * без потери IndexedDB, удаление старого кэша, перезагрузка посреди набора текста (Q-10), первый запуск без сети.
 * Офлайн: Chromium — context.setOffline + «упавший» сервер; WebKit — только «упавший» сервер
 * (setOffline в Playwright-WebKit ломает и SW, это ограничение инструмента, а не приложения).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT, staticServer, loadPlaywright, reporter, qaContext } = require("./qa-lib");

const T = reporter("e2e-offline");
T.watchdog(+process.env.QA_WATCHDOG_MS || 9 * 60 * 1000, "браузер завис; см. Q-20");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const sw = read("sw.js");
const html = read("index.html");
const manifest = JSON.parse(read("manifest.json"));

// ---------- статика ----------
const cacheName = (sw.match(/const CACHE = "([^"]+)"/) || [])[1];
const assets = JSON.parse(((sw.match(/const ASSETS = (\[[\s\S]*?\]);/) || [])[1] || "[]").replace(/,\s*\]/, "]"));
T.ok(`версия кэша задана (${cacheName})`, /^[\w-]+-v\d+\.\d+\.\d+$/.test(cacheName || ""));
T.ok(`precache не пуст (${assets.length} файлов)`, assets.length > 5);
const norm = (p) => p.replace(/^\.\//, "").replace(/^\//, "");
const missing = assets.filter((a) => a !== "./" && !fs.existsSync(path.join(ROOT, norm(a))));
T.ok("все файлы precache существуют (иначе install падает и офлайна нет совсем)", missing.length === 0, missing.join(", "));
const refs = [];
// R-24 (6997b76): заставки iOS (apple-touch-startup-image) в precache нарочно не кладутся — iOS берёт их при
// «На экран Домой», сама страница их не грузит. Проверяем только, что файлы есть (иначе белая вспышка).
const splash = [];
html.replace(/<link\b[^>]*\brel="apple-touch-startup-image"[^>]*\bhref="([^"]+)"/g, (_, u) => splash.push(u));
if (splash.length) T.ok(`заставки iOS (${splash.length}) — файлы на месте (в precache не нужны, R-24)`, splash.every((u) => fs.existsSync(path.join(ROOT, u.replace(/^\.?\//, "")))), splash.filter((u) => !fs.existsSync(path.join(ROOT, u.replace(/^\.?\//, "")))).join(", "));
html.replace(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g, (m, u) => { if (!/rel="apple-touch-startup-image"/.test(m) && !splash.includes(u)) refs.push(u); });
(manifest.icons || []).forEach((i) => refs.push(i.src));
const local = refs.filter((u) => !/^(https?:|data:|blob:)/.test(u)).map(norm);
const notCached = local.filter((u) => !assets.map(norm).includes(u));
T.ok("всё, что грузит index.html и manifest, есть в precache", notCached.length === 0, notCached.join(", "));
T.ok("manifest.start_url и scope внутри scope SW ('/')", (manifest.start_url || "/").startsWith("/") && (manifest.scope || "/") === "/");
T.ok("activate удаляет все кэши, кроме текущего", /caches\.keys\(\)[\s\S]*filter\(\(k\) => k !== CACHE\)[\s\S]*caches\.delete/.test(sw));
T.ok("install: skipWaiting, activate: clients.claim", /skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw));
T.ok("не-GET и чужие origin не перехватываются", /req\.method !== "GET"\) return/.test(sw) && /url\.origin !== self\.location\.origin\) return/.test(sw));
T.ok("перенаправленные ответы пересобираются перед кэшем и отдачей (фикс b5c5501)", /res\.redirected/.test(sw) && /cache\.put\(abs\.href, clean/.test(sw) && /settled\(await matchCache\(req\)\)/.test(sw));

// Q-9: «файлы precache менялись, а CACHE — нет». Проверка без состояния: по git сравниваем файлы precache
// в HEAD с коммитом, где CACHE последний раз менялся. Файл-замок больше не нужен (он зависел от рабочей копии
// и шумел в диффах); scripts/qa-asset-lock.json, если остался, не читается и не пишется.
const { execFileSync } = require("child_process");
function assetHash(readFile) {
  const h = crypto.createHash("sha256");
  assets.filter((a) => a !== "./").map(norm).sort().forEach((f) => {
    h.update(f + "\0");
    const buf = readFile(f);
    if (buf) h.update(buf);
  });
  return h.digest("hex").slice(0, 16);
}
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
let repo = false;
try { repo = git("rev-parse", "--show-toplevel").toString().trim() === path.resolve(ROOT); } catch (_) { /* не git */ }
if (!repo) {
  T.skip("версия кэша по git (Q-9)", "копия без .git (снимок git archive) — проверка только в рабочей копии");
} else {
  const atRev = (rev) => (f) => { try { return git("show", `${rev}:${f}`); } catch (_) { return null; } };
  const bump = git("log", "-1", "--format=%H", "-G", "const CACHE", "--", "sw.js").toString().trim();
  if (!bump) T.skip("версия кэша по git (Q-9)", "в истории нет коммита с CACHE");
  else {
    const same = atRev("HEAD")("sw.js").toString().match(/const CACHE = "([^"]+)"/)[1] === cacheName;
    const hHead = assetHash(atRev("HEAD"));
    const hBump = assetHash(atRev(bump));
    T.bug("Q-9", `файлы precache в HEAD менялись только вместе с CACHE (сейчас ${cacheName}, поднят в ${bump.slice(0, 7)})`, hHead === hBump, `после ${bump.slice(0, 7)} файлы precache изменены в коммитах, а CACHE тот же: установленные копии их не получат`);
    const hWork = assetHash((f) => { const p = path.join(ROOT, f); return fs.existsSync(p) ? fs.readFileSync(p) : null; });
    if (same && hWork !== hHead) console.log(`   i незакоммиченные правки в файлах precache без бампа CACHE (${cacheName}): перед коммитом поднимите CACHE`);
  }
}
let smoke = "";
try { smoke = read("scripts/smoke-test.js"); } catch (_) { /* нет */ }
T.bug("Q-9", "smoke-test не прибит к конкретной строке версии кэша (иначе поднять CACHE = сломать npm test)", !(cacheName && smoke.includes(`sw.includes("${cacheName}")`)), `smoke-test.js требует sw.includes("${cacheName}")`);

// ---------- браузер ----------
const APP_MARK = "\n;window.__QA_BUILD = 2;\n";

async function browserChecks() {
  if (process.argv.includes("--no-browser")) return T.skip("Playwright-проверки", "--no-browser");
  const pw = loadPlaywright();
  if (!pw) return T.skip("Playwright-проверки", "playwright не найден (npm i playwright в /workspace/planin-qa-tools или PLAYWRIGHT_DIR)");
  for (const engine of ["chromium", "webkit"]) {
    let browser;
    try {
      browser = await pw[engine].launch();
    } catch (e) {
      T.skip(engine, `не запускается: ${e.message.split("\n")[0]}`);
      continue;
    }
    // каждый движок — не дольше QA_ENGINE_MS (по умолчанию 240 с): зависание даёт «✗ шаг X завис», следующий движок идёт дальше
    const r = await T.withTimeout((async () => {
    const L = engine === "webkit" ? "WebKit/iPhone 14" : "Chromium";
    const ctxOpts = engine === "webkit" ? { ...pw.devices["iPhone 14"] } : {};
    const srv = await staticServer();
    const context = await qaContext(browser, ctxOpts);
    const page = await context.newPage();
    let navs = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs += 1; });
    const goOffline = async () => { srv.state.down = true; if (engine === "chromium") await context.setOffline(true); };
    const goOnline = async () => { srv.state.down = false; if (engine === "chromium") await context.setOffline(false); };
    const rows = () => page.$$eval("#sheet-cur .row .title", (els) => els.map((e) => e.textContent));
    const addLine = async (text) => { await page.click("#line"); await page.keyboard.type(text, { delay: 15 }); await page.keyboard.press("Enter"); await page.waitForTimeout(350); };
    try {
      // 1. первый визит
      await page.goto(srv.origin + "/");
      await page.waitForSelector("#line");
      const ready = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]));
      T.ok(`${L}: service worker зарегистрирован и активен`, ready);
      await page.waitForTimeout(1500);
      await page.waitForSelector("#line");
      T.bug("Q-11", `${L}: первая установка SW не перезагружает страницу`, navs === 1, `навигаций: ${navs}`);
      const cache = await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        const keys = await caches.keys();
        const c = await caches.open(keys[0]);
        const reqs = await c.keys();
        const out = { keys, entries: [] };
        for (const r of reqs) {
          const res = await c.match(r);
          const body = /\/$|index\.html$/.test(r.url) ? await res.clone().text() : "";
          out.entries.push({ url: new URL(r.url).pathname, redirected: res.redirected, status: res.status, hasApp: body.includes('id="app"'), len: body.length });
        }
        return out;
      });
      const paths = cache.entries.map((e) => e.url);
      const lost = assets.map((a) => "/" + norm(a)).filter((p) => !paths.includes(p));
      T.ok(`${L}: в кэше ${cacheName} все файлы precache`, cache.keys.length === 1 && cache.keys[0] === cacheName && lost.length === 0, `keys=${cache.keys} нет: ${lost}`);
      const shells = cache.entries.filter((e) => e.url === "/" || e.url === "/index.html");
      T.ok(`${L}: «/» и «/index.html» в кэше — полноценная страница, не перенаправленная копия (Vercel 308)`, shells.length === 2 && shells.every((e) => !e.redirected && e.status === 200 && e.hasApp), JSON.stringify(shells));

      // 2. данные + офлайн
      await page.reload();
      await page.waitForSelector("#line");
      T.ok(`${L}: после перезагрузки страница под управлением SW`, await page.evaluate(() => !!navigator.serviceWorker.controller));
      await addLine("онлайн задача");
      await goOffline();
      srv.state.log.length = 0;
      let offlineOk = false;
      try {
        await page.reload({ timeout: 15000 });
        offlineOk = await page.waitForSelector("#line", { timeout: 10000 }).then(() => true, () => false);
      } catch (_) { offlineOk = false; }
      T.ok(`${L}: офлайн-перезагрузка открывает приложение`, offlineOk);
      // /sw.js — проверка обновления, которую браузер делает сам при навигации (под нагрузкой она может запоздать
      // и попасть сюда от предыдущей перезагрузки); это не запрос приложения, офлайн она просто не удаётся.
      const appReqs = srv.state.log.filter((l) => !/ \/sw\.js(\?|$)/.test(l));
      T.ok(`${L}: офлайн — ни одного запроса до сервера (кроме проверки обновления /sw.js браузером)`, appReqs.length === 0, srv.state.log.join(","));
      if (offlineOk) {
        T.ok(`${L}: офлайн видны данные из IndexedDB`, (await rows()).includes("онлайн задача"), JSON.stringify(await rows()));
        await addLine("офлайн задача");
        await page.reload();
        await page.waitForSelector("#line");
        T.ok(`${L}: задача, добавленная офлайн, переживает перезагрузку офлайн`, (await rows()).includes("офлайн задача"));
        for (const u of ["/index.html", "/?utm_source=x"]) {
          const p2 = await context.newPage();
          const ok = await p2.goto(srv.origin + u, { timeout: 20000 }).then(() => p2.waitForSelector("#line", { timeout: 15000 }).then(() => true, () => false), () => false);
          T.ok(`${L}: офлайн открывается ${u}`, ok);
          await p2.close();
        }
      }
      await goOnline();

      // 3. изменили только app.js, CACHE тот же -> пользователь застревает на старой версии (by design cache-first)
      srv.state.overrides["js/app.js"] = read("js/app.js") + APP_MARK;
      await page.reload();
      await page.waitForSelector("#line");
      await page.reload();
      await page.waitForSelector("#line");
      const stale = await page.evaluate(() => window.__QA_BUILD);
      console.log(`   i ${L}: app.js изменён без смены CACHE -> новая версия ${stale === 2 ? "доехала" : "НЕ доехала (ожидаемо для cache-first; см. Q-9)"}`);

      T.step(`${engine}: 4. обновление SW`);
    // 4. обновление SW: новый CACHE -> новая версия, старый кэш удалён, данные целы
      srv.state.overrides["sw.js"] = sw.replace(/const CACHE = "[^"]+"/, 'const CACHE = "listok-v9.9.9-qa"');
      srv.state.delays["icons/icon-maskable.svg"] = 2000; // медленная сеть: precache идёт ~2 c
      navs = 0;
      await page.reload();
      await page.waitForSelector("#line");
      await page.click("#line");
      await page.keyboard.type("недописанная мысль", { delay: 15 });
      await page.waitForTimeout(5000);
      await page.waitForSelector("#line");
      const after = await page.evaluate(async () => ({ build: window.__QA_BUILD, keys: await caches.keys(), line: document.querySelector("#line").textContent }));
      T.ok(`${L}: новая версия SW скачана (новый кэш заполнен в install)`, after.keys.includes("listok-v9.9.9-qa"), JSON.stringify(after));
      let build = after.build;
      if (build !== 2) {
        // отложенное обновление: новая версия применяется при следующем открытии
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.waitForTimeout(500);
        await page.reload({ timeout: 15000 }).catch(() => {});
        await page.waitForSelector("#line", { timeout: 8000 }).catch(() => {});
        build = await page.evaluate(() => window.__QA_BUILD).catch(() => "страница не открылась");
        // холодный старт с ждущей версией: SKIP_WAITING -> controllerchange -> ещё одна перезагрузка; ждём её до 8 с
        for (let i = 0; i < 16 && build !== 2; i++) {
          const alive = await Promise.race([page.evaluate(() => !!document.querySelector("#line")).catch(() => false), new Promise((r) => setTimeout(() => r(null), 3000))]);
          if (alive === null) break; // вкладка висит (Q-20)
          await page.waitForTimeout(500);
          build = await Promise.race([page.evaluate(() => window.__QA_BUILD).catch(() => undefined), new Promise((r) => setTimeout(() => r(undefined), 3000))]);
        }
        // «при следующем открытии»: если вкладка жива, а версия ещё старая — ещё одно открытие (WebKit иногда активирует чуть позже)
        if (build !== 2 && engine !== "chromium") {
          await page.reload({ timeout: 15000 }).catch(() => {});
          await page.waitForSelector("#line", { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(1500);
          build = await page.evaluate(() => window.__QA_BUILD).catch(() => "страница не открылась");
        }
      }
      // Chromium: SKIP_WAITING до события load (холодный старт в boot.js) подвешивает следующую навигацию — Q-20
      if (engine === "chromium") T.bug("Q-20", `${L}: новый app.js применяется (сразу или при следующем открытии)`, build === 2, `build=${build}`);
      else T.ok(`${L}: новый app.js применяется (сразу или при следующем открытии)`, build === 2, `build=${build}`);
      // С подтверждаемым обновлением (Q-16) старый кэш живёт, пока новая версия ждёт; удаляется при активации.
      const hung = build !== 2 && !(await Promise.race([page.evaluate(() => !!document.querySelector("#line")).catch(() => false), new Promise((r) => setTimeout(() => r(false), 5000))]));
      if (hung) {
        // Страница висит (Q-20): любые evaluate/$$eval без таймаута ждали бы вечно — дальше этот сценарий не проверяем
        (engine === "chromium" ? (n, c, d) => T.bug("Q-20", n, c, d) : (n, c, d) => T.ok(n, c, d))(`${L}: после применения новой версии старый кэш удалён, остался только новый`, false, "вкладка зависла после SKIP_WAITING");
        T.skip(`${L}: данные после обновления, Q-10, офлайн после обновления`, "вкладка зависла (Q-20)");
        throw Object.assign(new Error("hung"), { qaHung: true });
      }
      const keysNow = await page.evaluate(() => caches.keys()).catch(() => ["страница не открылась"]);
      (engine === "chromium" ? (n, c, d) => T.bug("Q-20", n, c, d) : (n, c, d) => T.ok(n, c, d))(`${L}: после применения новой версии старый кэш удалён, остался только новый`, keysNow.length === 1 && keysNow[0] === "listok-v9.9.9-qa", `во время ожидания: ${JSON.stringify(after.keys)}, после: ${JSON.stringify(keysNow)}`);
      // после применения версии страница может ещё раз перезагрузиться (controllerchange) — ждём отрисовки до 8 с,
      // а решение принимаем по самой IndexedDB: пустой список на экране посреди перезагрузки — не потеря данных.
      let titles = [];
      for (let i = 0; i < 16; i++) {
        titles = await page.waitForSelector("#line", { timeout: 2000 }).then(() => rows(), () => []).catch(() => []);
        if (titles.includes("онлайн задача") && titles.includes("офлайн задача")) break;
        await page.waitForTimeout(500);
      }
      const stored = await page.evaluate(() => new Promise((res) => {
        const r = indexedDB.open("listok-private");
        r.onsuccess = () => { const q = r.result.transaction("tasks").objectStore("tasks").getAll(); q.onsuccess = () => { res(q.result.map((t) => t.title)); r.result.close(); }; q.onerror = () => res(null); };
        r.onerror = () => res(null);
      })).catch(() => null);
      T.ok(`${L}: после обновления данные IndexedDB на месте`, !!stored && stored.includes("онлайн задача") && stored.includes("офлайн задача"), `в IndexedDB: ${JSON.stringify(stored)}`);
      T.ok(`${L}: после обновления задачи видны на экране`, titles.includes("онлайн задача") && titles.includes("офлайн задача"), `на экране: ${JSON.stringify(titles)}`);
      T.bug("Q-10", `${L}: обновление SW не стирает текст, который набирают в строке (нет принудительной перезагрузки посреди ввода)`, after.line.includes("недописанная мысль") || titles.includes("недописанная мысль"), `перезагрузок: ${navs - 1}, строка после: «${after.line}»`);
      srv.state.delays = {};
      await goOffline();
      const offline2 = await page.reload({ timeout: 15000 }).then(() => page.waitForSelector("#line", { timeout: 10000 }).then(() => true, () => false), () => false);
      (engine === "chromium" ? (n, c, d) => T.bug("Q-20", n, c, d) : (n, c, d) => T.ok(n, c, d))(`${L}: после обновления офлайн работает`, offline2);
      // на зависшей вкладке (Q-20) setOffline(false) не возвращается — не ждём больше 5 с
      await Promise.race([goOnline().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      srv.state.down = false;
    } catch (e) {
      if (!e.qaHung) T.ok(`${L}: сценарий прошёл без исключений`, false, e.message.split("\n")[0]);
    } finally {
      await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
    }

    T.step(`${engine}: 6. хранение`);
    // 6. хранение: ошибка записи в IndexedDB (квота/обрыв соединения) и сбой открытия базы
    {
      const c3 = await qaContext(browser, ctxOpts);
      await c3.addInitScript(() => {
        if (location.search.includes("qa-idb-open-fail")) {
          const fake = () => {
            const req = { result: null, error: new DOMException("QA: open failed", "UnknownError") };
            setTimeout(() => req.onerror && req.onerror({ target: req }), 0);
            return req;
          };
          indexedDB.open = fake;
        }
      });
      const p3 = await c3.newPage();
      const rows3 = () => p3.$$eval("#sheet-cur .row .title", (els) => els.map((e) => e.textContent));
      const add3 = async (t) => { await p3.click("#line"); await p3.keyboard.type(t, { delay: 15 }); await p3.keyboard.press("Enter"); await p3.waitForTimeout(500); };
      try {
        await p3.goto(srv.origin + "/");
        await p3.waitForSelector("#line");
        await add3("до сбоя");
        await p3.evaluate(() => {
          const orig = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (...a) {
            const r = orig.apply(this, a);
            // синхронный abort — детерминированно (setTimeout(0) в Chromium иногда опаздывал: транзакция успевала закоммититься)
            if (this.name === "tasks") { try { this.transaction.abort(); } catch (_) { /* */ } }
            return r;
          };
        });
        await add3("запись упадёт");
        const visible = await rows3();
        const msg = ((await p3.textContent("#toast-text").catch(() => "")) + " " + (await p3.textContent("#ghost").catch(() => ""))).trim();
        const line = (await p3.textContent("#line")) || "";
        await p3.reload();
        await p3.waitForSelector("#line");
        const persisted = (await rows3()).includes("запись упадёт");
        T.bug("Q-6", `${L}: при ошибке записи IndexedDB пользователь видит ошибку или текст остаётся в строке`, persisted || line.includes("запись упадёт") || /не сохран|ошибк|места/i.test(msg), `на экране строки: ${JSON.stringify(visible)}, сообщение: «${msg}», строка ввода: «${line}», после перезагрузки задачи нет`);

        // После Q-6/R-15 текст упавшей записи остаётся в строке и сохраняется черновиком дня — убираем его
        // так, как сделал бы пользователь (выделить всё, стереть), чтобы следующая запись не приклеилась к нему.
        await p3.click("#line");
        await p3.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await p3.keyboard.press("Backspace");
        await p3.waitForTimeout(500);
        await p3.goto(srv.origin + "/?qa-idb-open-fail");
        await p3.waitForSelector("#line");
        const seenOld = (await rows3()).includes("до сбоя");
        await add3("записано в резерв");
        await p3.goto(srv.origin + "/");
        await p3.waitForSelector("#line");
        const back = await rows3();
        T.bug("Q-7", `${L}: если IndexedDB не открылась, приложение не подменяет данные пустым резервом молча`, seenOld || back.includes("записано в резерв"), `при сбое открытия старые задачи ${seenOld ? "видны" : "не видны"}; после восстановления IndexedDB «записано в резерв» ${back.includes("записано в резерв") ? "есть" : "пропало"} (${JSON.stringify(back)})`);
      } catch (e) {
        T.ok(`${L}: сценарий хранения без исключений`, false, e.message.split("\n")[0]);
      } finally {
        await c3.close();
      }
    }

    T.step(`${engine}: 5. первый запуск без сети`);
    // 5. первый запуск без сети (SW ещё не установлен) — ожидаемо не открывается; фиксируем поведение
    const c2 = await qaContext(browser, ctxOpts);
    const p2 = await c2.newPage();
    srv.state.down = true;
    const first = await p2.goto(srv.origin + "/", { timeout: 8000 }).then(() => "открылось", (e) => "ошибка браузера: " + e.message.split("\n")[0].slice(0, 80));
    console.log(`   i ${L}: первый запуск без сети -> ${first} (ожидаемо: без кэша открыть нечего)`);
    srv.state.down = false;
    await Promise.race([c2.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
    await srv.close();
    // зависший Chromium (Q-20) может не закрыться штатно — не ждём больше 10 с, затем убиваем процесс
    const closed = await Promise.race([browser.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    if (!closed) { try { browser.process && browser.process() && browser.process().kill("SIGKILL"); } catch (_) { /* */ } }
    })(), +process.env.QA_ENGINE_MS || 240000, null);
    if (r.hung) { try { browser.process && browser.process() && browser.process().kill("SIGKILL"); } catch (_) { /* */ } }
    if (r.error) T.ok(`${engine}: прогон без исключений`, false, String(r.error && r.error.message).split("\n")[0]);
  }
}

(async () => {
  await browserChecks();
  process.exit(T.summary());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
