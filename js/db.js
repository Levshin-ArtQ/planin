/**
 * IndexedDB для Planin. Задачи, список покупок, привычки, настройки.
 * Наружу ничего не уходит. Если IndexedDB недоступен — временный резерв в localStorage
 * (с плашкой в интерфейсе), который вливается обратно при следующем удачном открытии.
 */
(function (global) {
  const DB_NAME = "listok-private";
  const DB_VERSION = 1;
  const LS_PREFIX = "listok:";
  const D = () => global.ListokDay;

  let dbPromise = null;
  let useFallback = false;
  let storageError = null;
  const memory = { tasks: [], errands: [], habits: [], kv: {} };

  function id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function notify(detail) {
    try { global.dispatchEvent(new CustomEvent("planin:storage", { detail })); } catch { /* нет DOM (тесты) */ }
  }

  function tryOpen() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onerror = () => reject(req.error);
      // Другая вкладка/копия PWA держит старую версию базы — иначе вечное «Открываю Planin…».
      req.onblocked = () => notify({ state: "blocked" });
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch { /* уже закрыта */ }
          dbPromise = null;
          notify({ state: "versionchange" });
        };
        resolve(db);
      };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ["tasks", "errands", "habits"].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        });
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
    });
  }

  function goFallback() {
    useFallback = true;
    hydrateFallback();
    notify({ state: "fallback" });
    return null;
  }

  // Резерв в localStorage — только на время отказа IndexedDB. Не молча (Q-7):
  // приложение показывает плашку, а при следующем удачном открытии резерв вливается обратно.
  function openDB() {
    if (useFallback) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      if (!("indexedDB" in global)) return goFallback();
      let db = await tryOpen().catch(() => null);
      if (!db) {
        await new Promise((r) => setTimeout(r, 400)); // временный отказ WebKit после фона
        db = await tryOpen().catch(() => null);
      }
      if (!db) return goFallback();
      try {
        await mergeReserve(db);
      } catch { /* резерв остаётся до следующего открытия */ }
      return db;
    })();
    return dbPromise;
  }

  function readReserve() {
    const out = {};
    let any = false;
    try {
      ["tasks", "errands", "habits", "kv"].forEach((name) => {
        const raw = global.localStorage && global.localStorage.getItem(LS_PREFIX + name);
        if (!raw) return;
        out[name] = JSON.parse(raw);
        any = true;
      });
    } catch {
      return null;
    }
    return any ? out : null;
  }

  let reserveMerged = 0;
  async function mergeReserve(db) {
    const reserve = readReserve();
    if (!reserve) return;
    const names = ["tasks", "errands", "habits"];
    const fix = { tasks: fixTask, errands: fixErrand, habits: fixHabit };
    const stamp = (r) => (r && (r.updatedAt || r.doneAt || r.createdAt)) || 0;
    const current = {};
    for (const name of names) current[name] = await reqToPromise(db.transaction(name, "readonly").objectStore(name).getAll());
    const kvTx = db.transaction("kv", "readonly").objectStore("kv");
    const curMeta = await reqToPromise(kvTx.get("dayMeta"));
    const curSettings = await reqToPromise(db.transaction("kv", "readonly").objectStore("kv").get("settings"));
    const tx = db.transaction([...names, "kv"], "readwrite");
    const done = txDone(tx);
    let merged = 0;
    names.forEach((name) => {
      const have = new Map(current[name].map((r) => [r.id, r]));
      cleanRows(reserve[name]).map(fix[name]).forEach((row) => {
        const old = have.get(row.id);
        if (old && stamp(old) >= stamp(row)) return;
        tx.objectStore(name).put(row);
        merged += 1;
      });
    });
    const kv = isObj(reserve.kv) ? reserve.kv : {};
    const meta = fixDayMeta(kv.dayMeta);
    if (meta) tx.objectStore("kv").put({ ...meta, ...(curMeta || {}) }, "dayMeta");
    const settings = fixSettings(kv.settings);
    if (settings && !curSettings) tx.objectStore("kv").put(settings, "settings");
    await done;
    ["tasks", "errands", "habits", "kv"].forEach((name) => global.localStorage.removeItem(LS_PREFIX + name));
    reserveMerged += merged;
  }

  function hydrateFallback() {
    try {
      ["tasks", "errands", "habits"].forEach((name) => {
        const raw = localStorage.getItem(LS_PREFIX + name);
        if (raw) memory[name] = JSON.parse(raw);
      });
      const kv = localStorage.getItem(LS_PREFIX + "kv");
      if (kv) memory.kv = JSON.parse(kv);
    } catch {
      /* пустое хранилище */
    }
  }

  function persistFallback() {
    try {
      ["tasks", "errands", "habits"].forEach((name) => {
        localStorage.setItem(LS_PREFIX + name, JSON.stringify(memory[name]));
      });
      localStorage.setItem(LS_PREFIX + "kv", JSON.stringify(memory.kv));
      storageError = null;
    } catch {
      storageError = "quota";
    }
  }

  function storageInfo() {
    return {
      backend: useFallback ? ("localStorage" in global ? "local" : "memory") : "idb",
      quota: storageError === "quota",
      merged: reserveMerged
    };
  }

  // Ошибка записи: приложение показывает «не сохранилось», а не теряет данные молча (Q-6).
  class WriteError extends Error {
    constructor(cause) {
      super(cause && cause.message ? cause.message : "write failed");
      this.name = "PlaninWriteError";
      this.cause = cause;
      this.quota = !!cause && cause.name === "QuotaExceededError";
    }
  }

  // WebKit на iOS рвёт соединение с IndexedDB после сворачивания PWA
  // («Connection to Indexed Database server lost», InvalidStateError при закрытии).
  function isLost(err) {
    return !!err && (err.name === "UnknownError" || err.name === "InvalidStateError" || /connection|closing/i.test(err.message || ""));
  }

  // Операция над IndexedDB с одним переоткрытием базы при обрыве соединения.
  async function withDB(fn) {
    const db = await openDB();
    if (!db || useFallback) return fn(null);
    try {
      return await fn(db);
    } catch (err) {
      if (!isLost(err)) throw err;
      try { db.close(); } catch { /* уже закрыта */ }
      dbPromise = null;
      const again = await openDB();
      if (!again || useFallback) throw err;
      return fn(again);
    }
  }

  async function write(fn) {
    try {
      return await withDB(fn);
    } catch (err) {
      throw err instanceof WriteError ? err : new WriteError(err);
    }
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  }

  async function getAll(store) {
    return withDB((db) => {
      if (!db) return (memory[store] || []).slice();
      const tx = db.transaction(store, "readonly");
      return reqToPromise(tx.objectStore(store).getAll());
    });
  }

  async function put(store, value) {
    return write(async (db) => {
      if (!db) {
        const list = memory[store];
        const i = list.findIndex((x) => x.id === value.id);
        if (i >= 0) list[i] = value;
        else list.push(value);
        persistFallback();
        return value;
      }
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      await txDone(tx);
      return value;
    });
  }

  async function del(store, key) {
    return write(async (db) => {
      if (!db) {
        memory[store] = (memory[store] || []).filter((x) => x.id !== key);
        persistFallback();
        return;
      }
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      await txDone(tx);
    });
  }

  async function kvGet(key) {
    return withDB((db) => {
      if (!db) return memory.kv[key];
      const tx = db.transaction("kv", "readonly");
      return reqToPromise(tx.objectStore("kv").get(key));
    });
  }

  async function kvSet(key, value) {
    return write(async (db) => {
      if (!db) {
        if (value === undefined) delete memory.kv[key];
        else memory.kv[key] = value;
        persistFallback();
        return;
      }
      const tx = db.transaction("kv", "readwrite");
      if (value === undefined) tx.objectStore("kv").delete(key);
      else tx.objectStore("kv").put(value, key);
      await txDone(tx);
    });
  }

  // Q-15: перед «заменить файлом» текущие данные целиком лежат в kv до следующей замены.
  async function saveReplaceBackup() {
    const data = await exportAll();
    await kvSet("replaceBackup", { at: Date.now(), data });
  }
  async function getReplaceBackup() {
    const b = await kvGet("replaceBackup");
    return b && typeof b === "object" && b.data && typeof b.data === "object" ? b : null;
  }
  async function clearReplaceBackup() {
    await kvSet("replaceBackup", undefined);
  }

  async function getSettings() {
    const saved = await kvGet("settings");
    return { ...D().defaultSettings(), ...(saved || {}) };
  }

  async function saveSettings(settings) {
    const next = { ...D().defaultSettings(), ...settings };
    await kvSet("settings", next);
    return next;
  }

  async function getDayMetaAll() {
    return (await kvGet("dayMeta")) || {};
  }

  async function saveDayMeta(meta) {
    await kvSet("dayMeta", meta || {});
    return meta;
  }

  async function listTasks() {
    return getAll("tasks");
  }
  async function listErrands() {
    return getAll("errands");
  }
  async function listHabits() {
    return getAll("habits");
  }

  async function putTask(task) {
    return put("tasks", task);
  }
  async function putErrand(item) {
    return put("errands", item);
  }
  async function putHabit(habit) {
    return put("habits", habit);
  }
  async function deleteTask(key) {
    return del("tasks", key);
  }
  async function deleteErrand(key) {
    return del("errands", key);
  }
  async function deleteHabit(key) {
    return del("habits", key);
  }

  async function exportAll() {
    const [tasks, errands, habits, settings, dayMeta] = await Promise.all([
      listTasks(),
      listErrands(),
      listHabits(),
      getSettings(),
      getDayMetaAll()
    ]);
    return {
      kit: "listok",
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks,
      errands,
      habits,
      dayMeta,
      settings
    };
  }

  function cleanRows(rows) {
    // Ключ хранилища — id; не-строка (объект, true) роняет put() посреди транзакции.
    return (Array.isArray(rows) ? rows : []).filter(
      (row) => row && typeof row === "object" && typeof row.id === "string" && row.id
    );
  }

  // Поля чужого файла приводятся к типам, с которыми работает отрисовка:
  // иначе, например, history: 5 или workDays: 3 роняют renderSheets при каждом
  // запуске, и приложение не открывается, пока не стереть данные.
  // Q-2: запись собирается из белого списка полей, строки режутся до 1000 символов,
  // даты — только настоящие YYYY-MM-DD, минуты — целые 0..1440.
  const MAX_TEXT = 1000;
  const MAX_ROWS = 10000;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const text = (v) => (v == null ? "" : typeof v === "object" ? "" : String(v)).slice(0, MAX_TEXT);
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const minute = (v) => (Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null);
  const flag = (v) => v === true;
  const ymd = (v) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const [y, m, d] = v.split("-").map(Number);
    return D().ymdValid(y, m, d) ? v : null;
  };
  // Порядок и набор ключей — как в исходной записи (экспорт → импорт байт-в-байт);
  // из fixed берутся только разрешённые ключи, обязательные добавляются, если их не было.
  function shape(row, fixed, required) {
    const out = {};
    Object.keys(row).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(fixed, k) && fixed[k] !== undefined) out[k] = fixed[k];
    });
    required.forEach((k) => { if (!(k in out)) out[k] = fixed[k]; });
    return out;
  }
  const stampDay = (ms) => (num(ms) != null && ms > 0 ? D().dayKey(new Date(ms)) : null);

  function fixTask(row) {
    const fixed = {
      id: row.id,
      kind: ["loose", "window", "slot"].includes(row.kind) ? row.kind : "loose",
      title: text(row.title),
      // Задача без настоящей даты нигде не видна: ставим её на день создания (или сегодня).
      date: ymd(row.date) || ymd(stampDay(row.createdAt)) || D().todayKey(),
      order: num(row.order),
      startMin: minute(row.startMin),
      endMin: Number.isInteger(row.endMin) && row.endMin >= 0 && row.endMin <= D().NIGHT_END_MAX ? row.endMin : null, // окно через полночь — до 12:00 следующих суток
      done: flag(row.done),
      doneAt: num(row.doneAt),
      createdAt: num(row.createdAt),
      updatedAt: num(row.updatedAt)
    };
    // Q-26/Q-27: конец не позже начала, через полночь дольше 14 ч или дальше 36:00, срок после полуночи без начала — конец отбрасываем.
    if (fixed.endMin != null && !D().windowEndOk(fixed.startMin, fixed.endMin)) fixed.endMin = null;
    fixed.carried = Number.isInteger(row.carried) && row.carried >= 0 ? Math.min(row.carried, 999) : undefined;
    fixed.draft = row.draft === true ? true : undefined;
    return shape(row, fixed, ["id", "kind", "title", "date"]);
  }

  function fixErrand(row) {
    return shape(row, {
      id: row.id,
      text: text(row.text),
      tag: ["buy", "pickup", "order"].includes(row.tag) ? row.tag : "buy",
      from: ymd(row.from),
      atMin: minute(row.atMin),
      done: flag(row.done),
      doneOn: ymd(row.doneOn),
      doneAt: num(row.doneAt),
      order: num(row.order),
      createdAt: num(row.createdAt),
      updatedAt: num(row.updatedAt)
    }, ["id", "text", "tag"]);
  }

  function fixHistory(rec) {
    return shape(rec, {
      action: rec.action === "shift" ? "shift" : "done",
      date: ymd(rec.date),
      prevDue: ymd(rec.prevDue),
      prevLast: ymd(rec.prevLast),
      days: Number.isInteger(rec.days) ? rec.days : undefined,
      prevWeekday: Number.isInteger(rec.prevWeekday) && rec.prevWeekday >= 0 && rec.prevWeekday <= 6 ? rec.prevWeekday : null
    }, ["action", "date"]);
  }

  function fixHabit(row) {
    const every = (v) => (Number.isInteger(v) && v >= 1 && v <= 999 ? v : 1);
    const everyMin = every(row.everyMin);
    return shape(row, {
      id: row.id,
      title: text(row.title),
      everyMin,
      everyMax: Math.max(everyMin, every(row.everyMax)),
      weekday: Number.isInteger(row.weekday) && row.weekday >= 0 && row.weekday <= 6 ? row.weekday : null,
      anchor: ["morning", "day", "evening", "night"].includes(row.anchor) ? row.anchor : null,
      timeMin: minute(row.timeMin),
      nextDue: ymd(row.nextDue),
      lastDone: ymd(row.lastDone),
      history: Array.isArray(row.history) ? row.history.filter(isObj).slice(-120).map(fixHistory).filter((h) => h.date) : [],
      order: num(row.order),
      createdAt: num(row.createdAt),
      updatedAt: num(row.updatedAt)
    }, ["id", "title", "everyMin", "everyMax", "weekday", "anchor", "timeMin", "nextDue", "lastDone", "history"]);
  }

  function fixSettings(raw) {
    if (!isObj(raw)) return null;
    const def = D().defaultSettings();
    const out = {};
    const pick = (k, ok) => { if (k in raw && ok(raw[k])) out[k] = raw[k]; };
    const int = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
    pick("workStartMin", int(0, 1440));
    pick("workEndMin", int(0, 1440));
    if ("workStartMin" in raw && !("workStartMin" in out)) out.workStartMin = def.workStartMin;
    if ("workEndMin" in raw && !("workEndMin" in out)) out.workEndMin = def.workEndMin;
    if ("workDays" in raw) {
      out.workDays = Array.isArray(raw.workDays)
        ? [...new Set(raw.workDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
        : def.workDays;
    }
    ["seenLegend", "shopOpen", "autoCarry"].forEach((k) => pick(k, (v) => typeof v === "boolean"));
    pick("doneStyle", (v) => ["fade", "strike", "both"].includes(v));
    pick("textSize", (v) => ["auto", "s", "m", "l"].includes(v));
    pick("tailDays", (v) => v === 14 || v === 30);
    pick("addedCount", int(0, 1e9));
    pick("legendShown", int(0, 1e9));
    pick("installHintUntil", (v) => num(v) != null);
    pick("carriedOn", (v) => ymd(v) != null);
    pick("deckOn", (v) => ymd(v) != null); // R-34: тихая строка «разобрать день» уже открывалась сегодня
    if (isObj(raw.hints)) {
      out.hints = {};
      ["swipe", "defer", "hold"].forEach((k) => { if (raw.hints[k] === true) out.hints[k] = true; });
    }
    // R-33: названия, для которых уже спрашивали «сделать привычкой?» (ответ не повторяем).
    if (isObj(raw.habitAsked)) {
      out.habitAsked = {};
      Object.keys(raw.habitAsked).filter((k) => k.length <= 200 && raw.habitAsked[k] === 1).slice(-500)
        .forEach((k) => { out.habitAsked[k] = 1; });
    }
    return out;
  }

  function fixDayMeta(raw) {
    if (!isObj(raw)) return null;
    const out = {};
    Object.keys(raw).forEach((key) => {
      const meta = raw[key];
      if (!ymd(key) || !isObj(meta)) return;
      const copy = {};
      if (Array.isArray(meta.planOrder)) {
        copy.planOrder = meta.planOrder.filter((t) => typeof t === "string" && t.length <= 300).slice(0, MAX_ROWS);
      }
      if (meta.manualOrder === true) copy.manualOrder = true;
      if (meta.went === true) copy.went = true;
      if (meta.rail === "full" || meta.rail === "list") copy.rail = meta.rail;
      out[key] = copy;
    });
    return out;
  }

  // Q-2: не больше 10 000 записей на таблицу; id — непустая строка до 200 символов.
  function takeRows(rows, fix, skipped) {
    const all = cleanRows(rows);
    const ok = all.filter((row) => row.id.length <= 200);
    skipped.n += (Array.isArray(rows) ? rows.length : 0) - ok.length;
    if (ok.length > MAX_ROWS) skipped.n += ok.length - MAX_ROWS;
    return ok.slice(0, MAX_ROWS).map(fix);
  }

  async function importAll(payload, { merge = true } = {}) {
    if (!payload || typeof payload !== "object") throw new Error("Пустой файл");
    if (payload.kit !== "listok") {
      throw new Error("Это не резервная копия Planin. Нужен JSON из «Экспорт».");
    }
    const skipped = { n: 0 };
    const tasks = takeRows(payload.tasks, fixTask, skipped);
    const errands = takeRows(payload.errands, fixErrand, skipped);
    const habits = takeRows(payload.habits, fixHabit, skipped);
    const dayMeta = fixDayMeta(payload.dayMeta);
    const settings = fixSettings(payload.settings);
    const db = await openDB();
    if (!db || useFallback) {
      if (!merge) {
        memory.tasks = [];
        memory.errands = [];
        memory.habits = [];
      }
      mergeMemory("tasks", tasks);
      mergeMemory("errands", errands);
      mergeMemory("habits", habits);
      persistFallback();
    } else {
      const tx = db.transaction(["tasks", "errands", "habits"], "readwrite");
      const done = txDone(tx);
      const putRows = (name, rows) => {
        const store = tx.objectStore(name);
        if (!merge) store.clear();
        rows.forEach((row) => store.put(row));
      };
      try {
        putRows("tasks", tasks);
        putRows("errands", errands);
        putRows("habits", habits);
      } catch (err) {
        // Синхронная ошибка put() не отменяет транзакцию сама: без abort()
        // clear() и часть записей закоммитятся, и данные пропадут.
        try { tx.abort(); } catch { /* уже завершена */ }
        done.catch(() => {});
        throw new Error("Файл повреждён, ничего не изменено");
      }
      await done;
    }
    if (dayMeta) {
      if (merge) {
        const cur = await getDayMetaAll();
        await saveDayMeta({ ...cur, ...dayMeta });
      } else await saveDayMeta(dayMeta);
    } else if (!merge) await saveDayMeta({});
    if (settings) {
      const cur = merge ? await getSettings() : D().defaultSettings();
      await saveSettings({ ...cur, ...settings, seenLegend: true });
    }
    return { tasks: tasks.length, errands: errands.length, habits: habits.length, skipped: skipped.n };
  }

  function mergeMemory(store, rows) {
    const ids = new Set(memory[store].map((x) => x.id));
    for (const row of rows) {
      if (ids.has(row.id)) {
        const i = memory[store].findIndex((x) => x.id === row.id);
        memory[store][i] = row;
      } else {
        memory[store].push(row);
        ids.add(row.id);
      }
    }
  }

  async function replaceAll(data) {
    const tasks = cleanRows(data.tasks);
    const errands = cleanRows(data.errands);
    const habits = cleanRows(data.habits);
    const db = await openDB();
    if (!db || useFallback) {
      memory.tasks = tasks;
      memory.errands = errands;
      memory.habits = habits;
      memory.kv.dayMeta = data.dayMeta || {};
      if (data.settings) memory.kv.settings = data.settings;
      persistFallback();
      return;
    }
    const tx = db.transaction(["tasks", "errands", "habits", "kv"], "readwrite");
    const wipe = (name, rows) => {
      const store = tx.objectStore(name);
      store.clear();
      rows.forEach((row) => store.put(row));
    };
    wipe("tasks", tasks);
    wipe("errands", errands);
    wipe("habits", habits);
    tx.objectStore("kv").put(data.dayMeta || {}, "dayMeta");
    if (data.settings) tx.objectStore("kv").put(data.settings, "settings");
    await txDone(tx);
  }

  async function wipe() {
    const db = await openDB();
    if (!db || useFallback) {
      memory.tasks = [];
      memory.errands = [];
      memory.habits = [];
      memory.kv = {};
      persistFallback();
      return;
    }
    const tx = db.transaction(["tasks", "errands", "habits", "kv"], "readwrite");
    ["tasks", "errands", "habits", "kv"].forEach((name) => tx.objectStore(name).clear());
    await txDone(tx);
  }

  async function init() {
    await openDB();
    if (useFallback) hydrateFallback();
  }

  global.ListokDB = {
    MAX_FILE: 5 * 1024 * 1024,
    id,
    WriteError,
    init,
    storageInfo,
    getSettings,
    saveSettings,
    saveReplaceBackup,
    getReplaceBackup,
    clearReplaceBackup,
    getDayMetaAll,
    saveDayMeta,
    listTasks,
    listErrands,
    listHabits,
    putTask,
    putErrand,
    putHabit,
    deleteTask,
    deleteErrand,
    deleteHabit,
    getDrafts: () => kvGet("drafts"),
    saveDrafts: (value) => kvSet("drafts", value),
    exportAll,
    importAll,
    replaceAll,
    wipe
  };
})(typeof window !== "undefined" ? window : globalThis);
