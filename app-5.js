'use strict';
/* =========================================================
   OFFLINE — ذخیرهٔ صوت (Cache Storage) و متن (IndexedDB) برای استفادهٔ بدون اینترنت

   - متن و ترجمهٔ همهٔ ۱۱۴ سوره بعد از باز شدن سورهٔ اول، خودکار و در پس‌زمینه روی دستگاه ذخیره می‌شود
     (بخش TEXT SYNC)؛ بعد از آن همهٔ امکانات جز صوت بدون اینترنت هم کار می‌کنند.
   - هر فایل صوتی با «آدرس مستقیم»ش کلید می‌خورد؛ پخش‌کننده (app-4) قبل از هر دریافت از اینجا می‌پرسد.
   - ذخیره‌کردن با مسیر معمولی (مستقیم، و در صورت نیاز مسیر گوگل) و حداکثر ۳ دریافت هم‌زمان انجام می‌شود.
   - هر کاری قابل توقف و ادامه است: فایل‌های ذخیره‌شده دوباره دریافت نمی‌شوند.
========================================================= */
const OFF_CACHE = 'quran-audio-v1';
const OFF_CONCURRENCY = 3;
const OFF_RETRIES = 3;

/* حجم تقریبی صوت هر سوره (بایت) برای نمایش برآورد پیش از دانلود؛ اگر نباشد برآوردی نشان داده نمی‌شود */
const OFF_SIZES = null;

const off = {
  urls: new Set(),          // آدرس همهٔ فایل‌های صوتیِ ذخیره‌شده
  textSaved: new Set(),     // شمارهٔ سوره‌هایی که متنشان برای آفلاین ذخیره شده
  ready: false,             // فهرست صوت‌های ذخیره‌شده خوانده شد
  textReady: false,         // فهرست متن‌های ذخیره‌شده خوانده شد
  job: null,
  wake: null,
  confirm: null,            // { kind, surahs, text } تأییدِ در انتظار
  usage: null               // { usage, quota }
};

function offlineSupported() {
  return typeof caches !== 'undefined' && !!window.isSecureContext;
}

function offUrl(t) { return audioUrl(t.fa ? AUDIO_BASES.fa : AUDIO_BASES.ar, t.surah, t.ayah); }

function offlineHas(url) { return off.urls.has(url); }

async function offlineBlob(url) {
  try {
    const c = await caches.open(OFF_CACHE);
    const res = await c.match(url);
    return res ? await res.blob() : null;
  } catch (e) {
    return null;
  }
}

function offlineTracksOf(n) { return tracksForMode(n, ayahCount(n), settings.audioMode); }

/* همهٔ آهنگ‌های ممکن یک سوره (عربی و ترجمه)؛ برای شمارش و حذف مستقل از حالت پخش */
function offlineAllTracksOf(n) { return tracksForMode(n, ayahCount(n), 'both'); }

/* فایل «بسم‌الله عربی» (۱:۱) بین همهٔ سوره‌ها مشترک است؛ فقط برای کامل‌بودن هر سوره لازم است
   و به‌تنهایی نشان نمی‌دهد که صوتِ آن سوره ذخیره شده */
function isSharedBis(t) { return !t.fa && t.surah === 1 && t.ayah === 1; }

/* چند فایلِ خودِ این سوره (به‌جز فایل مشترک بسم‌الله)، در هر حالتی، ذخیره شده است */
function offlineAnyCount(n) {
  let have = 0;
  offlineAllTracksOf(n).forEach(function (t) { if (!isSharedBis(t) && off.urls.has(offUrl(t))) have++; });
  return have;
}

/* have/total: برای کامل‌بودنِ سوره در حالت فعلی؛ own: فقط فایل‌های خودِ سوره */
function offlineCount(n) {
  const tr = offlineTracksOf(n);
  let have = 0;
  let own = 0;
  tr.forEach(function (t) {
    if (!off.urls.has(offUrl(t))) return;
    have++;
    if (!isSharedBis(t)) own++;
  });
  return { have: have, own: own, total: tr.length };
}

