/**
 * Даты, часы, привычки, раскладка ленты. Без DOM.
 * Неделя: 0 воскресенье … 6 суббота, как Date#getDay.
 */
(function (global) {
  const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MONTHS = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ];
  const ANCHOR_MIN = { morning: 9 * 60, day: 14 * 60, evening: 21 * 60, night: 22 * 60 };
  const HOUR = 48;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function parseKey(key) {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function dayKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function todayKey(now) {
    return dayKey(now || new Date());
  }

  function addDays(key, n) {
    const dt = parseKey(key);
    dt.setDate(dt.getDate() + n);
    return dayKey(dt);
  }

  function diffDays(from, to) {
    return Math.round((parseKey(to) - parseKey(from)) / 86400000);
  }

  function dow(key) {
    return parseKey(key).getDay();
  }

  function ymdValid(y, m, d) {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function nextDow(fromKey, target, strict) {
    const cur = dow(fromKey);
    let delta = (target - cur + 7) % 7;
    if (strict && delta === 0) delta = 7;
    return addDays(fromKey, delta);
  }

  function daysWord(n) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return "день";
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "дня";
    return "дней";
  }

  function clock(h, m) {
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  function parseClockText(s) {
    let raw = String(s || "").trim().replace(/[.,]/g, ":");
    if (!raw) return null;
    raw = raw.replace(/\s+/g, ":");
    let m = raw.match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) {
      const minutes = m[2].length === 1 ? `${m[2]}0` : m[2];
      return clock(+m[1], +minutes);
    }
    m = raw.match(/^(\d{3,4})$/);
    if (m) {
      const digits = m[1].padStart(4, "0");
      return clock(+digits.slice(0, 2), +digits.slice(2));
    }
    m = raw.match(/^(\d{1,2})$/);
    if (m) return clock(+m[1], 0);
    return null;
  }

  function parseWhen(text) {
    const raw = String(text || "")
      .trim()
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[–—]/g, "-");
    if (!raw) return { ok: true, empty: true };
    let m = raw.match(/^до\s+(.+)$/);
    if (m) {
      const end = parseClockText(m[1]);
      if (end == null) return { ok: false };
      return { ok: true, empty: false, kind: "window", startMin: null, endMin: end };
    }
    m = raw.match(/^(.+?)\s*-\s*(.+)$/);
    if (m) {
      const start = parseClockText(m[1]);
      let end = parseClockText(m[2]);
      if (start == null || end == null) return { ok: false };
      if (end <= start && end < 12 * 60) end += 12 * 60;
      if (end <= start) return { ok: false };
      return { ok: true, empty: false, kind: "window", startMin: start, endMin: end };
    }
    const one = parseClockText(raw);
    if (one == null) return { ok: false };
    return { ok: true, empty: false, kind: "slot", startMin: one, endMin: null };
  }

  function clockLabel(min, opts) {
    if (min == null || Number.isNaN(min)) return "";
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (opts && opts.short && m === 0) return String(h);
    return `${h}:${pad(m)}`;
  }

  function rangeLabel(start, end) {
    if (start == null && end != null) return `до ${clockLabel(end, { short: true })}`;
    if (start != null && end == null) return clockLabel(start, { short: true });
    if (start == null) return "";
    return `${clockLabel(start, { short: true })}–${clockLabel(end, { short: true })}`;
  }

  function head(key, today) {
    const dt = parseKey(key);
    const delta = diffDays(today, key);
    let kicker = WD[dt.getDay()];
    if (delta === 0) kicker = "сегодня";
    else if (delta === 1) kicker = "завтра";
    else if (delta === -1) kicker = "вчера";
    return {
      kicker,
      weekday: WD[dt.getDay()],
      day: dt.getDate(),
      month: MONTHS[dt.getMonth()],
      short: WD_SHORT[dt.getDay()]
    };
  }

  function moveLabel(fromKey, days) {
    const target = addDays(fromKey, days);
    if (days === 1) return "на завтра";
    if (days === 2) return "на послезавтра";
    const h = head(target, fromKey);
    return `на ${h.short} ${h.day} ${h.month}`;
  }

  function workOn(key, settings) {
    return (settings.workDays || []).includes(dow(key));
  }

  function railMode(timed, meta) {
    if (meta && (meta.rail === "full" || meta.rail === "list")) return meta.rail;
    return timed.length >= 3 ? "full" : "list";
  }

  function railBounds(timed, settings) {
    let from = 6 * 60;
    let to = 24 * 60;
    void settings;
    for (const t of timed) {
      const start = t.startMin != null ? t.startMin : t.endMin != null ? t.endMin - 60 : null;
      const end = t.endMin != null ? t.endMin : t.startMin != null ? t.startMin + 45 : null;
      if (start != null) from = Math.min(from, start);
      if (end != null) to = Math.max(to, end);
    }
    from = Math.max(0, Math.floor(from / 60) * 60);
    to = Math.min(24 * 60, Math.ceil(to / 60) * 60);
    if (to <= from) to = from + 60;
    return { from, to, hour: HOUR, height: ((to - from) / 60) * HOUR };
  }

  function spanOf(item) {
    const start = item.startMin != null ? item.startMin : item.endMin != null ? Math.max(0, item.endMin - 60) : 0;
    const end = item.endMin != null ? item.endMin : item.startMin != null ? item.startMin + 30 : start + 30;
    return { start, end: Math.max(end, start + 15) };
  }

  function layoutLanes(items) {
    const sorted = items
      .map((it) => ({ ...it, ...spanOf(it) }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds = [];
    const placed = sorted.map((it) => {
      let lane = laneEnds.findIndex((end) => end <= it.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(it.end);
      } else laneEnds[lane] = it.end;
      return { ...it, lane };
    });
    const lanes = Math.max(1, laneEnds.length);
    return placed.map((p) => ({ ...p, lanes }));
  }

  function habitAt(habit) {
    if (!habit) return null;
    if (habit.timeMin != null) return habit.timeMin;
    if (habit.anchor && ANCHOR_MIN[habit.anchor] != null) return ANCHOR_MIN[habit.anchor];
    return null;
  }

  function habitState(habit, day, today) {
    if (!habit || !habit.nextDue || !day) return null;
    const everyMin = Math.max(1, habit.everyMin || 1);
    const everyMax = Math.max(everyMin, habit.everyMax || everyMin);
    const span = everyMax - everyMin;
    const due = habit.nextDue;
    const doneOnDay = (habit.history || []).some((x) => x.action === "done" && x.date === day);
    if (doneOnDay) return "done";
    if (day < today) return null;
    if (habit.weekday != null) {
      if (dow(day) === habit.weekday && day >= due) return "open";
      if (day === today && today > due) return "overdue";
      return null;
    }
    if (day < due) return null;
    const delta = diffDays(due, day);
    if (delta <= span) return delta === 0 ? "open" : "due";
    if (day === today) return "overdue";
    if (delta % everyMin === 0) return "open";
    return null;
  }

  function withHistory(habit, rec) {
    const history = [...(habit.history || []), rec].slice(-120);
    return { ...habit, history, updatedAt: Date.now() };
  }

  function markHabitDone(habit, day) {
    return withHistory(
      {
        ...habit,
        lastDone: day,
        nextDue: addDays(day, habit.everyMin || 1)
      },
      { action: "done", date: day, prevDue: habit.nextDue, prevLast: habit.lastDone || null }
    );
  }

  function undoHabitDone(habit, day) {
    const history = [...(habit.history || [])];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].action === "done" && history[i].date === day) {
        const rec = history[i];
        history.splice(i, 1);
        return {
          ...habit,
          history,
          nextDue: rec.prevDue || day,
          lastDone: rec.prevLast || null,
          updatedAt: Date.now()
        };
      }
    }
    return habit;
  }

  function shiftHabit(habit, days, today) {
    const forward = days >= 0;
    const base = forward ? (habit.nextDue > today ? habit.nextDue : today) : habit.nextDue;
    const nextDue = addDays(base, days);
    const weekday = habit.weekday == null ? null : dow(nextDue);
    return withHistory(
      { ...habit, nextDue, weekday },
      {
        action: "shift",
        date: today,
        days,
        prevDue: habit.nextDue,
        prevWeekday: habit.weekday == null ? null : habit.weekday
      }
    );
  }

  function undoHabitShift(habit) {
    const history = [...(habit.history || [])];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].action === "shift") {
        const rec = history[i];
        history.splice(i, 1);
        return {
          ...habit,
          history,
          nextDue: rec.prevDue,
          weekday: rec.prevWeekday == null ? null : rec.prevWeekday,
          updatedAt: Date.now()
        };
      }
    }
    return habit;
  }

  function habitPhrase(habit) {
    const bits = [];
    if (habit.weekday != null) bits.push(`каждый ${WD_SHORT[habit.weekday]}`);
    else if ((habit.everyMin || 1) === 1 && (habit.everyMax || 1) === 1) bits.push("каждый день");
    else if ((habit.everyMin || 1) === (habit.everyMax || 1)) {
      bits.push(`раз в ${habit.everyMin} ${daysWord(habit.everyMin)}`);
    } else bits.push(`раз в ${habit.everyMin}–${habit.everyMax}`);
    if (habit.timeMin != null) bits.push(clockLabel(habit.timeMin, { short: true }));
    else if (habit.anchor === "morning") bits.push("утро");
    else if (habit.anchor === "day") bits.push("день");
    else if (habit.anchor === "evening") bits.push("вечер");
    else if (habit.anchor === "night") bits.push("ночь");
    return bits.join(" · ");
  }

  function habitMeta(habit, st) {
    const phrase = habitPhrase(habit);
    if (st === "overdue") return `${phrase} · уже`;
    if (st === "due") return `${phrase} · пора`;
    return phrase;
  }

  function errandWaits(item, day) {
    if (!item || !item.from || !day) return false;
    const order = item.tag === "pickup" || item.tag === "order";
    return order && item.from > day;
  }

  function errandsFor(errands, day) {
    const list = (errands || [])
      .filter((e) => !errandWaits(e, day))
      .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
    return {
      open: list.filter((e) => !e.done),
      doneToday: list.filter((e) => e.done)
    };
  }

  function defaultSettings() {
    return {
      workStartMin: 11 * 60,
      workEndMin: 20 * 60,
      workDays: [1, 2, 3, 4, 5],
      seenLegend: false,
      doneStyle: "both",
      shopOpen: false,
      textSize: "m"
    };
  }

  global.ListokDay = {
    WD,
    WD_SHORT,
    MONTHS,
    HOUR,
    ANCHOR_MIN,
    dayKey,
    todayKey,
    parseKey,
    addDays,
    diffDays,
    dow,
    ymdValid,
    nextDow,
    daysWord,
    clock,
    parseClockText,
    parseWhen,
    clockLabel,
    rangeLabel,
    head,
    moveLabel,
    workOn,
    railMode,
    railBounds,
    layoutLanes,
    habitAt,
    habitState,
    markHabitDone,
    undoHabitDone,
    shiftHabit,
    undoHabitShift,
    habitPhrase,
    habitMeta,
    errandWaits,
    errandsFor,
    defaultSettings
  };
})(typeof window !== "undefined" ? window : globalThis);
