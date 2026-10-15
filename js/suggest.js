/* Planin: подсказки из собственной истории (R-33). Всё локально, без сети.
 * Индекс по нормализованному названию: {title, count, dates[], starts[], lastDate}.
 * Строится из задач за 90 дней после первой отрисовки и дополняется при вписывании. */
(function (global) {
  "use strict";

  const DAYS = 90;
  const D = () => global.ListokDay;

  function norm(title) {
    return String(title || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function create() {
    return new Map();
  }

  function add(index, task, today) {
    if (!task || task.draft || !task.title || !task.date) return;
    if (today && D().diffDays(task.date, today) > DAYS) return;
    const key = norm(task.title);
    if (!key) return;
    const e = index.get(key) || { key, title: task.title, count: 0, dates: [], starts: [], ends: [], lastDate: "" };
    e.count += 1;
    e.dates.push(task.date);
    if (task.startMin != null) e.starts.push(task.startMin);
    if (task.kind === "window" && task.endMin != null) e.ends.push(task.endMin);
    if (task.date >= e.lastDate) {
      e.lastDate = task.date;
      e.title = task.title; // последнее написание — самое свежее
    }
    index.set(key, e);
  }

  function build(tasks, today) {
    const index = create();
    (tasks || []).forEach((t) => add(index, t, today));
    return index;
  }

  function median(list) {
    if (!list.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
  }

  // Типичное время: только если время было хотя бы у половины повторов.
  function typical(e) {
    if (e.starts.length * 2 < e.count) return { startMin: null, endMin: null };
    const startMin = median(e.starts);
    const endMin = e.ends.length * 2 >= e.starts.length ? median(e.ends) : null;
    return { startMin, endMin: endMin != null && endMin > startMin ? endMin : null };
  }

  // Счёт: 2 × (сколько раз в этот день недели за 8 недель) + (сколько раз за 14 дней).
  function score(e, day) {
    const dow = D().dow(day);
    let same = 0;
    let recent = 0;
    for (const d of e.dates) {
      const ago = D().diffDays(d, day);
      if (ago <= 0) continue;
      if (ago <= 56 && D().dow(d) === dow) same += 1;
      if (ago <= 14) recent += 1;
    }
    return { total: 2 * same + recent, same };
  }

  // До 3 чипов для дня; то, что уже есть в этом дне, не предлагаем. Порог — счёт ≥ 3.
  function chips(index, day, existingTitles, limit) {
    const have = new Set((existingTitles || []).map(norm));
    const out = [];
    index.forEach((e) => {
      if (have.has(e.key) || e.count < 2) return; // разовое — не «обычно»
      const sc = score(e, day);
      if (sc.total < 3) return;
      out.push({ key: e.key, title: e.title, score: sc.total, same: sc.same, ...typical(e) });
    });
    out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "ru"));
    return out.slice(0, limit || 3);
  }

  // Дополнение: от 2 символов, по началу названия (регистр и ё не важны). Лучший — по счёту, затем по числу повторов.
  function complete(index, text, day) {
    const raw = String(text || "");
    const typed = norm(raw);
    if (typed.length < 2 || /\s$/.test(raw) && !typed) return null;
    let best = null;
    index.forEach((e) => {
      if (e.count < 2 || e.key === typed || !e.key.startsWith(typed)) return;
      const sc = score(e, day).total;
      if (!best || sc > best.sc || (sc === best.sc && e.count > best.e.count)) best = { e, sc };
    });
    if (!best) return null;
    const title = best.e.title;
    // Хвост считаем по исходному названию: длина набранного в нём та же после нормализации только
    // если набрано буквами без пунктуации — иначе дополняем целиком.
    const head = title.slice(0, raw.trimStart().length);
    const rest = norm(head) === typed ? title.slice(head.length) : null;
    if (rest == null || !rest) return null;
    return { title, rest, ...typical(best.e) };
  }

  // «сделать привычкой?»: ≥ 3 разных дня и ровный ритм — один день недели (каждую неделю)
  // или одинаковый интервал (разброс ≤ 1 дня, от 1 до 14 дней). Смотрим последние 4 раза.
  function habitOffer(e) {
    if (!e) return null;
    const dates = Array.from(new Set(e.dates)).sort().slice(-4);
    if (dates.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) gaps.push(D().diffDays(dates[i - 1], dates[i]));
    const lo = Math.min(...gaps);
    const hi = Math.max(...gaps);
    const t = typical(e);
    if (lo === 7 && hi === 7) return { weekday: D().dow(dates[dates.length - 1]), everyMin: 7, everyMax: 7, timeMin: t.startMin };
    if (lo >= 1 && hi <= 14 && hi - lo <= 1) return { weekday: null, everyMin: lo, everyMax: hi, timeMin: t.startMin };
    return null;
  }

  global.ListokSuggest = { DAYS, norm, create, add, build, chips, complete, typical, score, habitOffer };
})(typeof window !== "undefined" ? window : globalThis);