function offlineComplete(n) {
  if (!off.ready) return false;
  const c = offlineCount(n);
  return c.total > 0 && c.have === c.total;
}

function offlineSavedSurahs() {
  const out = [];
  for (let n = 1; n <= 114; n++) {
    const c = offlineCount(n);
    const any = offlineAnyCount(n);
    if (any > 0) out.push({ n: n, have: c.have, own: c.own, total: c.total, any: any });
  }
  return out;
}

async function offlineInit() {
  if (offlineSupported()) {
    try {
      const c = await caches.open(OFF_CACHE);
      const reqs = await c.keys();
      reqs.forEach(function (r) { off.urls.add(r.url); });
    } catch (e) { /* ذخیره‌ای نیست */ }
  }
  off.ready = true;
  refreshOfflineUI();
  refreshStorageUsage();

  /* خواندن فهرست متن‌های ذخیره‌شده تا وقتی سورهٔ اول نمایش داده نشده منتظر می‌ماند: اول همان سوره‌ای که کاربر باز کرده */
  const t0 = Date.now();
  while ((!S.data || S.loadingNum) && Date.now() - t0 < 5000) await sleep(120);
  try {
    const all = await idbGetAll('surahs');
    if (Array.isArray(all)) all.forEach(function (e) { if (e && e.saved && validEntry(e)) off.textSaved.add(Number(e.n)); });
  } catch (e) { /* ignore */ }
  off.textReady = true;
  refreshOfflineUI();
  bindTextSyncTriggers();
  setTimeout(function () { autoStartTextSync(0); }, TXT_START_DELAY);
}

function refreshStorageUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        off.usage = { usage: Number(e.usage) || 0, quota: Number(e.quota) || 0 };
        if (sheets.open === 'offline') renderOfflineSheet();
      }, noop);
    }
  } catch (e) { /* ignore */ }
}

/* =========================================================
   کار دانلود
========================================================= */
function estimateBytes(surahs) {
  if (!OFF_SIZES) return null;
  let sum = 0;
  surahs.forEach(function (n) { sum += Number(OFF_SIZES[n - 1]) || 0; });
  return sum || null;
}

function buildTasks(kind, surahs) {
  const tasks = [];
  const seen = new Set();
  surahs.forEach(function (n) {
    if (!off.textSaved.has(n)) tasks.push({ type: 'text', s: n });
    if (kind !== 'audio') return;
    offlineTracksOf(n).forEach(function (t) {
      const url = offUrl(t);
      if (off.urls.has(url) || seen.has(url)) return;
      seen.add(url);
      tasks.push({ type: 'audio', t: t, url: url, s: n });
    });
  });
  return tasks;
}

async function saveSurahText(n, signal) {
  await loadSurahData(n);
  let e = await dataGet(n);
  if (!e) {
    const json = await apiGet('ayahs', { surah: n }, { signal: signal });
    await dataPut(n, slimPayload(json), true);
    off.textSaved.add(n);
    return;
  }
  if (!e.saved) await dataPut(n, e.payload, true);
  off.textSaved.add(n);
}

async function putAudio(url, blob) {
  const c = await caches.open(OFF_CACHE);
  await c.put(url, new Response(blob, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(blob.size) } }));
  off.urls.add(url);
}

function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')));
}

async function runTask(J, task) {
  for (let attempt = 1; attempt <= OFF_RETRIES; attempt++) {
    if (J.state !== 'running') return 'stopped';
    try {
      if (task.type === 'text') {
        await saveSurahText(task.s, J.ctl.signal);
      } else {
        const blob = await fetchTrackBlob(task.t, J.ctl.signal);
        await putAudio(task.url, blob);
        J.bytes += blob.size;
      }
      return 'ok';
    } catch (err) {
      if (J.state !== 'running' || (err && err.kind === 'aborted')) return 'stopped';
      if (isQuotaError(err)) { failJob(J, 'حافظهٔ این دستگاه پر شد؛ جای کافی آزاد کنید یا چند سوره را حذف کنید.'); return 'stopped'; }
      if (typeof navigator.onLine === 'boolean' && !navigator.onLine) return 'offline';
      if (attempt < OFF_RETRIES) await sleep(500 * attempt * attempt);
    }
  }
  return 'fail';
}

