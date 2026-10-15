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
  const ANCHOR_MIN = { morning: 9 * 60, day: 15 * 60, evening: 21 * 60, night: 22 * 60 };
  // R-23: высота часа на ленте — из CSS (--hour растёт с текстом), по умолчанию 48 px.
  let HOUR = 48;
  function setHour(px) {
    if (Number.isFinite(px) && px >= 40 && px <= 120) HOUR = Math.round(px);
    return HOUR;
  }

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
      let end = /^24(?::00)?$/.test(m[2].trim()) ? 24 * 60 : parseClockText(m[2]); // «22–24»: до полуночи
      if (start == null || end == null) return { ok: false };
      const raw2 = end;
      if (end <= start) end = nightEnd(start, raw2); // через полночь (до 12:00, не дольше 14 ч): «20–9» — ночь
      if (end <= start && end < 12 * 60) end += 12 * 60;
      if (end <= start) return { ok: false };
      return { ok: true, empty: false, kind: "window", startMin: start, endMin: end };
    }
    const one = parseClockText(raw);
    if (one == null) return { ok: false };
    return { ok: true, empty: false, kind: "slot", startMin: one, endMin: null };
  }

  // Окно через полночь: конец хранится как 24:00 + N, не дальше 12:00 следующих суток (36:00),
  // и такое окно длится не больше 14 ч (UX, Q-27). Окно в пределах суток — любой длины.
  const NIGHT_END_MAX = 36 * 60;
  const NIGHT_LEN_MAX = 14 * 60;
  // batch10 P2-5: начало с 13:00 записано по 24-часовым часам — конец меньше начала читается буквально,
  // через полночь («с 17 до 7» → 17–7), без +12. «с 12 до 2» — по-прежнему обед 12–14.
  const NIGHT_START_MIN = 13 * 60;
  const NIGHT_MIN_DAY = 60; // Q-32: дневное окно с концом 1–5 (+12) — не короче часа
  function nightEnd(start, end, spoken) {
    if (end > start || start < NIGHT_START_MIN) return end;
    const next = end + 24 * 60;
    // Q-32 (UX): конец — голый час 1–5 (можно с минутами). Сначала тот же день +12: если окно
    // не короче часа — дневное («с 16 до 5» → 16–17, «с 14 до 3:30» → 14–15:30); иначе через полночь,
    // если ≤ 14 ч («с 17 до 5», «с 14:30 до 3» — ночь); иначе не окно. Конец с «утра/ночи» (spoken) — не голый час.
    if (!spoken && end >= 60 && end < 6 * 60) {
      const day = end + 12 * 60;
      if (day - start >= NIGHT_MIN_DAY) return day;
      return next - start <= NIGHT_LEN_MAX ? next : end;
    }
    return next <= NIGHT_END_MAX && next - start <= NIGHT_LEN_MAX ? next : end;
  }
  function windowEndOk(start, end) {
    if (!Number.isInteger(end) || end < 0 || end > NIGHT_END_MAX) return false;
    if (start == null) return end <= 24 * 60;
    return end > start && (end <= 24 * 60 || end - start <= NIGHT_LEN_MAX);
  }

  function clockLabel(min, opts) {
    if (min == null || Number.isNaN(min)) return "";
    // Конец окна через полночь хранится как 24:00 + N: показываем часы следующих суток (25:00 → 1:00).
    const h = min > 24 * 60 ? Math.floor(min / 60) - 24 : Math.floor(min / 60);
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

  // batch11 (макет 04): номер недели по ISO 8601 (неделя с понедельника; первая — с первым четвергом года).
  function isoWeek(key) {
    const thu = addDays(key, 3 - ((dow(key) + 6) % 7));
    const jan1 = `${thu.slice(0, 4)}-01-01`;
    return 1 + Math.floor(diffDays(jan1, thu) / 7);
  }

  // R-31: подпись прошлого дня — день недели до 6 дней назад, старше — дата («1 сен»).
  const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  function dayTag(key, today) {
    const dt = parseKey(key);
    if (diffDays(key, today) > 6) return `${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()]}`;
    return WD_SHORT[dt.getDay()];
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
    const end = item.endMin != null ? Math.min(item.endMin, 24 * 60) : item.startMin != null ? item.startMin + 30 : start + 30;
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

  // R-32: что идёт сейчас и что дальше на этом дне. Идёт — окно с началом и концом, now внутри;
  // из нескольких — то, что кончается раньше. Дальше — ближайшее открытое дело со временем начала > now.
  const SLOT_LIVE = 15;
  function nowLine(tasks, day, nowMin) {
    const open = (tasks || []).filter((t) => t && t.date === day && !t.done && (t.kind === "window" || t.kind === "slot") && t.startMin != null);
    const cur = open
      .filter((t) => t.kind === "window" && t.endMin != null && t.startMin <= nowMin && nowMin < t.endMin)
      .sort((a, b) => a.endMin - b.endMin || a.startMin - b.startMin)[0]
      // batch6 P3: час без конца, который уже начался, «идёт» ещё ~15 минут.
      || open
        .filter((t) => t.kind === "slot" && t.startMin <= nowMin && nowMin < t.startMin + SLOT_LIVE)
        .sort((a, b) => b.startMin - a.startMin)[0]
      || null;
    const next = open
      .filter((t) => t !== cur && t.startMin > nowMin)
      .sort((a, b) => a.startMin - b.startMin || (a.order || 0) - (b.order || 0))[0] || null;
    if (!cur && !next) return null;
    return { cur, next, inMin: next ? next.startMin - nowMin : null };
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
      textSize: "auto",
      tailDays: 14,
      autoCarry: false
    };
  }

  global.ListokDay = {
    WD,
    WD_SHORT,
    MONTHS,
    MONTHS_SHORT,
    isoWeek,
    get HOUR() { return HOUR; },
    setHour,
    ANCHOR_MIN,
    NIGHT_END_MAX,
    NIGHT_LEN_MAX,
    nightEnd,
    NIGHT_START_MIN,
    windowEndOk,
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
    dayTag,
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
    nowLine,
    defaultSettings
  };
})(typeof window !== "undefined" ? window : globalThis);
