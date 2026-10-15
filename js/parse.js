/**
 * Свой язык строки. Ключевые слова собраны сверху — их можно добавлять.
 *
 * Дата: сегодня, завтра, послезавтра, через 3, через неделю, через 2 недели, +2, 23.09, пн, в среду, след пн
 * Час: 14, 14:30, в 8.30, в 14, в четырнадцать тридцать, 8 вечера. Числа словом — только рядом с «в / к / с / до / через …»
 * Окно: 12-14, с 12 до 14, до 16, с утра до 12
 * Список: купить, забрать, заказать. Забор и заказ можно спрятать до дня: в пятницу забрать озон, забрать озон с пятницы
 * Привычка: привычка, раз в 2-3, каждые 2, каждый пн, вечером / утром
 * Через: через 20 минут, через час, через полчаса, через 2 часа (сейчас + N, вверх до 5 мин)
 * Разговорное: полвосьмого, в пол 8-го, без пятнадцати 9, четверть десятого, 7 с половиной, в 3 часа дня
 * Якоря: в обед, после обеда, днём, после работы, перед сном
 * Даты: на выходных, к пятнице, на следующей неделе, в конце недели / месяца
 *
 * Голос и клавиатура разбираются одним и тем же разбором.
 */
(function (global) {
  const D = () => global.ListokDay;

  const LETTER = "A-Za-zА-Яа-яЁё0-9";
  const WD_ALT =
    "понедельника|понедельник|вторника|вторник|среду|среды|среда|четверга|четверг|пятницу|пятницы|пятница|субботу|субботы|суббота|воскресенья|воскресенье|пн|вт|ср|чт|пт|сб|вс";
  // Дательный — только после «к / до»: «к пятнице». «В среде» без предлога — это не дата.
  const WD_BY_ALT = `понедельнику|вторнику|среде|четвергу|пятнице|субботе|воскресенью|${WD_ALT}`;
  const WD_MAP = {
    пн: 1, понедельник: 1, понедельника: 1, понедельнику: 1,
    вт: 2, вторник: 2, вторника: 2, вторнику: 2,
    ср: 3, среда: 3, среду: 3, среды: 3, среде: 3,
    чт: 4, четверг: 4, четверга: 4, четвергу: 4,
    пт: 5, пятница: 5, пятницу: 5, пятницы: 5, пятнице: 5,
    сб: 6, суббота: 6, субботу: 6, субботы: 6, субботе: 6,
    вс: 0, воскресенье: 0, воскресенья: 0, воскресенью: 0
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
    ["ноль", "0"],
    // Q-21: родительный и дательный после «с / до / к» («с двух до четырёх», «до пяти», «к трём»).
    ["одиннадцати", "11"],
    ["двенадцати", "12"],
    ["двух", "2"],
    ["двум", "2"],
    ["тр[её]х", "3"],
    ["тр[её]м", "3"],
    ["четыр[её]х", "4"],
    ["четыр[её]м", "4"],
    ["пяти", "5"],
    ["шести", "6"],
    ["семи", "7"],
    ["восьми", "8"],
    ["девяти", "9"],
    ["десяти", "10"]
  ];

  // Порядковые в родительном: «полвосьмого», «четверть десятого».
  const ORD_MAP = {
    первого: 1, второго: 2, третьего: 3, четвертого: 4, четвёртого: 4, пятого: 5, шестого: 6,
    седьмого: 7, восьмого: 8, девятого: 9, десятого: 10, одиннадцатого: 11, двенадцатого: 12
  };
  const ORD_ALT = "первого|второго|третьего|четв[её]ртого|пятого|шестого|седьмого|восьмого|девятого|десятого|одиннадцатого|двенадцатого";
  const BEZ_MAP = { пяти: 5, десяти: 10, пятнадцати: 15, четверти: 15, двадцати: 20, "двадцати пяти": 25 };
  const BEZ_ALT = "двадцати\\s+пяти|пяти|десяти|пятнадцати|четверти|двадцати";
  const DAYPART = "(?:\\s+(?:утра|вечера|дня|ночи))?";
  const HANGING_TITLE = /^(?:в|во|на|к|ко|с|со|до|через|около|после|по|за|от)$/i;
  const NOON = { lunch: 13 * 60, afterLunch: 14 * 60, sleep: 22 * 60 + 30 };

  function ordHour(tok) {
    const w = String(tok).toLowerCase().replace(/^(\d{1,2})-?го$/, "$1");
    if (/^\d{1,2}$/.test(w)) return +w;
    return ORD_MAP[w] || null;
  }

  function stamp(h, m) {
    return `@${h}:${String(m).padStart(2, "0")}`;
  }

  // «через N минут / час / полчаса / N часов» → «через N мин» до того, как prep()
  // срежет «часа» (иначе «через 2 часа» читалось как «через 2 дня»).
  function relTokens(s) {
    const L = LETTER;
    const edge = (body) => new RegExp(`(^|[^${L}])${body}(?=$|[^${L}])`, "giu");
    return s
      .replace(edge("через\\s+полчаса"), "$1через 30 мин")
      .replace(edge("через\\s+полтора\\s+часа"), "$1через 90 мин")
      .replace(edge("через\\s+час"), "$1через 60 мин")
      .replace(edge("через\\s+(\\d{1,3})\\s*(?:часа|часов|час|ч)"), (m0, a, n) => `${a}через ${+n * 60} мин`)
      .replace(edge("через\\s+(\\d{1,3})\\s*(?:минуты|минуту|минут|мин)"), "$1через $2 мин");
  }

  // Разговорное время → служебная метка «@H:MM» (утро/вечер решает takeTime).
  function spokenClock(s) {
    const L = LETTER;
    const edge = (body) => new RegExp(`(^|[^${L}])${body}(?=$|[^${L}])`, "giu");
    return s
      .replace(edge(`(?:в\\s+)?(?:половине\\s+|пол-?\\s*)(${ORD_ALT}|\\d{1,2}-?го|\\d{1,2})`), (m0, a, t) => {
        const n = ordHour(t);
        return n && n <= 12 ? `${a}${stamp(n - 1, 30)}` : m0;
      })
      .replace(edge(`(?:в\\s+)?без\\s+(${BEZ_ALT}|\\d{1,2})\\s+(час|\\d{1,2})`), (m0, a, mm, hh) => {
        const minus = /^\d/.test(mm) ? +mm : BEZ_MAP[mm.toLowerCase().replace(/\s+/g, " ")];
        const n = hh.toLowerCase() === "час" ? 1 : +hh;
        if (!minus || minus >= 60 || !n || n > 24) return m0;
        return `${a}${stamp((n - 1 + 24) % 24, 60 - minus)}`;
      })
      .replace(edge(`(?:в\\s+)?четверть\\s+(${ORD_ALT}|\\d{1,2}-?го)`), (m0, a, t) => {
        const n = ordHour(t);
        return n && n <= 12 ? `${a}${stamp(n - 1, 15)}` : m0;
      })
      .replace(edge("(?:в\\s+)?(\\d{1,2})\\s+с\\s+половиной"), (m0, a, n) => (+n <= 23 ? `${a}${stamp(+n, 30)}` : m0))
      .replace(edge("(?:в\\s+)?полдень"), (m0, a) => `${a}${stamp(12, 0)}`)
      .replace(edge("(?:в\\s+)?полночь"), (m0, a) => `${a}${stamp(24, 0)}`); // 24:00 — ближайшая полночь
  }

  function edgeRe(body, flags) {
    return new RegExp(`(^|[^${LETTER}])(?:${body})(?=$|[^${LETTER}])`, flags || "i");
  }

  // Q-19: число словом становится цифрой только рядом с маркером времени или срока
  // («в девять», «через два дня», «без пяти восемь», «семь тридцать», «три часа»).
  // Иначе слово остаётся в названии: «прочитать три главы», «девять жизней», «один на один».
  const TIMES_AFTER = new RegExp(`^\\s+раз(?:а)?(?=$|[^${LETTER}])`, "iu");
  const FROM_BEFORE = new RegExp(`(?:^|[^${LETTER}])от\\s+$`, "iu");
  function verbalNumbers(s) {
    const L = LETTER;
    const before = new RegExp(`(?:^|[^${L}])(?:в|во|к|ко|с|со|до|через|около|после|каждые|каждый|каждую|каждое)\\s+$|\\d\\s*-?\\s*$|(?:^|[^${L}])без\\s+(?:${BEZ_ALT}|\\d{1,2})\\s+$`, "iu");
    const after = new RegExp(`^\\s+(?:(?:час|часа|часов)\\s+(?:утра|вечера|дня|ночи)|утра|вечера|дня|ночи|дней|день|с\\s+половиной)(?=$|[^${L}])`, "iu");
    // Q-22: «три часа» без предлога — длительность, слово остаётся («три часа отчёт»); «три часа дня» — время.
    let out = s;
    // Два прохода: «семь тридцать» — «тридцать» становится минутами, когда «семь» уже цифра.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const [w, n] of NUM_WORDS) {
        const re = new RegExp(`(^|[^${L}])${w}(?=$|[^${L}])`, "giu");
        out = out.replace(re, (m0, a, at, str) => {
          const head = str.slice(0, at + a.length);
          const tail = str.slice(at + m0.length);
          if (TIMES_AFTER.test(tail)) return m0; // «до пяти раз» — счёт, не время
          const fromTo = FROM_BEFORE.test(head) && /^\s+до\s/i.test(tail); // «от двух до четырёх»
          return before.test(head) || after.test(tail) || fromTo ? `${a}${n}` : m0;
        });
      }
    }
    return out;
  }

  // Знаки внутри кавычек («хлеб, молоко», "Кто, если не мы?") — часть названия: на время разбора прячем их
  // в символы частной зоны (не буквы и не пробелы — как пунктуация для правил), cleanTitle возвращает.
  const QUOTE_MARKS = { ",": "\uE001", "!": "\uE002", "?": "\uE003", ";": "\uE004" };
  const QUOTE_BACK = { "\uE001": ",", "\uE002": "!", "\uE003": "?", "\uE004": ";" };
  function protectQuoted(s) {
    return s.replace(/«[^«»\n]*»|"[^"\n]*"|„[^„“\n]*“|“[^“”\n]*”/g, (q) => q.replace(/[,!?;]/g, (c) => QUOTE_MARKS[c]));
  }
  function prep(raw) {
    let s = protectQuoted(String(raw || "").replace(/[\uE001-\uE004]/g, ""))
      .replace(/[–—]/g, "-")
      .replace(/[,!?;]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    s = verbalNumbers(s);
    // «в 8.30», «8.45»: точка между часами и минутами — время. После предлога времени (в, к, с, до, около)
    // или если после точки не месяц (13–59). «23.09», «на 12.10» остаются датой.
    s = s.replace(/(^|\s)((?:в|к|с|со|до|около)\s+)?(\d{1,2})\.(\d{2})(?=$|[^\d.])/giu, (m0, a, pre, h, mm) =>
      +h <= 23 && +mm <= 59 && (pre || +mm > 12) ? `${a}${pre || ""}${h}:${mm}` : m0);
    // batch5 5b: «в 8-30 врач» — 8:30. Только после «в / к / на» и если минуты > 12 и кратны 5:
    // «в 9-11», «10-12» остаются окном.
    s = s.replace(/(^|\s)((?:в|во|к|ко|на)\s+)(\d{1,2})-(\d{2})(?=$|[^\d:-])/giu, (m0, a, pre, h, mm) =>
      +h <= 23 && +mm <= 59 && +mm > 12 && +mm % 5 === 0 ? `${a}${pre}${h}:${mm}` : m0);
    s = relTokens(s);
    s = spokenClock(s);
    // «3 часа дня» / «в 3 часа ночи» → «в 3 дня»: время, а не «3 дня» как срок.
    s = s.replace(new RegExp(`(^|[^${LETTER}])(?:(?:в|к)\\s+)?(\\d{1,2})\\s+час(?:а|ов)?\\s+(дня|ночи)(?=$|[^${LETTER}])`, "giu"), "$1в $2 $3");
    // Q-22: «часа» срезаем только после предлога времени («в 3 часа», «к 3 часам», «до 5 часов»).
    // Без предлога «3 часа отчёт» / «отчёт 3 часа» — длительность, текст остаётся как есть.
    s = s.replace(new RegExp(`(^|[^${LETTER}])((?:в|во|к|ко|с|со|до|около|после)\\s+)(\\d{1,2})\\s+час(?:а|ов|ам|у)?(?=$|[^${LETTER}])`, "giu"), "$1$2$3");
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
      .replace(/[\uE001-\uE004]/g, (c) => QUOTE_BACK[c])
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

  // «через 20 мин»: сейчас + N, вверх до 5 минут; за полночь — следующий день.
  function takeRelative(s, result, ctx) {
    const hit = consume(s, new RegExp(`(?:^|\\s)через\\s+(\\d{1,5})\\s+мин(?=$|[^${LETTER}])`, "i"));
    if (!hit) return s;
    const total = ctx.now + (+hit.m[1]);
    const at = Math.ceil(total / 5) * 5;
    const days = Math.floor(at / 1440);
    result.date = D().addDays(ctx.nowDay, days);
    result.dateSpoken = true;
    result.relative = { min: at % 1440 };
    return hit.next;
  }

  function lastOfMonth(key) {
    const dt = D().parseKey(key);
    const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
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
        re: new RegExp(`(?:^|\\s)(?:на|в)\\s+выходн(?:ых|ые)(?=$|[^${LETTER}])`, "i"),
        apply() {
          const w = day.dow(ctx.today);
          result.date = w === 6 || w === 0 ? ctx.today : day.nextDow(ctx.today, 6, false);
          result.dateSpoken = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)(?:к|до)\\s+(${WD_BY_ALT})(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          result.date = day.nextDow(ctx.today, WD_MAP[m[1].toLowerCase()], false);
          result.dateSpoken = true;
          result.by = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)на\\s+следующей\\s+неделе(?=$|[^${LETTER}])`, "i"),
        apply() {
          result.date = day.nextDow(ctx.today, 1, true);
          result.dateSpoken = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)(?:в\\s+)?конце\\s+недели(?=$|[^${LETTER}])`, "i"),
        apply() {
          const w = day.dow(ctx.today);
          result.date = w === 6 || w === 0 ? ctx.today : day.nextDow(ctx.today, 5, false);
          result.dateSpoken = true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)(?:в\\s+)?конце\\s+месяца(?=$|[^${LETTER}])`, "i"),
        apply() {
          result.date = lastOfMonth(ctx.today);
          result.dateSpoken = true;
        }
      },
      {
        re: edgeRe("(?:на\\s+)?сегодня"), // «на завтра врач» — без «на» в названии
        apply() {
          result.date = ctx.today;
          result.dateSpoken = true;
        }
      },
      {
        re: edgeRe("(?:на\\s+)?послезавтра"), // «на завтра врач» — без «на» в названии
        apply() {
          result.date = day.addDays(ctx.today, 2);
          result.dateSpoken = true;
        }
      },
      {
        re: edgeRe("(?:на\\s+)?завтра"), // «на завтра врач» — без «на» в названии
        apply() {
          result.date = day.addDays(ctx.today, 1);
          result.dateSpoken = true;
        }
      },
      {
        // «через неделю», «через 2 недели» — +7 дней на неделю
        re: new RegExp(`(?:^|\\s)через\\s+(?:(\\d{1,2})\\s+)?недел(?:ю|и|ь)(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          result.date = day.addDays(ctx.today, 7 * (m[1] ? +m[1] : 1));
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
    // Наборов дней в модели привычек пока нет: слова не уходят в название, превью честно об этом говорит.
    const days = consume(cur, new RegExp(`(?:^|\\s)по\\s+(будням|выходным)(?=$|[^${LETTER}])`, "i"));
    if (days) {
      result.warn = `«по ${days.m[1].toLowerCase()}» пока без повтора`;
      result.recurring = true;
      cur = days.next;
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
      if (m) {
        const lead = m[1].length;
        return claim(verb, m.index + lead, m[0].length - lead);
      }
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

  // Часть дня к часу: «7 вечера» — 19, «2 дня» — 14, «11 ночи» — 23, «12 ночи» — 0. Недопустимое — NaN.
  const DAYQ = "утра|дня|вечера|ночи";
  function dayQ(h, q) {
    if (!q) return h;
    if (q === "утра") return h >= 1 && h <= 11 ? h : h === 12 ? 0 : NaN;
    if (q === "вечера") return h >= 1 && h < 12 ? h + 12 : h >= 12 && h <= 23 ? h : NaN;
    if (q === "дня") return h >= 1 && h <= 5 ? h + 12 : h >= 11 && h <= 17 ? h : NaN;
    if (q === "ночи") return h === 12 ? 0 : h >= 9 && h <= 11 ? h + 12 : h >= 0 && h <= 5 ? h : NaN;
    return h;
  }

  const GRACE = 60;
  function takeTime(s, result, ctx) {
    const at = (min) => {
      applyClock(result, min, null, false);
      return true;
    };
    // Повтор («по будням», привычка) — время по часам, а не «ближайшее»: вечер не подставляем.
    const today = () => ctx.now != null && result.date === ctx.nowDay && !result.recurring && result.kind !== "habit";
    // Голые часы без «утра/вечера», уже прошедшие сегодня: 1–7 — вечер («в 7» в 13:07 → 19:00),
    // 8–11 — завтра в тот же час («в 11» в 13:07 → завтра 11:00; вечер 23:00 почти всегда ошибка).
    // Прошёл и вечерний вариант («в 7» в 22:00) — тоже завтра в исходный час.
    const tomorrow = () => {
      if (!result.dateSpoken) result.date = D().addDays(ctx.nowDay, 1);
    };
    // Решение UX (batch7 п.3): неоднозначный час без «утра/вечера» и без даты — одно правило для цифр и слов.
    // Кандидаты — h и h+12 сегодня, потом завтра: (1) кандидат в [сейчас − 60 мин, сейчас] — он, сегодня;
    // (2) иначе ближайший в будущем. Голые 1–5 (без минут) с 5:00 — только h+12, кроме льготы; ночью — общее правило.
    const nearest = (h, min, bare) => {
      if (!(h >= (bare ? 1 : 0) && h <= 12) || !today()) return h;
      const now = ctx.now;
      // «в 12» — полночь или полдень: в 0:30 это 0:00 по льготе (review-batch9 п.3), днём — 12:00.
      const cands = h === 12 ? [0, 12] : h < 12 ? [h, h + 12] : [h]; // 0 — «без пяти час»: 0:55 / 12:55
      const graced = cands.find((c) => c * 60 + min <= now && now - (c * 60 + min) <= GRACE);
      const ahead = cands.find((c) => c * 60 + min > now);
      if (result.dateSpoken) {
        // review-batch9 п.2: «сегодня в 9» — то же правило (льгота, иначе ближайший впереди), но только в этом дне:
        // прошли оба варианта больше часа назад — поздний; день не меняем (в 22:00 → 21:00, в 8:00 → 9:00).
        if (graced != null) return graced;
        if (ahead != null) return ahead;
        return cands[cands.length - 1];
      }
      // Голые 1–5 (решение UX): с 5:00 — только h+12, но льгота сильнее («в 5» в 5:30 — сегодня 5:00);
      // ночью (0:00–4:59) правило выключено — общее правило («в 3» в 1:00 → 3:00, в 4:30 → 15:00).
      if (bare && h <= 5 && now >= 5 * 60) {
        if (h * 60 + min <= now && now - (h * 60 + min) <= GRACE) return h;
        if ((h + 12) * 60 + min < now - GRACE) tomorrow();
        return h + 12;
      }
      if (graced != null) return graced;
      if (ahead != null) return ahead;
      tomorrow();
      return h;
    };
    // «в 12» тоже неоднозначно (полночь/полдень) — кроме срока «до 12»: он остаётся полуднем.
    const pm = (h, min, hasMin, noNoon) => (h >= 1 && (h < 12 || (h === 12 && !noNoon)) ? nearest(h, min, !hasMin) : h);
    // Ночное время без даты, уже прошедшее сегодня (полночь, «2 ночи» в 22:00), — это завтра.
    const nightRoll = (min) => {
      if (!result.dateSpoken && today() && min < 6 * 60 && min <= ctx.now && ctx.now - min > GRACE) result.date = D().addDays(ctx.nowDay, 1);
    };
    const specs = [
      {
        // разговорное «@7:30»: если сегодня это время уже прошло — вечерний вариант (19:30)
        // «полвосьмого утра», «полдевятого вечера»: уточнение решает само и уходит из названия.
        re: new RegExp(`(?:^|\\s)@(\\d{1,2}):(\\d{2})(?:\\s+(утра|вечера|дня|ночи))?(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          let h = +m[1];
          const min = +m[2];
          const q = (m[3] || "").toLowerCase();
          if (h === 24) {
            if (min || q === "дня" || q === "вечера") return false;
            nightRoll(0);
            return at(0);
          }
          if (q === "утра") {
            if (h >= 12) return false;
          } else if (q === "вечера") {
            if (h < 12) h += 12;
          } else if (q === "дня") {
            if (h <= 5) h += 12;
          } else if (q === "ночи") {
            if (h === 12) h = 0;
            else if (h >= 9 && h < 12) h += 12;
          } else if (h <= 12 && today()) {
            // «полвосьмого», «без четверти восемь», «в полдень» — то же правило, что у цифр (минуты есть всегда).
            h = nearest(h, min, false);
          }
          const v = D().clock(h, min);
          if (v == null) return false;
          if (q === "ночи") nightRoll(v);
          return at(v);
        }
      },
      { re: new RegExp(`(?:^|\\s)в\\s+обед(?=$|[^${LETTER}])`, "i"), apply: () => at(NOON.lunch) },
      { re: new RegExp(`(?:^|\\s)после\\s+обеда(?=$|[^${LETTER}])`, "i"), apply: () => at(NOON.afterLunch) },
      { re: new RegExp(`(?:^|\\s)перед\\s+сном(?=$|[^${LETTER}])`, "i"), apply: () => at(NOON.sleep) },
      {
        re: new RegExp(`(?:^|\\s)после\\s+работы(?=$|[^${LETTER}])`, "i"),
        apply: () => at(Math.min(23 * 60 + 55, (ctx.workEndMin != null ? ctx.workEndMin : 18 * 60) + 30))
      },
      {
        re: new RegExp(`(?:^|\\s)(?:в|к)\\s+(\\d{1,2})(?::(\\d{2}))?\\s+(дня|ночи)(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          let h = +m[1];
          if (m[3].toLowerCase() === "дня") {
            if (h < 1 || h > 12) return false;
            if (h < 12) h += 12;
          } else {
            // «2 ночи» — 2:00, «11 ночи» — 23:00, «12 ночи» — полночь
            if (h > 12 || (h > 5 && h < 9)) return false;
            if (h === 12) h = 0;
            else if (h >= 9) h += 12;
          }
          const v = D().clock(h, m[2] ? +m[2] : 0);
          if (v == null) return false;
          if (m[3].toLowerCase() === "ночи") nightRoll(v);
          return at(v);
        }
      },
      {
        // batch5 5b: «с 7 до 9 вечера», «с 7 вечера до 9» — часть дня на оба конца и уходит из названия.
        re: new RegExp(`(?:^|\\s)с\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s+(${DAYQ}))?\\s+до\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s+(${DAYQ}))?(?=$|[^${LETTER}\\d])`, "i"),
        apply(m) {
          const q1 = (m[3] || "").toLowerCase();
          const q2 = (m[6] || "").toLowerCase();
          if (!q1 && !q2) return false;
          const m1 = m[2] ? +m[2] : 0;
          const m2 = m[5] ? +m[5] : 0;
          // batch6 P3: «с 10 до 12 дня» — «дня» к началу не подходит (10 дня нет), начало берём как есть.
          let start = D().clock(dayQ(+m[1], q1 || q2), m1);
          if (start == null && !q1) start = D().clock(+m[1], m1);
          let end = +m[4] === 24 && !m2 && !q2 ? 24 * 60 : D().clock(dayQ(+m[4], q2 || q1), m2);
          if (start == null || end == null) return false;
          end = overnight(start, end, !!q2); // Q-32: «до 5 утра» — не голый час, правило +12 не действует
          if (end <= start && !q2) {
            end = D().clock(+m[4], m2);
            if (end != null && end <= start && +m[4] < 12) end = D().clock(+m[4] + 12, m2);
          }
          if (end == null || end <= start) return false;
          applyClock(result, start, end, true);
          return true;
        }
      },
      {
        re: new RegExp(`(?:^|\\s)до\\s+(\\d{1,2})(?::(\\d{2}))?\\s+(${DAYQ})(?=$|[^${LETTER}])`, "i"),
        apply(m) {
          const end = D().clock(dayQ(+m[1], m[3].toLowerCase()), m[2] ? +m[2] : 0);
          if (end == null) return false;
          applyClock(result, null, end, true);
          return true;
        }
      },
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
        // Q-27: «с 20 до 12» — 16 ч через полночь, это не окно; текст оставляем как есть
        // (и не превращаем «до 12» в срок, а «с 20» — в начало).
        re: /(?:^|\s)(?:с|от)\s+(\d{1,2})(?::(\d{2}))?\s+до\s+(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          const start = D().clock(+m[1], m[2] ? +m[2] : 0);
          const end = D().clock(+m[3], m[4] ? +m[4] : 0);
          if (start == null || end == null || start < D().NIGHT_START_MIN || end > start) return false;
          // Q-32: конец 1–5 решает nightEnd (день +12 от часа, иначе ночь ≤ 14 ч)
          if (+m[3] >= 1 && +m[3] <= 5) return D().nightEnd(start, end) > start ? false : "keep";
          if (+m[3] < 12 && D().clock(+m[3] + 12, m[4] ? +m[4] : 0) > start) return false;
          return D().nightEnd(start, end) > start ? false : "keep";
        }
      },
      {
        re: /(?:^|\s)(?:с|от)\s+(\d{1,2})(?::(\d{2}))?\s+до\s+(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          return applyRange(result, +m[1], m[2] ? +m[2] : 0, +m[3], m[4] ? +m[4] : 0, ctx);
        }
      },
      {
        re: /(?:^|\s)(?:(?:в|во|на|с|со)\s+)?(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?(?=$|[^\d])/i,
        apply(m) {
          return applyRange(result, +m[1], m[2] ? +m[2] : 0, +m[3], m[4] ? +m[4] : 0, ctx);
        }
      },
      {
        re: new RegExp(`(?:^|\\s)до\\s+(\\d{1,2})(?::(\\d{2}))?(?=$|[^\\d])(?!\\s+раз(?:а)?(?:$|[^${LETTER}]))`, "i"),
        apply(m) {
          const mm = m[2] ? +m[2] : 0;
          const end = D().clock(pm(+m[1], mm, m[2] != null, true), mm);
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
          // batch6 P3: «на 2 часа позже», «на 30 минут» — длительность, а не время.
          if (/^на/i.test(m[0].trim()) && !m[2] && /^\s+(?:час|мин)/i.test(m.input.slice(m.index + m[0].length))) return false;
          const mm = m[2] ? +m[2] : 0;
          const start = D().clock(pm(+m[1], mm, m[2] != null), mm);
          if (start == null) return false;
          applyClock(result, start, null, false);
          return true;
        }
      },
      {
        // «5 минут зарядка» — длительность, не 5 часов.
        re: /^(\d{1,2})(?::(\d{2}))?(?=\s|$)(?!\s+(?:минут[аы]?|минуту|мин|час(?:а|ов)?)(?:\s|$))/i,
        apply(m) {
          if (result.kind === "errand") return false;
          const mm = m[2] ? +m[2] : 0;
          const start = D().clock(pm(+m[1], mm, m[2] != null), mm);
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
      const got = hit.spec.apply(hit.m);
      if (got === false) {
        pool.splice(pool.indexOf(hit.spec), 1);
        continue;
      }
      if (got === "keep") return s; // время названо так, что его не понять — текст не трогаем
      return hit.next;
    }
    return s;
  }

  // batch6 P3: окно через полночь («с 23 до 1», «с 11 вечера до 1 ночи») — конец на следующие сутки
  // (endMin > 1440). Начало не раньше 18:00, иначе это ошибка, а не ночь.
  // UX (Q-27): конец не дальше 12:00 следующих суток и окно не дольше 14 ч — «с 22 до 9 смена» → 22–9.
  function overnight(start, end, spoken) {
    return end <= start ? D().nightEnd(start, end, spoken) : end;
  }

  function applyRange(result, h1, m1, h2, m2, ctx) {
    let start = D().clock(h1, m1);
    let end = h2 === 24 && !m2 ? 24 * 60 : D().clock(h2, m2);
    if (start == null || end == null) return false;
    // UX + batch10 P2-5: конец меньше начала (начало с 13:00) — сначала окно через полночь по общему правилу
    // (до 12:00, ≤ 14 ч), и только потом +12 к концу: «с 20 до 9» → 20–9, «с 17 до 7» → 17–7.
    if (end <= start && overnight(start, end) > start) end = overnight(start, end);
    if (end <= start && h2 < 12) {
      const bumped = D().clock(h2 + 12, m2);
      if (bumped != null && bumped > start) end = bumped;
    }
    end = overnight(start, end);
    if (end <= start) return false;
    // Решение UX (batch7 п.3) и для окна: кандидаты — часы как написаны и +12 сегодня, потом завтра.
    // Идёт сейчас или кончилось не больше часа назад — оно, сегодня; иначе ближайшее впереди.
    // Голое начало 1–5 (без минут) с 5:00 — только +12 («с 3 до 5» — 15–17), ночью — общее правило.
    if (ctx && ctx.now != null && result.date === ctx.nowDay && !result.recurring && result.kind !== "habit" && h1 >= 1 && end <= 12 * 60) {
      const now = ctx.now;
      if (result.dateSpoken) {
        // день назван: прошедшее утреннее окно 1–7 — вечер, остальное как написано
        if (end <= now && h1 <= 7 && h2 <= 7) { start += 12 * 60; end += 12 * 60; }
      } else {
        // льгота — от конца окна; голое начало 1–5 с 5:00 — только +12 (если окно не идёт / не кончилось ≤ часа назад)
        const graceAt = (o) => start + o <= now && now - (end + o) <= GRACE;
        const offs = h1 <= 5 && !m1 && now >= 5 * 60 && !graceAt(0) ? [12 * 60] : [0, 12 * 60];
        let off = offs.find(graceAt);
        if (off == null) off = offs.find((o) => start + o > now);
        if (off == null) {
          result.date = D().addDays(ctx.nowDay, 1);
          off = offs[0];
        }
        start += off;
        end += off;
      }
    }
    applyClock(result, start, end, true);
    return true;
  }

  function parse(raw, ctx) {
    const today = (ctx && ctx.today) || D().todayKey();
    const clockNow = new Date();
    const now = ctx && Number.isFinite(ctx.now) ? ctx.now : clockNow.getHours() * 60 + clockNow.getMinutes();
    const nowDay = (ctx && ctx.nowDay) || (ctx && Number.isFinite(ctx.now) ? today : D().todayKey());
    const context = { today, now, nowDay, workEndMin: ctx && ctx.workEndMin };
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
    s = takeRelative(s, result, context);
    if (!result.dateSpoken) s = takeDate(s, result, context);
    s = takeHabit(s, result);
    s = takeErrand(s, result);
    s = takeTime(s, result, context);
    // batch5 (R-30): время без даты, которое сегодня уже прошло («в 12» в 12:30, «в 5 утра»,
    // «полвосьмого утра», «без четверти восемь утра»), — это завтра. Идущее окно остаётся сегодня.
    if (!result.dateSpoken && !result.recurring && context.now != null && result.date === context.nowDay &&
        (result.kind === "slot" || result.kind === "window")) {
      // Решение UX: прошло не больше GRACE (60 мин) — остаётся сегодня, больше — завтра.
      const passed = result.kind === "slot"
        ? result.startMin != null && context.now - result.startMin > GRACE
        : result.endMin != null && context.now - result.endMin > GRACE;
      if (passed) result.date = D().addDays(context.nowDay, 1);
    }
    if (result.relative && result.startMin == null && result.endMin == null && result.atMin == null) {
      applyClock(result, result.relative.min, null, false);
    } else if (result.relative) delete result.relative;
    if (result.softAnchor && result.kind !== "habit" && result.startMin == null && result.endMin == null) {
      const at = D().ANCHOR_MIN[result.softAnchor];
      if (result.kind === "errand") result.atMin = at;
      else {
        result.kind = "slot";
        result.startMin = at;
      }
    }
    delete result.recurring;
    result.title = cleanTitle(s);
    // «завтра в» + Enter: висящий предлог — не название («в», «к», «через»).
    if (HANGING_TITLE.test(result.title)) result.title = "";
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

  // Без lookbehind: Safari до 16.4 не компилирует такие выражения (SyntaxError).
  // Левая граница — первая группа (начало строки или не буква); её длину
  // вычитают из совпадения там, где нужен отрезок самого слова.
  function wordRe(body) {
    return `(^|[^${LETTER}])(?:${body})(?![${LETTER}])`;
  }

  function collectRanges(s, source) {
    const re = new RegExp(source, "giu");
    const found = [];
    let m;
    while ((m = re.exec(s))) {
      let start = m.index + (m[1] || "").length;
      let end = m.index + m[0].length;
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
      wordRe("(?:на\\s+)?(?:послезавтра|сегодня|завтра)"), // batch5: «на» уходит из названия — подсвечиваем и его
      wordRe(`через\\s+\\d{1,3}(?:\\s*(?:дня|дней|день|дн))?`),
      wordRe(`через\\s+(?:\\d{1,2}\\s+)?недел(?:ю|и|ь)`),
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
      wordRe(`(?:с|от)\\s+\\d{1,2}(?:[.:]\\d{2})?\\s+до(?:\\s+\\d{1,2}(?:[.:]\\d{2})?)?`),
      wordRe(`\\d{1,2}(?::\\d{1,2})?\\s*-\\s*\\d{1,2}(?::\\d{1,2})?`),
      wordRe(`до\\s+\\d{1,2}(?::\\d{1,2})?(?![\\d:])(?!\\s+раз(?:а)?(?:$|[^${LETTER}]))`), // «до 5 раз» — счёт
      wordRe(`(?:в|к)\\s+\\d{1,2}(?:\\.\\d{2}|:\\d{1,2})?(?:\\s+\\d{2})?`),
      // batch7: «на 2 часа позже» — длительность, не подсвечиваем
      wordRe(`на\\s+\\d{1,2}(?:\\.\\d{2}|:\\d{1,2})?(?:\\s+\\d{2})?(?!\\d|\\s+(?:час|мин))`),
      wordRe(`(?:в|во|к|ко)\\s+(?:${nums})(?:\\s+(?:${nums}))?`),
      wordRe(`(?:с|от)\\s+(?:${nums})\\s+до\\s+(?:${nums})|до\\s+(?:${nums})(?!\\s+раз(?:а)?(?:$|[^${LETTER}]))`),
      // batch5 5b: часть дня на концах окна и «в 8-30» / «в 9-11»
      wordRe(`(?:с\\s+(?:\\d{1,2}|${nums})(?::\\d{2})?(?:\\s+(?:${DAYQ}))?\\s+)?до\\s+(?:\\d{1,2}|${nums})(?::\\d{2})?\\s+(?:${DAYQ})`),
      wordRe(`с\\s+(?:\\d{1,2}|${nums})(?::\\d{2})?\\s+(?:${DAYQ})\\s+до\\s+(?:\\d{1,2}|${nums})(?::\\d{2})?`),
      wordRe(`(?:в|во|к|ко|на|с|со)\\s+\\d{1,2}\\s*-\\s*\\d{1,2}`),
      wordRe(`\\d{1,2}(?::\\d{2})?\\s+вечера`),
      wordRe(`\\d{1,2}(?::\\d{2})?\\s+утра`),
      wordRe("вечером|утром|дн[её]м|ночью"),
      wordRe(`через\\s+(?:\\d{1,3}|${nums})\\s*(?:часа|часов|час|ч|минуты|минуту|минут|мин)`),
      wordRe("через\\s+(?:час|полчаса|полтора\\s+часа)"),
      wordRe(`(?:в\\s+)?(?:половине\\s+|пол-?\\s*)(?:${ORD_ALT}|\\d{1,2}-?го|\\d{1,2})${DAYPART}`),
      wordRe(`(?:в\\s+)?без\\s+(?:${BEZ_ALT}|\\d{1,2})\\s+(?:\\d{1,2}|${nums}|час)${DAYPART}`),
      wordRe(`(?:в\\s+)?четверть\\s+(?:${ORD_ALT}|\\d{1,2}-?го)${DAYPART}`),
      wordRe(`(?:в\\s+)?(?:\\d{1,2}|${nums})\\s+с\\s+половиной${DAYPART}`),
      wordRe("(?:в\\s+)?(?:полдень|полночь)"),
      wordRe("в\\s+обед|после\\s+обеда|после\\s+работы|перед\\s+сном"),
      wordRe(`(?:(?:в|к)\\s+)?(?:\\d{1,2}|${nums})(?:\\s+(?:часа|часов|час))?\\s+(?:дня|ночи)`),
      wordRe("(?:на|в)\\s+выходн(?:ых|ые)|на\\s+следующей\\s+неделе|(?:в\\s+)?конце\\s+(?:недели|месяца)|по\\s+(?:будням|выходным)"),
      wordRe(`(?:к|до)\\s+(?:${WD_BY_ALT})`),
      wordRe(`(?:в|во|к|ко|с|со|до|около|после)\\s+(?:\\d{1,2}|${nums})\\s+час(?:а|ов|ам|у)?`), // Q-22: «3 часа отчёт» не подсвечиваем
      `(^|[^${LETTER}])(?:в|на|к)\\s*$`
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
    // Голый час — как в разборе: в начале фразы или сразу после распознанного («завтра 14 врач»).
    // Q-22: «5 минут», «3 часа» — длительность, не час.
    const hours = collectRanges(s, `(^|[^${LETTER}])\\d{1,2}(?::\\d{2})?(?=\\s+\\S)(?!\\s+(?:минут[аы]?|минуту|мин|час(?:а|ов)?)(?=$|[^${LETTER}]))`);
    const hasVerb = found.some((r) => /^(купить|купи|покупка|забрать|забери|заказать|закажи)$/i.test(s.slice(r.start, r.end)));
    if (!hasVerb) hours.forEach((hour) => { if (prefixIsMarked(s.slice(0, hour.start), found)) found.push(hour); });
    return mergeRanges(found);
  }

  function describeWith(r, today, nowDay) {
    if (!r || !r.ok) return (r && r.reason) || "";
    const copy = r;
    const day = D();
    const bits = [];
    if (copy.kind === "errand") bits.push(copy.errandSay || "в список");
    if (copy.kind === "habit") bits.push("привычка");
    // Дата видна и когда её не называли, но время увело дело на другой день («в 11» в 13:07 → завтра).
    if (copy.dateSpoken || (today && copy.date && copy.date !== today)) {
      const word = dateWord(today, copy.date);
      const pickup = copy.kind === "errand" && (copy.errandTag === "pickup" || copy.errandTag === "order");
      if (copy.by) {
        const dt = day.parseKey(copy.date);
        bits.push(`к ${day.WD_SHORT[dt.getDay()]} ${dt.getDate()}`);
      } else if (word) bits.push(pickup ? `с ${word}` : word);
      // batch7 P3: сказанное «сегодня» тоже видно в предпросмотре: «сегодня · 11 · врач».
      else if (!nowDay || nowDay === today) bits.push("сегодня");
      else {
        const h = day.head(copy.date, nowDay);
        bits.push(`${h.short} ${h.day}`);
      }
    } else if (!copy.relative && (copy.kind === "slot" || copy.kind === "window") && (copy.startMin != null || copy.endMin != null)) {
      // R-30 (решение UX): у явного времени день виден всегда — «сегодня · 13» или «завтра · 13».
      if (!nowDay || nowDay === today) bits.push("сегодня");
      else {
        const h = day.head(copy.date, nowDay);
        bits.push(`${h.short} ${h.day}`);
      }
    }
    if (copy.relative && copy.kind === "slot" && copy.startMin != null) bits.push(`→ ${day.clockLabel(copy.startMin)}`);
    else if (copy.kind === "slot" && copy.startMin != null) bits.push(day.clockLabel(copy.startMin, { short: true }));
    if (copy.kind === "window") bits.push(day.rangeLabel(copy.startMin, copy.endMin));
    if (copy.kind === "errand" && copy.atMin != null) bits.push(day.clockLabel(copy.atMin, { short: true }));
    if (copy.habit) bits.push(day.habitPhrase(copy.habit));
    bits.push(copy.title);
    if (copy.warn) bits.push(copy.warn);
    return bits.filter(Boolean).join(" · ");
  }

  // R-35: много дел одной фразой. Разделители — перенос строки, «;», «потом», «затем», «а ещё», «и ещё», «а также».
  // «завтра: …» в начале — общая дата для частей без своей. Маркеры вставки («- », «• », «1.», «[ ]», «[x]») снимаются.
  // После глагола списка («купить молоко, хлеб и яйца») запятые и «и» делят покупки; вне покупок запятые не делят.
  // batch8 P2-6: «и ещё раз», «а ещё раз» — не разделитель («позвонить маме и ещё раз папе»).
  const MANY_SEP = new RegExp(`\\s*[\\n;]\\s*|(?:^|\\s)(?:потом|затем|а\\s+ещ[её](?!\\s+раз)|и\\s+ещ[её](?!\\s+раз)|а\\s+также)(?=\\s|$)`, "i");
  const MANY_ALSO = new RegExp(`(?:^|\\s)(?:а\\s+ещ[её]|и\\s+ещ[её]|а\\s+также)$`, "i");
  // «и» внутри предложной группы не делит покупки: «подарок для мамы и папы».
  const MANY_PREP = /(?:^|\s)(?:для|у|от|с|со|к|ко|без|про|из|на|в|во|о|об|по|до|за|при)\s+\S+$/i;
  // batch9 п.6: «подарок маме и папе» — «и» между адресатами (дательный) не делит покупку.
  const WHOM = "маме|папе|бабушке|дедушке|бабуле|деду|брату|сестре|сыну|дочке|дочери|дочерям|сыновьям|жене|мужу|детям|ребёнку|ребенку|другу|подруге|друзьям|коллеге|коллегам|тёте|тете|дяде|племяннику|племяннице|внуку|внучке|внукам|соседу|соседке|учителю|учительнице|начальнику";
  const MANY_WHOM = new RegExp(`(?:^|\\s)(?:${WHOM})$`, "i");
  const MANY_WHOM_HEAD = new RegExp(`^(?:${WHOM})(?:$|\\s)`, "i");
  const MANY_MARK = /^(?:[-•*–—]\s+|\d{1,2}[.)]\s+|\[\s?\]\s*|\[[xхXХ]\]\s*)/;
  function splitMany(raw) {
    return splitManyX(raw).map((p) => p.text);
  }
  // Части с пометкой, шли ли они после «и ещё» / «а ещё» / «а также» (тогда хвост без глагола наследует покупку).
  // batch10 P3: внутри кавычек («…», "…", „…“) не делим — название книги или фильма остаётся целым.
  // Маска той же длины: кавычки и всё между ними — \u0001, разделители ищем по маске, режем оригинал.
  function maskQuotes(text) {
    return text.replace(/«[^«»\n]*»|"[^"\n]*"|„[^„“\n]*“|“[^“”\n]*”/g, (q) => "\u0001".repeat(q.length));
  }
  const MANY_LEAD = /^(?:потом|затем)\s+(?=\S)/i;
  function splitManyX(raw) {
    const text = String(raw || "").replace(/\r/g, "");
    const masked = maskQuotes(text);
    const re = new RegExp(MANY_SEP.source, "gi");
    const out = [];
    let last = 0;
    let also = false;
    let m;
    while ((m = re.exec(masked))) {
      if (!m[0].length) { re.lastIndex += 1; continue; }
      // Q-28: слово-разделитель («потом», «а ещё») делит, только если по обе стороны есть текст:
      // «подумать, что делать потом» — «потом» остаётся в деле.
      if (!/[\n;]/.test(m[0]) && (!text.slice(last, m.index).trim() || !/[^\s.,!?…—–-]/.test(text.slice(m.index + m[0].length)))) continue;
      out.push({ text: text.slice(last, m.index).trim(), also });
      also = MANY_ALSO.test(m[0].trim()) || MANY_ALSO.test(` ${m[0].trim()}`);
      last = m.index + m[0].length;
    }
    out.push({ text: text.slice(last).trim(), also });
    // «…; потом врач в 9»: слово-разделитель сразу после «;» или переноса — не часть названия
    return out.map((p, i) => (i > 0 ? { ...p, text: p.text.replace(MANY_LEAD, "") } : p)).filter((p) => p.text && !(out.length > 1 && /^(?:потом|затем)[.!…]*$/i.test(p.text)));
  }
  // split по маске: разделитель внутри кавычек не считается
  function splitOutside(text, re) {
    const masked = maskQuotes(text);
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const out = [];
    let last = 0;
    let m;
    while ((m = g.exec(masked))) {
      if (!m[0].length) { g.lastIndex += 1; continue; }
      out.push(text.slice(last, m.index));
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }
  function splitObjects(list) {
    const out = [];
    splitOutside(list, /\s*,\s*/).forEach((chunk) => {
      const bits = splitOutside(chunk, /\s+и\s+/i);
      let cur = bits[0];
      for (let i = 1; i < bits.length; i += 1) {
        if (MANY_PREP.test(cur) || (MANY_WHOM.test(cur) && MANY_WHOM_HEAD.test(bits[i]))) cur = `${cur} и ${bits[i]}`;
        else { out.push(cur); cur = bits[i]; }
      }
      out.push(cur);
    });
    return out.map((x) => x.trim()).filter(Boolean);
  }
  function parseMany(raw, ctx) {
    let text = String(raw || "").replace(/\r/g, "");
    let shared = null;
    const head = /^\s*([^:;\n]{1,40}):\s*([\s\S]+)$/.exec(text);
    if (head) {
      const probe = parse(`${head[1]} ы`, ctx);
      if (probe.ok && probe.dateSpoken && probe.title === "ы") {
        shared = head[1].trim();
        text = head[2];
      }
    }
    // batch9 п.6: «купить: хлеб, молоко» — глагол перед двоеточием относится ко всем.
    const verbHead = /^\s*([^:;\n]{1,20}):\s*([\s\S]+)$/.exec(text);
    if (!shared && verbHead && ERRAND_VERBS.some((v) => new RegExp(`^(?:${v.body})$`, "i").test(verbHead[1].trim()))) text = `${verbHead[1].trim()} ${verbHead[2]}`;
    const out = [];
    let prevVerb = null;
    for (const { text: piece, also: sepAlso } of splitManyX(text)) {
      // Маркеров может быть два подряд: «- [x] зарядка».
      let part = piece;
      // batch9 п.6: «купить хлеб; ещё молоко» — «ещё» в начале части (не «ещё раз») наследует глагол, как «и ещё».
      let also = sepAlso;
      const more = /^(?:и\s+|а\s+)?ещ[её]\s+(?!раз(?:а)?(?:\s|$))(?=\S)/i.exec(part);
      if (more && prevVerb) { also = true; part = part.slice(more[0].length); }
      let done = false;
      for (let i = 0; i < 2; i += 1) {
        const mark = MANY_MARK.exec(part);
        if (!mark) break;
        if (/\[[xхXХ]\]/.test(mark[0])) done = true;
        part = part.slice(mark[0].length).trim();
      }
      if (!part) continue;
      let r = parse(part, ctx);
      // «купить хлеб и ещё молоко»: хвост без своего глагола и без времени — тоже покупка.
      if (also && prevVerb && r.ok && r.kind === "loose" && !r.dateSpoken && r.startMin == null && !/^\S+(?:ть|ти|чь)(?:ся|сь)?(?:\s|$)/i.test(part)) {
        const inh = parse(`${prevVerb} ${part}`, ctx);
        if (inh.ok && inh.kind === "errand") r = inh;
      }
      if (shared && r.ok && !r.dateSpoken) {
        const both = parse(`${shared} ${part}`, ctx);
        if (both.ok) r = both;
      }
      if (!r.ok) {
        prevVerb = null;
        out.push({ ...r, text: part });
        continue;
      }
      prevVerb = null;
      if (r.kind === "errand") {
        let split = null;
        for (const verb of ERRAND_VERBS) {
          const m = new RegExp(`(?:^|\\s)(?:${verb.body})(?=$|[^${LETTER}])\\s+(.+)$`, "i").exec(part);
          if (!m) continue;
          prevVerb = m[0].trim().split(/\s+/)[0];
          const objs = splitObjects(m[1]);
          if (objs.length > 1) split = objs.map((o) => {
            const one = parse(`${m[0].trim().split(/\s+/)[0]} ${o}`, ctx);
            return { ...r, title: one.ok && one.title ? one.title : o, text: o };
          });
          break;
        }
        if (split) {
          out.push(...split);
          continue;
        }
      }
      out.push(done ? { ...r, done: true, text: part } : { ...r, text: part });
    }
    return out;
  }

  global.ListokParse = {
    parseMany,
    splitMany,
    GRACE,
    parse,
    marks,
    describe: describeWith,
    prep,
    ERRAND_VERBS,
    NUM_WORDS
  };
})(typeof window !== "undefined" ? window : globalThis);
