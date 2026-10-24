'use strict';
/* =========================================================
   OFFLINE — ذخیرهٔ صوت (Cache Storage) و متن (IndexedDB) برای استفادهٔ بدون اینترنت

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
  ready: false,
  job: null,
  wake: null,
  confirm: null,            // { kind, surahs, text } تأییدِ در انتظار
  usage: null               // { usage, quota }
};

function offlineSupported() {
  return typeof caches !== 'undefined' && !!window.isSecureContext;
}

function offUrl(t) { return audioUrl(AUDIO_BASES.ar, t.surah, t.ayah); }

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

function offlineTracksOf(n) { return tracksForSurah(n, ayahCount(n)); }

function offlineCount(n) {
  const tr = offlineTracksOf(n);
  let have = 0;
  tr.forEach(function (t) { if (off.urls.has(offUrl(t))) have++; });
  return { have: have, total: tr.length };
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
    if (c.have > 0 || off.textSaved.has(n)) out.push({ n: n, have: c.have, total: c.total, text: off.textSaved.has(n) });
  }
  return out;
}

async function offlineInit() {
  if (!offlineSupported()) { off.ready = true; refreshOfflineUI(); return; }
  try {
    const c = await caches.open(OFF_CACHE);
    const reqs = await c.keys();
    reqs.forEach(function (r) { off.urls.add(r.url); });
  } catch (e) { /* ذخیره‌ای نیست */ }
  try {
    const all = await idbGetAll('surahs');
    if (Array.isArray(all)) all.forEach(function (e) { if (e && e.saved) off.textSaved.add(Number(e.n)); });
  } catch (e) { /* ignore */ }
  off.ready = true;
  refreshOfflineUI();
  refreshStorageUsage();
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
function bismillahInUse(exceptSurah) {
  for (let n = 2; n <= 114; n++) {
    if (n === 9 || n === exceptSurah) continue;
    const c = offlineCount(n);
    if (c.have > 1) return true;
  }
  return false;
}

async function deleteSurahOffline(n) {
  try {
    const c = await caches.open(OFF_CACHE);
    const tracks = offlineTracksOf(n);
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const isBis = t.surah === 1 && t.ayah === 1 && n !== 1;
      if (isBis) continue;                                      // فایل بسم‌الله مشترک است
      if (t.surah === 1 && t.ayah === 1 && n === 1 && bismillahInUse(1)) continue;
      const url = offUrl(t);
      await c.delete(url);
      off.urls.delete(url);
    }
  } catch (e) { /* ignore */ }
  const e = await dataGet(n);
  if (e && e.saved) await dataPut(n, e.payload, false);
  off.textSaved.delete(n);
  refreshOfflineUI();
}

