'use strict';
/* =========================================================
   API (Google Apps Script)
========================================================= */
function apiError(kind, message, status) {
  const err = new Error(message);
  err.kind = kind;
  err.retryable = kind === 'network' || kind === 'timeout' || (kind === 'http' && status >= 500);
  return err;
}

function apiUrl(action, params) {
  let q = '?action=' + encodeURIComponent(action);
  if (params) {
    Object.keys(params).forEach(function (k) {
      q += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    });
  }
  return API_URL + q;
}

function describeApiError(err) {
  if (!err) return 'خطای ناشناخته';
  switch (err.kind) {
    case 'network': return 'اتصال به سرور برقرار نشد. اینترنت خود را بررسی کنید و دوباره تلاش کنید.';
    case 'timeout': return 'پاسخ سرور دیر رسید. کمی بعد دوباره تلاش کنید.';
    case 'format': return 'پاسخ گوگل اسکریپت قابل‌خواندن نبود. مطمئن شوید آدرس /exec درست است و دسترسی (Who has access) روی Anyone تنظیم شده است.';
    case 'http': return 'سرور خطا داد (' + err.message + ').';
    case 'aborted': return 'متوقف شد.';
    default: return err.message || 'خطای ناشناخته';
  }
}

/* opts: timeout (ms)، retries، signal (AbortSignal بیرونی برای لغو) */
async function apiGet(action, params, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeout || 25000;
  const retries = opts.retries === undefined ? 1 : opts.retries;
  const outer = opts.signal || null;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (outer && outer.aborted) throw apiError('aborted', 'aborted');
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const forward = function () { if (ctl) ctl.abort(); };
    if (outer) outer.addEventListener('abort', forward);
    const timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    try {
      // درخواست ساده (بدون هدر سفارشی) تا مرورگر preflight نفرستد
      const res = await fetch(apiUrl(action, params), ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) throw apiError('http', 'HTTP ' + res.status, res.status);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { throw apiError('format', 'invalid json'); }
      if (!json || json.ok === false) throw apiError('server', (json && json.error) ? String(json.error) : 'خطای ناشناخته از سرور');
      return json;
    } catch (err) {
      if (outer && outer.aborted) { lastErr = apiError('aborted', 'aborted'); break; }
      if (err && err.kind) lastErr = err;
      else if (err && err.name === 'AbortError') lastErr = apiError('timeout', 'timeout');
      else lastErr = apiError('network', String(err && err.message || err));
      if (attempt < retries && lastErr.retryable) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', forward);
    }
  }
  throw lastErr;
}

/* =========================================================
   IDB — متن سوره‌ها روی دستگاه (جای بیشتر و پایدارتر از localStorage).
   هر خطایی (حالت خصوصی، حافظهٔ پر…) فقط یعنی «ذخیره نشد»؛ برنامه بدون آن هم کار می‌کند.
========================================================= */
const IDB_NAME = 'quran_data_v1';
let idbPromise = null;

function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise(function (resolve) {
    let done = false;
    const finish = function (db) { if (!done) { done = true; resolve(db); } };
    setTimeout(function () { finish(null); }, 4000);          // بعضی مرورگرها در حالت خصوصی هیچ پاسخی نمی‌دهند
    let req = null;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) { finish(null); return; }
      req = indexedDB.open(IDB_NAME, 1);
    } catch (e) { finish(null); return; }
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains('surahs')) db.createObjectStore('surahs', { keyPath: 'n' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = function () {
      const db = req.result;
      db.onversionchange = function () { try { db.close(); } catch (e) { /* ignore */ } idbPromise = null; };
      finish(db);
    };
    req.onerror = function () { finish(null); };
    req.onblocked = function () { finish(null); };
  });
  return idbPromise;
}

