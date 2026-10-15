// Регистрация service worker. Отдельным файлом, а не inline-скриптом:
// так CSP обходится без 'unsafe-inline' и хэшей в script-src (Q-5).
(function () {
  if (!("serviceWorker" in navigator) || location.protocol.indexOf("http") !== 0) return;
  var hadController = !!navigator.serviceWorker.controller;
  var coldAsk = false;
  // Новая версия установлена и ждёт (reg.waiting): app.js выберет момент и попросит SKIP_WAITING.
  function announce() {
    if (!navigator.serviceWorker.controller || window.__planinUpdateReady) return;
    window.__planinUpdateReady = true;
    document.dispatchEvent(new Event("planin:update"));
  }
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    // Первая установка — не обновление: страницу не трогаем.
    if (!hadController) { hadController = true; return; }
    // Холодный старт: приложение ещё не нарисовано — сразу на новую версию.
    if (coldAsk && !window.__planinBooted) { location.reload(); return; }
    // Q-20: SKIP_WAITING ушёл после load — приложение уже нарисовано, перезагрузку решает app.js.
    window.__planinColdTook = coldAsk;
    coldAsk = false;
    // Новый SW взял управление (по нашей просьбе или из другой вкладки).
    window.__planinActivated = true;
    document.dispatchEvent(new Event("planin:activated"));
    announce();
  });
  function afterLoad(fn) {
    if (document.readyState === "complete") setTimeout(fn, 0);
    else window.addEventListener("load", function () { setTimeout(fn, 0); }, { once: true });
  }
  navigator.serviceWorker.register("./sw.js").then(function (reg) {
    if (reg.waiting && navigator.serviceWorker.controller) {
      // Холодный старт при уже скачанной версии: просим включить её сейчас.
      // SW согласится, только если эта вкладка единственная (иначе версии разойдутся).
      // Q-20: только после load — SKIP_WAITING до load подвешивает навигацию в Chromium.
      coldAsk = true;
      afterLoad(function () {
        if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      });
      announce();
    }
    reg.addEventListener("updatefound", function () {
      var next = reg.installing;
      if (!next) return;
      next.addEventListener("statechange", function () {
        if (next.state === "installed" && reg.waiting) announce();
      });
    });
  }).catch(function () {});
})();
