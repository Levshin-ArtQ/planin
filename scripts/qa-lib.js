/**
 * Общие помощники для QA-тестов Planin (не часть приложения).
 * - staticServer(): мини-сервер без зависимостей. Режим vercel: /index.html и /index -> 308 на "/",
 *   как делает Vercel с cleanUrls. Можно подменять тело файлов в памяти (overrides), не трогая репозиторий,
 *   и переключать "сеть" (down = true -> соединение рвётся).
 * - loadPlaywright(): ищет playwright в репо, в PLAYWRIGHT_DIR или в /workspace/planin-qa-tools. Нет — null (тест пишет SKIP).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

// QA_ROOT=/путь/к/копии — прогнать те же тесты на другой копии (например, на старом коммите).
const ROOT = process.env.QA_ROOT ? path.resolve(process.env.QA_ROOT) : path.join(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};

function staticServer(opts = {}) {
  const root = opts.root || ROOT;
  const state = { overrides: Object.assign({}, opts.overrides || {}), delays: {}, down: false, log: [], vercel: opts.vercel !== false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    state.log.push(`${req.method} ${p}`);
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const wait = state.delays[p.replace(/^\/+/, "")];
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (state.vercel && (p === "/index.html" || p === "/index")) {
      res.writeHead(308, { Location: "/" + (url.search || "") });
      res.end();
      return;
    }
    if (p.endsWith("/")) p += "index.html";
    const rel = p.replace(/^\/+/, "");
    const headers = { "Cache-Control": "no-cache" };
    if (Object.prototype.hasOwnProperty.call(state.overrides, rel)) {
      headers["Content-Type"] = TYPES[path.extname(rel)] || "application/octet-stream";
      res.writeHead(200, headers);
      res.end(state.overrides[rel]);
      return;
    }
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    headers["Content-Type"] = TYPES[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(opts.port || 0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        state,
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); })
      });
    });
  });
}

function loadPlaywright() {
  // QA_NO_PLAYWRIGHT=1 — прогон как на машине без Playwright (браузерные части — SKIP, exit 0)
  if (process.env.QA_NO_PLAYWRIGHT) return null;
  const tries = [
    "playwright",
    process.env.PLAYWRIGHT_DIR && path.join(process.env.PLAYWRIGHT_DIR, "node_modules", "playwright"),
    "/workspace/planin-qa-tools/node_modules/playwright"
  ].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch (_) {
      /* дальше */
    }
  }
  return null;
}

function reporter(title) {
  const res = { pass: 0, fail: 0, known: 0, skip: 0, lines: [] };
  const out = (s) => {
    res.lines.push(s);
    console.log(s);
  };
  console.log(`\n=== ${title} ===`);
  return {
    res,
    ok(name, cond, detail) {
      if (cond) {
        res.pass += 1;
        out(` ✓ ${name}`);
      } else {
        res.fail += 1;
        out(` ✗ ${name}${detail ? " — " + detail : ""}`);
      }
      return !!cond;
    },
    /** Проверка, которая сейчас падает из-за известного бага (Q-N). Падение не считается регрессией теста, но видно. */
    bug(id, name, cond, detail) {
      if (cond) {
        res.pass += 1;
        out(` ✓ ${name} [${id} исправлен?]`);
      } else {
        res.known += 1;
        out(` ✗ KNOWN BUG ${id}: ${name}${detail ? " — " + detail : ""}`);
      }
      return !!cond;
    },
    /** Сторож: если прогон завис (браузер не отвечает), через ms печатает итог с FAIL и выходит — не висит вечно. */
    // step(name): текущий шаг — сторож и withTimeout называют его в сообщении о зависании
    step(name) {
      res.step = name;
    },
    // withTimeout(promise, ms, name): «✗ шаг X завис» вместо вечного ожидания; возвращает { hung: true } по таймауту
    async withTimeout(promise, ms, name) {
      let timer;
      const hung = new Promise((r) => { timer = setTimeout(() => r({ hung: true }), ms); });
      const r = await Promise.race([Promise.resolve(promise).then((v) => ({ value: v }), (e) => ({ error: e })), hung]);
      clearTimeout(timer);
      if (r.hung) {
        res.fail += 1;
        out(` ✗ шаг «${name || res.step || "?"}» завис (> ${Math.round(ms / 1000)} с)`);
      }
      return r;
    },
    watchdog(ms, what) {
      const t = setTimeout(() => {
        res.fail += 1;
        out(` ✗ сторож: прогон не закончился за ${Math.round(ms / 1000)} с${res.step ? `, завис шаг «${res.step}»` : ""}${what ? " — " + what : ""}`);
        process.exit(this.summary() || 1);
      }, ms);
      t.unref();
      return t;
    },
    skip(name, why) {
      res.skip += 1;
      out(` - SKIP ${name}: ${why}`);
    },
    summary() {
      const strict = process.argv.includes("--strict") || process.env.QA_STRICT === "1";
      console.log(`\n${title}: passed ${res.pass}, failed ${res.fail}, known bugs ${res.known}, skipped ${res.skip}${strict ? " (strict: known bugs count as failures)" : ""}`);
      const bad = res.fail + (strict ? res.known : 0);
      return bad ? 1 : 0;
    }
  };
}

// Часы браузера: по умолчанию сегодня 12:07 (как в parse-readme-test), чтобы тесты не зависели от времени суток
// (R-30/146e385: прошедшее сегодня время без даты уходит на завтра; после полуночи — другой день).
// Часы идут дальше с нормальной скоростью. QA_CLOCK=HH:MM — другое время, QA_REAL_CLOCK=1 — системные часы.
function qaClockTime() {
  if (process.env.QA_REAL_CLOCK) return null;
  const [h, m] = String(process.env.QA_CLOCK || "12:07").split(":").map(Number);
  const d = new Date();
  d.setHours(h, m || 0, 0, 0);
  return d;
}
async function qaContext(browser, opts) {
  const context = await browser.newContext(opts || {});
  const t = qaClockTime();
  if (t && context.clock) await context.clock.install({ time: t });
  return context;
}

module.exports = { ROOT, staticServer, loadPlaywright, reporter, qaContext, qaClockTime };
