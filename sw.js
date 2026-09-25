const CACHE = "listok-v1.0.22";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/day.js",
  "./js/parse.js",
  "./js/db.js",
  "./js/motion.js",
  "./js/app.js",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
  "./icons/icon-maskable.svg"
];

function isNav(req) {
  if (req.mode === "navigate") return true;
  if (req.destination === "document") return true;
  const accept = req.headers.get("accept") || "";
  return accept.indexOf("text/html") !== -1;
}

async function settled(res) {
  if (!res) return null;
  if (!res.redirected && res.type !== "opaqueredirect") return res;
  const buf = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("location");
  return new Response(buf, { status: 200, statusText: "OK", headers });
}

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(ASSETS.map(async (path) => {
    const abs = new URL(path, self.registration.scope);
    const res = await fetch(new Request(abs, { cache: "reload" }));
    if (!res || !res.ok) throw new Error("no " + path);
    const clean = await settled(res);
    await cache.put(abs.href, clean.clone());
    if (path === "./" || path === "./index.html") {
      await cache.put(self.registration.scope, clean.clone());
      await cache.put(new URL("./index.html", self.registration.scope).href, clean.clone());
    }
  }));
}

async function matchOne(cache, key) {
  try {
    return await cache.match(key, { ignoreSearch: true });
  } catch (_) {
    return null;
  }
}

async function matchCache(req) {
  const cache = await caches.open(CACHE);
  const found = await matchOne(cache, req);
  if (found) return found;
  let url;
  try { url = new URL(req.url); } catch (_) { return null; }
  const keys = [url.href];
  if (isNav(req) || url.pathname === "/" || url.pathname.endsWith("/index.html")) {
    keys.push(self.registration.scope);
    keys.push(new URL("./index.html", self.registration.scope).href);
    keys.push(new URL("./", self.registration.scope).href);
  } else {
    keys.push(new URL("." + url.pathname, self.registration.scope).href);
  }
  for (let i = 0; i < keys.length; i += 1) {
    const hit = await matchOne(cache, keys[i]);
    if (hit) return hit;
  }
  return null;
}

function offlineShell() {
  return new Response(
    `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Planin</title><style>html,body{margin:0;background:#f3f0e8;color:#1c1916;font-family:-apple-system,sans-serif}main{padding:48px 24px;text-align:center}p{color:#8a8276}@media (prefers-color-scheme:dark){html,body{background:#141311;color:#ece7df}p{color:#a39c91}}</style></head><body><main><h1>Planin</h1><p>Открой страницу один раз, пока сервер доступен. После этого день останется на телефоне.</p></main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const saved = await settled(await matchCache(req));
    if (isNav(req)) {
      if (saved) return saved;
      const shell = await settled(await matchCache(new Request(new URL("./index.html", self.registration.scope).href)));
      return shell || offlineShell();
    }
    if (saved) return saved;
    try {
      const net = await fetch(url.href);
      if (net && net.ok) {
        const clean = await settled(net);
        const cache = await caches.open(CACHE);
        await cache.put(url.href, clean.clone());
        return clean;
      }
      return net;
    } catch (_) {
      return new Response("", { status: 503, statusText: "Offline" });
    }
  })());
});