async function offWorker(J) {
  while (J.state === 'running') {
    const i = J.next++;
    if (i >= J.tasks.length) return;
    const r = await runTask(J, J.tasks[i]);
    if (J.state !== 'running') return;
    if (r === 'ok') {
      J.done++;
      J.consecFail = 0;
    } else if (r === 'offline') {
      pauseJob(J, 'اینترنت قطع شد. هر چه ذخیره شده می‌ماند؛ بعد از اتصال «ادامه» را بزنید.');
      return;
    } else {
      J.failed++;
      J.consecFail++;
      if (J.consecFail >= 6) {
        pauseJob(J, 'اتصال ناپایدار است. هر چه ذخیره شده می‌ماند؛ کمی بعد «ادامه» را بزنید.');
        return;
      }
    }
    queueOfflineUI();
  }
}

async function requestWake() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) off.wake = await navigator.wakeLock.request('screen');
  } catch (e) { off.wake = null; }
}

function releaseWake() {
  try { if (off.wake && off.wake.release) off.wake.release(); } catch (e) { /* ignore */ }
  off.wake = null;
}

function endJobCleanup(J) {
  releaseWake();
  J.ended = Date.now();
  refreshStorageUsage();
  refreshOfflineUI();
}

function pauseJob(J, message) {
  if (!J || J.state !== 'running') return;
  J.state = 'paused';
  J.error = message || '';
  try { J.ctl.abort(); } catch (e) { /* ignore */ }
  endJobCleanup(J);
  if (message) showToast(message, { ms: 6000 });
}

function failJob(J, message) {
  if (!J || J.state !== 'running') return;
  J.state = 'error';
  J.error = message;
  try { J.ctl.abort(); } catch (e) { /* ignore */ }
  endJobCleanup(J);
  showToast(message, { ms: 7000 });
}

function startOfflineJob(kind, surahs) {
  if (!offlineSupported()) {
    showToast('این مرورگر ذخیرهٔ آفلاین را پشتیبانی نمی‌کند.');
    return;
  }
  if (off.job && off.job.state === 'running') return;
  const tasks = buildTasks(kind, surahs);
  if (!tasks.length) {
    showToast('همهٔ این بخش قبلاً ذخیره شده است.');
    refreshOfflineUI();
    return;
  }
  const J = {
    kind: kind, surahs: surahs, tasks: tasks, total: tasks.length, done: 0, failed: 0, bytes: 0,
    state: 'running', error: '', ctl: new AbortController(), next: 0, consecFail: 0, started: Date.now(), ended: 0
  };
  off.job = J;
  off.confirm = null;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(noop, noop); } catch (e) { /* ignore */ }
  requestWake();
  refreshOfflineUI();
  const workers = [];
  for (let i = 0; i < OFF_CONCURRENCY; i++) workers.push(offWorker(J));
  Promise.all(workers).then(function () {
    if (J.state !== 'running') return;
    if (J.failed === 0) {
      J.state = 'done';
      endJobCleanup(J);
      showToast(kind === 'audio' ? 'ذخیره برای آفلاین تمام شد.' : 'متن سوره‌ها ذخیره شد.');
    } else {
      J.state = 'paused';
      J.error = J.failed + ' مورد ذخیره نشد. دوباره «ادامه» را بزنید.';
      endJobCleanup(J);
      showToast(J.error, { ms: 6000 });
    }
  });
}

function resumeOfflineJob() {
  const J = off.job;
  if (!J || J.state === 'running' || J.state === 'done') return;
  startOfflineJob(J.kind, J.surahs);
}

/* =========================================================
   حذف
========================================================= */
/* آیا سوره‌ای غیر از این، فایل مشترک بسم‌الله را لازم دارد؟ (یعنی صوتِ خودش را هم ذخیره کرده) */
function bismillahInUse(exceptSurah) {
  for (let n = 1; n <= 114; n++) {
    if (n === 9 || n === exceptSurah) continue;
    if (offlineAnyCount(n) > 0) return true;
  }
  return false;
}

