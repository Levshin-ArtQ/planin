/**
 * Математика свайпа строки. Без DOM, чтобы её можно было проверить тестом.
 *   axis(dx, dy)         — "x", "y" или null (ещё не ясно)
 *   pushSample / velocity — скорость по последним ~100 мс, px/мс
 *   decideSwipe({dx, v, W}) — "done" (влево), "defer" (вправо) или null
 *   resist(d, W)         — 1:1 до порога, дальше сопротивление, не больше max
 */
(function (global) {
  const HIT = {
    claim: 10,
    axis: 1.2,
    commit: 96,
    commitRatio: 0.28,
    flickV: 0.45,
    flickMin: 36,
    resist: 0.35,
    max: 140,
    window: 100
  };

  function axis(dx, dy) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < HIT.claim && ay < HIT.claim) return null;
    if (ax >= HIT.claim && ax > ay * HIT.axis) return "x";
    if (ay > ax) return "y";
    return null;
  }

  function pushSample(samples, x, t) {
    samples.push({ x, t });
    while (samples.length > 5) samples.shift();
    while (samples.length > 1 && t - samples[0].t > HIT.window) samples.shift();
    return samples;
  }

  function velocity(samples) {
    if (!samples || samples.length < 2) return 0;
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.x - a.x) / dt : 0;
  }

  function threshold(W) {
    return Math.min(HIT.commit, HIT.commitRatio * (W > 0 ? W : 346));
  }

  function decideSwipe({ dx, v, W }) {
    const T = threshold(W);
    const speed = v || 0;
    if (dx <= -T || (speed <= -HIT.flickV && dx <= -HIT.flickMin)) return "done";
    if (dx >= T || (speed >= HIT.flickV && dx >= HIT.flickMin)) return "defer";
    return null;
  }

  function resist(d, W) {
    const T = threshold(W);
    const a = Math.abs(d);
    const out = a <= T ? a : Math.min(HIT.max, T + (a - T) * HIT.resist);
    return d < 0 ? -out : out;
  }

  global.ListokGesture = { HIT, axis, pushSample, velocity, threshold, decideSwipe, resist };
})(typeof window !== "undefined" ? window : globalThis);