async function deleteAllOffline() {
  try { await caches.delete(OFF_CACHE); } catch (e) { /* ignore */ }
  off.urls.clear();
  const all = await idbGetAll('surahs');
  if (Array.isArray(all)) {
    for (let i = 0; i < all.length; i++) if (all[i].saved) await dataPut(all[i].n, all[i].payload, false);
  }
  off.textSaved.clear();
  refreshStorageUsage();
  refreshOfflineUI();
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
  if (dom.btnOffline) dom.btnOffline.classList.toggle('busy', !!(J && J.state === 'running'));
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
    text = 'این سوره برای آفلاین ذخیره شده است';
  } else {
    const c = offlineCount(n);
    const est = estimateBytes([n]);
    if (c.have > 0) text = 'ادامهٔ ذخیره برای آفلاین (' + faNum(c.have) + ' از ' + faNum(c.total) + ')';
    else text = 'ذخیرهٔ صوت و متن این سوره برای آفلاین' + (est ? ' (' + formatBytes(est) + ')' : '');
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

function renderOfflineSheet() {
  const sheet = $('sheetOffline');
  if (!sheet) return;
  const saved = offlineSavedSurahs();
  const full = saved.filter(function (x) { return x.have === x.total; }).length;
  let sum = off.ready ? ('سوره‌های کامل‌شده: ' + faNum(full) + ' از ۱۱۴') : 'در حال خواندن…';
  if (off.usage && off.usage.quota) sum += ' · حجم مصرفی برنامه: ' + formatBytes(off.usage.usage) + ' از ' + formatBytes(off.usage.quota) + ' فضای قابل استفاده';
  $('offSummary').textContent = offlineSupported() ? sum : 'این مرورگر ذخیرهٔ آفلاین را پشتیبانی نمی‌کند.';

  const J = off.job;
  const jobBox = $('offJob');
  if (J && (J.state === 'running' || J.state === 'paused' || J.state === 'error')) {
    jobBox.hidden = false;
    const label = J.kind === 'audio' ? 'ذخیرهٔ صوت و متن' : 'ذخیرهٔ متن';
    let line = label + ': ' + faNum(J.done) + ' از ' + faNum(J.total) + ' (' + faNum(jobPercent(J)) + '٪)';
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
  curBtn.textContent = cur ? ('ذخیرهٔ صوت و متن ' + surahTitle(cur)) : '';
  curBtn.disabled = running || !offlineSupported() || (cur ? offlineComplete(cur) : true);
  $('offSaveText').disabled = running || !offlineSupported();
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
    list.innerHTML = '<div class="empty-note">هنوز چیزی برای آفلاین ذخیره نکرده‌اید.</div>';
  } else {
    list.innerHTML = saved.map(function (x) {
      const state = x.have === x.total ? 'صوت کامل' : (x.have > 0 ? ('صوت ' + faNum(x.have) + ' از ' + faNum(x.total)) : 'فقط متن');
      return '<div class="orow"><span class="oname"><strong>' + esc(surahTitle(x.n)) + '</strong><span>' + state + (x.text ? ' · متن ذخیره‌شده' : '') + '</span></span>' +
        '<button type="button" class="del" data-act="del" data-n="' + x.n + '" aria-label="حذف ' + esc(surahTitle(x.n)) + ' از ذخیره‌ها">' + icon('i-trash') + '</button></div>';
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
    if (id === 'offSaveCur') {
      if (S.surah) startOfflineJob('audio', [S.surah]);
    } else if (id === 'offSaveText') {
      const miss = allSurahNumbers().filter(function (n) { return !off.textSaved.has(n); });
      if (!miss.length) { showToast('متن همهٔ سوره‌ها قبلاً ذخیره شده است.'); return; }
      askConfirm('text', allSurahNumbers(), 'متن و ترجمهٔ همهٔ سوره‌ها (حدود چند مگابایت) روی دستگاه ذخیره می‌شود تا همه جا سریع باز شود و بدون اینترنت هم خوانده شود. ادامه می‌دهید؟');
    } else if (id === 'offSaveAll') {
      const est = estimateBytes(allSurahNumbers());
      askConfirm('audio', allSurahNumbers(), 'صوت و متن همهٔ قرآن ذخیره می‌شود' + (est ? ' (حدود ' + formatBytes(est) + ')' : ' و ممکن است صدها مگابایت اینترنت و فضا مصرف کند') +
        '. اگر اینترنت شما حجمی است بهتر است با وای‌فای انجام دهید. ادامه می‌دهید؟');
    } else if (id === 'offConfirmYes') {
      const c = off.confirm;
      off.confirm = null;
      if (c && c.kind === 'delete') deleteAllOffline().then(function () { showToast('همهٔ ذخیره‌های آفلاین حذف شد.'); });
      else if (c) startOfflineJob(c.kind, c.surahs);
    } else if (id === 'offConfirmNo') {
      off.confirm = null;
      renderOfflineSheet();
    } else if (id === 'offPause') {
      if (act === 'pause') pauseJob(off.job, 'ذخیره متوقف شد. هر چه ذخیره شده می‌ماند.');
      else resumeOfflineJob();
    } else if (act === 'del') {
      const n = Number(b.getAttribute('data-n'));
      deleteSurahOffline(n).then(function () { showToast(surahTitle(n) + ' از ذخیره‌ها حذف شد.'); });
    } else if (id === 'offDeleteAll') {
      askConfirm('delete', [], 'همهٔ صوت‌ها و متن‌های ذخیره‌شده برای آفلاین پاک می‌شود. ادامه می‌دهید؟');
    }
  });
}
