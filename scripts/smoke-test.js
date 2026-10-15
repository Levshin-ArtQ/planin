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
  "js/gesture.js",
  "js/boot.js",
  "js/app.js",
  "icons/icon-192.svg",
  "icons/icon-512.svg",
  "icons/icon-maskable.svg",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/favicon-32.png",
  "scripts/icons.js"
].forEach((file) => ok(file, fs.existsSync(path.join(root, file))));

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
const dbSrc = fs.readFileSync(path.join(root, "js/db.js"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const css = fs.readFileSync(path.join(root, "css/styles.css"), "utf8");
ok("no remote scripts", !/src="https?:/.test(html));
ok("indexedDB", dbSrc.includes("indexedDB"));
ok("app does not fetch remote APIs", !/fetch\((['"])https?:/.test(app));
ok("export and import", app.includes("exportJson") && app.includes("importAll") && html.includes('id="import-file"'));
ok("gesture language is in the sheet", app.includes("влево и вниз") || app.includes("openDepth"));
ok("work hours default live in settings flow", app.includes("workStartMin") && app.includes("toggle-rail"));
{
  const bad = ["js/app.js", "js/db.js", "js/day.js", "js/parse.js", "js/motion.js", "js/gesture.js", "js/boot.js", "sw.js"].filter((f) => {
    try { new vm.Script(fs.readFileSync(path.join(root, f), "utf8"), { filename: f }); return false; } catch { return true; }
  });
  ok("every script parses", bad.length === 0, bad.join(", "));
}
ok("service worker cache", /const CACHE = "listok-v\d+\.\d+\.\d+";/.test(sw) && sw.includes("./js/parse.js") && sw.includes("function isNav") && sw.includes("res.redirected") && sw.includes("matchCache") && sw.includes("function precache") && !sw.includes("return cached || net") && !sw.includes("fetch(req)"));
{
  // Скрипт регистрации SW (js/boot.js) — на поддельном navigator.
  const inline = fs.readFileSync(path.join(root, "js/boot.js"), "utf8");
  const run = (controller, waiting, loading) => {
    const handlers = {};
    const winHandlers = {};
    const log = { reloads: 0, events: [], registers: 0 };
    const reg = { waiting: waiting || null, addEventListener: () => {} };
    const sandbox = {
      location: { protocol: "https:", reload: () => { log.reloads += 1; } },
      navigator: { serviceWorker: {
        controller,
        addEventListener: (type, fn) => { handlers[type] = fn; },
        // синхронный thenable: .then(reg) выполняется сразу
        register: () => { log.registers += 1; return { then: (fn) => { fn(reg); return { catch: () => {} }; } }; }
      } },
      document: { dispatchEvent: (e) => log.events.push(e.type), readyState: loading ? "loading" : "complete" },
      Event: function (type) { this.type = type; },
      setTimeout: (fn) => fn(),
      addEventListener: (type, fn) => { winHandlers[type] = fn; }
    };
    sandbox.window = sandbox;
    vm.runInNewContext(inline, sandbox);
    return { fire: () => handlers.controllerchange && handlers.controllerchange(), load: () => winHandlers.load && winHandlers.load(), log, sandbox };
  };
  const fresh = run(null);
  fresh.fire();
  ok("first install does not reload the page", fresh.log.reloads === 0 && fresh.log.events.length === 0 && fresh.log.registers === 1);
  const upd = run({});
  upd.fire();
  upd.fire();
  ok("update announces instead of reloading", upd.log.reloads === 0 && upd.log.events.filter((e) => e === "planin:update").length === 1 && upd.sandbox.__planinUpdateReady === true);
  const asked = [];
  const cold = run({}, { postMessage: (m) => asked.push(m.type + (m.force ? "!" : "")) });
  ok("cold start with a waiting worker asks it gently and announces (Q-16)", cold.log.reloads === 0 && cold.log.events.join() === "planin:update" && asked.join() === "SKIP_WAITING");
  cold.fire();
  ok("cold start reloads before the app draws", cold.log.reloads === 1);
  const early = [];
  const coldLoading = run({}, { postMessage: (m) => early.push(m.type) }, true);
  const before = early.length;
  coldLoading.load();
  ok("cold start sends SKIP_WAITING only after load (Q-20)", before === 0 && early.join() === "SKIP_WAITING" && coldLoading.log.events.join() === "planin:update");
  coldLoading.sandbox.__planinBooted = 1;
  coldLoading.fire();
  ok("cold start after load lets app reload once idle (Q-20)", coldLoading.log.reloads === 0 && coldLoading.sandbox.__planinColdTook === true && coldLoading.log.events.includes("planin:activated") && /planin:activated[\s\S]{0,160}__planinColdTook && isIdle\(\)/.test(app));
  const coldFresh = run(null, { postMessage: () => asked.push("x") });
  ok("waiting worker without controller is not an update", coldFresh.log.events.length === 0);
}
{
  // iOS не берёт SVG: нужны PNG без альфа-канала и без своих скруглений (R-5).
  const pngInfo = (file) => {
    const b = fs.readFileSync(path.join(root, file));
    return { sig: b.slice(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], type: b[25] };
  };
  const want = { "icons/apple-touch-icon.png": 180, "icons/icon-192.png": 192, "icons/icon-512.png": 512, "icons/icon-maskable-512.png": 512, "icons/favicon-32.png": 32 };
  Object.entries(want).forEach(([file, size]) => {
    const i = pngInfo(file);
    ok(`${file} is ${size}px RGB`, i.sig === "PNG" && i.w === size && i.h === size && i.depth === 8 && i.type === 2, JSON.stringify(i));
    ok(`${file} precached`, sw.includes(`"./${file}"`));
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const icons = manifest.icons || [];
  ok("manifest png icons first", icons[0] && icons[0].type === "image/png" && icons.some((i) => i.src === "icons/icon-512.png" && i.purpose === "any") && icons.some((i) => i.src === "icons/icon-maskable-512.png" && i.purpose === "maskable") && icons[icons.length - 1].type === "image/svg+xml");
  ok("apple-touch-icon is png", /rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon\.png"/.test(html) && !/apple-touch-icon"[^>]*\.svg/.test(html));
  ok("icon svgs are full-bleed", ["icon-192.svg", "icon-512.svg", "icon-maskable.svg"].every((f) => /<rect width="512" height="512" fill="#f3f0e8"\/>/.test(fs.readFileSync(path.join(root, "icons", f), "utf8"))));
  const icon = require(path.join(root, "scripts/icons.js"));
  const small = icon.png(32, icon.raster(32, 1));
  ok("icon generator reproduces favicon", small.equals(fs.readFileSync(path.join(root, "icons/favicon-32.png"))));
  // R-24: заставки iOS по теме — PNG нужного размера, ссылки в index.html, не в кэше SW.
  const shots = icon.SPLASH_SCREENS.flatMap(([w, h, dpr]) => ["light", "dark"].map((t) => ({ file: icon.splashFile(w, h, dpr, t), w: w * dpr, h: h * dpr, w0: w, h0: h, dpr, t })));
  ok("splash pngs exist with right size (R-24)", shots.length === 22 && shots.every((s) => { try { const i = pngInfo(s.file); return i.sig === "PNG" && i.w === s.w && i.h === s.h && i.type === 2; } catch (e) { return false; } }));
  ok("splash links per screen and theme (R-24)", shots.every((s) => html.includes(`media="(device-width: ${s.w0}px) and (device-height: ${s.h0}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait) and (prefers-color-scheme: ${s.t})" href="${s.file}"`)) && (html.match(/apple-touch-startup-image/g) || []).length === 22);
  ok("splash not precached (R-24)", !/splash\//.test(sw));
  const darkPx = fs.readFileSync(path.join(root, "splash/1170x2532-dark.png"));
  ok("splash generator reproduces dark splash (R-24)", icon.splash(390, 844, 3, "dark").equals(darkPx));
  ok("boot text fades in after 400ms (R-24)", /\.boot \{[^}]*animation: boot-in var\(--dur-2\) var\(--ease-out\) var\(--dur-4\) both/.test(css));
}
ok("service worker registered once", ((html + app + fs.readFileSync(path.join(root, "js/boot.js"), "utf8")).match(/serviceWorker\.register\(/g) || []).length === 1);
{
  // CSP: одна политика в meta (для страницы из кэша SW) и в заголовке Vercel (+ frame-ancestors).
  const meta = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/) || [, ""])[1];
  const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  const all = (vercel.headers.find((h) => h.source === "/(.*)") || { headers: [] }).headers;
  const header = (k) => (all.find((h) => h.key.toLowerCase() === k) || {}).value || "";
  ok("CSP meta before any script", !!meta && html.indexOf("Content-Security-Policy") < html.indexOf("<script"));
  ok("CSP: scripts only from self, no inline", /script-src 'self'(;|$)/.test(meta) && !/<script>/.test(html) && !/unsafe-eval/.test(meta) && !/\son[a-z]+=/i.test(html));
  ok("CSP header matches meta + frame-ancestors", header("content-security-policy") === meta + "; frame-ancestors 'none'");
  ok("security headers", header("x-content-type-options") === "nosniff" && header("x-frame-options") === "DENY" && !!header("permissions-policy") && header("referrer-policy") === "no-referrer");
}
ok("update is confirmed by the page, not forced in install (Q-16)", !/skipWaiting\(\)\)\);\s*\}\);/.test(sw) && /event\.waitUntil\(precache\(\)\);/.test(sw) && /data\.type !== "SKIP_WAITING"[\s\S]{0,500}list\.length <= 1 \|\| data\.force\) self\.skipWaiting\(\);/.test(sw) && /reg\.waiting\.postMessage\(\{ type: "SKIP_WAITING", force \}\)/.test(app) && app.includes("applyUpdate({ force: true })"));
ok("update waits for idle or the toast", app.includes('addEventListener("planin:update", onUpdate)') && app.includes('id="toast-update"') && app.includes("window.__planinUpdateReady") && /visibilityState === "hidden" && updatePending/.test(app) && /\.toast button \{[^}]*min-height: 44px/.test(css));
ok("toast sits above the composer, pauses under a finger, rail-close moves up (R-8)", /\.toast \{[^}]*bottom: calc\(var\(--compose-h[^;]*\+ 8px\)/.test(css) && css.includes("body.has-toast .rail-close") && app.includes("function pauseToast()") && app.includes("function resumeToast()"));
ok("draft survives the update reload", /async function applyUpdate\(opts\) \{\s*if \(reloading\) return;\s*saveDraftNow\(\);[\s\S]{0,1200}location\.reload\(\)/.test(app) && !/reloading = false; \}, 3000/.test(app) && !/sessionStorage\.(?:get|set|remove)Item\((?!RESTORED_KEY)/.test(app) && !app.includes("DRAFT_KEY") && app.includes('const DRAFTS_KEY = "planin:drafts"'));
ok("drafts saved on input, blur, pagehide and hide (R-15)", /line\.addEventListener\("input"[\s\S]{0,200}scheduleDraft\(\)/.test(app) && /function onLineBlur[\s\S]{0,80}saveDraftNow\(\)/.test(app) && /"pagehide"[^\n]*saveDraftNow/.test(app) && /visibilityState === "hidden"\) saveDraftNow/.test(app) && /function scheduleDraft\(\) \{[\s\S]{0,40}saveDraftNow\(\);\s*\}/.test(app) && !/setTimeout\(saveDraftNow/.test(app));
ok("blur never makes a silent task (R-15)", !app.includes("commitComposer(true)") && /function onLineBlur[\s\S]{0,300}lastPointerAt < 400[\s\S]{0,600}const text = readLine\(\);\s*if \(completePhrase\(text\) && [^\n]*\) commitComposer\(\)/.test(app));
ok("composer is bound to its day (R-15)", /function renderSheets\(animate\) \{\s*(?:if \(inline && !inline\.closing\) return;[^\n]*\s*)?syncComposerDay\(\);/.test(app) && app.includes('class="row draft" data-kind="draft"') && /kind === "draft"\) \{\s*if \(action === "done"\) commitDraft\(id[,)]/.test(app));
ok("edit sheet is backed up synchronously and restored at boot (R-15 review-batch2)",
  /id === "sheet-title"\) \{\s*state\.editDraft\.title = e\.target\.value;\s*backupEdit\(\);/.test(app) &&
  /function saveDraftNow\(\)[\s\S]{0,500}backupEdit\(\);/.test(app) &&
  /all\[editKey\(id\)\] = entry;\s*writeDrafts\(all\);/.test(app) &&
  /DB\(\)\.putTask\(model\)\.then\(\(\) => dropEditBackup\(id, at\)\)/.test(app) &&
  !/function backupEdit[\s\S]{0,900}setTimeout/.test(app) &&
  /const restored = await restoreEdits\(\);\s*if \(restored\.length\) stashRestored\(restored\);\s*reconcileDrafts\(\);\s*await dropEmptyNewTasks\(\);/.test(app) &&
  /offerUndo\("правка восстановлена", \(\) => undoRestored\(undo\), null, "отменить"\)/.test(app));
ok("restored-edit toast survives an extra reload via sessionStorage and offers «отменить» (P2-3)", /const RESTORED_KEY = "planin:restored";/.test(app) && /function stashRestored[\s\S]{0,200}sessionStorage\.setItem\(RESTORED_KEY/.test(app) && /function showRestored[\s\S]{0,300}setTimeout\(\(\) => \{ if \(!reloading\) clearRestored\(\); \}, 5000\)/.test(app) && /async function undoRestored[\s\S]{0,900}DB\(\)\[put\[u\.kind\]\]\(u\.prev\)[\s\S]{0,300}DB\(\)\[del\[u\.kind\]\]\(u\.id\)/.test(app) && /renderSheets\(false\);\s*showRestored\(\);/.test(app) && /Date\.now\(\) - Number\(raw\.at\) > 60000/.test(app));
ok("new task title is written on input with a draft flag (R-15/D-4)", /if \(!title\) task\.draft = true;/.test(app) && /function persistNewTitle[\s\S]{0,600}model\.draft = true;[\s\S]{0,120}DB\(\)\.putTask\(model\)/.test(app) && /async function dropEmptyNewTasks[\s\S]{0,300}DB\(\)\.deleteTask\(t\.id\)/.test(app) && /await dropEmptyNewTasks\(\);/.test(app));
ok("draft fallback to IndexedDB kv (R-15)", /getDrafts: \(\) => kvGet\("drafts"\)/.test(dbSrc) && /saveDrafts: \(value\) => kvSet\("drafts", value\)/.test(dbSrc));
ok("soft focus ring on the composer (R-15)", /\.line:focus-visible, \.field:focus-visible \{ outline: none; box-shadow: 0 0 0 2px var\(--ring\); \}/.test(css) && (css.match(/--ring:/g) || []).length === 2);
ok("row tap opens edit without a timer (R-22)", /function tapRow[\s\S]{0,700}openEdit\(kind, id/.test(app) && !/tapWait|setTimeout\(\(\) => \{\s*if \(tapWait/.test(app));
ok("grip tap completes at once, repeat ignored (R-22)", /function tapGrip[\s\S]{0,400}HIT\.gripRepeat[\s\S]{0,300}resolveRow\(current, "done"\)/.test(app) && /dt <= HIT\.gripTap\) tapGrip\(current\)/.test(app));
ok("double tap bridge 300 ms / 24 px (R-22, review-batch2)", /bridgeMs: 300, bridgePx: 24/.test(app) && /function bridgeTap[\s\S]{0,900}closeEdit\(false\)[\s\S]{0,120}resolveRow/.test(app) && app.includes('addEventListener("pointerdown", bridgeTap, true)'));
ok("grip is a checkbox for VoiceOver on every row kind", (app.match(/gripHTML\(/g) || []).length >= 4 && app.includes('role="checkbox"'));
ok("reorder grip", app.includes('class="grip"') && app.includes('data-group="plan"') && app.includes("fromGrip"));

ok("reorder is saved by the swap, not by the final offset", (app.match(/drag\.swapped = true;/g) || []).length === 2 && app.includes("if (!current.swapped) return;"));
ok("empty new line is dropped on close", app.includes("function emptyDraft") && (app.match(/drafts\.add\(/g) || []).length === 3);
ok("habit rhythm is escaped in the sheet", app.includes("каждые ${esc(early)}") && !app.includes("clock-read\">каждые ${early}"));
ok("kind switch keeps the typed time", /async function changeKind[\s\S]{0,400}\$\("#edit-time"\)[\s\S]{0,200}parseWhen/.test(app));
ok("composer DOM is not rewritten while typing", !/line\.innerHTML\s*=/.test(app) && !app.includes("markedHTML") && app.includes('CSS.highlights.set("kw"') && /::highlight\(kw\)/.test(css));
ok("viewport height follows keyboard", app.includes('setProperty("--vvh"') && app.includes('"kb-open"') && !app.includes("app.style.height") && /\.app \{[^}]*height: var\(--vvh, 100dvh\)/.test(css));
ok("sheet fits visible viewport", /\.sheet-ui \{[^}]*max-height: min\(calc\(var\(--vvh, 100dvh\)[^}]*overscroll-behavior: contain/.test(css) && css.includes(".kb-open .sheet-ui"));
ok("focused sheet field scrolls into view", /sheetUi\.addEventListener\("focusin"[\s\S]{0,400}scrollIntoView\(\{ block: "nearest" \}\)/.test(app));
ok("storage persistence requested (Q-8)", /navigator\.storage/.test(app) && app.includes("st.persist()") && app.includes("st.persisted()"));
ok("safari tab gets install hint once dismissible (R-20)", app.includes("display-mode: standalone") && app.includes("navigator.standalone") && /addedCount \|\| 0\) < 3/.test(app) && app.includes("30 * 864e5") && app.includes("хранятся раздельно"));
ok("settings show storage state", app.includes("Хранилище: ${kept}") && app.includes('"постоянное"') && app.includes('"может очищаться"'));
ok("composer keyboard hints", app.includes('enterkeyhint="send"') && app.includes('enterkeyhint="next"') && !/id="line"[^>]*autocorrect="off"/.test(app));
ok("ghost is debounced on input", /line\.addEventListener\("input", \(\) => \{\s*if \(painting\) return;[\s\S]{0,80}scheduleGhost\(\);/.test(app));
ok("blur keeps unfinished input as a draft", app.includes('line.addEventListener("blur", onLineBlur)'));
ok("selectstart on a text node does not throw (D-11)", app.includes("function elementOf(node)") && !/addEventListener\("selectstart", \(e\) => \{\s*if \(!e\.target\.closest/.test(app));
ok("theme-color per scheme without JS (R-18, replaces D-12 listener)", /name="theme-color" content="#f3f0e8" media="\(prefers-color-scheme: light\)"/.test(html) && /name="theme-color" content="#141311" media="\(prefers-color-scheme: dark\)"/.test(html) && !app.includes("tintTheme") && /html \{ background-color: var\(--bg\); \}/.test(css));
ok("export link is revoked later, not right after click (D-13)", /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), \d+\)/.test(app) && !/a\.click\(\);\s*URL\.revokeObjectURL/.test(app));
{
  // R-21: контраст вторичного текста по токенам (WCAG, текст < 18 px ≥ 4.5:1).
  const lum = (hex) => {
    const c = hex.replace("#", "").match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  const tok = (src, name) => (src.match(new RegExp(`--${name}: (#[0-9a-f]{6});`)) || [])[1];
  for (const [label, src] of [["light", light], ["dark", dark]]) {
    const bg = tok(src, "bg");
    ok(`--muted ≥ 4.5:1 on --bg (${label}, R-21)`, ratio(tok(src, "muted"), bg) >= 4.5, ratio(tok(src, "muted"), bg).toFixed(2));
    ok(`--faint ≥ 3.5:1 on --bg (${label}, R-21)`, ratio(tok(src, "faint"), bg) >= 3.5, ratio(tok(src, "faint"), bg).toFixed(2));
    ok(`--done-ink ≥ 3:1 on --bg (${label}, R-10)`, ratio(tok(src, "done-ink"), bg) >= 3, ratio(tok(src, "done-ink"), bg).toFixed(2));
  }
  for (const [label, src] of [["light", light], ["dark", dark]]) {
    // «приедет позже · N» (.archive) и «ещё N» — информация: ≥ 4.5:1 и на листе, и на поверхности шторки.
    for (const bgName of ["bg", "surface"]) {
      const r = ratio(tok(src, "muted"), tok(src, bgName));
      ok(`«приедет позже» ≥ 4.5:1 on --${bgName} (${label}, R-21 fix)`, r >= 4.5, r.toFixed(2));
    }
  }
  {
    // batch3 R-10: сделанный блок ленты — время ≥ 3:1 на фоне окна (--bg + --wash), без opacity на всём блоке.
    const rgba = (src, name) => (src.match(new RegExp(`--${name}: rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\);`)) || []).slice(1).map(Number);
    const hex = (h) => h.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
    const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    for (const [label, src] of [["light", light], ["dark", dark]]) {
      const [r, g, b, a] = rgba(src, "wash");
      const under = toHex(hex(tok(src, "bg")).map((v, i) => v + ([r, g, b][i] - v) * a));
      const time = ratio(tok(src, "faint"), under);
      const title = ratio(tok(src, "done-ink"), under);
      ok(`done timeline block: time ≥ 3:1, title ≥ 3:1 on the window wash (${label}, batch3 R-10)`, time >= 3 && title >= 3, `time ${time.toFixed(2)}, title ${title.toFixed(2)}`);
    }
    ok("done timeline block uses explicit colours, not opacity (batch3 R-10)", !/\.block\.is-done\.is-fade \{[^}]*opacity/.test(css) && /\.block\.is-done\.is-fade \.block-time \{ color: var\(--faint\); \}/.test(css) && /\.block\.window\.is-done\.is-fade \{ background: var\(--wash\); \}/.test(css));
  }
  ok("right swipe underlay shows the icon first (batch3 R-7)", /\.swipe-under\.at-right \.su-mark \{[^}]*flex-direction: row-reverse;/.test(css));
  ok("«приедет позже» uses --muted, not --faint (R-21 fix)", /\.more-done, \.archive \{[^}]*color: var\(--muted\)/.test(css) && app.includes('class="archive" data-act="toggle-shop-wait"') && !/\.went \{/.test(css));
  ok("placeholders use --muted, not ink × 0.3 (R-21)", !/placeholder[^}]*opacity: 0\.3/.test(css) && /\.line\.is-empty::before \{[^}]*color: var\(--muted\)/.test(css));
}
ok("VoiceOver: rows are labelled buttons, sheet is a modal dialog with inert background, date says the day (R-12)", /function rowA11y[\s\S]{0,120}role="button" tabindex="0" aria-label=/.test(app) && app.includes('aria-describedby="row-help"') && app.includes('role="dialog" aria-modal="true"') && /function labelDialog[\s\S]{0,1400}\.inert = true/.test(app) && /function releaseDialog[\s\S]{0,200}\.inert = false/.test(app) && /dataset\.label = `\$\{h\.weekday\}, \$\{h\.day\} \$\{h\.month\}/.test(app) && !app.includes("Сегодня. Долгое нажатие"));
ok("R-13 fix: timeline block hit area 44 px via ::before outside clipping, visible 36 px, nearest centre wins", /\.block::before \{ content: ""; position: absolute; inset: -4px 0; \}/.test(css) && !/\.block \{[^}]*\n  overflow: hidden;/.test(css) && /function pickBlock[\s\S]{0,700}r\.top - 4[\s\S]{0,300}Math\.abs\(point\.y - \(r\.top \+ r\.height \/ 2\)\)/.test(app) && (app.match(/pickBlock\(e?\.?target\.closest\("\.block"\)/g) || []).length >= 1 && app.includes(': 36;'));
ok("R-12 fix: grip checkbox says «выполнено: <название>», title is the button (not the whole row), keys work on both", /function gripHTML\(done, label, title\)[\s\S]{0,200}aria-checked="\$\{done \? "true" : "false"\}" aria-label="\$\{esc\(`\$\{label\}: \$\{title\}`\)\}"/.test(app) && (app.match(/<p class="title"\$\{rowA11y\(said\)\}>/g) || []).length === 3 && !/data-flip="[^"]*"\$\{rowA11y/.test(app) && (app.match(/gripHTML\([^)]*"выполнено", /g) || []).length >= 2 && app.includes("'.row [role=\"button\"], .row[role=\"button\"], .row .grip'") && !/aria-label="[^"]*(удерж|перетащ)/.test(app));
ok("touch targets are at least 44 px (R-13)", /\.step, \.tiny, \.day-toggle, \.io button, \.open-row button \{[^}]*min-height: 44px;[^}]*min-width: 44px;/.test(css) && /\.kinds button, \.edit-row button, \.anchors button \{\s*min-height: 44px;/.test(css) && /\.kinds button, \.choice \{[^}]*min-height: 44px;/.test(css) && /\.cal-day \{\s*height: 44px;/.test(css) && /\.strip \{[^}]*height: 44px;/.test(css) && /\.row \{[^}]*min-height: 48px;/.test(css) && /\.more-done, \.archive \{[^}]*min-height: 44px;/.test(css));
ok("empty new rows are marked draft everywhere and hour-add needs a calm tap (R-14)", (app.match(/\.draft = true; \/\/ R-14/g) || []).length === 2 && /act\.dataset\.act === "hour-add" && !calmTap\(e\)\) return;/.test(app) && /function calmTap[\s\S]{0,400}since > 1500\) return true;[\s\S]{0,120}HIT\.spaceTap[\s\S]{0,120}<= 6/.test(app));
ok("header swipes the day with a date peek, Safari edge left to the system (R-16)", /const top = \$\("\.top"\);\s*top\.addEventListener\("touchstart", \(e\) => begin\(e, "touch"\)/.test(app) && /function peekHeader[\s\S]{0,120}renderHeader\(delta \? D\(\)\.addDays/.test(app) && /point\.x < 24 && !target\.closest\("\.grip"\) && !isStandalone\(\)\) return;/.test(app));
ok("import limits: 5 MB file, 1000-char strings, real dates, whitelisted fields, 10 000 rows (Q-2)", /file\.size > DB\(\)\.MAX_FILE/.test(app) && /MAX_FILE: 5 \* 1024 \* 1024/.test(dbSrc) && /const MAX_TEXT = 1000;/.test(dbSrc) && /const MAX_ROWS = 10000;/.test(dbSrc) && /function shape\(row, fixed, required\)/.test(dbSrc) && /D\(\)\.ymdValid\(y, m, d\)/.test(dbSrc) && app.includes("пропущено ${skipped}"));
ok("«заменить файлом» asks first and keeps a «вернуть как было» backup (Q-15)", /state\.importMode === "replace"[\s\S]{0,400}state\.overlay = \{ type: "replace" \}/.test(app) && /async function replaceGo[\s\S]{0,300}saveReplaceBackup\(\)[\s\S]{0,300}applyImport\(payload, false\)/.test(app) && app.includes('data-act="replace-undo"') && /async function saveReplaceBackup[\s\S]{0,120}exportAll\(\)[\s\S]{0,80}kvSet\("replaceBackup"/.test(dbSrc));
ok("edit backups are type-checked on restore, broken ones removed (Q-18)", /function cleanEditBackup[\s\S]{0,400}key !== editKey\(raw\.id\)[\s\S]{0,1200}v >= 0 && v <= 1440/.test(app) && /const b = cleanEditBackup\(all\[key\], key\);\s*if \(!b\) \{\s*const cur = readDrafts\(\);\s*delete cur\[key\];/.test(app));
ok("failed edit save says «не сохранилось · повторить» (P2-2)", (app.match(/\.catch\(\(\) => saveFailed\(\(\) => DB\(\)\.put(Task|Habit|Errand)\(model\), id, at\)\)/g) || []).length === 3 && /function saveFailed[\s\S]{0,300}offerUndo\("не сохранилось", again, null, "повторить"/.test(app));
ok("rail blocks let the sheet scroll (D-10)", /\.block \{[^}]*touch-action: pan-y;/.test(fs.readFileSync(path.join(root, "css/styles.css"), "utf8")));
ok("dead mic code removed", !app.includes("function toggleMic"));
ok("dead HTML builders removed (Q-14)", !/function (editTaskHTML|editHabitHTML|removedPanel|doneHTML)\(/.test(app));
ok("done task is not deleted by a swipe", !/task\.done\) removeTask/.test(app));

// R-31: хвост — выборка и правило «время впереди больше чем на 15 минут».
(() => {
  const pick = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
  const src = pick("  function tailDepth()", "  // Черновики прошлых дней") + pick("  function nowMin()", "  function tailBusy()");
  const box = { state: { today: "2026-09-28", settings: { tailDays: 14 }, tasks: [] }, D: null, out: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, "js/day.js"), "utf8"), box);
  vm.runInContext(`D = () => ListokDay; function byOrder(a, b) { return (a.order || 0) - (b.order || 0); }\n${src}\nout.tailTasks = tailTasks; out.keep = keepTimeAhead; nowMin = () => 10 * 60;`, box);
  box.state.tasks = [
    { id: "a", date: "2026-09-27", kind: "slot", startMin: 15 * 60, title: "банк" },
    { id: "b", date: "2026-09-27", kind: "slot", startMin: 9 * 60, title: "врач" },
    { id: "c", date: "2026-09-26", kind: "loose", title: "позвонить", order: 2 },
    { id: "d", date: "2026-09-27", kind: "loose", title: "сделано", done: true },
    { id: "e", date: "2026-09-10", kind: "loose", title: "старое" },
    { id: "f", date: "2026-09-28", kind: "loose", title: "сегодня" },
    { id: "g", date: "2026-09-25", kind: "loose", title: "пустая новая", draft: true }
  ];
  const ids = box.out.tailTasks().map((t) => t.id).join(",");
  ok("tail: past, open, ≤14 days, by day then time", ids === "c,b,a", ids);
  box.state.settings.tailDays = 30;
  ok("tail depth 30 days", box.out.tailTasks().some((t) => t.id === "e"));
  const late = { kind: "slot", startMin: 10 * 60 + 10 };
  const soon = { kind: "slot", startMin: 10 * 60 + 20 };
  const win = { kind: "window", startMin: 9 * 60, endMin: 12 * 60 };
  ok("carry keeps time only if >15 min ahead", !box.out.keep(late) && late.kind === "loose" && late.startMin == null && box.out.keep(soon) && soon.startMin === 620 && box.out.keep(win));
})();
ok("tail plate on today with gestures", app.includes('data-kind="tail"') && /kind === "tail"\) \{\s*if \(action === "done"\)/.test(app) && app.includes('"errand", "errand-head", "draft", "tail"'));
ok("move from the past lands today (R-31)", /const base = past \? state\.today : task\.date;/.test(app) && app.includes("task.carried = (task.carried || 0) + 1"));
ok("auto-carry is off by default", /autoCarry: false/.test(fs.readFileSync(path.join(root, "js/day.js"), "utf8")) && /tailDays: 14/.test(fs.readFileSync(path.join(root, "js/day.js"), "utf8")));

// R-15: полная фраза и хранилище черновиков — исполняем исходники функций из app.js.
(() => {
  const pick = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
  const src = pick("  function parseCtx(", "  function mount()") + pick("  async function loadDrafts()", "  function saveDraftNow()") + pick("  const HANGING = ", "  // blur строки ввода");
  const store = {};
  const box = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    state: { cursor: "2026-09-28", tasks: [], errands: [], habits: [] },
    DB: () => ({ saveDrafts: async () => {}, getDrafts: async () => ({}), id: (p) => `${p}_${Math.random().toString(36).slice(2, 10)}` }),
    P: null,
    out: {}
  };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, "js/day.js"), "utf8"), box);
  vm.runInContext(fs.readFileSync(path.join(root, "js/parse.js"), "utf8"), box);
  vm.runInContext(`let draftsLS = true; let draftsMem = {}; const DRAFTS_KEY = "planin:drafts"; P = () => ListokParse; var D = () => ListokDay;\n${src}\nout.completePhrase = completePhrase; out.setDraft = setDraft; out.getDraft = getDraft; out.parkDraft = parkDraft; out.dropParked = dropParked; out.reconcileDrafts = reconcileDrafts;`, box);
  const { completePhrase, setDraft, getDraft } = box.out;
  const yes = ["врач в 15", "завтра в 14 врач", "позвонить маме"];
  const no = ["врач в", "завтра в", "завтра", "в 15", "к", "позвонить через", "пойти на"];
  ok("only a complete phrase is committed on keyboard close (R-15)", yes.every(completePhrase) && !no.some(completePhrase), [...yes.filter((t) => !completePhrase(t)), ...no.filter(completePhrase)].join(" | "));
  setDraft("2026-09-28", "купить мол", 5);
  setDraft("shop", "хлеб");
  const saved = JSON.parse(store["planin:drafts"]);
  setDraft("2026-09-28", "  ");
  ok("drafts are kept per day and removed when emptied (R-15)", saved["2026-09-28"].text === "купить мол" && saved["2026-09-28"].caret === 5 && saved.shop.text === "хлеб" && !getDraft("2026-09-28") && getDraft("shop").text === "хлеб");
  {
    const { parkDraft, dropParked, reconcileDrafts } = box.out;
    const day = "2026-09-29";
    setDraft(day, "врач в", 6);
    const id1 = getDraft(day).id;
    setDraft(day, "врач в 15", 9);
    const sameId = getDraft(day).id === id1 && /^t_/.test(id1);
    const parked = parkDraft(day);
    const lineFree = !getDraft(day);
    setDraft(day, "новое", 5);
    const freshId = getDraft(day).id !== id1;
    ok("draft keeps its id and is parked while the write runs (R-15)", sameId && lineFree && freshId && parked.id === id1);
    reconcileDrafts(); // запись не подтвердилась — черновик вернулся
    // P2-4: в строке уже «новое» — неподтверждённое не склеивается, а ждёт в очереди дня.
    const queued = JSON.parse(store["planin:drafts"])["next:" + day];
    const back = getDraft(day).text === "новое" && !!queued && queued.items.length === 1 && queued.items[0].text === "врач в 15" && queued.items[0].id === id1;
    setDraft(day, "");
    reconcileDrafts(); // строка пуста — очередь становится черновиком строки
    const promoted = getDraft(day) && getDraft(day).text === "врач в 15" && getDraft(day).id === id1 && !JSON.parse(store["planin:drafts"])["next:" + day];
    ok("unconfirmed write does not glue two thoughts, queues the second (P2-4)", back && promoted, `back ${back}, promoted ${promoted}`);
    setDraft(day, "");
    setDraft(day, "позвонить");
    const p2 = parkDraft(day);
    box.state.tasks.push({ id: p2.id, title: "позвонить" });
    reconcileDrafts(); // запись есть — черновик не возвращается (нет дубля)
    const noDup = !getDraft(day) && !Object.keys(JSON.parse(store["planin:drafts"])).some((k) => k.startsWith("~"));
    setDraft(day, "ещё");
    const p3 = parkDraft(day);
    dropParked(p3);
    ok("unconfirmed write restores the draft, confirmed one clears it (R-15)", back && noDup && !JSON.parse(store["planin:drafts"])[day], `back ${back}, noDup ${noDup}`);
    {
      const all = JSON.parse(store["planin:drafts"] || "{}");
      const tid = "t_edit1";
      box.state.tasks.push({ id: tid, title: "старое" });
      all["edit:" + tid] = { kind: "task", id: tid, title: "старое и новое", at: 1 };
      store["planin:drafts"] = JSON.stringify(all);
      box.draftsMem = all;
      reconcileDrafts();
      const kept = JSON.parse(store["planin:drafts"])["edit:" + tid];
      ok("reconcileDrafts leaves edit-sheet backups alone (R-15 review-batch2)", !!kept && kept.title === "старое и новое");
    }
  }
  const escSrc = app.slice(app.indexOf("  function esc(s) {"), app.indexOf("\n  }\n", app.indexOf("  function esc(s) {")) + 4);
  const rowSrc = app.slice(app.indexOf("  function draftRowHTML("), app.indexOf("\n  }\n", app.indexOf("  function draftRowHTML(")) + 4);
  vm.runInContext(`${escSrc}\n${rowSrc}\nout.row = draftRowHTML;`, box);
  const html = box.out.row("2026-09-28", { text: '<img src=x onerror=alert(1)>"' });
  ok("draft row text is escaped (R-15)", !html.includes("<img") && html.includes("&lt;img") && !/aria-label="[^"]*"[^ >]/.test(html));
})();

const assets = (sw.match(/const ASSETS = \[([\s\S]*?)\];/) || [, ""])[1].match(/"[^"]+"/g).map((q) => q.slice(1, -1));
ok("boot.js is precached (Q-9)", /"\.\/js\/boot\.js"/.test(sw) && html.includes('src="js/boot.js"'));
ok("update toast waits for the sheet to close (R-4 fix)", /if \(state\.overlay \|\| state\.editing\) \{\s*updateToastDue = true;/.test(app) && /function hideOverlay[\s\S]{0,400}updateToastDue && updatePending && !reloading[\s\S]{0,80}showUpdateToast\(\)/.test(app));
ok("touchcancel mid-swipe snaps back and clears the strike (R-1 fix)", /function cancelDrag[\s\S]{0,500}snap\(drag\.el\);\s*drag\.el\.style\.removeProperty\("--strike"\)/.test(app));
ok("done row at rest: only the title is struck (text-decoration 1.5px), .ink only animates (batch3 R-10)", /\.row\.is-done\.is-strike > \.title \{[^}]*text-decoration-line: line-through;[^}]*text-decoration-thickness: 1\.5px;/.test(css) && !/\.row\.is-done\.is-strike \{[^}]*--strike: 1/.test(css) && !/setProperty\("--strike", [^)]*is-done/.test(app));
ok("day shift keeps the typed title (D-4 fix)", /act === "shift-plus" \|\| act === "shift-minus"\) && state\.editing\) \{[\s\S]{0,400}if \(closeEdit\(true\) === false\) return;/.test(app));
ok("tap on empty space writes (R-29)", /class="tail-space/.test(app) && /function tapSpace[\s\S]{0,300}HIT\.spaceTap[\s\S]{0,120}> 8\) return;\s*openKeyboard\(\);/.test(app) && /\.tail-space \{[^}]*flex: 1 0 88px/.test(css) && app.includes("Напишите внизу, что сделать"));
ok("empty day invites with 3 examples, past day says nothing was there (R-11)", app.includes("День пустой") && app.includes("В этот день ничего не было") && /EXAMPLES = \["завтра в 14 врач", "купить молоко", "с 12 до 14 обед"\]/.test(app) && /function useExample[\s\S]{0,200}writeLine\(text\)[\s\S]{0,80}openKeyboard\(\)/.test(app) && /\.empty \{[^}]*margin-top: 28vh/.test(css));
ok("gesture hints once, visible «выполнить» in the edit sheet (R-11)", /function hintAfterAdd[\s\S]{0,300}markHint\("swipe"\)/.test(app) && app.includes("долгое нажатие — меню") && app.includes("вправо и вниз — выбрать день") && /function wink[\s\S]{0,80}M\(\)\.reduce\(\)\) return;/.test(app) && app.includes('data-act="edit-done"') && /function legendNow[\s\S]{0,160}state\.cursor === state\.today\) return false;[\s\S]{0,160}legendShown \|\| 0\) >= 3/.test(app));
ok("pull down from the top writes to the start of the day (R-29)", /pullShow: 40, pullArm: 72/.test(app) && /current\.mode === "pull"[\s\S]{0,200}endPull\(dy >= HIT\.pullArm\)/.test(app) && app.includes('"в начало дня"') && /order: parsed\.top \? topOrder\(parsed\.date\)/.test(app));
ok("Enter during a write is queued as a {text, day} snapshot, not lost (R-29, batch2 п.10)", !app.includes("commitAgain") && /if \(committing\) \{\s*commitQueue\.push\(snap\);/.test(app) && /if \(commitQueue\.length\) \{\s*runCommit\(commitQueue\.shift\(\)\);/.test(app));
ok("every precached file exists", assets.every((a) => a === "./" || fs.existsSync(path.join(root, a))), assets.filter((a) => a !== "./" && !fs.existsSync(path.join(root, a))).join(", "));
const pageRefs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => "./" + m[1]).filter((r) => !/^\.\/https?:/.test(r) && !/^\.\/splash\//.test(r)); // заставки iOS берёт при установке (R-24)
ok("everything index.html loads is precached", pageRefs.every((r) => assets.includes(r)), pageRefs.filter((r) => !assets.includes(r)).join(", "));
ok("no double-tap zoom on buttons", /html, body \{ touch-action: manipulation; \}/.test(css));

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

vm.runInContext(fs.readFileSync(path.join(root, "js/gesture.js"), "utf8"), ctx);
const G = ctx.ListokGesture;
const W = 346;
ok("fast flick left completes", G.decideSwipe({ dx: -55, v: -0.6, W }) === "done");
ok("fast flick right defers", G.decideSwipe({ dx: 55, v: 0.6, W }) === "defer");
ok("slow short drag does nothing", G.decideSwipe({ dx: -60, v: -0.1, W }) === null && G.decideSwipe({ dx: 30, v: 0.9, W }) === null);
ok("long drag commits without speed", G.decideSwipe({ dx: -96, v: 0, W }) === "done" && G.decideSwipe({ dx: 96, v: 0, W }) === "defer");
ok("axis lock", G.axis(12, 3) === "x" && G.axis(3, 12) === "y" && G.axis(5, 4) === null && G.axis(11, 10) === null);
ok("resistance after the threshold", G.resist(50, W) === 50 && G.resist(-196, W) === -131 && G.resist(400, W) === 140);
const samples = [];
[[0, 0], [20, 30], [40, 60], [60, 90], [80, 120], [100, 150]].forEach(([t, x]) => G.pushSample(samples, x, t));
ok("velocity over the last 100 ms", Math.abs(G.velocity(samples) - 1.5) < 1e-9 && samples.length <= 5);
ok("reorder branch has its element", /if \(drag\.mode === "reorder"\) \{\s*if \(e\.cancelable\) e\.preventDefault\(\);\s*const el = drag\.el;/.test(app));
ok("grip: reorder only after a 170 ms hold within 8 px, otherwise scrolling (review-batch2)",
  /gripDrag: 170, gripSlop: 8, scrollCalm: 120/.test(app) &&
  /if \(!drag\.held\) \{[\s\S]{0,300}Date\.now\(\) - drag\.t0 < HIT\.gripDrag\) \{\s*if \(Math\.hypot\(dx, dy\) > HIT\.gripSlop\) \{[\s\S]{0,200}drag = null;\s*\}\s*return;/.test(app) &&
  /\.grip \{[^}]*touch-action: pan-y;/.test(css));
ok("grip tap right after a scroll does not complete (review-batch2)",
  /addEventListener\("scroll", \(\) => \{ lastScrollAt = Date\.now\(\); \}, \{ capture: true, passive: true \}\)/.test(app) &&
  /const noTap = Date\.now\(\) - lastScrollAt < HIT\.scrollCalm;/.test(app) && /!current\.noTap && Math\.hypot/.test(app));
ok("--press declared for light and dark (review-batch2)",
  /:root \{\s*--bg: #f3f0e8;\s*--press: rgba\(28, 25, 22, \.10\);/.test(css) && /prefers-color-scheme: dark\) \{\s*:root \{\s*--bg: #141311;\s*--press: rgba\(236, 231, 223, \.14\);/.test(css));
ok("undo after «вписано» returns the text to the line (R-15 review-batch2)",
  /const giveBack = \(\) => \{[\s\S]{0,500}if \(cur && cur !== text(?: && [^\n]*)?\) \{\s*queueNext\(day, text\);[\s\S]{0,300}writeLine\(text\);[\s\S]{0,360}setDraft\(day, text, text\.length\);/.test(app) &&
  !/\$\{text\} \$\{cur\}/.test(app) && /if \(composerDay === day && !readLine\(\)\.trim\(\)\) promoteNext\(day\);/.test(app) &&
  /const write = snap\.items \? \(\) => commitMany\(snap\.items, giveBack\) : \(\) => commitParsed\(item, giveBack\);\s*Promise\.resolve\(write\(\)\)/.test(app) && /Promise\.resolve\(write\(\)\)\.then\(\(\) => setDraft/.test(app));
ok("restored draft puts the caret at the end, also on focus without a tap (P2-5)", /pendingCaret = mine \? mine\.text\.length : null;/.test(app) && /setCaret\(line, mine \? mine\.text\.length : 0\)/.test(app) && /line\.addEventListener\("focus", \(\) => \{\s*if \(pendingCaret == null\) return;[\s\S]{0,160}setCaret\(line, at\)/.test(app) && /writeLine\(text\);\s*pendingCaret = text\.length;[\s\S]{0,160}setCaret\(line, text\.length\)/.test(app));
ok("toast rises above an open sheet (z 22, above its top) (batch4 P1)", /body\.has-sheet \.toast \{\s*z-index: 22;\s*bottom: min\(calc\(var\(--sheet-h, 0px\) \+ 8px\)/.test(css) && /function liftToast\(\)[\s\S]{0,300}classList\.toggle\("has-sheet", open\)[\s\S]{0,200}--sheet-h/.test(app) && (app.match(/liftToast\(\);/g) || []).length >= 2);
ok("hidden file input is out of tab order and a11y tree (batch4 P2)", /id="import-file"[^>]*tabindex="-1" aria-hidden="true"/.test(html));
ok("batch4 P3: calmTap passes clicks without coordinates, saveFailed drops backup by time, tail plate focusable; habit days 44×44, «любой» on its own row (R-13 fix)", /function calmTap\(e\) \{[\s\S]{0,200}e\.detail === 0 \|\| \(e\.clientX === 0 && e\.clientY === 0\)\) return true;/.test(app) && /function saveFailed\(retry, id, at\)[\s\S]{0,120}dropEditBackup\(id, at\)/.test(app) && (app.match(/saveFailed\(\(\) => DB\(\)\.put\w+\(model\), id, at\)/g) || []).length === 3 && app.includes('data-id="tail" role="button" tabindex="0"') && /\.weekdays \{\s*display: grid;\s*grid-template-columns: repeat\(7, minmax\(0, 44px\)\);/.test(css) && /\.weekdays \.day-toggle::before \{ content: ""; position: absolute; inset: 0 min\(0px, calc\(\(100% - 44px\) \/ 2\)\); \}/.test(css) && app.includes('class="day-toggle day-any') && !/<div class="weekdays">\s*<button[^>]*data-weekday=""/.test(app));
{
  const DY = ctx.ListokDay;
  const day = "2026-09-29";
  const ts = [
    { id: "a", date: day, kind: "window", startMin: 720, endMin: 840, title: "обед" },
    { id: "b", date: day, kind: "slot", startMin: 900, endMin: null, title: "врач" },
    { id: "c", date: day, kind: "slot", startMin: 960, title: "сделано", done: true },
    { id: "d", date: "2026-09-30", kind: "slot", startMin: 800, title: "завтра" }
  ];
  const a = DY.nowLine(ts, day, 13 * 60 + 20), b = DY.nowLine(ts, day, 14 * 60 + 21), c = DY.nowLine(ts, day, 16 * 60);
  const s1 = DY.nowLine(ts, day, 15 * 60 + 10), s2 = DY.nowLine(ts, day, 15 * 60 + 15);
  ok("batch6 P3: a started slot with no end is «идёт» for 15 min (15:10 — врач, 15:15 — nothing)", s1 && s1.cur && s1.cur.id === "b" && s2 === null && app.includes('if (line.cur.kind === "slot") parts.push(["", " · идёт"]);'), JSON.stringify([s1, s2]));
  ok("R-32: nowLine — at 13:20 обед till 14:00, next врач; at 14:21 врач in 39 min; nothing after 15:00", a && a.cur.id === "a" && a.next.id === "b" && b && !b.cur && b.next.id === "b" && b.inMin === 39 && c === null);
  ok("R-32: badge = open today + tail, habits not counted; permission asked only from the settings toggle", /function badgeCount\(\) \{\s*return state\.tasks\.filter\(\(t\) => !t\.done && !t\.draft && t\.date === state\.today\)\.length \+ tailTasks\(\)\.length;/.test(app) && (app.match(/requestPermission\(/g) || []).length === 1 && /async function setBadge[\s\S]{0,200}requestPermission/.test(app) && /"setAppBadge" in navigator && isStandalone\(\)/.test(app));
ok("neighbour day sheets are inert and aria-hidden, current one active (batch5 P1, R-12)", /function syncSheetA11y[\s\S]{0,300}el\.inert = off;[\s\S]{0,80}setAttribute\("aria-hidden", "true"\)/.test(app) && /fillSheet\(\$\("#sheet-next"\)[^\n]*\n\s*syncSheetA11y\(\);/.test(app));
ok("re-render keeps focus on the same grip / title / tail plate (batch5 P2, R-12)", /const keep = el\.id === "sheet-cur" \? focusMark\(el\) : null;/.test(app) && /\]\.join\(""\);\n\s*if \(keep\) focusBack\(el, keep\);/.test(app));
ok("shop line on blur does not pull the keyboard back (batch5 5b п.2)", /addErrandFrom\(text, parked && parked\.id, onBlur\)/.test(app) && /if \(!onBlur\) state\.focusShop = true;/.test(app));
ok("R-32: «now» refreshes on the minute boundary, «через N мин» only under 60 (UX)", /function minuteTick\(\) \{\s*const ms = 60000 - \(Date\.now\(\) % 60000\) \+ 50;/.test(app) && !app.includes("setInterval(updateNow") && /line\.inMin < 60 \? " · через "/.test(app) && !/\.kicker[^{]*\{[^}]*(transition|animation)/.test(css));
ok("R-32: live line in the header, same height; tap shows the task; dot on the strip", /function paintNowLine[\s\S]{0,1400}" · через " \+ line\.inMin \+ " мин"/.test(app) && /\.kicker \{ white-space: nowrap; overflow: hidden;/.test(css) && app.includes("data-strip-now") && /function updateNow\(\) \{\s*paintNowLine\(\);/.test(app));
}
ok("R-31: past-day tags — weekday up to 6 days back, date after («1 сен»); plate 64 px", ctx.ListokDay.dayTag("2026-09-23", "2026-09-29") === "ср" && ctx.ListokDay.dayTag("2026-09-22", "2026-09-29") === "22 сен" && ctx.ListokDay.dayTag("2026-09-01", "2026-09-29") === "1 сен" && !/WD_SHORT\[D\(\)\.dow\((task\.date|k)\)\]/.test(app) && /\.tail \.t1 \{[^}]*line-height: 20px;/.test(css) && /\.tail \.t2 \{[^}]*line-height: 18px;/.test(css));
ok("shop line on blur: commits words, keeps one letter and a hanging preposition as a draft (researcher decision)", /shop\.addEventListener\("blur", \(\) => \{\s*if \(shopEscaping\) \{ setDraft\("shop", readEditable\(shop\)\); return; \}\s*commitShopLine\(shop, true\);/.test(app) && ["для", "из", "без", "про", "о", "об", "под", "над"].every((w) => app.includes(`"${w}"`)) && /function shopBlurReady\(text\) \{\s*if \(text\.length < 2\) return false;\s*return !HANGING\.has/.test(app) && /if \(onBlur && !shopBlurReady\(text\)\) \{\s*setDraft\("shop"/.test(app));
ok("row swipe has no start delay", (app.match(/HIT\.dragDelay/g) || []).length === 1 && app.includes("G().decideSwipe("));

const D = ctx.ListokDay;
const P = ctx.ListokParse;
const DB = ctx.ListokDB;
const today = "2026-09-23";

ok("23 Sep 2026 is Wednesday", D.dow(today) === 3);
ok("add days", D.addDays(today, 1) === "2026-09-24" && D.diffDays(today, "2026-10-01") === 8);
ok("workday", D.workOn(today, D.defaultSettings()) && !D.workOn("2026-09-26", D.defaultSettings()));
ok("text size default — «как в системе» (R-23)", D.defaultSettings().textSize === "auto");
ok("text size buttons: no raw expression in the template (R-23 fix)", /const size = \(value, label, full\) => \{\s*const on = \(s\.textSize \|\| "auto"\) === value;/.test(app));
ok("inline chips act on pointerup, click only for keyboard/VO (batch10 P1-1)", /bar\.addEventListener\("pointerup", \(ev\) => \{[\s\S]{0,400}swallowClick = true;[\s\S]{0,120}inlineChip\(b\.dataset\.inline\);/.test(app) && /bar\.addEventListener\("click", \(ev\) => \{\s*ev\.stopPropagation\(\);[\s\S]{0,120}ev\.detail === 0\) inlineChip/.test(app) && !/addEventListener\("click", \(ev\) => \{ ev\.stopPropagation\(\); endInline\("chip"/.test(app));
ok("inline edit survives reload / pagehide / SW update (batch10 P1-2)", /function backupEdit\(\) \{\s*if \(inline && !inline\.closing\) backupInline\(\);/.test(app) && /all\[editKey\(task\.id\)\] = \{ kind: "task", id: task\.id, title: text, inline: true/.test(app) && /function inlineInput\(\) \{\s*inlineSay\(\);\s*if \(inline\) backupInline\(\);/.test(app) && /if \(raw\.inline === true\) b\.inline = true;/.test(app) && /if \(b\.inline && model && !model\.done && title\) \{[\s\S]{0,200}applyInlineText\(model, title\);/.test(app) && /if \(inline\) \{[\s\S]{0,120}await endInline\("save"\);\s*if \(inline\) return;/.test(app) && (app.match(/dropEditBackup\((?:cur\.id|task\.id)(?:, at)?\)/g) || []).length >= 4);
ok("actions sheet stays reachable: «ещё…» chip first, keyless click, Shift+F10/ContextMenu, VO «действия…» (batch10 P1-3, R-12)", /const keyed = !e \|\| e\.detail === 0 \|\| \(e\.clientX === 0 && e\.clientY === 0\);/.test(app) && /if \(k === "more"\) \{[\s\S]{0,300}endInline\("save"\)\)\.then\(\(\) => \{[^\n]*openEdit\("task", id\)/.test(app) && /e\.key === "ContextMenu" \|\| \(e\.shiftKey && e\.key === "F10"\)\) && openRowSheet\(menuRow\)/.test(app) && /e\.button === 2 && !el\.closest\("\[data-inline\]"\)/.test(app) && /class="sr-only row-actions" tabindex="-1" data-act="row-actions"/.test(app) && app.includes("Все действия — Shift+F10."));
ok("inline save failures keep the text as a draft and offer retry (batch10 P1-4)", /try \{\s*await DB\(\)\.putTask\(task\);\s*\} catch \{[\s\S]{0,250}keepInlineText\(cur, text\);\s*renderSheets\(true\);\s*saveFailed\(\(\) => DB\(\)\.putTask\(task\), task\.id, Date\.now\(\)\);/.test(app) && /\} catch \(err\) \{[\s\S]{0,200}state\.tasks = before\.tasks;[^\n]*\n\s*keepInlineText\(cur, text\);[\s\S]{0,80}offerUndo\(writeFailText\(err\), null\);/.test(app) && /DB\(\)\.deleteTask\(task\.id\)\.catch\(\(\) => saveFailed\(\(\) => DB\(\)\.deleteTask\(task\.id\), null, null\)\);/.test(app));
{
  const snapSrc = fs.readFileSync(path.join(root, "js/snap.js"), "utf8");
  ok("snapshot keeps rows and boxes in place: strip, tail banner, rail hours/wash/blocks (batch10 P2-6)", /rowEls\.forEach\(\(r, i\) => \{ const b = at\(r\); rows\[i\]\.y = b\.y; \}\);/.test(app) && /add\("tail", plate,/.test(app) && /add\("strip", strip,/.test(app) && /\.rail \.hour"\)\.forEach/.test(app) && /\.rail \.block"\)\.forEach/.test(app) && /boxes, sy: Math\.round\(sheet\.scrollTop\) \};/.test(app) && /var BOX = \{/.test(snapSrc) && /\/\^block-\(slot\|window\|habit\)\$\//.test(snapSrc) && /function num\(v, max\) \{ return typeof v === "number" && isFinite\(v\)/.test(snapSrc) && !/innerHTML/.test(snapSrc) && /\.row\.tail-plate, \.snap-tail \{/.test(css));
}
ok("row actions button joined by concatenation, not a raw template expression (batch10 P1-3 fix)", app.includes('` + rowActions(task) + \'<span class="ink"></span></article>\';') && !app.includes("${rowActions("));
ok("inline bar above the keyboard in #compose, one scrollable chip row with a right fade, current day hidden, hint once (batch10 P3)", /compose\.insertBefore\(bar, compose\.querySelector\("\.compose-row"\)\);\s*compose\.classList\.add\("is-inline"\);/.test(app) && /function dropBar\(bar\) \{\s*bar\.remove\(\);[\s\S]{0,80}classList\.remove\("is-inline"\)/.test(app) && !/\.bar\.remove\(\)/.test(app) && /!\(k === "tomorrow" && task\.date === tomorrow\)/.test(app) && /hintSeen\("inline"\) \? "" : "Enter — сохранить"/.test(app) && /\.inline-chips \{[^}]*overflow-x: auto;[^}]*mask-image: linear-gradient\(to right, #000 calc\(100% - 36px\), transparent\);/.test(css) && /\.compose\.is-inline #chips, \.compose\.is-inline #many, \.compose\.is-inline #ghost \{ display: none; \}/.test(css) && /\.inline-chip\.is-danger \{ color: var\(--danger\); \}/.test(css) && /"#shop-btn, #send, \.inline-bar"/.test(app));
ok("inline edit: text that is only a time/day («в 17», «завтра») sets it and keeps the title (batch10 P3)", /const INLINE_STUB = "\\u2063";/.test(app) && /stub\.title\.trim\(\) === INLINE_STUB && \(stub\.kind !== "loose" \|\| stub\.dateSpoken\)\) return \{ \.\.\.stub, title: task\.title, timeOnly: true \};/.test(app) && (() => { const st = P.parse("в 17 \u2063", { today: "2026-09-30" }); const d = P.parse("завтра \u2063", { today: "2026-09-30" }); return st.ok && st.kind === "slot" && st.startMin === 1020 && st.title.trim() === "\u2063" && d.ok && d.dateSpoken && d.date === "2026-10-01"; })());
ok("inline «удалить»: one tap, always «удалено · вернуть», failure keeps the task (batch10 P3)", /if \(how === "chip" && chip === "delete"\) \{[\s\S]{0,600}await DB\(\)\.deleteTask\(task\.id\);\s*\} catch \(err\) \{\s*state\.tasks = before\.tasks;[\s\S]{0,300}offerUndo\("удалено", \(\) => restore\(before\), null, "вернуть"\);/.test(app));
ok("inline preview keeps the task's hour when only the day is named (batch10 P3)", /const parsed = raw && raw\.kind === "loose" && task\.kind !== "loose" && task\.startMin != null\s*\? \{ \.\.\.raw, kind: task\.kind, startMin: task\.startMin, endMin: task\.endMin \}/.test(app));
{
  const cq = { today: "2026-09-29", now: 600, nowDay: "2026-09-29" };
  const pq = (t) => JSON.stringify(P.parseMany(t, cq).map((r) => `${r.kind}:${r.title}`));
  const got = [pq("купить книгу «Отцы и дети»"), pq("купить хлеб, молоко; потом врач в 9"), pq("позвонить маме; затем"), pq("потом позвонить маме"), pq('купить "Мастер и Маргарита" и хлеб')];
  ok("parseMany: no split inside «» / \"\" quotes; «потом» after «;» is not part of the title (batch10 P3)", got[0] === '["errand:книгу «Отцы и дети»"]' && got[1] === '["errand:хлеб","errand:молоко","slot:врач"]' && got[2] === '["loose:позвонить маме"]' && got[3] === '["loose:потом позвонить маме"]' && got[4] === '["errand:\\"Мастер и Маргарита\\"","errand:хлеб"]', got.join(" | "));
}
ok("hold progress: row presses in 150→450 ms (scale .97), pops back 120 ms on fire; menu starts with the row title and time (R-26)", /current\.holdTimer = setTimeout\(\(\) => \{\s*if \(drag === current && !current\.mode\) el\.classList\.add\("is-holding"\);\s*\}, HIT\.holdShow\);/.test(app) && /el\.style\.setProperty\("--hold-ms", `\$\{HIT\.press - HIT\.holdShow\}ms`\);/.test(app) && /popHold\(current\.el\);\s*openMenu\(/.test(app) && /\.row\.is-holding \{ transform: scale\(\.97\);[^}]*transition: transform var\(--hold-ms, var\(--dur-3\)\) linear/.test(css) && /\.row\.is-hold-pop \{ transform: scale\(1\); transition: transform var\(--dur-1\) var\(--ease-spring\); \}/.test(css) && /const head = menuHead\(kind, id\);\s*if \(head\) parts\.push\(head\);/.test(app) && /\.menu-head-title \{[^}]*font-size: 15px; font-weight: 600;/.test(css) && /press: 450, holdShow: 150/.test(app));
{
  const cq = { today: "2026-09-29", now: 600, nowDay: "2026-09-29" };
  const a = P.parse("купить «хлеб, молоко»", cq), b = P.parse("посмотреть «Кто, если не мы?» в 20", cq), c = P.parse("позвонить, маме", cq), d = P.parse("купить хлеб\uE001 молоко", cq);
  ok("punctuation inside quotes stays in the title; outside it is dropped as before", a.title === "«хлеб, молоко»" && b.title === "посмотреть «Кто, если не мы?»" && b.startMin === 1200 && c.title === "позвонить маме" && !/[\uE001-\uE004]/.test(d.title), [a.title, b.title, c.title, d.title].join(" | "));
}
{
  const want = {
    "с 16 до 5": "16:00-17:00", "с 17 до 5": "17:00-29:00", "с 16:59 до 5": "16:59-29:00", "с 16 до 3": "16:00-27:00",
    "с 14 до 3": "14:00-15:00", "с 14 до 3:30": "14:00-15:30", "с 13 до 3": "13:00-15:00", "с 12 до 2": "12:00-14:00",
    "с 22 до 3": "22:00-27:00", "с 14:30 до 3": "14:30-27:00", "с 16 до 6": "16:00-30:00", "с 20 до 12": "no",
    "с 16 до 5 утра": "16:00-29:00", "с 13 до 3 ночи": "13:00-27:00", "с 22 до 3 ночи": "22:00-27:00", "с 16 до 8": "16:00-20:00", "с 17 до 7": "17:00-31:00"
  };
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  const w = (t) => { const r = P.parse(t + " смена", { today: "2026-09-30" }); return r.ok && r.kind === "window" ? `${hm(r.startMin)}-${hm(r.endMin)}` : "no"; };
  const got = Object.keys(want).map(w);
  const fieldWant = { "16-5": 1020, "17-5": 1740, "16:59-5": 1740, "16-3": 1620, "14-3": 900, "14-3:30": 930, "13-3": 900, "12-2": 840, "22-3": 1620, "14:30-3": 1620 };
  const field = Object.keys(fieldWant).map((k) => ctx.ListokDay.parseWhen(k).endMin);
  ok("Q-32 (UX): a bare end hour 1–5 (with or without minutes) is +12 the same day if that gives ≥ 60 min, else night ≤ 14 h; same in the time field; «утра/ночи» on the end and ends 6–12 keep the old rules", Object.keys(want).every((k, i) => got[i] === want[k]) && P.parse("дело с 16 до 5 утра", { today: "2026-09-30" }).title === "дело" && Object.keys(fieldWant).every((k, i) => field[i] === fieldWant[k]), got.join(" ") + " | " + field.join(" "));
}
ok("R-39 strip drag (UX conditions): haptic tick on each full hour crossed, big time label above the finger, kept on screen, 15-min step", /const hour = Math\.floor\(min \/ 60\);\s*if \(d\.schedHour != null && hour !== d\.schedHour\) haptic\("tick"\);/.test(app) && /d\.schedHour = null;/.test(app) && /const x = clamp\(point\.x, half \+ 8, window\.innerWidth - half - 8\);/.test(app) && /\.drop-clock \{ font-size: 32px;/.test(css) && /const q = \(m\) => clamp\(Math\.round\(m \/ 15\) \* 15/.test(app));
ok("UX (R-23): text size is one segmented control «система · A · A+ · A++», one line, zones ≥ 44 px, full names in aria-label", app.includes('<div class="seg" role="group" aria-label="размер текста">` + size("auto", "система", "как в системе") + size("s", "A", "меньше") + size("m", "A+", "обычно") + size("l", "A++", "крупнее") + `</div>') && /\.seg \{ display: flex; flex-wrap: nowrap;/.test(css) && /\.seg-btn \{[^}]*min-width: 44px; min-height: 44px;/.test(css) && /\.seg-s \{ font-size: 13px; \}\s*\.seg-m \{ font-size: 17px; \}\s*\.seg-l \{ font-size: 21px; \}/.test(css));
ok("R-28: motion tokens --dur-0..4 / --ease-* live in :root; CSS has no bare ms or cubic-bezier outside them; reduce motion keeps opacity at --dur-1", (() => {
  const head = css.slice(0, css.indexOf("}"));
  const rest = css.slice(css.indexOf("}"));
  return /--dur-1: 120ms;/.test(head) && /--dur-2: 200ms;/.test(head) && /--dur-3: 280ms;/.test(head) && /--dur-4: 360ms;/.test(head) &&
    /--ease-out: cubic-bezier\(\.2,\.8,\.2,1\);/.test(head) && /--ease-in: cubic-bezier\(\.4,0,1,1\);/.test(head) && /--ease-sheet: cubic-bezier\(\.32,\.72,0,1\);/.test(head) && /--ease-spring: cubic-bezier\(\.3,1\.25,\.5,1\);/.test(head) &&
    !/\d{2,3}ms|cubic-bezier/.test(rest) && /prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{\s*animation: none !important;\s*transition-property: opacity !important;\s*transition-duration: var\(--dur-1\) !important;/.test(css);
})());
ok("R-28: JS reads durations/curves from the CSS tokens (M().dur/ease/tr); no numeric durations or cubic-bezier in app.js; new FLIP rows fade + 8 px at --dur-3, reduce motion keeps the opacity fade", (() => {
  const mo = fs.readFileSync(path.join(root, "js/motion.js"), "utf8");
  return !/\d{2,3}ms|cubic-bezier|duration: \d/.test(app) && /getPropertyValue\(name\)/.test(mo) && /global\.ListokMotion = \{ measure, play, reduce, dur, ease, tr \};/.test(mo) &&
    /soft\s*\? \[\{ opacity: 0 \}, \{ opacity: 1 \}\]\s*: \[\{ opacity: 0, transform: "translateY\(-8px\)" \}, \{ opacity: 1, transform: "none" \}\],\s*\{ duration: dur\(soft \? 1 : 3\), easing: soft \? "ease" : ease\("out"\) \}/.test(mo) &&
    !/duration: \d/.test(mo);
})());
ok("batch11 P2-1: week «tap empty — write» closes the week and focuses the line synchronously in the tap (no View Transition), so the iPhone keyboard comes up", /if \(act === "week-add"\) \{[\s\S]{0,400}const key = el\.dataset\.date;\s*closeOverlay\(true\);\s*if \(key && key !== state\.cursor\) goTo\(key, true\);\s*const line = \$\("#line"\);\s*if \(line\) try \{ line\.focus\(/.test(app));
ok("batch11 P2-2: a failed write on a move (menu time chips, rail → list, rail time drag, week lift) rolls memory back to `before` and shows «не сохранилось · повторить»", /async function putMoved\(task, before, redraw\) \{[\s\S]{0,200}try \{\s*await DB\(\)\.putTask\(task\);\s*return true;\s*\} catch \{\s*state\.tasks = before\.tasks;[\s\S]{0,120}saveFailed\(/.test(app) && (app.match(/if \(!\(await putMoved\(task, before(?:, redraw)?\)\)\) return;/g) || []).length === 4 && /state\.habits = before\.habits; \/\/ batch11 P2-2/.test(app));
{
  const DW = ctx.ListokDay;
  ok("batch11 P3 (mockup 04): week is full-screen, «неделя N» (ISO) with «28 сен – 4 окт» under it, gesture hint at the bottom until 3 moves, explicit «неделя» button in the header", DW.isoWeek("2026-09-28") === 40 && DW.isoWeek("2026-10-04") === 40 && DW.isoWeek("2027-01-01") === 53 && DW.isoWeek("2026-01-01") === 1 &&
    /\.sheet-ui:has\(> \.week\) \{\s*top: 0;\s*max-height: none;\s*height: var\(--vvh, 100dvh\);/.test(css) && /\.sheet-ui:has\(> \.week\) > \.grab \{ display: none; \}/.test(css) &&
    app.includes('<h2 class="week-title">${esc(`неделя ${D().isoWeek(o.start)}`)}</h2>') && app.includes('<p class="week-range">${esc(`${md(days[0])} – ${md(days[6])}`)}</p>') &&
    /const hint = moves < WEEK_HINT_MOVES \? '<p class="week-hint" aria-hidden="true">щипок наружу или тап по дню — обратно в день · держать и тянуть — перенести<\/p>'/.test(app) && /const WEEK_HINT_MOVES = 3;/.test(app) && /hints: \{ \.\.\.hints, weekMoves: moved \}/.test(app) &&
    app.includes('<button type="button" class="week-btn" id="week-btn" aria-label="неделя" title="неделя">${ico("week")}</button>') && /\$\("#week-btn"\)\.addEventListener\("click", \(\) => \{ if \(!swallowClick\) openWeek\(\); \}\);/.test(app));
}
ok("batch11 P3 (R-23): week chips, day numbers, labels and title scale with --text (no fixed px font sizes in .week-*)", /\.week-chip, \.week-more \{[^}]*font-size: calc\(var\(--text\) \* \.74\);/.test(css) && /\.week-head b \{ font-size: var\(--text\);/.test(css) && /\.week-day \{[^}]*grid-template-columns: calc\(var\(--text\) \* 2\.75\)/.test(css) && !(css.match(/\.week[\w-]*[^{]*\{[^}]*font-size: \d+px/g) || []).length);
ok("batch11 P3: the day title focused on week open shows a ring only after keyboard input (:focus-visible); after touch/pinch it is .is-quiet", /if \(cur && lastInput !== "key"\) \{\s*cur\.classList\.add\("is-quiet"\);/.test(app) && /\.week-head\.is-quiet:focus-visible \{ outline: none; \}/.test(css) && /lastInput = "key";\s*document\.querySelectorAll\("\.is-quiet"\)\.forEach\(\(el\) => el\.classList\.remove\("is-quiet"\)\);/.test(app));
ok("batch11 P3 (R-39): while scheduling, the row waits in place (faded) and a card with the title and big time sits above the finger and the strip, with a backing and shadow (dark: edge + deep shadow); built without innerHTML", /row\.style\.transform = "";\s*row\.classList\.add\("is-scheduling"\);\s*dropTime\(min, point, task\.title\);/.test(app) && /const y = Math\.max\(8, point\.y - 28 - \(tag\.offsetHeight \|\| 56\)\);/.test(app) && /name = document\.createElement\("span"\);/.test(app) && /\.row\.is-scheduling \{ opacity: \.4; box-shadow: none; \}/.test(css) && /prefers-color-scheme: dark\) \{\s*\.drop-time \{ box-shadow: 0 0 0 1px var\(--sheet-edge\), 0 12px 32px rgba\(0, 0, 0, \.7\); \}/.test(css));
ok("batch11 P3 (R-23 decision): the «выполнить» circle (html.large) only on A++, system AX1+ (root ≥ 28 px) or with an assistive click (no touch/mouse/key before it); not on A+", /document\.documentElement\.classList\.toggle\("large", size === "l" \|\| root >= AX1_PX \|\| assistive\);/.test(app) && /const AX1_PX = 28;/.test(app) && /if \(assistive \|\| !e\.isTrusted\) return;\s*const now = Date\.now\(\);\s*if \(now - lastPointerAt < 1000 \|\| now - lastKeyAt < 1000\) return;\s*assistive = true;/.test(app) && !/px > 19/.test(app));
ok("batch11 P3 (320 pt, max text): the line placeholder is ≤ 21 px and wraps instead of clipping; «рабочие часы» wrap by pairs; work days start with «пн»", /\.line\.is-empty::before \{\s*position: absolute;[^}]*font-size: min\(1em, 21px\);[^}]*white-space: normal;/.test(css) && /\.hours-pair \{ display: inline-flex;[^}]*white-space: nowrap; \}/.test(css) && (app.match(/<span class="hours-pair">/g) || []).length === 2 && /const days = \[1, 2, 3, 4, 5, 6, 0\]\.map\(\(i\) => \{\s*const name = D\(\)\.WD_SHORT\[i\];/.test(app));
ok("haptic(kind) is the only vibration call (R-25)", (app.match(/navigator\.vibrate\(/g) || []).length === 1 && /function haptic\(kind\) \{\s*try \{ if \(navigator\.vibrate\) navigator\.vibrate\(kind === "tick" \? 6 : 10\);/.test(app) && !/\bbuzz\(/.test(app));
ok("work days are real <input switch> under the touch (R-25)", /<label class="day-toggle' \+ \(on \? " is-on" : ""\) \+ '"><input type="checkbox" switch class="day-switch" data-act="work-day"/.test(app) && /\.day-switch \{[^}]*appearance: none;[^}]*position: absolute;/.test(css) && /на iPhone Safari её не даёт/.test(fs.readFileSync(path.join(root, "README.md"), "utf8")));
ok("R-23: Dynamic Type — html font -apple-system-body under @supports, --text from the system size (19 px at default), s/m/l = 94/106/124 %, capped at 28 px; --hour grows with the text and D.HOUR follows it", /@supports \(font: -apple-system-body\) \{\s*html \{ font: -apple-system-body; \}\s*:root \{ --base: calc\(1rem \* 19 \/ 17\); \}/.test(css) && /--text: min\(calc\(var\(--base\) \* var\(--scale\)\), 28px\);/.test(css) && /html\[data-text="s"\] \{ --scale: \.94; \}/.test(css) && /html\[data-text="l"\] \{ --scale: 1\.24; \}/.test(css) && /--hour: max\(48px, calc\(var\(--text\) \* 2\.5\)\);/.test(css) && D.HOUR === 48 && D.setHour(60) === 60 && D.HOUR === 60 && D.setHour(48) === 48 && /height:var\(--hour\)[\s\S]{0,200}D\(\)\.setHour\(probe\.getBoundingClientRect\(\)\.height\);/.test(app) && app.includes('size("auto", "система", "как в системе")') && /\["auto", "s", "m", "l"\]\.includes\(v\)/.test(dbSrc));

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

// R-30: разговорное время и «через N» — «сейчас» зафиксировано: ср 23.09, 12:07, рабочий день до 18.
const nowCtx = { today, now: 12 * 60 + 7, nowDay: today, workEndMin: 18 * 60 };
const spoken = [
  ["через 2 часа позвонить", (r) => r.kind === "slot" && r.startMin === 14 * 60 + 10 && r.date === today && r.relative && r.title === "позвонить"],
  ["через 20 минут выйти", (r) => r.kind === "slot" && r.startMin === 12 * 60 + 30 && r.title === "выйти"],
  ["через полчаса чай", (r) => r.startMin === 12 * 60 + 40 && r.title === "чай"],
  ["через час врач", (r) => r.startMin === 13 * 60 + 10 && r.title === "врач"],
  ["через 12 часов поезд", (r) => r.date === "2026-09-24" && r.startMin === 10 && r.title === "поезд"],
  ["купить хлеб через час", (r) => r.kind === "errand" && r.atMin === 13 * 60 + 10 && r.title === "хлеб"],
  ["через 3 дня врач", (r) => r.kind === "loose" && r.date === "2026-09-26" && r.title === "врач"],
  ["полвосьмого врач", (r) => r.startMin === 19 * 60 + 30 && r.title === "врач"],
  // решение UX (batch7 п.3): кандидат в [сейчас − 60, сейчас] — сегодня, иначе ближайший в будущем
  ["пол 12-го врач", (r) => r.date === today && r.startMin === 11 * 60 + 30 && r.title === "врач"],
  ["завтра полвосьмого бег", (r) => r.date === "2026-09-24" && r.startMin === 7 * 60 + 30 && r.title === "бег"],
  ["без пятнадцати 9 врач", (r) => r.startMin === 20 * 60 + 45 && r.title === "врач"],
  ["без пяти час обед", (r) => r.startMin === 12 * 60 + 55 && r.title === "обед"],
  ["в четверть десятого врач", (r) => r.startMin === 21 * 60 + 15 && r.title === "врач"],
  ["в 7 с половиной ужин", (r) => r.startMin === 19 * 60 + 30 && r.title === "ужин"],
  ["в обед встреча", (r) => r.startMin === 13 * 60 && r.title === "встреча"],
  ["после обеда врач", (r) => r.startMin === 14 * 60 && r.title === "врач"],
  ["днём прогулка", (r) => r.startMin === 15 * 60 && r.title === "прогулка"],
  ["после работы спорт", (r) => r.startMin === 18 * 60 + 30 && r.title === "спорт"],
  ["перед сном почитать", (r) => r.startMin === 22 * 60 + 30 && r.title === "почитать"],
  ["в 3 часа дня врач", (r) => r.kind === "slot" && r.startMin === 15 * 60 && r.date === today && r.title === "врач"],
  ["в 2 ночи поезд", (r) => r.startMin === 2 * 60 && r.title === "поезд"],
  ["в 11 ночи поезд", (r) => r.startMin === 23 * 60 && r.title === "поезд"],
  ["на выходных дача", (r) => r.date === "2026-09-26" && r.title === "дача"],
  ["к пятнице отчёт", (r) => r.date === "2026-09-25" && r.by && r.title === "отчёт"],
  ["на следующей неделе ремонт", (r) => r.date === "2026-09-28" && r.title === "ремонт"],
  ["в конце недели отчёт", (r) => r.date === "2026-09-25" && r.title === "отчёт"],
  ["в конце месяца налоги", (r) => r.date === "2026-09-30" && r.title === "налоги"],
  ["в 9:30 планёрка по будням", (r) => r.startMin === 9 * 60 + 30 && r.title === "планёрка" && /пока без повтора/.test(r.warn)],
  ["в среде разработки", (r) => r.kind === "loose" && !r.dateSpoken && r.title === "в среде разработки"]
];
spoken.forEach(([text, check]) => {
  const parsed = P.parse(text, nowCtx);
  ok(`parse R-30 «${text}»`, parsed.ok && check(parsed), JSON.stringify(parsed));
});
// review-batch2 п.7 (R-30 fix): голые часы, которые сегодня уже прошли, — вечер; полдень/полночь; «утра/вечера» после разговорного времени.
const lateCtx = { today, now: 13 * 60 + 7, nowDay: today, workEndMin: 18 * 60 };
const at = (h, m) => h * 60 + (m || 0);
const bare = [
  ["в 1 врач", { today, now: at(12, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(13) && r.title === "врач"],
  // решение UX: прошло ≤ 60 мин — сегодня (после правила «1–5 → h+12»), больше — завтра
  ["в 1 врач", lateCtx, (r) => r.date === today && r.startMin === at(13)],
  ["в 1 врач", { today, now: at(14, 1), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(13)],
  ["в 12 врач", { today, now: at(13), nowDay: today }, (r) => r.date === today && r.startMin === at(12)],
  ["в 12 врач", { today, now: at(13, 1), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(12)],
  ["в 8 врач", { today, now: at(8, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(8)],
  ["в 8 врач", { today, now: at(9, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(20)],
  ["в 8 врач", { today, now: at(21, 30), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(8)],
  ["полвосьмого врач", { today, now: at(7, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(7, 30)],
  ["полвосьмого врач", { today, now: at(19, 40), nowDay: today }, (r) => r.date === today && r.startMin === at(19, 30)],
  ["пол 12-го врач", { today, now: at(12, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(11, 30)],
  ["пол 12-го врач", { today, now: at(13), nowDay: today }, (r) => r.date === today && r.startMin === at(23, 30)],
  ["без четверти восемь врач", { today, now: at(20, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(19, 45)],
  ["в 4 врач", { today, now: at(10), nowDay: today }, (r) => r.date === today && r.startMin === at(16)],
  ["в 5 утра пробежка", { today, now: at(5, 40), nowDay: today }, (r) => r.date === today && r.startMin === at(5)],
  ["полвосьмого утра зарядка", { today, now: at(8, 10), nowDay: today }, (r) => r.date === today && r.startMin === at(7, 30)],
  ["утром зарядка", { today, now: at(13, 7), nowDay: today }, (r) => r.date === today && r.startMin === at(9)],
  ["позвонить в 5", lateCtx, (r) => r.startMin === at(17) && r.title === "позвонить"],
  ["в 7:30 врач", lateCtx, (r) => r.startMin === at(19, 30) && r.title === "врач"],
  ["в 7:30 врач", { today, now: at(7, 20), nowDay: today }, (r) => r.startMin === at(7, 30)],
  ["с 3 до 5 встреча", lateCtx, (r) => r.kind === "window" && r.startMin === at(15) && r.endMin === at(17) && r.title === "встреча"],
  ["до 5 отчёт", lateCtx, (r) => r.endMin === at(17) && r.title === "отчёт"],
  ["в 14 созвон", lateCtx, (r) => r.startMin === at(14)],
  ["в 7 утра бег", lateCtx, (r) => r.startMin === at(7) && r.title === "бег"],
  ["завтра в 7 бег", lateCtx, (r) => r.date === "2026-09-24" && r.startMin === at(7)],
  ["полвосьмого утра зарядка", lateCtx, (r) => r.startMin === at(7, 30) && r.title === "зарядка"],
  ["полдевятого вечера кино", lateCtx, (r) => r.startMin === at(20, 30) && r.title === "кино"],
  ["без десяти восемь утра бег", lateCtx, (r) => r.startMin === at(7, 50) && r.title === "бег"],
  ["в полдень обед", { today, now: at(8), nowDay: today }, (r) => r.startMin === at(12) && r.date === today && r.title === "обед"],
  ["в полдень обед", lateCtx, (r) => r.startMin === at(12) && r.date === "2026-09-24" && r.title === "обед"],
  ["в полночь сон", lateCtx, (r) => r.startMin === 0 && r.date === "2026-09-24" && r.title === "сон"],
  ["в 12 ночи сон", { today, now: at(22), nowDay: today }, (r) => r.startMin === 0 && r.date === "2026-09-24" && r.title === "сон"],
  ["в 11 врач", lateCtx, (r) => r.date === today && r.startMin === at(23) && r.title === "врач"],
  ["в 9 врач", lateCtx, (r) => r.date === today && r.startMin === at(21)],
  ["в 7 врач", lateCtx, (r) => r.date === today && r.startMin === at(19)],
  ["в 7 врач", { today, now: at(22), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(7)],
  ["в 1 врач", { today, now: at(22), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(13)],
  ["в 9 врач", { today, now: at(8), nowDay: today }, (r) => r.date === today && r.startMin === at(9)],
  // batch5 (R-30): прошедшее сегодня время без даты — завтра; идущее окно и названный день — сегодня
  ["в 12 врач", { today, now: at(12, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(12) && r.title === "врач"],
  ["в 5 утра пробежка", { today, now: at(13, 7), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(5)],
  ["полвосьмого утра зарядка", { today, now: at(13, 7), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(7, 30)],
  ["без четверти восемь утра зарядка", { today, now: at(13, 7), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(7, 45)],
  ["с 12 до 14 обед", { today, now: at(13, 7), nowDay: today }, (r) => r.date === today && r.startMin === at(12)],
  ["сегодня в 9 врач", { today, now: at(13, 7), nowDay: today }, (r) => r.date === today && r.startMin === at(21)], // batch9 п.2 (решение): день назван — ближайший впереди в этом дне,
  ["сегодня в 9 врач", lateCtx, (r) => r.date === today && r.startMin === at(21)], // batch9 п.2,
  ["с 9 до 11 встреча", lateCtx, (r) => r.date === today && r.startMin === at(21) && r.endMin === at(23)],
  ["с 9 до 11 встреча", { today, now: at(23, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(21) && r.endMin === at(23)],
  ["с 9 до 10 встреча", { today, now: at(23, 30), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(9)],
  ["с 3 до 5 встреча", { today, now: at(1), nowDay: today }, (r) => r.date === today && r.startMin === at(3) && r.endMin === at(5)],
  ["с 3 до 5 встреча", { today, now: at(10), nowDay: today }, (r) => r.date === today && r.startMin === at(15) && r.endMin === at(17)],
  ["с 3 до 5 встреча", { today, now: at(22), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(15) && r.endMin === at(17)],
  // review-batch3 п.1: голые 1–5 ночью не бывают; прошедшие «полдень», «пол-N», «без четверти N» — завтра; «8.30» — время.
  ["в 1", { today, now: at(0, 30), nowDay: today }, (r) => false],
  // решение UX: ночью (0:00–4:59) «1–5 → h+12» выключено — общее правило; с 5:00 — только h+12, но льгота сильнее
  ["в 1 врач", { today, now: at(0, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(1)],
  ["в 3 врач", { today, now: at(1), nowDay: today }, (r) => r.date === today && r.startMin === at(3)],
  ["в 3 врач", { today, now: at(4, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(15)],
  ["в 3 врач", { today, now: at(10), nowDay: today }, (r) => r.date === today && r.startMin === at(15)],
  ["в 5 врач", { today, now: at(5, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(5)],
  ["в 5 врач", { today, now: at(6, 31), nowDay: today }, (r) => r.date === today && r.startMin === at(17)],
  ["в 5:59 врач", { today, now: at(6), nowDay: today }, (r) => r.date === today && r.startMin === at(5, 59)],
  ["с 10 до 11 встреча", { today, now: at(12), nowDay: today }, (r) => r.date === today && r.startMin === at(10) && r.endMin === at(11)],
  ["с 10 до 11 встреча", { today, now: at(12, 1), nowDay: today }, (r) => r.date === today && r.startMin === at(22) && r.endMin === at(23)],
  ["в 1 врач", { today, now: at(7, 20), nowDay: today }, (r) => r.date === today && r.startMin === at(13)],
  ["в полдень обед", { today, now: at(22), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(12)],
  ["полвосьмого врач", { today, now: at(22), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(7, 30) && r.title === "врач"],
  ["полвосьмого врач", lateCtx, (r) => r.date === today && r.startMin === at(19, 30)],
  ["без четверти восемь бег", { today, now: at(22), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(7, 45) && r.title === "бег"],
  ["в 8.30 врач", lateCtx, (r) => r.date === today && r.startMin === at(20, 30) && r.title === "врач"],
  ["8.30 врач", { today, now: at(7), nowDay: today }, (r) => r.date === today && r.startMin === at(8, 30) && r.title === "врач"],
  ["с 9.30 до 11 встреча", { today, now: at(6), nowDay: today }, (r) => r.kind === "window" && r.startMin === at(9, 30) && r.endMin === at(11)],
  ["25.09 врач", lateCtx, (r) => r.date === "2026-09-25" && r.kind === "loose" && r.title === "врач"],
  ["на 12.10 врач", lateCtx, (r) => r.date === "2026-10-12" && r.kind === "loose"],
  ["через неделю отчёт", lateCtx, (r) => r.date === "2026-09-30" && r.title === "отчёт"],
  ["через 2 недели отчёт", lateCtx, (r) => r.date === "2026-10-07" && r.title === "отчёт"],
  ["без десяти восемь врач", lateCtx, (r) => r.date === today && r.startMin === at(19, 50)],
  ["в 9:30 планёрка по будням", lateCtx, (r) => r.startMin === at(9, 30) && r.title === "планёрка"],
  ["через 3 дня врач", lateCtx, (r) => r.kind === "loose" && r.date === "2026-09-26"],
  // batch6 P2: минуты написаны и прошло ≤ 60 мин — сегодня в это время, без +12; без минут правило «1–5 → h+12» остаётся.
  ["в 5:59 зарядка", { today, now: at(6), nowDay: today }, (r) => r.date === today && r.startMin === at(5, 59)],
  ["5:30 зарядка", { today, now: at(6), nowDay: today }, (r) => r.date === today && r.startMin === at(5, 30)],
  ["в 5 зарядка", { today, now: at(6), nowDay: today }, (r) => r.date === today && r.startMin === at(5)], // UX: льгота сильнее правила 1–5
  ["в 5 зарядка", { today, now: at(6, 1), nowDay: today }, (r) => r.date === today && r.startMin === at(17)],
  ["в 1:30 врач", { today, now: at(3), nowDay: today }, (r) => r.date === today && r.startMin === at(13, 30)],
  // batch6 P3: «дня» у конца диапазона уходит из названия; окна через полночь; «на 2 часа позже» — не время.
  ["с 10 до 12 дня встреча", { today, now: at(8), nowDay: today }, (r) => r.kind === "window" && r.startMin === at(10) && r.endMin === at(12) && r.title === "встреча"],
  ["с 11 вечера до 1 ночи дежурство", { today, now: at(12), nowDay: today }, (r) => r.date === today && r.startMin === at(23) && r.endMin === at(25) && r.title === "дежурство"],
  ["с 23 до 1 дежурство", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(23) && r.endMin === at(25) && r.title === "дежурство"],
  ["с 22 до 24 кино", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(22) && r.endMin === at(24) && r.title === "кино"],
  ["сегодня в 9 врач", { today, now: at(22), nowDay: today }, (r) => r.date === today && r.startMin === at(21) && r.title === "врач"], // batch9 п.2: день назван — ближайший впереди в этом дне
  ["сегодня в 9 врач", { today, now: at(8), nowDay: today }, (r) => r.date === today && r.startMin === at(9)], // batch9 п.2
  ["сегодня в 9 врач", { today, now: at(23) + 30, nowDay: today }, (r) => r.date === today && r.startMin === at(21)], // batch9 п.2: оба прошли — поздний, день не меняем
  ["сегодня в 9 врач", { today, now: at(9) + 40, nowDay: today }, (r) => r.date === today && r.startMin === at(9)], // batch9 п.2: льгота
  ["завтра в 9 врач", { today, now: at(22), nowDay: today }, (r) => r.date !== today && r.startMin === at(9)], // batch9 п.2: как было
  ["в 12 обед", { today, now: 30, nowDay: today }, (r) => r.date === today && r.startMin === 0 && r.title === "обед"], // batch9 п.3: льгота — 0:00
  ["в 12 обед", { today, now: at(10), nowDay: today }, (r) => r.date === today && r.startMin === at(12)], // batch9 п.3
  ["до 12 отчёт", { today, now: 30, nowDay: today }, (r) => r.date === today && r.endMin === at(12)], // batch9 п.3: срок «до 12» — полдень
  ["с 22 до 7 смена", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(22) && r.endMin === at(31) && r.title === "смена"],
  ["с 22 до 9 смена", { today, now: at(12), nowDay: today }, (r) => r.date === today && r.kind === "window" && r.startMin === at(22) && r.endMin === at(33) && r.title === "смена"], // Q-27 (UX): до 12:00, ≤ 14 ч
  ["с 22:30 до 10:15 дежурство", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(22) + 30 && r.endMin === at(34) + 15 && r.title === "дежурство"], // Q-27
  ["с 23 до 11 смена", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(23) && r.endMin === at(35) && r.title === "смена"], // Q-27
  ["с 22 до 12 смена", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(22) && r.endMin === at(36) && r.title === "смена"], // Q-27: ровно 36:00 и 14 ч
  ["с 20 до 9 смена", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(20) && r.endMin === at(33) && r.title === "смена"], // UX: ночная смена 13 ч
  ["с 18 до 9 смена", { today, now: at(12), nowDay: today }, (r) => r.startMin === at(18) && r.endMin === at(21)], // 15 ч через полночь — нельзя, остаётся 18–21
  ["с 10 до 3 встреча", { today, now: at(9), nowDay: today }, (r) => r.startMin === at(10) && r.endMin === at(15)], // днём — как было
  ["с 20 до 12 смена", { today, now: at(12), nowDay: today }, (r) => r.startMin == null && r.endMin == null && r.title === "с 20 до 12 смена"], // Q-27: 16 ч — не окно, текст как есть
  ["на 2 часа позже созвон", { today, now: at(12), nowDay: today }, (r) => r.kind === "loose" && r.title === "на 2 часа позже созвон"],
  ["с 9 до 3 разбор", { today, now: at(8), nowDay: today }, (r) => r.startMin === at(9) && r.endMin === at(15)],
  // Q-23 / Q-24: та же льгота 60 мин у разговорного времени и у окна
  ["полвосьмого врач", { today, now: at(19, 40), nowDay: today }, (r) => r.date === today && r.startMin === at(19, 30)],
  ["без четверти восемь врач", { today, now: at(20, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(19, 45)],
  ["полвосьмого врач", { today, now: at(20, 40), nowDay: today }, (r) => r.date === "2026-09-24" && r.startMin === at(7, 30)],
  ["с 10 до 11 встреча", { today, now: at(11, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(10)],
  ["с 10 до 11 встреча", { today, now: at(12, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(22)],
  ["с 3 до 5 встреча", { today, now: at(17, 30), nowDay: today }, (r) => r.date === today && r.startMin === at(15)]
];
bare.forEach(([text, c, check]) => {
  const parsed = P.parse(text, c);
  const empty = text === "в 1"; // только время — не задача
  ok(`parse R-30 fix «${text}» @${Math.floor(c.now / 60)}:${String(c.now % 60).padStart(2, "0")}`, empty ? !parsed.ok : parsed.ok && check(parsed), JSON.stringify(parsed));
});
// P2-6: «завтра в», «в», «через» + Enter — не задача «в».
ok("hanging preposition is not a title (P2-6)", ["завтра в", "в", "через", "к", "в 8.30", "через неделю"].every((t) => !P.parse(t, lateCtx).ok), ["завтра в", "в", "через", "к", "в 8.30", "через неделю"].map((t) => `${t}: ${JSON.stringify(P.parse(t, lateCtx).title)}`).join(", "));
ok("marks: bare hour only at the start or after a date («завтра 14»); «3 часа», «5 минут», «прочитать 3 главы» not lit (Q-22)", marked("прочитать 3 главы").length === 0 && marked("3 часа отчёт").length === 0 && marked("5 минут зарядка").length === 0 && marked("завтра 14 врач").indexOf("14") >= 0);
ok("marks: «с 7 до 9 вечера», «с 7 вечера до 9», «в 8-30» lit whole (batch5 5b)", marked("с 7 до 9 вечера кино").indexOf("с 7 до 9 вечера") >= 0 && marked("с 7 вечера до 9 кино").indexOf("с 7 вечера до 9") >= 0 && marked("в 8-30 врач").indexOf("в 8-30") >= 0 && marked("до девяти вечера сдать").indexOf("до девяти вечера") >= 0);
ok("marks: «на завтра» with «на», not «до 5 раз» / «до 15 раз», «от 2 до 4» whole (batch5 5b P3)", marked("на завтра врач").indexOf("на завтра") >= 0 && marked("до 15 раз").length === 0 && marked("до пяти раз отжаться").length === 0 && marked("от 2 до 4 встреча").indexOf("от 2 до 4") >= 0 && marked("на завтраке встреча").length === 0);
{
  const dctx = { today: "2026-09-23", now: 13 * 60 + 7, nowDay: "2026-09-23" };
  const a = P.describe(P.parse("в 13 врач", dctx), "2026-09-23", "2026-09-23");
  const b = P.describe(P.parse("в 10 врач", { ...dctx, now: 23 * 60 + 30 }), "2026-09-23", "2026-09-23");
  const c = P.describe(P.parse("купить молоко", dctx), "2026-09-23", "2026-09-23");
  ok("preview always names the day of an explicit time: «сегодня · 13», «завтра · 10» (R-30, UX)", a === "сегодня · 13 · врач" && b === "завтра · 10 · врач" && !/сегодня/.test(c), `${a} | ${b} | ${c}`);
}
{
  vm.runInContext(fs.readFileSync(path.join(root, "js/suggest.js"), "utf8"), ctx);
  const S = ctx.ListokSuggest;
  const DY = ctx.ListokDay;
  // три понедельника подряд «спорт 19:00», сегодня — четвёртый понедельник 2026-09-28
  const hist = ["2026-09-07", "2026-09-14", "2026-09-21"].map((d, i) => ({ id: "s" + i, title: i === 2 ? "Спорт" : "спорт", date: d, kind: "slot", startMin: 19 * 60 }));
  hist.push({ id: "x", title: "разовое", date: "2026-09-21", kind: "loose" });
  hist.push({ id: "old", title: "старьё", date: "2026-05-01", kind: "loose" });
  const idx = S.build(hist, "2026-09-28");
  const ch = S.chips(idx, "2026-09-28", []);
  const none = S.chips(idx, "2026-09-28", ["спорт"]);
  const tue = S.chips(idx, "2026-09-29", []);
  const comp = S.complete(idx, "сп", "2026-09-28");
  ok("R-33: index — 3 Mondays of «спорт 19:00» give a chip on the 4th Monday with 19:00; not if already today; old/one-off ignored", ch.length === 1 && ch[0].title === "Спорт" && ch[0].startMin === 19 * 60 && none.length === 0 && !idx.has("старье") && S.norm("  Ёлка, купить! ") === "елка купить", JSON.stringify(ch));
  ok("R-33: score = 2×same weekday (8 weeks) + last 14 days; Tuesday below threshold", tue.length === 0 && S.score(idx.get("спорт"), "2026-09-28").total === 2 * 3 + 2, JSON.stringify(S.score(idx.get("спорт"), "2026-09-28")));
  ok("R-33: completion «сп» → «орт» at 19:00, not from 1 letter or an exact match", comp && comp.rest === "орт" && comp.startMin === 19 * 60 && !S.complete(idx, "с", "2026-09-28") && !S.complete(idx, "спорт", "2026-09-28") && !S.complete(idx, "ра", "2026-09-28"), JSON.stringify(comp));
  ok("R-33: chips over the empty focused line; tap writes with the usual time (focus stays), hold 450 ms puts the text into the line", app.includes('<div class="chips" id="chips" hidden></div>') && /box\.addEventListener\("pointerdown"[\s\S]{0,200}e\.preventDefault\(\);/.test(app) && /hold = setTimeout\([\s\S]{0,300}writeLine\(text\)[\s\S]{0,400}HIT\.gripHold\)/.test(app) && /setTimeout\(buildSuggest, 1500\)/.test(app) && /\.chip \{[^}]*height: 36px;/.test(css));
  const mk = (title, dates) => S.build(dates.map((d, i) => ({ id: title + i, title, date: d, kind: "loose" })), "2026-09-28").get(title);
  const hw = S.habitOffer(idx.get("спорт"));
  const hi = S.habitOffer(mk("полив", ["2026-09-19", "2026-09-22", "2026-09-26"]));
  ok("R-33: habit offer — 3 same weekdays → «каждый пн» at 19:00; stable 3–4 day gap → «раз в 3–4»; 2 dates or ragged gaps → none", hw && hw.weekday === 1 && hw.everyMin === 7 && hw.timeMin === 19 * 60 && hi && hi.weekday == null && hi.everyMin === 3 && hi.everyMax === 4 && !S.habitOffer(mk("а", ["2026-09-20", "2026-09-27"])) && !S.habitOffer(mk("б", ["2026-09-01", "2026-09-10", "2026-09-12"])), JSON.stringify([hw, hi]));
  ok("R-33: habit offer asked once per title (settings.habitAsked survives the DB sanitizer)", /habitAsked: \{ \.\.\.\(state\.settings\.habitAsked \|\| \{\}\), \[key\]: 1 \}/.test(app) && dbSrc.includes("out.habitAsked[k] = 1"));
ok("batch6 P3: overnight end label «23–1», edit field «22–24» and «23:00-1:00» parse", ctx.ListokDay.rangeLabel(23 * 60, 25 * 60) === "23–1" && ctx.ListokDay.parseWhen("22-24").endMin === 1440 && ctx.ListokDay.parseWhen("23:00-1:00").endMin === 1500);
ok("batch6 P3: settings choices carry aria-pressed (incl. badge «нет / показывать»); ink follows the first line of a two-line title", (app.match(/class="choice\$\{[^}]+\}" aria-pressed="\$\{/g) || []).length >= 8 && app.includes('aria-pressed="${s.badge ? "false" : "true"}" data-act="badge"') && app.includes('el.style.setProperty("--ink-top"') && css.includes("top: var(--ink-top, 50%);"));
ok("R-27: strip label «пн 11–20» / «сб · выходной» on the left, ticks and «сейчас» in .strip-track to its right (no overlap)", app.includes('<span class="strip-label">${esc(label)}</span><span class="strip-track">') && app.includes("`${wd} · выходной`") && /\.strip-track \{ position: relative; flex: 1;/.test(css));
ok("R-33 (UX): chip tap uses R-30 grace (usual time passed >60 min → tomorrow, label «завтра 19:00»); Tab or → at line end accepts completion", /function chipDate\(c\)[\s\S]{0,300}nowMin\(\) - ref > P\(\)\.GRACE \? D\(\)\.addDays\(state\.today, 1\)/.test(app) && app.includes("date: chipDate(c)") && app.includes('"завтра " : ""') && /e\.key === "Tab"[\s\S]{0,200}e\.key === "ArrowRight"[\s\S]{0,200}acceptCompletion\(\)/.test(app) && P.GRACE === 60);
ok("R-34: deck — overlay «triage» (sheet 88 %, card 340×200, 4 buttons 72×56), gestures ← → →↓ ↑ on HIT thresholds, «шаг назад», hold 450 → удалить, summary closes itself in 1.5 s", app.includes('else if (type === "triage") html = deckHTML();') && /function deckDecide\(how, days\)/.test(app) && /function deckBack\(\)/.test(app) && /deckTimer = setTimeout\([\s\S]{0,120}\}, 1500\);/.test(app) && /\}, HIT\.gripHold\);\s*\}\);\s*card\.addEventListener\("pointermove"/.test(app) && css.includes("height: calc(var(--vvh, 100dvh) * 0.88)") && /\.deck-stack \{[^}]*width: min\(340px, 100%\); height: 200px;/.test(css) && /grid-template-columns: repeat\(4, minmax\(0, 72px\)\)/.test(css) && /\.deck-btn \{ min-height: 56px;/.test(css));
ok("R-34: entry points — tail menu «разобрать по одному», quiet line «разобрать день · N» after workEnd once a day (settings.deckOn), hold on the live line", app.includes('item("tail-deck", "разобрать по одному", "down")') && /function deckLineCount\(\)[\s\S]{0,400}nowMin\(\) < end/.test(app) && app.includes("if (onNow && state.cursor === state.today) openDeck(\"day\");") && dbSrc.includes('pick("deckOn"'));
{
  const PM = (t) => P.parseMany(t, { today: "2026-09-28", now: 12 * 60, nowDay: "2026-09-28" });
  const a = PM("завтра в 9 врач потом купить молоко и хлеб потом позвонить маме вечером");
  ok("R-35: criterion — врач tomorrow 9:00, молоко + хлеб errands, позвонить маме today 21:00", a.length === 4 && a[0].title === "врач" && a[0].date === "2026-09-29" && a[0].startMin === 540 && a[1].kind === "errand" && a[1].title === "молоко" && a[2].kind === "errand" && a[2].title === "хлеб" && a[3].title === "позвонить маме" && a[3].date === "2026-09-28" && a[3].startMin === 21 * 60, JSON.stringify(a.map((x) => [x.kind, x.title, x.date, x.startMin])));
  const b = PM("- отчёт\n- [x] зарядка\n1. позвонить\n[ ] врач; купить молоко, хлеб и яйца");
  ok("R-35: paste markers stripped, [x] → done, «купить a, b и c» → 3 errands", b.length === 7 && b[0].title === "отчёт" && b[1].title === "зарядка" && b[1].done === true && b[2].title === "позвонить" && b[3].title === "врач" && b.slice(4).every((x) => x.kind === "errand") && b[6].title === "яйца", JSON.stringify(b.map((x) => [x.title, x.done])));
  const c = PM("завтра: врач в 9; купить хлеб; в пятницу отчёт");
  ok("R-35: «завтра:» shared date for parts without their own", c.length === 3 && c[0].date === "2026-09-29" && c[1].date === "2026-09-29" && c[2].date === "2026-10-02", JSON.stringify(c.map((x) => x.date)));
  ok("R-35: commas outside errands and «потомки» do not split", PM("позвонить маме, спросить про дачу").length === 1 && PM("потомки").length === 1);
  ok("R-35: one Enter writes all parts, one undo removes all; paste/dictation newline → «; »; separators highlighted", /async function commitMany\(items, onUndo\) \{\s*const before = snapshot\(\);/.test(app) && app.includes("commitParsed(it, null, { quiet: true })") && app.includes('const text = lines.join("; ");') && /t === "insertParagraph" \|\| t === "insertLineBreak"/.test(app) && css.includes("::highlight(sep)") && app.includes('<div class="many" id="many" hidden></div>'));
}
ok("batch7: chips row pads 4px inside the scroller so the 44px ::before is not clipped; completion is a 44px button for VoiceOver, --muted rest, short heading", /\.chips \{[^}]*margin: -4px 0 4px;[^}]*padding-block: 4px;/.test(css) && /\.ghost\.is-complete \{[^}]*min-height: 44px;/.test(css) && /\.ghost-rest \{ color: var\(--muted\); \}/.test(css) && /ghost\.setAttribute\("role", "button"\);\s*ghost\.setAttribute\("aria-label", `дописать: /.test(app) && /chipList\.every\(\(c\) => c\.same > 0\) \? "обычно" : "недавно"/.test(app));
ok("batch7: blur with a visible completion keeps a one-syllable fragment as a draft", /completePhrase\(text\) && !\(ghostComp && syllables\(text\) <= 1\)\) commitComposer\(\)/.test(app));
ok("batch7: «на 2 часа позже» is not highlighted, «на 12» still is", (() => { const m = (t) => (P.marks(t) || []).length; return m("на 2 часа позже") === 0 && m("на 30 минут") === 0 && m("на 12 врач") === 1; })());
ok("batch7: live line built via DOM; under 360px «до …» and «дальше» are hidden (.now-long)", /\["now-long", " до " \+ D\(\)\.clockLabel\(line\.cur\.endMin\)\]/.test(app) && /\["now-long", "дальше "\]/.test(app) && /@media \(max-width: 359px\) \{ \.kicker \.now-long \{ display: none; \} \}/.test(css) && !/k\.innerHTML/.test(app));
ok("batch7 P3: spoken «сегодня» shows the day in the preview", P.describe(P.parse("сегодня в 11 врач", { today: "2026-09-29", now: 600, nowDay: "2026-09-29" }), "2026-09-29", "2026-09-29") === "сегодня · 11 · врач");
ok("batch8 P2-1/P2-5: deck ignores actions while a card flies; write failures go to saveFailed", /if \(!o \|\| o\.busy\) return;\s*const t = deckTask\(\);/.test(app) && /try \{ await deckFly\(how\); \} finally \{ o\.busy = false; \}/.test(app) && /o\.type !== "triage" \|\| o\.busy\) return;/.test(app) && !/function deckDecide[\s\S]{0,2500}\.catch\(\(\) => \{\}\)/.test(app.slice(app.indexOf("async function deckDecide"), app.indexOf("function deckAct("))));
ok("batch8 P2-4: after a deck decision VoiceOver hears it (role=status) and focus moves to the new card", /<p class="sr-only" id="deck-said" role="status"><\/p>/.test(app) && /function deckSay\(clear\)/.test(app) && /renderOverlay\(\);\s*deckFocus\(\);\s*if \(!deckTask\(\)\) deckFinish\(\);/.test(app) && /class="deck-card is-top" data-id="\$\{esc\(t\.id\)\}" role="group" tabindex="-1"/.test(app));
ok("batch8 P2-3/P3: deck underlay sits above the lower cards (z 1) and below the top one; buttons right under the card", /\.deck-bed \{ position: absolute; inset: 0; z-index: 1;/.test(css) && /\.deck-stack \{[^}]*margin: 10px auto 76px;/.test(css) && /\.deck-btns \{[^}]*margin-top: 0;/.test(css));
ok("batch9 п.4: the deck sheet sizes to its content (max 88% of the screen), card right under the title, ≈90 px from card to buttons", /\.sheet-ui:has\(> \.deck\) \{ max-height: calc\(var\(--vvh, 100dvh\) \* 0\.88\); height: auto;/.test(css) && /\.deck-stack \{[^}]*margin: 10px auto 76px;/.test(css));
ok("batch8 P2-2: date/live-line hold swallows clicks until release + 350 ms (the release click must not close the sheet)", /function swallowUntilRelease\(\) \{\s*swallowClick = true;/.test(app) && /haptic\("press"\);[\s\S]{0,200}swallowUntilRelease\(\);[\s\S]{0,200}openDeck\("day"\)/.test(app) && /document\.addEventListener\("pointerup", up, \{ capture: true, once: true \}\)/.test(app));
{
  const c8 = { today: "2026-09-29", now: 600, nowDay: "2026-09-29" };
  const pm8 = (t) => JSON.stringify(P.parseMany(t, c8).map((r) => `${r.kind}:${r.title}`));
  ok("batch8 P2-6: «и ещё раз» does not split; «купить хлеб и ещё молоко» — two purchases; «подарок для мамы и папы» — one; a tail with its own verb stays a task",
    pm8("позвонить маме и ещё раз папе") === '["loose:позвонить маме и ещё раз папе"]' && pm8("купить хлеб и ещё молоко") === '["errand:хлеб","errand:молоко"]' && pm8("купить подарок для мамы и папы") === '["errand:подарок для мамы и папы"]' && pm8("купить хлеб а также позвонить маме") === '["errand:хлеб","loose:позвонить маме"]' && pm8("купить молоко, хлеб и яйца") === '["errand:молоко","errand:хлеб","errand:яйца"]',
    [pm8("позвонить маме и ещё раз папе"), pm8("купить хлеб и ещё молоко"), pm8("купить подарок для мамы и папы"), pm8("купить хлеб а также позвонить маме")].join(" | "));
}
{
  const c9 = { today: "2026-09-29", now: 600, nowDay: "2026-09-29" };
  const pm9 = (t) => JSON.stringify(P.parseMany(t, c9).map((r) => r.title));
  const got = ["подумать что делать потом", "подумать что делать потом.", "потом позвонить маме", "позвонить маме потом написать папе", "проверить отчёт и ещё раз проверить"].map(pm9);
  ok("Q-28: a word separator splits only with text on both sides — «…что делать потом» keeps «потом», «и ещё раз проверить» stays whole",
    got[0] === '["подумать что делать потом"]' && /потом/.test(got[1]) && got[2] === '["потом позвонить маме"]' && got[3] === '["позвонить маме","написать папе"]' && got[4] === '["проверить отчёт и ещё раз проверить"]', got.join(" | "));
}
{
  const c9 = { today: "2026-09-29", now: 600, nowDay: "2026-09-29" };
  const pm9 = (t) => JSON.stringify(P.parseMany(t, c9).map((r) => `${r.kind}:${r.title}`));
  const got = ["купить подарок маме и папе", "купить: хлеб, молоко", "купить хлеб; ещё молоко", "купить хлеб и молоко", "позвонить маме; ещё раз папе"].map(pm9);
  ok("batch9 п.6: «подарок маме и папе» — one purchase; «купить: хлеб, молоко» — two; «купить хлеб; ещё молоко» — both purchases; «ещё раз» still no",
    got[0] === '["errand:подарок маме и папе"]' && got[1] === '["errand:хлеб","errand:молоко"]' && got[2] === '["errand:хлеб","errand:молоко"]' && got[3] === '["errand:хлеб","errand:молоко"]' && got[4] === '["loose:позвонить маме","loose:ещё раз папе"]', got.join(" | "));
}
ok("batch8 P3: more than MANY_MAX parts — the rest stays in the line and the draft; undo puts the whole line back", /const rest = many && many\.length > MANY_MAX \? many\.slice\(MANY_MAX\)/.test(app) && /writeLine\(rest\);/.test(app) && /if \(snap\.rest && cur === snap\.rest\) text = `\$\{snap\.text\}; \$\{snap\.rest\}`;/.test(app));
ok("batch9 п.5: one persistent role=status outside the sheet (text only changes), no role=status inside deckHTML; «удалить…» visible on :focus-visible; Tab is trapped inside the deck", (app.match(/role="status"/g) || []).length === 3 && !/deck-sum is-end" role="status"/.test(app) && /if \(live\.textContent !== text\) live\.textContent = text;/.test(app) && /\.deck-armkey:not\(:focus-visible\) \{ position: absolute !important;/.test(css) && /\.deck-armkey:focus-visible \{/.test(css) && /if \(e\.key === "Tab" && state\.overlay && state\.overlay\.type === "triage"\) \{ deckTrap\(e\); return; \}/.test(app) && /function deckTrap\(e\)[\s\S]{0,700}last\.focus\(\);[\s\S]{0,200}first\.focus\(\);/.test(app));
ok("batch8 P3: day pager is .pager (the .deck class belongs to the triage only); triage delete reachable without a hold (VoiceOver)", app.includes('<div class="pager" id="deck">') && /^\.pager \{ flex: 1;/m.test(css) && !/^\.deck \{ (?:flex: 1; min-height: 0; overflow|position: relative)/m.test(css) && /class="deck-armkey" data-act="deck-arm">удалить…<\/button>/.test(app) && /act === "deck-arm"\) \{\s*o\.arm = true;/.test(app));
ok("UX: window preview always names the day and time («сегодня · 22–23»)", P.describe(P.parse("с 10 до 11 встреча", { today: "2026-09-29", now: 12 * 60 + 1, nowDay: "2026-09-29" }), "2026-09-29", "2026-09-29") === "сегодня · 22–23 · встреча");
ok("Q-26/Q-27: import/restore keep a window end only if D.windowEndOk (after start; past midnight ≤ 36:00 and ≤ 14 h; no start — ≤ 24:00)", /Q-26\/Q-27[\s\S]{0,200}if \(fixed\.endMin != null && !D\(\)\.windowEndOk\(fixed\.startMin, fixed\.endMin\)\) fixed\.endMin = null;/.test(dbSrc) && /const endMin = D\(\)\.windowEndOk\(startMin, raw\.endMin\) \? raw\.endMin : null;/.test(app));
{
  const Day = ctx.ListokDay;
  const W = (st, e) => Day.windowEndOk(st, e);
  const cases = [[1320, 1980, true], [1380, 2100, true], [1320, 2160, true], [1200, 2160, false], [1320, 2161, false], [60, 1440, true], [60, 1920, false], [600, 540, false], [600, 600, false], [null, 1440, true], [null, 1500, false]];
  const pw = (t) => { const r = Day.parseWhen(t); return r.ok ? `${r.startMin}-${r.endMin}` : "no"; };
  ok("Q-27: time field «22–9» → 22–33:00, «23–11» → 23–35:00, «20–12» — not a night window", pw("22-9") === "1320-1980" && pw("23-11") === "1380-2100" && pw("20-12") === "no" && pw("22-7") === "1320-1860" && pw("20-9") === "1200-1980" && pw("18-9") === "1080-1260" && pw("10-3") === "600-900", [pw("22-9"), pw("23-11"), pw("20-12"), pw("22-7")].join(" "));
  ok("Q-27: windowEndOk / nightEnd — end ≤ 36:00, night window ≤ 14 h; «22–9» → 33:00, «20–12» stays 12:00", Day.NIGHT_END_MAX === 2160 && Day.NIGHT_LEN_MAX === 840 && cases.every(([a, b, want]) => W(a, b) === want) && Day.nightEnd(1320, 540) === 1980 && Day.nightEnd(1200, 720) === 720 && Day.nightEnd(600, 540) === 540, JSON.stringify(cases.map(([a, b]) => W(a, b))));
}
{
  // batch10 P2-5: окно через полночь проверяется до +12 к концу; начало с 13:00 — 24-часовые часы.
  const w = (t) => { const r = P.parse(t + " смена", { today: "2026-09-30" }); return r.ok && r.kind === "window" ? `${r.startMin / 60}-${r.endMin / 60}` : "no"; };
  const want = { "с 21 до 11": "21-35", "с 19 до 9": "19-33", "с 20 до 9": "20-33", "с 18 до 8": "18-32", "с 17 до 7": "17-31", "с 18 до 9": "18-21", "с 12 до 2": "12-14", "с 9 до 18": "9-18", "с 8 до 5": "8-17" };
  const got = Object.keys(want).map((k) => w(k));
  ok("night windows before the +12 bump: 21–11, 19–9, 20–9, 18–8, 17–7; 18–9 (15 h) → 18–21; «с 12 до 2» — 12–14 (batch10 P2-5)", Object.keys(want).every((k, i) => got[i] === want[k]) && ctx.ListokDay.NIGHT_START_MIN === 780 && ctx.ListokDay.parseWhen("17-7").endMin === 1860 && ctx.ListokDay.parseWhen("12-2").endMin === 840, got.join(" "));
}
ok("Q-25/Q-27: dragging/stretching keeps night windows within D.NIGHT_END_MAX (36:00) and D.NIGHT_LEN_MAX (14 h); start ≤ 23:45; a long day window never crosses midnight", /const END_MAX = D\(\)\.NIGHT_END_MAX;[\s\S]{0,60}const LEN_MAX = D\(\)\.NIGHT_LEN_MAX;[\s\S]{0,200}const endCap = \(st\) => Math\.max\(DAY, Math\.min\(END_MAX, st \+ LEN_MAX\)\);[\s\S]{0,500}const hi = dur > LEN_MAX \? DAY - dur : END_MAX - dur;/.test(app) && !/32 \* 60/.test(app + dbSrc));
ok("R-40: week view — 7 day rows Mon–Sun, up to 4 chips + «+N», today on var(--plate); arrows and a horizontal swipe change the week; tap a day opens it; tap empty space writes on that day; «неделя» in the calendar", /else if \(type === "week"\) html = weekHTML\(\);/.test(app) && /return D\(\)\.addDays\(key, -\(\(D\(\)\.dow\(key\) \+ 6\) % 7\)\);/.test(app) && /list\.slice\(0, 4\)\.map\(weekChip\)/.test(app) && /esc\(`\+\$\{list\.length - 4\}`\)/.test(app) && /\.week-day\.is-today \{ background: var\(--plate\); \}/.test(css) && /Math\.abs\(dx\) > 60 && Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.5[\s\S]{0,160}shiftWeek\(dx < 0 \? 1 : -1\);/.test(app) && /if \(act === "week-open"\) \{\s*closeWeek\(el\.dataset\.date\);/.test(app) && /if \(act === "week-add"\) \{[\s\S]{0,500}closeOverlay\(true\);[\s\S]{0,160}line\.focus/.test(app) && app.includes('data-act="open-week">неделя</button>'));
ok("R-40: hold a week chip (like the row grip: HIT.gripDrag within HIT.gripSlop), drag to another day (highlighted), release — the task moves there, time kept, undo toast; chips pan-y, a lifted chip blocks scrolling (batch11)", /\.week-chip, \.week-more \{[^}]*touch-action: pan-y;/.test(css) && /box\.addEventListener\("touchmove", \(e\) => \{\s*if \(!lift \|\| !lift\.up\) return;\s*if \(e\.cancelable\) e\.preventDefault\(\);\s*e\.stopPropagation\(\);/.test(app) && /lift\.timer = setTimeout\(\(\) => \{[\s\S]{0,500}chip\.classList\.add\("is-lifted"\);[\s\S]{0,120}\}, HIT\.gripDrag\);/.test(app) && /task\.date = to;\s*task\.order = nextOrder\(to\);/.test(app) && /offerUndo\(`на \$\{h\.short\} \$\{h\.day\}`, \(\) => restore\(before\)/.test(app) && /if \(day\) day\.classList\.add\("is-drop"\);/.test(app) && /\.week-chip\.is-lifted \{ position: fixed;[^}]*pointer-events: none;/.test(css));
ok("R-40: pinch in on the day (scale < 0.8) opens the week, pinch out (> 1.25) goes back; Safari gesture events with preventDefault, two-finger distance elsewhere; View Transitions when available", /const open = scale < 0\.8 && !o && !state\.editing && !inline;/.test(app) && /const close = scale > 1\.25 && o && o\.type === "week";/.test(app) && /swallowUntilRelease\(\); \/\/ клик от отпускания пальцев/.test(app) && /addEventListener\("gesturechange", \(e\) => \{\s*e\.preventDefault\(\);/.test(app) && /document\.startViewTransition\(fn\)/.test(app) && /bindPinch\(\);/.test(app) && /if \(drag && e\.touches && e\.touches\.length > 1\) \{ cancelDrag\(\); return; \}/.test(app) && /function begin\(e, input\) \{\s*if \(e\.touches && e\.touches\.length > 1\) return;/.test(app));
ok("R-39: a loose task dragged by its grip onto the day's hours (rail by height, strip by width, 15-min step) after 250 ms gets that time; a time tag follows the finger; a rail block pulled below the rail loses its time", /if \(scheduleHover\(drag, point\)\) return;/.test(app) && /function scheduleZone\(point\)[\s\S]{0,300}Math\.round\(m \/ 15\) \* 15[\s\S]{0,400}\/ D\(\)\.HOUR\) \* 60[\s\S]{0,500}\/ r\.width\) \* 18 \* 60/.test(app) && /Date\.now\(\) - d\.schedAt < 250/.test(app) && /const sched = current\.sched;[\s\S]{0,200}setMenuTime\(current\.id \|\| current\.el\.dataset\.id, String\(sched\)\);/.test(app) && /dragState\.y > rail\.getBoundingClientRect\(\)\.bottom \+ 24\)/.test(app) && app.includes('<div class="drop-time" id="drop-time" aria-hidden="true" hidden></div>') && /\.drop-time \{ position: fixed;/.test(css));
ok("R-39 quick step: hold menu of an open task has time chips «+1 ч · вечером · без времени · 9 · 12 · 15 · 19», applied at once with undo; night window limits kept", /const MENU_TIMES = \[\["plus1", "\+1 ч"\], \["evening", "вечером"\], \["none", "без времени"\], \["540", "9"\], \["720", "12"\], \["900", "15"\], \["1140", "19"\]\];/.test(app) && /data-act="menu-time" data-t="\$\{esc\(v\)\}"/.test(app) && /if \(act === "menu-time"\) \{[\s\S]{0,160}setMenuTime\(id, el\.dataset\.t\);/.test(app) && /D\(\)\.windowEndOk\(task\.startMin, task\.startMin \+ dur\)/.test(app) && /offerUndo\(task\.startMin == null \? "без времени"/.test(app));
ok("R-38: tap on a task's text edits it in place (loose/slot, not done): caret from caretPositionFromPoint/caretRangeFromPoint, focus in the same gesture, same parser, chips bar", /if \(!\(opts && opts\.focusTime\) && !keyed && startInline\(kind, id, e\)\) return;/.test(app) && /document\.caretPositionFromPoint[\s\S]{0,200}document\.caretRangeFromPoint/.test(app) && /task\.kind !== "loose" && task\.kind !== "slot"/.test(app) && /title\.focus\(\{ preventScroll: true \}\);[\s\S]{0,60}caretAt\(title, e\.clientX, e\.clientY\);/.test(app) && /P\(\)\.parse\(text, parseCtx\(task\.date\)\)/.test(app) && /\["more", "ещё…"\], \["today", "сегодня"\], \["tomorrow", "завтра"\], \["hour", "\+1 ч"\], \["loose", "без времени"\], \["list", "в список"\], \["delete", "удалить"\]/.test(app));
ok("R-38: Enter or tap elsewhere saves (with undo), Escape or swipe down cancels; chips keep focus; the sheet is not re-rendered mid-edit; double tap still means done", /if \(e\.key === "Enter" && !e\.isComposing\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); endInline\("save"\); \}/.test(app) && /else if \(e\.key === "Escape"\)[^\n]*endInline\("cancel"\)/.test(app) && /if \(dy > 40\) endInline\("cancel"\);/.test(app) && /bar\.addEventListener\("pointerdown", \(ev\) => \{[\s\S]{0,120}ev\.preventDefault\(\);/.test(app) && /if \(inline && !inline\.closing\) return; \/\/ R-38/.test(app) && /const inlineHit = inline && inline\.id === tap\.id;/.test(app) && /offerUndo\("исправлено", \(\) => restore\(before\)\);/.test(app) && /\.inline-bar \{[^}]*min-height: 44px;/.test(css));
ok("dialog inerts the background by id (#deck pager, #compose), never the triage .deck inside the sheet", (app.match(/\["#app > \.top", "#deck", "#compose"\]\.forEach/g) || []).length === 2 && !/\["top", "deck", "compose"\]/.test(app));
{
  const snapJs = fs.readFileSync(path.join(root, "js/snap.js"), "utf8");
  const lineTag = (app.match(/<div id="line" class="line is-empty"([^>]*)>/) || [])[1] || "";
  const attrs = [...lineTag.matchAll(/ ([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  ok("R-37: snap.js draws today's snapshot and the input line with DOM nodes only (no innerHTML), before app.js; precached", !/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(snapJs) && /raw\.day === today/.test(snapJs) && /slice\(0, 30\)/.test(snapJs) && html.indexOf('src="js/snap.js"') > html.indexOf('id="app"') && html.indexOf('src="js/snap.js"') < html.indexOf('src="js/day.js"') && sw.includes('"./js/snap.js"'));
  ok("R-37: ?day=YYYY-MM-DD opens that day (valid dates only), drops the parameter from the address; snap.js then skips today's snapshot and draft", /state\.cursor = linkDay\(\) \|\| state\.today;/.test(app) && /function linkDay\(\) \{[\s\S]{0,200}q\.delete\("day"\);[\s\S]{0,200}history\.replaceState\([\s\S]{0,200}D\(\)\.ymdValid\(/.test(app) && /if \(asked && asked\[1\] !== today\) today = null;/.test(snapJs) && /setDraft\(state\.cursor \|\| D\(\)\.todayKey\(\), typed/.test(app));
  ok("Q-29: the pre-drawn line moves the caret to the end after the first character (WebKit left it at 0 once the placeholder went away)", /var was = input\.classList\.contains\("is-empty"\);[\s\S]{0,200}if \(was && input\.textContent\) \{[\s\S]{0,120}r\.selectNodeContents\(input\);\s*r\.collapse\(false\);/.test(snapJs));
  ok("R-37: Enter on the pre-drawn line before boot is remembered and committed right after mount", /e\.key !== "Enter" \|\| e\.isComposing \|\| window\.__planinBooted\) return;\s*e\.preventDefault\(\);\s*if \(window\.__planinSnap\) window\.__planinSnap\.enter = true;/.test(snapJs) && /showStorageState\(\);[\s\S]{0,160}if \(window\.__planinSnap && window\.__planinSnap\.enter\) \{[\s\S]{0,80}if \(readLine\(\)\.trim\(\)\) commitComposer\(\);/.test(app));
  ok("R-37: the static #line has the same attributes as mount()'s", attrs.length >= 9 && attrs.every(([k, v]) => k === "contenteditable" ? snapJs.includes(`setAttribute("contenteditable", "${v}")`) : snapJs.includes(`setAttribute("${k}", "${v}")`)), JSON.stringify(attrs));
  ok("R-37: mount() builds around the pre-drawn line (never recreates it) and keeps what was typed as today's draft; snapshot written 500 ms after render", /const preLine = pre && pre\.querySelector\("\.compose-row > #line"\);/.test(app) && /if \(ch !== pre\) ch\.remove\(\)/.test(app) && /if \(typed !== given\) setDraft\(state\.cursor \|\| D\(\)\.todayKey\(\), typed/.test(app) && /snapTimer = setTimeout\(writeSnap, 500\)/.test(app) && /paintShopCount\(\);\s*scheduleSnap\(\);/.test(app));
}
ok("R-36: one hold time 450 ms everywhere (rows, blocks, grip, date, line, chips, deck) with a ring from 150 ms", /hold: 190, press: 450, holdShow: 150,/.test(app) && !/\}, 480\)/.test(app) && !/\}, 450\);/.test(app) && (app.match(/ringStart\(/g) || []).length >= 8 && /\.hold-ring \{[^}]*animation: hold-fill/.test(css));
ok("R-33: suggest.js precached and loaded before app.js", sw.includes('"./js/suggest.js"') && html.indexOf("js/suggest.js") > 0 && html.indexOf("js/suggest.js") < html.indexOf("js/app.js"));
}
ok("marks cover «8.30», «через неделю», «с двух до четырёх», not «на один» (batch3, Q-19, Q-21)", marked("с двух до четырёх встреча").indexOf("с двух до четырёх") >= 0 && marked("до пяти звонок").indexOf("до пяти") >= 0 && marked("в 8.30 врач").indexOf("в 8.30") >= 0 && marked("через 2 недели отчёт").indexOf("через 2 недели") >= 0 && !P.marks("один на один").length);
ok("«на сегодня / на завтра / на послезавтра» don't leave «на» in the title (batch2 п.18)", P.parse("на сегодня врач", lateCtx).title === "врач" && P.parse("на завтра врач", lateCtx).date === "2026-09-24" && P.parse("на завтра врач", lateCtx).title === "врач" && P.parse("на послезавтра отчёт", lateCtx).title === "отчёт" && P.parse("позвонить на завтра", lateCtx).title === "позвонить");
// Q-19: числа словом — цифры только рядом с маркером времени или срока.
{
  const q19 = [
    ["прочитать три главы", (r) => r.kind === "loose" && r.title === "прочитать три главы"],
    ["блок один", (r) => r.kind === "loose" && r.title === "блок один"],
    ["девять жизней книга", (r) => r.kind === "loose" && r.startMin == null && r.title === "девять жизней книга"],
    ["один на один", (r) => r.kind === "loose" && r.title === "один на один"],
    ["купить два молока", (r) => r.kind === "errand" && /два молока/.test(r.title)],
    ["в два врач", (r) => r.kind === "slot" && r.startMin === at(14) && r.title === "врач"],
    ["позвонить в пять", (r) => r.startMin === at(17) && r.title === "позвонить"],
    ["в семь тридцать врач", (r) => r.startMin === at(19, 30) && r.title === "врач"],
    ["через три дня врач", (r) => r.date === "2026-09-26" && r.title === "врач"],
    ["в девять вечера кино", (r) => r.startMin === at(21) && r.title === "кино"],
    ["без пяти восемь бег", (r) => r.startMin === at(19, 55) && r.title === "бег"],
    ["каждые два дня зарядка", (r) => r.kind === "habit" && r.habit.everyMin === 2 && r.title === "зарядка"],
    ["привычка мазь раз в два-три вечером", (r) => r.kind === "habit" && r.habit.everyMin === 2 && r.habit.everyMax === 3 && r.title === "мазь"],
    ["три часа дня врач", (r) => r.startMin === at(15) && r.title === "врач"],
    // Q-21: родительный и дательный после «с / до / к»
    ["с двух до четырёх встреча", (r) => r.kind === "window" && r.startMin === at(14) && r.endMin === at(16) && r.title === "встреча"],
    ["до пяти звонок", (r) => r.endMin === at(17) && r.title === "звонок"],
    ["к трём отчёт", (r) => r.startMin === at(15) && r.title === "отчёт"],
    ["у двух друзей", (r) => r.kind === "loose" && r.title === "у двух друзей"],
    ["пять минут зарядка", (r) => r.kind === "loose" && r.title === "пять минут зарядка"],
    ["5 минут зарядка", (r) => r.kind === "loose" && r.title === "5 минут зарядка"],
    // batch5 5b: часть дня на оба конца окна; «в 8-30» — 8:30, «в 9-11» — окно
    ["с 7 до 9 вечера кино", (r) => r.kind === "window" && r.startMin === at(19) && r.endMin === at(21) && r.title === "кино"],
    ["с семи до девяти вечера кино", (r) => r.kind === "window" && r.startMin === at(19) && r.endMin === at(21) && r.title === "кино"],
    ["с 7 вечера до 9 кино", (r) => r.startMin === at(19) && r.endMin === at(21) && r.title === "кино"],
    ["до девяти вечера сдать", (r) => r.startMin == null && r.endMin === at(21) && r.title === "сдать"],
    ["с 9 утра до 5 работа", (r) => r.startMin === at(9) && r.endMin === at(17) && r.title === "работа"],
    ["в 8-30 врач", (r) => r.kind === "slot" && r.startMin === at(20, 30) && r.title === "врач"],
    ["до пяти раз отжаться", (r) => r.kind === "loose" && r.title === "до пяти раз отжаться"],
    ["от двух до четырёх встреча", (r) => r.kind === "window" && r.startMin === at(14) && r.endMin === at(16) && r.title === "встреча"],
    ["от двух друзей подарок", (r) => r.kind === "loose" && r.title === "от двух друзей подарок"],
    ["в 9-11 встреча", (r) => r.kind === "window" && r.startMin === at(21) && r.endMin === at(23) && r.title === "встреча"],
    // Q-22: «N часа» без предлога — длительность; с «в / к» — время без «часа» в названии
    ["3 часа отчёт", (r) => r.kind === "loose" && r.title === "3 часа отчёт"],
    ["три часа отчёт", (r) => r.kind === "loose" && r.title === "три часа отчёт"],
    ["отчёт 3 часа", (r) => r.kind === "loose" && r.title === "отчёт 3 часа"],
    ["к 3 часам отчёт", (r) => r.startMin === at(15) && r.title === "отчёт"],
    ["в три часа отчёт", (r) => r.startMin === at(15) && r.title === "отчёт"]
  ];
  const bad = q19.filter(([t, check]) => { const r = P.parse(t, lateCtx); return !r.ok || !check(r); }).map(([t]) => `${t} → ${JSON.stringify(P.parse(t, lateCtx))}`);
  ok("number words become digits only next to a time or duration marker (Q-19, Q-21)", !bad.length, bad.join(" | "));
}
{
  const late = { today, now: at(23, 30), nowDay: today };
  ok("describe shows the day a bare hour moved to", /чт|завтра/.test(P.describe(P.parse("в 10 врач", late), today)), P.describe(P.parse("в 10 врач", late), today));
}
ok("mark noon, midnight and day-part", ["в полдень", "в полночь", "полвосьмого утра"].every((w) => marked(`${w} врач`).indexOf(w) >= 0));
ok("describe relative time", P.describe(P.parse("через 20 минут выйти", nowCtx), today).includes("→ 12:30"));
ok("describe by weekday", P.describe(P.parse("к пятнице отчёт", nowCtx), today).includes("к пт 25"));
ok("mark spoken time", ["через двадцать минут", "полвосьмого", "без пятнадцати девять", "после работы", "в 3 часа дня", "к пятнице", "на выходных"].every((w) => marked(`${w} врач`).indexOf(w) >= 0));
ok("app passes now to the parser", !/P\(\)\.parse\([^)]*\{ today:/.test(app) && app.includes("function parseCtx("));

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
ok("no regex lookbehind (Safari < 16.4)", ["js/app.js", "js/parse.js", "js/day.js", "js/db.js", "js/motion.js"].every((f) => !/\(\?<[!=]/.test(fs.readFileSync(path.join(root, f), "utf8"))));
ok("mark after punctuation", marked("(завтра) молоко").indexOf("завтра") >= 0 && marked("ну, забрать озон").length === 0);
ok("errand verb inside a phrase", P.parse("озон забрать", { today }).errandTag === "pickup" && P.parse("озон забрать", { today }).title === "озон");
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
  const weird = await DB.importAll({
    kit: "listok",
    tasks: [{ id: "ok1", kind: "loose", title: "норм", date: today }, { id: { a: 1 }, title: "x" }, { id: true }, { id: 7 }, "строка", null],
    errands: [],
    habits: []
  }, { merge: true });
  ok("import skips rows with a non-string id", weird.tasks === 1 && (await DB.listTasks()).every((t) => typeof t.id === "string"));
  await DB.importAll({
    kit: "listok",
    tasks: [{ id: "bt", kind: "bogus", title: 5, date: today, startMin: "<b>" }],
    errands: [{ id: "be", text: null, tag: "x", from: 3 }],
    habits: [{ id: "bh", title: "мазь", everyMin: "<img src=x>", everyMax: 2, nextDue: today, history: 5, weekday: 9 }],
    settings: { workDays: 3, workStartMin: "11" },
    dayMeta: { [today]: { planOrder: "x" }, junk: 7 }
  }, { merge: true });
  const bh = (await DB.listHabits()).find((h) => h.id === "bh");
  const bt = (await DB.listTasks()).find((t) => t.id === "bt");
  const be = (await DB.listErrands()).find((e) => e.id === "be");
  const bs = await DB.getSettings();
  const bm = await DB.getDayMetaAll();
  ok("import normalizes habit fields", Array.isArray(bh.history) && bh.everyMin === 1 && bh.everyMax === 2 && bh.weekday === null && D.habitState(bh, today, today) === "open");
  ok("import normalizes task and errand fields", bt.kind === "loose" && bt.title === "5" && bt.startMin === null && be.text === "" && be.tag === "buy" && be.from === null);
  ok("import normalizes settings and day meta", Array.isArray(bs.workDays) && bs.workStartMin === 11 * 60 && !("planOrder" in bm[today]) && !("junk" in bm));
  ok("import aborts the transaction on a failed put", dbSrc.includes("tx.abort()"));
  try {
    await DB.importAll({ kit: "hours-private" });
    ok("reject foreign json", false);
  } catch (err) {
    ok("reject foreign json", /Planin/.test(err.message));
  }
}

// Мини-IndexedDB для проверки ошибок записи (Q-6): обрыв соединения и квота.
function fakeIndexedDB(plan) {
  const data = { tasks: new Map(), errands: new Map(), habits: new Map(), kv: new Map() };
  const stats = { opens: 0, closes: 0 };
  const later = (fn) => setTimeout(fn, 0);
  function makeDb() {
    let closed = false;
    return {
      objectStoreNames: { contains: () => true },
      close() { closed = true; stats.closes += 1; },
      transaction(names) {
        const fail = plan.shift();
        if (fail === "lost" || closed) {
          const err = new Error("The database connection is closing.");
          err.name = "InvalidStateError";
          throw err;
        }
        const tx = { error: null };
        const store = (name) => ({
          put(v, k) { later(() => { if (fail === "quota") { tx.error = Object.assign(new Error("quota"), { name: "QuotaExceededError" }); tx.onabort && tx.onabort(); } else { data[name].set(k || v.id, v); tx.oncomplete && tx.oncomplete(); } }); return {}; },
          delete(k) { later(() => { data[name].delete(k); tx.oncomplete && tx.oncomplete(); }); return {}; },
          getAll() { const r = {}; later(() => { r.result = [...data[name].values()]; r.onsuccess && r.onsuccess(); }); return r; },
          get(k) { const r = {}; later(() => { r.result = data[name].get(k); r.onsuccess && r.onsuccess(); }); return r; },
          clear() { data[name].clear(); }
        });
        tx.objectStore = store;
        return tx;
      }
    };
  }
  return {
    stats,
    data,
    failOpens: 0,
    open() {
      stats.opens += 1;
      const req = {};
      if (this.failOpens > 0) {
        this.failOpens -= 1;
        later(() => { req.error = Object.assign(new Error("open failed"), { name: "UnknownError" }); req.onerror && req.onerror(); });
        return req;
      }
      later(() => { req.result = makeDb(); req.onsuccess && req.onsuccess(); });
      return req;
    }
  };
}

function dbSandbox(idb, ls) {
  const events = [];
  const box = {
    indexedDB: idb, setTimeout, clearTimeout, console, Promise, Map, Set, Date, Math, JSON, Error,
    localStorage: ls,
    dispatchEvent: (e) => events.push(e.detail.state),
    CustomEvent: function (type, init) { this.type = type; this.detail = init.detail; }
  };
  box.window = box;
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, "js/day.js"), "utf8"), box);
  vm.runInContext(dbSrc, box);
  return { db: box.ListokDB, events };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
}

async function reserveMerge() {
  const ls = memoryStorage();
  const idb = fakeIndexedDB([]);
  const first = dbSandbox(idb, ls);
  await first.db.init();
  await first.db.putTask({ id: "old", title: "до сбоя", updatedAt: 1 });
  // IndexedDB не открывается дважды подряд → резерв, но не молча
  idb.failOpens = 2;
  const down = dbSandbox(idb, ls);
  await down.db.init();
  ok("IndexedDB open is retried before falling back", idb.stats.opens === 3);
  ok("fallback is announced, not silent", down.db.storageInfo().backend === "local" && down.events.includes("fallback"));
  await down.db.putTask({ id: "res", title: "записано в резерв", updatedAt: 5 });
  await down.db.putTask({ id: "old", title: "старое из резерва", updatedAt: 0 });
  // IndexedDB снова работает → резерв влит, localStorage очищен
  const back = dbSandbox(idb, ls);
  await back.db.init();
  const titles = (await back.db.listTasks()).map((t) => t.title).sort();
  ok("reserve merges back into IndexedDB", titles.join("|") === "до сбоя|записано в резерв" && back.db.storageInfo().merged === 1, titles.join("|"));
  ok("reserve cleared after merge", ls.keys().filter((k) => k.startsWith("listok:")).length === 0);
  ok("blocked and versionchange handled", dbSrc.includes("req.onblocked") && dbSrc.includes("db.onversionchange") && app.includes('addEventListener("planin:storage", onStorage)'));
}

async function writeErrors() {
  const plan = [];
  const idb = fakeIndexedDB(plan);
  const box = { indexedDB: idb, setTimeout, clearTimeout, console, Promise, Map, Set, Date, Math, JSON, Error };
  box.window = box;
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, "js/day.js"), "utf8"), box);
  vm.runInContext(dbSrc, box);
  const db = box.ListokDB;
  await db.init();
  plan.push("lost");
  await db.putTask({ id: "t1", title: "после сворачивания" });
  ok("lost IndexedDB connection is reopened and the write retried", idb.data.tasks.has("t1") && idb.stats.opens === 2);
  plan.push("quota");
  let err = null;
  try { await db.putTask({ id: "t2", title: "нет места" }); } catch (e) { err = e; }
  ok("failed write rejects with PlaninWriteError (quota)", !!err && err.name === "PlaninWriteError" && err.quota === true && !idb.data.tasks.has("t2"));
  ok("composer keeps text and offers retry on a failed write", /\.catch\(\(err\) => \{\s*unparkDraft\(parked\);\s*lineWriteFailed\(err, text/.test(app) && /function lineWriteFailed[\s\S]{0,120}writeLine\(text\)/.test(app) && app.includes('"повторить"'));
  ok("failed write rolls back state", (app.match(/saveOrDrop\(DB\(\)\.put/g) || []).length >= 4);
  ok("other failed writes are not silent", /addEventListener\("unhandledrejection"[\s\S]{0,160}isWriteError/.test(app));
}

roundtrip()
  .then(writeErrors)
  .then(reserveMerge)
  .then(() => {
    console.log(failed ? `FAILED ${failed}` : "ALL PASSED");
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    ok("roundtrip", false, err.stack || err.message);
    console.log(`FAILED ${failed}`);
    process.exit(1);
  });