async function deleteSurahOffline(n) {
  try {
    const c = await caches.open(OFF_CACHE);
    const tracks = offlineAllTracksOf(n);
    const shared = bismillahInUse(n);                           // فایل مشترک بسم‌الله تا وقتی سورهٔ دیگری لازمش دارد می‌ماند
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (isSharedBis(t) && shared) continue;
      const url = offUrl(t);
      await c.delete(url);
      off.urls.delete(url);
    }
  } catch (e) { /* ignore */ }
  refreshStorageUsage();
  refreshOfflineUI();
}

/* فقط صوت‌ها پاک می‌شوند؛ متن و ترجمهٔ سوره‌ها همیشه روی دستگاه می‌ماند */
async function deleteAllOffline() {
  try { await caches.delete(OFF_CACHE); } catch (e) { /* ignore */ }
  off.urls.clear();
  refreshStorageUsage();
  refreshOfflineUI();
}

/* =========================================================
   TEXT SYNC — متن و ترجمهٔ همهٔ سوره‌ها خودکار روی دستگاه ذخیره می‌شود

   اول همان سوره‌ای که کاربر باز کرده نمایش داده می‌شود؛ بعد از آن (بدون مزاحمت برای خواندن)
   بقیهٔ سوره‌ها، از نزدیک‌ترین به دورترین، با دو دریافت هم‌زمان در IndexedDB ذخیره می‌شوند.
   با قطع اینترنت یا خطا متوقف می‌شود و با اتصال دوباره ادامه می‌دهد.
========================================================= */
const TXT_CONCURRENCY = 2;
const TXT_START_DELAY = 1800;
const TXT_MAX_RETRIES = 6;

const txt = { running: false, queue: [], token: 0, consec: 0, tries: {}, error: '', timer: null, retries: 0, bound: false };

function textCount() { return off.textSaved.size; }
function textComplete() { return off.textSaved.size >= 114; }

/* سوره‌های ذخیره‌نشده، نزدیک‌ترین به سورهٔ جاری اول */
function textSyncQueue() {
  const cur = S.surah || 1;
  const miss = [];
  for (let n = 1; n <= 114; n++) if (!off.textSaved.has(n)) miss.push(n);
  miss.sort(function (a, b) { return (Math.abs(a - cur) - Math.abs(b - cur)) || (b - a); });
  return miss;
}

async function saveOneSurahText(n) {
  const e = await dataGet(n);
  if (e) {
    if (!e.saved) {
      const ok = await idbPut('surahs', { n: e.n, v: e.v, at: e.at, saved: true, payload: e.payload });
      if (!ok) throw apiError('storage', 'ذخیره روی دستگاه ممکن نشد');
      store.remove(lsSurahKey(n));
    }
    off.textSaved.add(n);
    return;
  }
  const json = await apiGet('ayahs', { surah: n }, { timeout: 30000, retries: 1 });
  prepareSurahData(n, json);                                     // اعتبارسنجی؛ داده‌ٔ خراب ذخیره نمی‌شود
  const ok = await idbPut('surahs', { n: n, v: CACHE_VERSION, at: Date.now(), saved: true, payload: slimPayload(json) });
  if (!ok) throw apiError('storage', 'ذخیره روی دستگاه ممکن نشد');
  store.remove(lsSurahKey(n));
  off.textSaved.add(n);
}

async function textWorker(token) {
  while (token === txt.token && txt.running) {
    while (S.loadingNum && token === txt.token) await sleep(400);    // کاربر منتظر یک سوره است؛ جلویش را نگیر
    const n = txt.queue.shift();
    if (!n) return;
    if (off.textSaved.has(n)) continue;
    try {
      await saveOneSurahText(n);
      txt.consec = 0;
    } catch (err) {
      txt.tries[n] = (txt.tries[n] || 0) + 1;
      txt.consec++;
      if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
        txt.error = 'اینترنت قطع شد؛ بعد از اتصال خودکار ادامه پیدا می‌کند.';
        txt.queue.length = 0;
        return;
      }
      if (err && err.kind === 'storage' && txt.tries[n] >= 2) {
        txt.error = 'ذخیره روی این دستگاه ممکن نشد (شاید حافظه پر است یا مرورگر ذخیره را محدود کرده).';
        txt.queue.length = 0;
        return;
      }
      if (txt.tries[n] < 3) txt.queue.push(n);
      if (txt.consec >= 6) {
        txt.error = 'اتصال ناپایدار است؛ کمی بعد دوباره تلاش می‌شود.';
        txt.queue.length = 0;
        return;
      }
      await sleep(500 * txt.consec);
    }
    queueOfflineUI();
    await sleep(60);
  }
}