function idbRun(storeName, mode, fn) {
  return idbOpen().then(function (db) {
    if (!db) return undefined;
    return new Promise(function (resolve) {
      try {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = function () { resolve(mode === 'readonly' ? (req ? req.result : undefined) : true); };
        tx.onerror = function () { resolve(undefined); };
        tx.onabort = function () { resolve(undefined); };
      } catch (e) { resolve(undefined); }
    });
  });
}

function idbGet(storeName, key) { return idbRun(storeName, 'readonly', function (s) { return s.get(key); }); }
function idbGetAll(storeName) { return idbRun(storeName, 'readonly', function (s) { return s.getAll(); }); }
function idbPut(storeName, value) { return idbRun(storeName, 'readwrite', function (s) { return s.put(value); }); }
function idbDelete(storeName, key) { return idbRun(storeName, 'readwrite', function (s) { return s.delete(key); }); }
function idbClear(storeName) { return idbRun(storeName, 'readwrite', function (s) { return s.clear(); }); }

function kvGet(k) { return idbGet('kv', k).then(function (r) { return r ? r.v : undefined; }); }
function kvSet(k, v) { return idbPut('kv', { k: k, v: v }); }

/* =========================================================
   DATA — فهرست سوره‌ها و آیه‌ها (حافظه ← دستگاه ← شبکه)
   قاعده: هر چیزی که روی دستگاه باشد همان لحظه نمایش داده می‌شود؛ اگر کهنه بود، بی‌صدا در پس‌زمینه تازه می‌شود.
========================================================= */
const mem = { surahs: null, data: new Map(), inflight: new Map(), listInflight: null, refreshing: new Set() };

function lsSurahKey(num) { return KEYS.cachePrefix + 'surah:' + num; }

/* حافظهٔ localStorage فقط پشتیبان است (وقتی IndexedDB در دسترس نباشد) */
function lsPutSurah(entry) {
  if (store.set(lsSurahKey(entry.n), entry)) return true;
  storageKeys(KEYS.cachePrefix + 'surah:').forEach(store.remove);
  return store.set(lsSurahKey(entry.n), entry);
}

function validEntry(e) {
  return !!(e && e.v === CACHE_VERSION && e.payload && Array.isArray(e.payload.ayahs));
}

async function dataGet(num) {
  const e = await idbGet('surahs', num);
  if (validEntry(e)) return e;
  const l = store.get(lsSurahKey(num), null);
  return validEntry(l) ? l : null;
}

async function dataPut(num, payload, saved) {
  /* سوره‌ای که برای آفلاین ذخیره شده با یک دریافت معمولی از حالت «ذخیره‌شده» خارج نمی‌شود */
  const keep = !!saved || (typeof off !== 'undefined' && off.textSaved && off.textSaved.has(num));
  const entry = { n: num, v: CACHE_VERSION, at: Date.now(), saved: keep, payload: payload };
  const ok = await idbPut('surahs', entry);
  if (ok) { store.remove(lsSurahKey(num)); return true; }
  return lsPutSurah(entry);
}

function slimPayload(json) {
  return { surah: json.surah, total_ayahs: json.total_ayahs, has_bismillah: json.has_bismillah, bismillah: json.bismillah, ayahs: json.ayahs };
}

/* کش نسخهٔ قبلی (localStorage) دیگر استفاده نمی‌شود؛ جایش آزاد شود */
function purgeOldCaches() {
  storageKeys(KEYS.oldCachePrefix).forEach(store.remove);
}

/* پاک‌کردن حافظهٔ موقت؛ سوره‌هایی که برای آفلاین ذخیره شده‌اند می‌مانند */
async function clearTextCache() {
  storageKeys(KEYS.cachePrefix).forEach(store.remove);
  const all = await idbGetAll('surahs');
  if (Array.isArray(all)) {
    for (let i = 0; i < all.length; i++) {
      if (!all[i].saved) await idbDelete('surahs', all[i].n);
    }
  }
  mem.data.clear();
  mem.surahs = null;
}

function validSurahList(list) {
  return Array.isArray(list) && list.length > 0 && list.every(function (s) { return s && Number(s.number) >= 1; });
}

