/**
 * IndexedDB для Planin. Задачи, список покупок, привычки, настройки.
 * Наружу ничего не уходит. Если IndexedDB недоступен — localStorage, затем память.
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

  function openDB() {
    if (useFallback) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!("indexedDB" in global)) {
        useFallback = true;
        hydrateFallback();
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => {
        useFallback = true;
        hydrateFallback();
        resolve(null);
      };
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ["tasks", "errands", "habits"].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        });
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
    });
    return dbPromise;
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
      quota: storageError === "quota"
    };
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
    const db = await openDB();
    if (!db || useFallback) return (memory[store] || []).slice();
    const tx = db.transaction(store, "readonly");
    return reqToPromise(tx.objectStore(store).getAll());
  }

  async function put(store, value) {
    const db = await openDB();
    if (!db || useFallback) {
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
  }

  async function del(store, key) {
    const db = await openDB();
    if (!db || useFallback) {
      memory[store] = (memory[store] || []).filter((x) => x.id !== key);
      persistFallback();
      return;
    }
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    return txDone(tx);
  }

  async function kvGet(key) {
    const db = await openDB();
    if (!db || useFallback) return memory.kv[key];
    const tx = db.transaction("kv", "readonly");
    return reqToPromise(tx.objectStore("kv").get(key));
  }

  async function kvSet(key, value) {
    const db = await openDB();
    if (!db || useFallback) {
      if (value === undefined) delete memory.kv[key];
      else memory.kv[key] = value;
      persistFallback();
      return;
    }
    const tx = db.transaction("kv", "readwrite");
    if (value === undefined) tx.objectStore("kv").delete(key);
    else tx.objectStore("kv").put(value, key);
    return txDone(tx);
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
    return (Array.isArray(rows) ? rows : []).filter((row) => row && row.id);
  }

  async function importAll(payload, { merge = true } = {}) {
    if (!payload || typeof payload !== "object") throw new Error("Пустой файл");
    if (payload.kit !== "listok") {
      throw new Error("Это не резервная копия Planin. Нужен JSON из «Экспорт».");
    }
    const tasks = cleanRows(payload.tasks);
    const errands = cleanRows(payload.errands);
    const habits = cleanRows(payload.habits);
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
      const putRows = (name, rows) => {
        const store = tx.objectStore(name);
        if (!merge) store.clear();
        rows.forEach((row) => store.put(row));
      };
      putRows("tasks", tasks);
      putRows("errands", errands);
      putRows("habits", habits);
      await txDone(tx);
    }
    if (payload.dayMeta && typeof payload.dayMeta === "object") {
      if (merge) {
        const cur = await getDayMetaAll();
        await saveDayMeta({ ...cur, ...payload.dayMeta });
      } else await saveDayMeta(payload.dayMeta);
    } else if (!merge) await saveDayMeta({});
    if (payload.settings) {
      const cur = merge ? await getSettings() : D().defaultSettings();
      await saveSettings({ ...cur, ...payload.settings, seenLegend: true });
    }
    return { tasks: tasks.length, errands: errands.length, habits: habits.length };
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
    id,
    init,
    storageInfo,
    getSettings,
    saveSettings,
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
    exportAll,
    importAll,
    replaceAll,
    wipe
  };
})(typeof window !== "undefined" ? window : globalThis);