function startTextSync(manual) {
  if (txt.running || !API_READY || !off.textReady || textComplete()) { if (manual) refreshOfflineUI(); return; }
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    if (manual) showToast('اینترنت قطع است؛ بعد از اتصال دوباره امتحان کنید.');
    return;
  }
  if (!manual && !canPrefetch()) return;                           // صرفه‌جویی در داده: فقط با دکمه
  idbOpen().then(function (db) {
    if (!db) {
      txt.error = 'حافظهٔ مرورگر (IndexedDB) در دسترس نیست؛ متن‌ها فقط هنگام دیدن سوره ذخیره می‌شوند.';
      refreshOfflineUI();
      return;
    }
    runTextSync(textSyncQueue());
  });
}

function runTextSync(queue) {
  if (txt.running || !queue.length) return;
  const token = ++txt.token;
  txt.running = true;
  txt.queue = queue.slice();
  txt.consec = 0;
  txt.tries = {};
  txt.error = '';
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(noop, noop); } catch (e) { /* ignore */ }
  refreshOfflineUI();
  const workers = [];
  for (let i = 0; i < TXT_CONCURRENCY; i++) workers.push(textWorker(token));
  Promise.all(workers).then(function () {
    if (token !== txt.token) return;
    txt.running = false;
    if (textComplete()) onTextAllSaved(true);
    else {
      if (!txt.error) txt.error = 'بعضی سوره‌ها ذخیره نشد؛ کمی بعد دوباره تلاش می‌شود.';
      scheduleTextRetry();
    }
    refreshOfflineUI();
  });
}

/* باز شدن برنامه (و هر بار که سوره‌ای باز شد) در صورت ناقص‌بودن، شروع می‌شود؛ اگر سوره‌ای هنوز در حال بارگذاری است صبر می‌کند */
function autoStartTextSync(tries) {
  if (txt.running || textComplete()) return;
  if ((S.loadingNum || !S.data) && tries < 20) {
    setTimeout(function () { autoStartTextSync(tries + 1); }, 1500);
    return;
  }
  startTextSync(false);
}

function scheduleTextRetry() {
  clearTimeout(txt.timer);
  if (textComplete() || txt.retries >= TXT_MAX_RETRIES) return;
  txt.retries++;
  const wait = Math.min(10 * 60000, 20000 * Math.pow(2, txt.retries - 1));
  txt.timer = setTimeout(function () { autoStartTextSync(0); }, wait);
}

function bindTextSyncTriggers() {
  if (txt.bound) return;
  txt.bound = true;
  window.addEventListener('online', function () { txt.retries = 0; autoStartTextSync(0); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !txt.running && !textComplete()) autoStartTextSync(0);
  });
}

function onTextAllSaved(fresh) {
  clearTimeout(txt.timer);
  txt.error = '';
  txt.retries = 0;
  kvSet('textAll', { v: CACHE_VERSION, at: Date.now() }).then(noop, noop);
  buildPageIndex().then(noop, noop);
  if (fresh && !store.get(KEYS.textToast, false)) {
    store.set(KEYS.textToast, true);
    showToast('متن و ترجمهٔ همهٔ سوره‌ها روی این دستگاه ذخیره شد؛ بدون اینترنت هم کار می‌کند.', { ms: 5200 });
  }
  refreshOfflineUI();
}

/* ---------- فهرست «صفحه ← اولین آیه» برای رفتن به صفحه بدون اینترنت ---------- */
let pageIndex = null;