async function fetchSurahList(opts) {
  const json = await apiGet('surahs', null, opts);
  if (!validSurahList(json.surahs)) throw apiError('server', 'فهرست سوره‌ها نامعتبر است');
  const entry = { v: CACHE_VERSION, at: Date.now(), data: json.surahs };
  store.set(KEYS.cachePrefix + 'surahs', entry);
  kvSet('surahs', entry).then(noop, noop);          // نسخهٔ دوم در IndexedDB؛ با پاک‌کردن حافظهٔ موقت از بین نمی‌رود
  mem.surahs = json.surahs;
  return json.surahs;
}

function loadSurahList() {
  if (mem.surahs) return Promise.resolve(mem.surahs);
  if (mem.listInflight) return mem.listInflight;

  mem.listInflight = (async function () {
    let entry = store.get(KEYS.cachePrefix + 'surahs', null);
    if (!(entry && entry.v === CACHE_VERSION && validSurahList(entry.data))) {
      try { entry = await kvGet('surahs'); } catch (e) { entry = null; }
    }
    if (entry && entry.v === CACHE_VERSION && validSurahList(entry.data)) {
      mem.surahs = entry.data;
      if (Date.now() - Number(entry.at || 0) > STALE_MS && navigator.onLine !== false) {
        fetchSurahList({ retries: 0 }).then(noop, noop);
      }
      return mem.surahs;
    }
    return fetchSurahList();
  })();

  const clear = function () { mem.listInflight = null; };
  mem.listInflight.then(clear, clear);
  return mem.listInflight;
}

/* پاسخ سرور → ساختار داخلی. بسم‌الله یک بار دیگر هم اینجا جدا می‌شود تا حتی اگر
   نسخه قدیمیِ گوگل‌اسکریپت یا کش قدیمی جواب داد، آیه اول با بسم‌الله قاطی نشود. */
function prepareSurahData(num, json) {
  if (!json || !Array.isArray(json.ayahs) || json.ayahs.length === 0) {
    throw apiError('server', 'داده سوره نامعتبر است');
  }
  const hasBismillah = surahHasBismillah(num);
  let bismillah = hasBismillah ? String(json.bismillah || '') : '';

  const ayahs = json.ayahs.map(function (a) {
    return {
      id: a.id,
      surah_id: Number(a.surah_id || num),
      ayah_number: Number(a.ayah_number),
      text_ar: a.text_ar === null || a.text_ar === undefined ? '' : String(a.text_ar),
      text_fa: a.text_fa ? String(a.text_fa).trim() : '',
      juz: Number(a.juz) || null,
      page: Number(a.page) || null
    };
  }).sort(function (a, b) { return a.ayah_number - b.ayah_number; });

  if (hasBismillah && ayahs[0].ayah_number === 1) {
    const split = stripBismillah(ayahs[0].text_ar);
    if (split.bismillah) {
      ayahs[0].text_ar = split.rest;
      if (!bismillah) bismillah = split.bismillah;
    }
  }
  if (hasBismillah && !bismillah) bismillah = BISMILLAH_FALLBACK;

  return {
    surah: num,
    ayahs: ayahs,
    hasBismillah: hasBismillah,
    bismillah: bismillah,
    hasFa: ayahs.some(function (a) { return !!a.text_fa; })
  };
}

function loadSurahData(num) {
  if (mem.data.has(num)) return Promise.resolve(mem.data.get(num));
  if (mem.inflight.has(num)) return mem.inflight.get(num);

  const p = (async function () {
    const entry = await dataGet(num);
    if (entry) {
      try {
        const d = prepareSurahData(num, entry.payload);
        mem.data.set(num, d);
        if (Date.now() - Number(entry.at || 0) > STALE_MS) refreshSurahInBackground(num, entry.saved);
        return d;
      } catch (e) { /* ذخیره‌شدهٔ خراب است؛ از شبکه می‌گیریم */ }
    }
    const json = await apiGet('ayahs', { surah: num });
    const d = prepareSurahData(num, json);
    mem.data.set(num, d);
    dataPut(num, slimPayload(json), !!(entry && entry.saved)).then(noop, noop);   // نمایش منتظر ذخیره‌شدن نمی‌ماند
    return d;
  })();

  mem.inflight.set(num, p);
  const clear = function () { mem.inflight.delete(num); };
  p.then(clear, clear);
  return p;
}

