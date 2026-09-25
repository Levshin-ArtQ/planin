/**
 * Свой язык строки. Ключевые слова собраны сверху — их можно добавлять.
 *
 * Дата: сегодня, завтра, послезавтра, через 3, +2, 23.09, пн, в среду, след пн
 * Час: 14, 14:30, в 14, в четырнадцать тридцать, 8 вечера
 * Окно: 12-14, с 12 до 14, до 16, с утра до 12
 * Список: купить, забрать, заказать. Забор и заказ можно спрятать до дня: в пятницу забрать озон, забрать озон с пятницы
 * Привычка: привычка, раз в 2-3, каждые 2, каждый пн, вечером / утром
 *
 * Голос и клавиатура разбираются одним и тем же разбором.
 */
(function (global) {
  const D = () => global.ListokDay;

  const LETTER = "A-Za-zА-Яа-яЁё0-9";
  const WD_ALT =
    "понедельника|понедельник|вторника|вторник|среду|среды|среда|четверга|четверг|пятницу|пятницы|пятница|субботу|субботы|суббота|воскресенья|воскресенье|пн|вт|ср|чт|пт|сб|вс";
  const WD_MAP = {
    пн: 1, понедельник: 1, понедельника: 1,
    вт: 2, вторник: 2, вторника: 2,
    ср: 3, среда: 3, среду: 3, среды: 3,
    чт: 4, четверг: 4, четверга: 4,
    пт: 5, пятница: 5, пятницу: 5, пятницы: 5,
    сб: 6, суббота: 6, субботу: 6, субботы: 6,
    вс: 0, воскресенье: 0, воскресенья: 0
  };

  const ERRAND_VERBS = [
    { body: "купить|купи|покупка", tag: "buy", say: "купить" },
    { body: "забрать|забери|забор", tag: "pickup", say: "забрать" },
    { body: "заказать|закажи|заказ", tag: "order", say: "заказать" }
  ];

  const NUM_WORDS = [
    ["сорок пять", "45"],
    ["тридцать", "30"],
    ["сорок", "40"],
    ["пятьдесят", "50"],
    ["двадцать три", "23"],
    ["двадцать два", "22"],
    ["двадцать один", "21"],
    ["двадцать", "20"],
    ["девятнадцать", "19"],
    ["восемнадцать", "18"],
    ["семнадцать", "17"],
    ["шестнадцать", "16"],
    ["пятнадцать", "15"],
    ["четырнадцать", "14"],
    ["тринадцать", "13"],
    ["двенадцать", "12"],
    ["одиннадцать", "11"],
    ["десять", "10"],
    ["девять", "9"],
    ["восемь", "8"],
    ["семь", "7"],
    ["шесть", "6"],
    ["пять", "5"],
    ["четыре", "4"],
    ["три", "3"],
    ["два", "2"],
    ["один", "1"],
    ["одну", "1"],
    ["одна", "1"],
    ["ноль", "0"]
  ];

  function edgeRe(body, flags) {
    return new RegExp(`(^|[^${LETTER}])(?:${body})(?=$|[^${LETTER}])`, flags || "i");
  }

  function verbalNumbers(s) {
    let out = s;
    for (const [w, n] of NUM_WORDS) {
      const re = new RegExp(`(^|[^${LETTER}])${w}(?=$|[^${LETTER}])`, "giu");
      out = out.replace(re, `$1${n}`);
    }
    return out;
  }

  function prep(raw) {
    let s = String(raw || "")
      .replace(/[–—]/g, "-")
      .replace(/[,!?;]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    s = verbalNumbers(s);
    s = s.replace(new RegExp(`(^|[^${LETTER}])(\\d{1,2})\\s+час(?:а|ов)?(?=$|[^${LETTER}])`, "giu"), "$1$2");
    return s.replace(/\s+/g, " ").trim();
  }

  function consume(s, re) {
    const m = re.exec(s);
    if (!m) return null;
    const next = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
    return { next, m };
  }

  function leftmost(s, specs) {
    let best = null;
    for (const spec of specs) {
      const m = spec.re.exec(s);
      if (!m) continue;
      if (!best || m.index < best.m.index) best = { spec, m };
    }
    if (!best) return null;
    const { m } = best;
    const next = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
    return { next, m, spec: best.spec };
  }

  function cleanTitle(s) {
    return s
      .replace(/\s+/g, " ")
      .replace(/^[\s.:;-]+|[\s.:;-]+$/g, "")
      .trim();
  }

  function dateWord(today, key) {
    const n = D().diffDays(today, key);
    if (n === 0) return null;
    if (n === 1) return "завтра";
    if (n === 2) return "послезавтра";
    const h = D().head(key, today);
    return `${h.short} ${h.day}`;
  }

  function takeWeekly(s, result, ctx) {
    const re = new RegExp(
      `(^|[^${LETTER}])кажд(?:ый|ую|ое|ые)\\s+(?:(?:в|во|на)\\s+)?(${WD_ALT})(?=$|[^${LETTER}])`,
      "i"
    );
    const hit = consume(s, re);
    if (!hit) return s;
    const word = hit.m[2].toLowerCase();
    const weekday = WD_MAP[word];
    result.kind = "habit";
    result.habit = result.habit || blankHabit();
    result.habit.weekday = weekday;
    result.habit.everyMin = 7;
    result.habit.everyMax = 7;
    result.date = D().nextDow(ctx.today, weekday, false);
    result.dateSpoken = true;
    return hit.next;
  }

  function blankHabit() {
    return { everyMin: 1, everyMax: 1, weekday: null, anchor: null, timeMin: null };
  }

  function takeDate(s, result, ctx) {
    const day = D();
    const wdStrict = new RegExp(
      `(?:^|\\s)след(?:ующ(?:ий|ую|ее))?\\s+(?:(?:в|во|на)\\s+)?(${WD_ALT})(?=$|[^${LETTER}])`,
      "i"
    );
    const wdPrep = new RegExp(`(?:^|\\s)(?:в|во|на)\\s+(${WD_ALT})(?=$|[^${LETTER}])`, "i");
    const wdBare = new RegExp(`(?:^|\\s)(${WD_ALT})(?=$|[^${LETTER}])`, "i");
    const specs = [
      {
        re: edgeRe("сегодня"),
        apply() {
          result.date = ctx.today;
          result.dateSpoken = true;
        }
      },
      {
        re: edgeRe("послезавтра"),
        apply() {
          result.date = day.addDays(ctx.today, 2);
          result.dateSpoken = true;
        }
      },
      {
        re: edgeRe("завтра"),
        apply() {
          result.date = day.addDays(ctx.today, 1);
          result.dateSpoken = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)через\\s+(\\d{1,3})(?:\\s*(?:дня|дней|день|дн))?(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          result.date = day.addDays(ctx.today, +m[1]);
          result.dateSpoken = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)\\+(\\d{1,3})(?:\\s*(?:дня|дней|день|дн))?(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          result.date = day.addDays(ctx.today, +m[1]);
          result.dateSpoken = true;
        }
      },
      {
        re: /(?:^|\s)(?:на\s+)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=$|[^\d])/i,
        apply(m) {
          const today = day.parseKey(ctx.today);
          let y = m[3] ? +m[3] : today.getFullYear();
          if (y < 100) y += 2000;
          const month = +m[2];
          const d = +m[1];
          if (!day.ymdValid(y, month, d)) return false;
          let key = `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          if (!m[3] && key < ctx.today) {
            y += 1;
            if (!day.ymdValid(y, month, d)) return false;
            key = `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          }
          result.date = key;
          result.dateSpoken = true;
          return true;
        }
      },
      {
        re: wdStrict,
        apply(m) {
          result.date = day.nextDow(ctx.today, WD_MAP[m[1].toLowerCase()], true);
          result.dateSpoken = true;
        }
      },
      {
        re: wdPrep,
        apply(m) {
          result.date = day.nextDow(ctx.today, WD_MAP[m[1].toLowerCase()], false);
          result.dateSpoken = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)(?:начиная\\s+)?(?:с|со)\\s+(${WD_ALT})(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          result.date = day.nextDow(ctx.today, WD_MAP[m[1].toLowerCase()], false);
          result.dateSpoken = true;
        }
      },
      {
        re: wdBare,
        apply(m) {
          result.date = day.nextDow(ctx.today, WD_MAP[m[1].toLowerCase()], false);
          result.dateSpoken = true;
        }
      }
    ];
    const pool = specs.slice();
    while (pool.length) {
      const hit = leftmost(s, pool);
      if (!hit) return s;
      if (hit.spec.apply(hit.m) === false) {
        pool.splice(pool.indexOf(hit.spec), 1);
        continue;
      }
      return hit.next;
    }
    return s;
  }

  function takeHabit(s, result) {
    let cur = s;
    let habit = result.kind === "habit";
    const intervals = [
      new RegExp(`(?:^|\\s)раз\\s+в\\s+(\\d{1,3})\\s*-\\s*(\\d{1,3})(?:\\s*(?:дня|дней|день|дн))?(?=$|[^${LETTER}])`, "i"),
      new RegExp(`(?:^|\\s)раз\\s+в\\s+(\\d{1,3})(?:\\s*(?:дня|дней|день|дн))?(?=$|[^${LETTER}])`, "i"),
      new RegExp(`(?:^|\\s)каждые\\s+(\\d{1,3})\\s*-\\s*(\\d{1,3})(?:\\s*(?:дня|дней|день|дн))?(?=$|[^${LETTER}])`, "i"),
      new RegExp(`(?:^|\\s)каждые\\s+(\\d{1,3})(?:\\s*(?:дня|дней|день|дн))?(?=$|[^${LETTER}])`, "i"),
      new RegExp(`(?:^|\\s)кажд(?:ый|ую|ое|ые)\\s+день(?=$|[^${LETTER}])`, "i")
    ];
    for (const re of intervals) {
      const hit = consume(cur, re);
      if (!hit) continue;
      habit = true;
      const h = result.habit || blankHabit();
      if (hit.m[1] && hit.m[2]) {
        h.everyMin = Math.min(+hit.m[1], +hit.m[2]);
        h.everyMax = Math.max(+hit.m[1], +hit.m[2]);
      } else if (hit.m[1]) {
        h.everyMin = +hit.m[1];
        h.everyMax = +hit.m[1];
      } else {
        h.everyMin = 1;
        h.everyMax = 1;
      }
      result.habit = h;
      cur = hit.next;
      break;
    }
    const word = consume(cur, new RegExp(`(?:^|\\s)привычка(?=$|[^${LETTER}])`, "i"));
    if (word) {
      habit = true;
      result.habit = result.habit || blankHabit();
      cur = word.next;
    }
    const anchors = [
      ["evening", new RegExp(`(?:^|\\s)вечером(?=$|[^${LETTER}])`, "i")],
      ["morning", new RegExp(`(?:^|\\s)утром(?=$|[^${LETTER}])`, "i")],
      ["day", new RegExp(`(?:^|\\s)дн[её]м(?=$|[^${LETTER}])`, "i")],
      ["night", new RegExp(`(?:^|\\s)ночью(?=$|[^${LETTER}])`, "i")]
    ];
    for (const [name, re] of anchors) {
      const hit = consume(cur, re);
      if (!hit) continue;
      if (habit) {
        result.habit = result.habit || blankHabit();
        result.habit.anchor = name;
      } else {
        result.softAnchor = name;
      }
      cur = hit.next;
    }
    if (habit) result.kind = "habit";
    return cur;
  }

  function takeErrand(s, result) {
    if (result.kind === "habit") return s;
    const claim = (verb, index, length) => {
      result.kind = "errand";
      result.errandTag = verb.tag;
      result.errandSay = verb.say;
      return `${s.slice(0, index)} ${s.slice(index + length)}`.replace(/\s+/g, " ").trim();
    };
    for (const verb of ERRAND_VERBS) {
      const m = new RegExp(`^(?:${verb.body})(?=$|[^${LETTER}])`, "i").exec(s);
      if (m) return claim(verb, 0, m[0].length);
    }
    for (const verb of ERRAND_VERBS) {
      if (verb.tag === "buy") continue;
      const m = new RegExp(wordRe(verb.body), "i").exec(s);
      if (m) return claim(verb, m.index, m[0].length);
    }
    return s;
  }

  function applyClock(result, start, end, asRange) {
    if (result.kind === "habit") {
      result.habit = result.habit || blankHabit();
      result.habit.timeMin = start != null ? start : end;
      return;
    }
    if (result.kind === "errand") {
      result.atMin = start != null ? start : end;
      return;
    }
    if (asRange) {
      result.kind = "window";
      result.startMin = start;
      result.endMin = end;
      return;
    }
    result.kind = "slot";
    result.startMin = start;
    result.endMin = null;
  }

  function takeTime(s, result) {
    const specs = [
      {
        re: /(?:^|\s)с\s+утра\s+до\s+(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          const end = D().clock(+m[1], m[2] ? +m[2] : 0);
          if (end == null) return false;
          applyClock(result, 9 * 60, end, true);
          return true;
        }
      },
      {
        re: /(?:^|\s)с\s+(\d{1,2})(?::(\d{2}))?\s+до\s+вечера(?=$|\s)/i,
        apply(m) {
          const start = D().clock(+m[1], m[2] ? +m[2] : 0);
          if (start == null) return false;
          applyClock(result, start, 21 * 60, true);
          return true;
        }
      },
      {
        re: /(?:^|\s)с\s+(\d{1,2})(?::(\d{2}))?\s+до\s+(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          return applyRange(result, +m[1], m[2] ? +m[2] : 0, +m[3], m[4] ? +m[4] : 0);
        }
      },
      {
        re: /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          return applyRange(result, +m[1], m[2] ? +m[2] : 0, +m[3], m[4] ? +m[4] : 0);
        }
      },
      {
        re: /(?:^|\s)до\s+(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          const end = D().clock(+m[1], m[2] ? +m[2] : 0);
          if (end == null) return false;
          applyClock(result, null, end, true);
          return true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)(?:(?:в|на|к)\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s+вечера(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          let h = +m[1];
          if (h < 12) h += 12;
          const start = D().clock(h, m[2] ? +m[2] : 0);
          if (start == null) return false;
          applyClock(result, start, null, false);
          return true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)(?:(?:в|на|к)\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s+утра(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          const start = D().clock(+m[1], m[2] ? +m[2] : 0);
          if (start == null) return false;
          applyClock(result, start, null, false);
          return true;
        }
      },
      {
        re: /(?:^|\s)(?:в|на|к)\s+(\d{1,2})(?:(?::|\s+)(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          const start = D().clock(+m[1], m[2] ? +m[2] : 0);
          if (start == null) return false;
          applyClock(result, start, null, false);
          return true;
        }
      },
      {
        re: /^(\d{1,2})(?::(\d{2}))?(?=\s|$)/i,
        apply(m) {
          if (result.kind === "errand") return false;
          const start = D().clock(+m[1], m[2] ? +m[2] : 0);
          if (start == null) return false;
          applyClock(result, start, null, false);
          return true;
        }
      }
    ];
    const pool = specs.slice();
    while (pool.length) {
      const hit = leftmost(s, pool);
      if (!hit) return s;
      if (hit.spec.apply(hit.m) === false) {
        pool.splice(pool.indexOf(hit.spec), 1);
        continue;
      }
      return hit.next;
    }
    return s;
  }

  function applyRange(result, h1, m1, h2, m2) {
    const start = D().clock(h1, m1);
    let end = D().clock(h2, m2);
    if (start == null || end == null) return false;
    if (end <= start && h2 < 12) {
      const bumped = D().clock(h2 + 12, m2);
      if (bumped != null && bumped > start) end = bumped;
    }
    if (end <= start) return false;
    applyClock(result, start, end, true);
    return true;
  }

  function parse(raw, ctx) {
    const today = (ctx && ctx.today) || D().todayKey();
    const context = { today };
    let s = prep(raw);
    if (!s) return { ok: false, reason: "" };
    const result = {
      ok: true,
      kind: "loose",
      title: "",
      date: today,
      dateSpoken: false,
      startMin: null,
      endMin: null,
      atMin: null,
      errandTag: null,
      errandSay: null,
      habit: null,
      softAnchor: null
    };
    s = takeWeekly(s, result, context);
    if (!result.dateSpoken) s = takeDate(s, result, context);
    s = takeHabit(s, result);
    s = takeErrand(s, result);
    s = takeTime(s, result);
    if (result.softAnchor && result.kind !== "habit" && result.startMin == null && result.endMin == null) {
      const at = D().ANCHOR_MIN[result.softAnchor];
      if (result.kind === "errand") result.atMin = at;
      else {
        result.kind = "slot";
        result.startMin = at;
      }
    }
    result.title = cleanTitle(s);
    if (!result.title) {
      return { ok: false, reason: "добавьте, что сделать" };
    }
    if (result.kind === "habit") {
      result.habit = result.habit || blankHabit();
      if (result.habit.everyMax < result.habit.everyMin) {
        const t = result.habit.everyMin;
        result.habit.everyMin = result.habit.everyMax;
        result.habit.everyMax = t;
      }
    }
    return result;
  }

  function wordRe(body) {
    return `(?<![${LETTER}])(?:${body})(?![${LETTER}])`;
  }

  function collectRanges(s, source) {
    const re = new RegExp(source, "giu");
    const found = [];
    let m;
    while ((m = re.exec(s))) {
      let start = m.index;
      let end = start + m[0].length;
      while (start < end && /\s/.test(s.charAt(start))) start += 1;
      while (end > start && /\s/.test(s.charAt(end - 1))) end -= 1;
      if (end > start) found.push({ start, end });
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
    }
    return found;
  }

  function mergeRanges(found) {
    const sorted = found.slice().sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    sorted.forEach((item) => {
      const last = out[out.length - 1];
      if (last && item.start < last.end) return;
      out.push(item);
    });
    return out;
  }

  function prefixIsMarked(text, ranges) {
    for (let i = 0; i < text.length; i += 1) {
      if (/\s/.test(text.charAt(i))) continue;
      const inside = ranges.some((r) => i >= r.start && i < r.end);
      if (!inside) return false;
    }
    return true;
  }

  function marks(raw) {
    const s = String(raw || "");
    if (!s) return [];
    const nums = NUM_WORDS.map(([w]) => w).join("|");
    const sources = [
      wordRe("послезавтра"),
      wordRe("сегодня"),
      wordRe("завтра"),
      wordRe(`через\\s+\\d{1,3}(?:\\s*(?:дня|дней|день|дн))?`),
      wordRe(`\\+\\d{1,3}(?:\\s*(?:дня|дней|день|дн))?`),
      wordRe(`(?:на\\s+)?\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?`),
      wordRe(`след(?:ующ(?:ий|ую|ее))?\\s+(?:(?:в|во|на)\\s+)?(?:${WD_ALT})`),
      wordRe(`(?:в|во|на)\\s+(?:${WD_ALT})`),
      wordRe(WD_ALT),
      wordRe("привычка"),
      wordRe(`раз\\s+в\\s+\\d{1,3}(?:\\s*-\\s*\\d{1,3})?(?:\\s*(?:дня|дней|день|дн))?`),
      wordRe(`каждые\\s+\\d{1,3}(?:\\s*-\\s*\\d{1,3})?(?:\\s*(?:дня|дней|день|дн))?`),
      wordRe("кажд(?:ый|ую|ое|ые)\\s+день"),
      wordRe(`кажд(?:ый|ую|ое|ые)\\s+(?:(?:в|во|на)\\s+)?(?:${WD_ALT})`),
      wordRe(`с\\s+\\d{1,2}(?::\\d{1,2})?\\s+до(?:\\s+\\d{1,2}(?::\\d{1,2})?)?`),
      wordRe(`\\d{1,2}(?::\\d{1,2})?\\s*-\\s*\\d{1,2}(?::\\d{1,2})?`),
      wordRe(`до\\s+\\d{1,2}(?::\\d{1,2})?`),
      wordRe(`(?:в|на|к)\\s+\\d{1,2}(?::\\d{1,2})?(?:\\s+\\d{2})?`),
      wordRe(`(?:в|на|к)\\s+(?:${nums})(?:\\s+(?:${nums}))?`),
      wordRe(`\\d{1,2}(?::\\d{2})?\\s+вечера`),
      wordRe(`\\d{1,2}(?::\\d{2})?\\s+утра`),
      wordRe("вечером|утром|дн[её]м|ночью"),
      wordRe("час(?:а|ов)?"),
      `(?<![${LETTER}])(?:в|на|к)\\s*$`
    ];
    let found = [];
    sources.forEach((source) => {
      found = found.concat(collectRanges(s, source));
    });
    found = mergeRanges(found);
    const verbs = collectRanges(s, wordRe("купить|купи|покупка|забрать|забери|заказать|закажи"));
    verbs.forEach((verb) => {
      if (prefixIsMarked(s.slice(0, verb.start), found)) found.push(verb);
    });
    const hours = collectRanges(s, `(?<![${LETTER}])\\d{1,2}(?::\\d{2})?(?=\\s+\\S)`);
    const hasVerb = found.some((r) => /^(купить|купи|покупка|забрать|забери|заказать|закажи)$/i.test(s.slice(r.start, r.end)));
    if (!hasVerb) hours.forEach((hour) => found.push(hour));
    return mergeRanges(found);
  }

  function describeWith(r, today) {
    if (!r || !r.ok) return (r && r.reason) || "";
    const copy = r;
    const day = D();
    const bits = [];
    if (copy.kind === "errand") bits.push(copy.errandSay || "в список");
    if (copy.kind === "habit") bits.push("привычка");
    if (copy.dateSpoken) {
      const word = dateWord(today, copy.date);
      const pickup = copy.kind === "errand" && (copy.errandTag === "pickup" || copy.errandTag === "order");
      if (word) bits.push(pickup ? `с ${word}` : word);
    }
    if (copy.kind === "slot" && copy.startMin != null) bits.push(day.clockLabel(copy.startMin, { short: true }));
    if (copy.kind === "window") bits.push(day.rangeLabel(copy.startMin, copy.endMin));
    if (copy.kind === "errand" && copy.atMin != null) bits.push(day.clockLabel(copy.atMin, { short: true }));
    if (copy.habit) bits.push(day.habitPhrase(copy.habit));
    bits.push(copy.title);
    return bits.filter(Boolean).join(" · ");
  }

  global.ListokParse = {
    parse,
    marks,
    describe: describeWith,
    prep,
    ERRAND_VERBS,
    NUM_WORDS
  };
})(typeof window !== "undefined" ? window : globalThis);