async function loadPageIndex() {
  if (pageIndex) return pageIndex;
  const rec = await kvGet('pageIndex');
  if (rec && rec.v === CACHE_VERSION && rec.map && Object.keys(rec.map).length >= 604) {
    pageIndex = rec.map;
    return pageIndex;
  }
  return null;
}

async function buildPageIndex() {
  if (pageIndex) return pageIndex;
  const all = await idbGetAll('surahs');
  if (!Array.isArray(all)) return null;
  const map = {};
  let surahs = 0;
  all.forEach(function (e) {
    if (!validEntry(e)) return;
    surahs++;
    e.payload.ayahs.forEach(function (a) {
      const p = Number(a.page);
      const sNum = Number(a.surah_id || e.n);
      const nNum = Number(a.ayah_number);
      if (!(p >= 1 && p <= 604) || !(sNum >= 1) || !(nNum >= 1)) return;
      const cur = map[p];
      if (!cur || sNum < cur[0] || (sNum === cur[0] && nNum < cur[1])) map[p] = [sNum, nNum];
    });
  });
  if (surahs < 114 || Object.keys(map).length < 604) return null;       // ناقص است؛ ذخیره نمی‌کنیم
  pageIndex = map;
  await kvSet('pageIndex', { v: CACHE_VERSION, at: Date.now(), map: map });
  return map;
}

/* همان خروجی عملِ «page» سرور: { surah_id, ayah_number }؛ اگر داده کامل روی دستگاه نباشد null */
async function localPageFirst(page) {
  try {
    const idx = (await loadPageIndex()) || (textComplete() ? await buildPageIndex() : null);
    const f = idx && idx[page];
    return f ? { surah_id: f[0], ayah_number: f[1], page: page } : null;
  } catch (e) {
    return null;
  }
}

/* =========================================================
   رابط کاربری
========================================================= */
let offUiQueued = false;

function queueOfflineUI() {
  if (offUiQueued) return;
  offUiQueued = true;
  setTimeout(function () { offUiQueued = false; refreshOfflineUI(); }, 180);
}

function jobPercent(J) {
  return J && J.total ? Math.min(100, Math.round(J.done / J.total * 100)) : 0;
}

function refreshOfflineUI() {
  updateSaveSurahButton();
  refreshSurahBadges();
  const J = off.job;
  if (dom.btnOffline) dom.btnOffline.classList.toggle('busy', !!((J && J.state === 'running') || txt.running));
  if (sheets.open === 'offline') renderOfflineSheet();
}

function updateSaveSurahButton() {
  const btn = dom.saveSurah;
  if (!btn) return;
  const n = S.surah;
  if (!offlineSupported() || !n) { btn.hidden = true; return; }
  btn.hidden = false;
  const J = off.job;
  let text;
  let pct = 0;
  let cls = '';
  if (J && J.state === 'running') {
    const mine = J.surahs.length === 1 && J.surahs[0] === n;
    pct = jobPercent(J);
    cls = 'is-busy';
    text = mine
      ? ('در حال ذخیره… ' + faNum(J.done) + ' از ' + faNum(J.total) + ' (برای توقف لمس کنید)')
      : ('در حال ذخیره‌سازی… ' + faNum(pct) + '٪ (لمس کنید)');
  } else if (offlineComplete(n)) {
    cls = 'is-saved';
    pct = 100;
    text = 'صوت این سوره برای آفلاین ذخیره شده است';
  } else {
    const c = offlineCount(n);
    const est = estimateBytes([n]);
    if (c.own > 0) text = 'ادامهٔ ذخیرهٔ صوت برای آفلاین (' + faNum(c.have) + ' از ' + faNum(c.total) + ')';
    else text = 'ذخیرهٔ صوت این سوره برای آفلاین' + (est ? ' (' + formatBytes(est) + ')' : '');
    pct = c.total ? Math.round(c.have / c.total * 100) : 0;
  }
  btn.className = 'btn btn-soft save-surah ' + cls;
  dom.saveSurahText.textContent = text;
  if (dom.saveSurahBar) dom.saveSurahBar.style.width = pct + '%';
  btn.setAttribute('aria-label', text);
}

