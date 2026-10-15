/**
 * FLIP: строка переезжает на новое место, а не вспыхивает заново.
 */
(function (global) {
  function reduce() {
    return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // R-28: длительности и кривые берутся из CSS-токенов (:root в styles.css), в JS чисел нет.
  const FALL_DUR = [60, 120, 200, 280, 360];
  const FALL_EASE = { out: "cubic-bezier(.2,.8,.2,1)", in: "cubic-bezier(.4,0,1,1)", sheet: "cubic-bezier(.32,.72,0,1)", spring: "cubic-bezier(.3,1.25,.5,1)" };
  const cache = {};
  function token(name) {
    if (!(name in cache)) {
      let v = "";
      try { v = global.getComputedStyle(global.document.documentElement).getPropertyValue(name).trim(); } catch (e) { v = ""; }
      if (!v) return "";
      cache[name] = v;
    }
    return cache[name];
  }
  function dur(n) {
    const v = parseFloat(token("--dur-" + n));
    return Number.isFinite(v) ? v : FALL_DUR[n];
  }
  function ease(name) {
    return token("--ease-" + name) || FALL_EASE[name] || "ease";
  }
  function tr(prop, n, e) {
    return prop + " " + dur(n) + "ms " + ease(e || "out");
  }

  function measure(root) {
    const map = new Map();
    if (!root) return map;
    root.querySelectorAll("[data-flip]").forEach((el) => {
      map.set(el.dataset.flip, el.getBoundingClientRect());
    });
    return map;
  }

  function play(root, first) {
    if (!root || !first) return;
    const soft = reduce();
    root.querySelectorAll("[data-flip]").forEach((el) => {
      const prev = first.get(el.dataset.flip);
      if (!prev) {
        // Новая строка: проявляется и опускается на 8 px; при reduce motion — только opacity.
        el.animate(
          soft
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }],
          { duration: dur(soft ? 1 : 3), easing: soft ? "ease" : ease("out") }
        );
        return;
      }
      if (soft) return;
      const next = el.getBoundingClientRect();
      const dy = prev.top - next.top;
      const dx = prev.left - next.left;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: dur(3), easing: ease("out") }
      );
    });
  }

  global.ListokMotion = { measure, play, reduce, dur, ease, tr };
})(typeof window !== "undefined" ? window : globalThis);