/* تازه‌کردن بی‌صدای یک سورهٔ کهنه؛ هر خطایی نادیده گرفته می‌شود */
function refreshSurahInBackground(num, saved) {
  if (navigator.onLine === false || mem.refreshing.has(num)) return;
  mem.refreshing.add(num);
  apiGet('ayahs', { surah: num }, { retries: 0 }).then(function (json) {
    const d = prepareSurahData(num, json);
    mem.data.set(num, d);
    return dataPut(num, slimPayload(json), !!saved);
  }).then(noop, noop).then(function () { mem.refreshing.delete(num); });
}

/* فقط از حافظه (همگام) */
function peekSurahData(num) {
  return mem.data.get(num) || null;
}

/* فقط از حافظه یا دستگاه، بدون شبکه: برای خلاصهٔ آیه در یادآوری‌ها و ترجمهٔ بسم‌الله */
async function localSurahData(num) {
  if (mem.data.has(num)) return mem.data.get(num);
  const e = await dataGet(num);
  if (!e) return null;
  try {
    const d = prepareSurahData(num, e.payload);
    mem.data.set(num, d);
    return d;
  } catch (err) {
    return null;
  }
}

function canPrefetch() {
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) return false;
  const c = navigator.connection;
  return !(c && c.saveData);
}

function prefetchSurahData(n) {
  if (!(n >= 1 && n <= 114) || mem.data.has(n) || mem.inflight.has(n) || !canPrefetch()) return;
  loadSurahData(n).then(noop, noop);
}

/* =========================================================
   نام سوره‌ها و وضعیت نمایش
========================================================= */
const S = {
  surahs: [],            // فهرست ۱۱۴ سوره از سرور
  surahMap: {},
  surah: 0,              // سوره‌ای که نمایش داده می‌شود و پخش‌کننده هم به همین وصل است
  data: null,
  items: [],             // فهرست پخش: بسم‌الله (اگر دارد) + آیه‌ها
  els: [],               // عناصر DOM هر آیتم
  pos: -1,               // اندیس آیتم فعال
  activeEl: null,
  navToken: 0,           // هر رفتن به سوره جدید یک شماره تازه می‌گیرد؛ پاسخ‌های کهنه نادیده گرفته می‌شوند
  loadingNum: 0,
  autoLoading: false,    // بارگذاریِ در انتظار از پخش خودکار آمده است
  retryFn: null
};

function setSurahs(list) {
  S.surahs = list;
  S.surahMap = {};
  list.forEach(function (s) { S.surahMap[Number(s.number)] = s; });
}

function surahBase(n) {
  const s = S.surahMap[n];
  const name = s && s.name_fa ? String(s.name_fa).replace(/^\s*سوره\s*/, '').trim() : '';
  return name;
}

function surahShort(n) {
  return surahBase(n) || ('سوره ' + faNum(n));
}

function surahTitle(n) {
  const b = surahBase(n);
  return b ? ('سوره ' + b) : ('سوره ' + faNum(n));
}

/* تعداد آیه‌های یک سوره (برای ذخیره آفلاین؛ اگر فهرست نیامده بود از جدول ثابت) */
const AYAH_COUNTS = [7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11,
  11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25,
  22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4,
  7, 3, 6, 3, 5, 4, 5, 6];

function ayahCount(n) {
  const s = S.surahMap[n];
  const c = s ? Number(s.ayah_count) : 0;
  return c > 0 ? c : (AYAH_COUNTS[n - 1] || 0);
}
