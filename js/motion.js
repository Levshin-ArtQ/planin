/**
 * FLIP: строка переезжает на новое место, а не вспыхивает заново.
 */
(function (global) {
  function reduce() {
    return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
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
    if (!root || !first || reduce()) return;
    root.querySelectorAll("[data-flip]").forEach((el) => {
      const prev = first.get(el.dataset.flip);
      const next = el.getBoundingClientRect();
      if (!prev) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-8px)" },
            { opacity: 1, transform: "none" }
          ],
          { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" }
        );
        return;
      }
      const dy = prev.top - next.top;
      const dx = prev.left - next.left;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    });
  }

  global.ListokMotion = { measure, play, reduce };
})(typeof window !== "undefined" ? window : globalThis);