function onSaveSurahClick() {
  const n = S.surah;
  if (!n) return;
  const J = off.job;
  if (J && J.state === 'running') {
    const mine = J.surahs.length === 1 && J.surahs[0] === n;
    if (mine) pauseJob(J, 'ذخیره متوقف شد. هر چه ذخیره شده می‌ماند.');
    else openSheet('offline', dom.saveSurah);
    return;
  }
  if (offlineComplete(n)) { openSheet('offline', dom.saveSurah); return; }
  startOfflineJob('audio', [n]);
}

function prepareOfflineSheet() {
  off.confirm = null;
  refreshStorageUsage();
  renderOfflineSheet();
}

function renderTextStatus() {
  const line = $('offTextLine');
  const fill = $('offTextFill');
  const note = $('offTextNote');
  const go = $('offTextGo');
  if (!line) return;
  const n = textCount();
  fill.style.width = Math.round(n / 114 * 100) + '%';
  go.hidden = true;
  if (!off.textReady) {
    line.textContent = 'در حال بررسی…';
    note.textContent = '';
    return;
  }
  if (textComplete()) {
    line.textContent = 'متن و ترجمهٔ همهٔ ۱۱۴ سوره روی این دستگاه ذخیره شده است.';
    note.textContent = 'بدون اینترنت هم می‌توانید همه‌جا بخوانید، رنگ بدهید و کپی کنید؛ فقط صوت اینترنت می‌خواهد.';
  } else if (txt.running) {
    line.textContent = 'در حال ذخیرهٔ متن و ترجمه: ' + faNum(n) + ' از ۱۱۴ سوره';
    note.textContent = 'در پس‌زمینه انجام می‌شود؛ همین حالا هم می‌توانید بخوانید.';
  } else {
    const offline = typeof navigator.onLine === 'boolean' && !navigator.onLine;
    line.textContent = 'متن و ترجمه: ' + faNum(n) + ' از ۱۱۴ سوره ذخیره شده';
    note.textContent = txt.error || (offline ? 'اینترنت قطع است؛ بعد از اتصال خودکار ادامه پیدا می‌کند.' : 'برای ذخیرهٔ بقیه «ادامهٔ ذخیره» را بزنید.');
    go.hidden = false;
  }
}

function renderOfflineSheet() {
  const sheet = $('sheetOffline');
  if (!sheet) return;
  renderTextStatus();
  const saved = offlineSavedSurahs();
  const full = saved.filter(function (x) { return x.have === x.total; }).length;
  let sum = off.ready ? ('سوره‌هایی که صوتشان کامل ذخیره شده: ' + faNum(full) + ' از ۱۱۴') : 'در حال خواندن…';
  if (off.usage && off.usage.quota) sum += '\nحجم مصرفی برنامه روی این دستگاه: ' + formatBytes(off.usage.usage) + ' (از ' + formatBytes(off.usage.quota) + ' فضای قابل استفاده)';
  $('offSummary').textContent = offlineSupported() ? sum : 'این مرورگر ذخیرهٔ آفلاین را پشتیبانی نمی‌کند.';

  const J = off.job;
  const jobBox = $('offJob');
  if (J && (J.state === 'running' || J.state === 'paused' || J.state === 'error')) {
    jobBox.hidden = false;
    let line = 'ذخیرهٔ صوت: ' + faNum(J.done) + ' از ' + faNum(J.total) + ' (' + faNum(jobPercent(J)) + '٪)';
    if (J.bytes) line += ' · ' + formatBytes(J.bytes);
    $('offJobText').textContent = line;
    $('offFill').style.width = jobPercent(J) + '%';
    $('offJobNote').textContent = J.state === 'running' ? 'صفحه را باز نگه دارید؛ هر چه ذخیره شود می‌ماند.' : (J.error || '');
    const b = $('offPause');
    b.textContent = J.state === 'running' ? 'توقف' : 'ادامه';
    b.setAttribute('data-act', J.state === 'running' ? 'pause' : 'resume');
  } else {
    jobBox.hidden = true;
  }

  const running = !!(J && J.state === 'running');
  const cur = S.surah;
  const curBtn = $('offSaveCur');
  curBtn.hidden = !cur;
  curBtn.textContent = cur ? ('ذخیرهٔ صوت ' + surahTitle(cur)) : '';
  curBtn.disabled = running || !offlineSupported() || (cur ? offlineComplete(cur) : true);
  $('offSaveAll').disabled = running || !offlineSupported();

  const conf = $('offConfirm');
  if (off.confirm) {
    conf.hidden = false;
    $('offConfirmText').textContent = off.confirm.text;
  } else {
    conf.hidden = true;
  }

  const list = $('offList');
  if (!saved.length) {
    list.innerHTML = '<div class="empty-note">هنوز صوتی برای آفلاین ذخیره نکرده‌اید.</div>';
  } else {
    list.innerHTML = saved.map(function (x) {
      const state = x.have === x.total ? 'صوت کامل' : (x.own > 0 ? ('صوت ' + faNum(x.have) + ' از ' + faNum(x.total)) : 'صوتِ حالت پخش دیگر');
      return '<div class="orow"><span class="oname"><strong>' + esc(surahTitle(x.n)) + '</strong><span>' + state + '</span></span>' +
        '<button type="button" class="del" data-act="del" data-n="' + x.n + '" aria-label="حذف صوت ' + esc(surahTitle(x.n)) + ' از ذخیره‌ها">' + icon('i-trash') + '</button></div>';
    }).join('');
  }
  $('offDeleteAll').hidden = !saved.length;
}

function askConfirm(kind, surahs, text) {
  off.confirm = { kind: kind, surahs: surahs, text: text };
  renderOfflineSheet();
}

function allSurahNumbers() {
  const out = [];
  for (let n = 1; n <= 114; n++) out.push(n);
  return out;
}

function bindOffline() {
  if (dom.saveSurah) dom.saveSurah.addEventListener('click', onSaveSurahClick);
  const sheet = $('sheetOffline');
  if (!sheet) return;
  sheet.addEventListener('click', function (e) {
    const b = e.target.closest('button');
    if (!b) return;
    const id = b.id;
    const act = b.getAttribute('data-act');
    if (id === 'offTextGo') {
      txt.retries = 0;
      txt.error = '';
      startTextSync(true);
    } else if (id === 'offSaveCur') {
      if (S.surah) startOfflineJob('audio', [S.surah]);
    } else if (id === 'offSaveAll') {
      const est = estimateBytes(allSurahNumbers());
      askConfirm('audio', allSurahNumbers(), 'صوت همهٔ قرآن ذخیره می‌شود' + (est ? ' (حدود ' + formatBytes(est) + ')' : ' و ممکن است صدها مگابایت اینترنت و فضا مصرف کند') +
        '. اگر اینترنت شما حجمی است بهتر است با وای‌فای انجام دهید. ادامه می‌دهید؟');
    } else if (id === 'offConfirmYes') {
      const c = off.confirm;
      off.confirm = null;
      if (c && c.kind === 'delete') deleteAllOffline().then(function () { showToast('همهٔ صوت‌های ذخیره‌شده حذف شد.'); });
      else if (c) startOfflineJob(c.kind, c.surahs);
    } else if (id === 'offConfirmNo') {
      off.confirm = null;
      renderOfflineSheet();
    } else if (id === 'offPause') {
      if (act === 'pause') pauseJob(off.job, 'ذخیره متوقف شد. هر چه ذخیره شده می‌ماند.');
      else resumeOfflineJob();
    } else if (act === 'del') {
      const n = Number(b.getAttribute('data-n'));
      deleteSurahOffline(n).then(function () { showToast('صوت ' + surahTitle(n) + ' از ذخیره‌ها حذف شد.'); });
    } else if (id === 'offDeleteAll') {
      askConfirm('delete', [], 'همهٔ صوت‌های ذخیره‌شده برای آفلاین پاک می‌شود؛ متن و ترجمهٔ سوره‌ها می‌ماند. ادامه می‌دهید؟');
    }
  });
}
