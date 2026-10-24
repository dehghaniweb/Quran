'use strict';
/* =========================================================
   PLAYER

   اصل طراحی: پخش‌کننده همیشه به همان سوره‌ای وصل است که روی صفحه است.
   S.surah / S.items / S.pos فقط یک‌جا و با هم عوض می‌شوند (commitSurah) و هر آهنگ،
   سوره و آیه‌اش را در خودش دارد؛ بنابراین نشانگر هرگز روی سوره دیگری نمی‌رود.

   پخش بدون وقفه: دو عنصر <audio> (A و B) داریم. تا آیه فعلی پخش می‌شود، آیه بعد (و چند آیهٔ بعدتر)
   در پس‌زمینه دریافت می‌شود و در عنصرِ بیکار آماده می‌ماند؛ به‌محض تمام‌شدن آیه، عنصر آماده «پخش» می‌شود.
========================================================= */
const WATCHDOG_MS = 12000;
const BLOB_KEEP = 6;
const PREFETCH_AHEAD = 3;
const FETCH_TIMEOUT = 20000;

const P = {
  wantPlay: false,       // نیت کاربر: پخش یا توقف
  playing: false,        // صدا واقعاً در حال پخش است
  buffering: false,
  trackId: 0,            // هر بارگذاری آهنگ یک شماره تازه می‌گیرد
  switching: false,      // بین عوض‌شدن src و رویداد loadstart
  loaded: null,          // { id, surah, pos, track, key, route, triedRelay, triedDirect, relayKey, cacheFailed }
  watchdog: null,
  error: '',
  lastSave: 0,
  resume: null,          // { surah, pos, time } فقط برای دکمه پخش بعد از «ادامه»
  pendingSeek: 0,
  preloadedFor: 0,
  seeking: false,
  metaKey: '',
  userPaused: false,     // فقط با دکمه توقف خودِ کاربر true می‌شود
  markHold: false,       // بعد از علامت‌زدن دستی، تا پخش دستیِ بعدی ذخیره خودکار متوقف است
  decks: [],             // دو عنصر صوتی
  cur: null,             // عنصری که آهنگ فعلی روی آن است
  singleDeck: false,     // اگر مرورگر پخش خودکار عنصر دوم را نپذیرفت، فقط با یک عنصر کار می‌کنیم
  blobs: new Map(),      // «سوره:آیه» ← فایل صوتیِ از پیش دریافت‌شده
  fetching: new Map()
};

/* ---------- دو عنصر صوتی ---------- */
function makeDeck(el, name) {
  return { el: el, name: name, key: '', state: 'idle', objUrl: '', token: 0, route: '' };
}

function curEl() { return P.cur.el; }

function otherDeck() { return P.decks[0] === P.cur ? P.decks[1] : P.decks[0]; }

function deckClearSrc(d) {
  try { d.el.pause(); } catch (e) { /* ignore */ }
  try { d.el.removeAttribute('src'); d.el.load(); } catch (e) { /* ignore */ }
  if (d.objUrl) {
    try { URL.revokeObjectURL(d.objUrl); } catch (e) { /* ignore */ }
    d.objUrl = '';
  }
}

/* عنصر را کاملاً خالی می‌کند و هر دریافتِ در راه برایش بی‌اثر می‌شود */
function deckReset(d) {
  d.token++;
  deckClearSrc(d);
  d.key = '';
  d.state = 'idle';
  d.route = '';
}

function deckSetSrc(d, url, isObj) {
  const old = d.objUrl;
  d.objUrl = isObj ? url : '';
  d.el.src = url;
  if (old && old !== url) {
    try { URL.revokeObjectURL(old); } catch (e) { /* ignore */ }
  }
}

function initDecks() {
  P.decks = [makeDeck(dom.audio, 'A'), makeDeck(dom.audio2, 'B')];
  P.cur = P.decks[0];
}
initDecks();

/* ---------- آهنگِ هر آیتم ---------- */
function trackFor(pos, fa) {
  const it = S.items[pos];
  if (!it) return null;
  const t = it.kind === 'bismillah'
    ? { surah: 1, ayah: 1, bismillah: true }
    : { surah: S.surah, ayah: it.ayah.ayah_number, bismillah: false };
  if (fa) t.fa = true;
  return t;
}

/* آیه‌هایی که صدای ترجمهٔ فارسیِ منبع خراب است (با شنیدن و بررسی طول فایل پیدا شده‌اند)؛ برایشان صدای ترجمه پخش نمی‌شود */
const FA_SKIP = ['17:22', '26:48', '28:34', '50:25', '57:10', '75:5', '75:20', '75:33'];

function faAudioFor(track) {
  return !!(settings.faAudio && S.data && S.data.hasFa && track && FA_SKIP.indexOf(track.surah + ':' + track.ayah) < 0);
}

/* آهنگِ بعد از این آهنگ در همین سوره: (عربی ← ترجمه) ← آیهٔ بعد؛ null = پایان سوره */
function afterTrack(pos, fa) {
  if (!fa && faAudioFor(trackFor(pos))) return { pos: pos, fa: true };
  if (pos + 1 < S.items.length) return { pos: pos + 1, fa: false };
  return null;
}

function itemLabel(pos) {
  const it = S.items[pos];
  if (!it) return '';
  return it.kind === 'bismillah' ? 'بسم‌الله الرحمن الرحیم' : ('آیه ' + faNum(it.ayah.ayah_number));
}

function currentRef() {
  const it = S.items[S.pos];
  if (!it || !S.data) return null;
  if (it.kind === 'bismillah') return { surah: S.surah, ayah: 1, bis: true };
  return { surah: S.surah, ayah: it.ayah.ayah_number, bis: false };
}

/* =========================================================
   UI
========================================================= */
function setBuffering(on) {
  P.buffering = !!on;
  updatePlayUI();
}

function updatePlayUI() {
  document.body.classList.toggle('is-playing', P.playing);
  dom.player.classList.toggle('buffering', P.wantPlay && P.buffering);
  const glyph = dom.btnPlay.querySelector('svg.glyph');
  if (glyph) setIcon(glyph, P.wantPlay ? 'i-pause' : 'i-play');
  const label = P.wantPlay ? 'توقف' : 'پخش';
  dom.btnPlay.setAttribute('aria-label', label);
  dom.btnPlay.title = label;
  const hasData = !!(S.data && S.items.length);
  dom.btnPlay.disabled = !hasData;
  dom.btnPrev.disabled = !hasData;
  dom.btnNext.disabled = !hasData;
  dom.btnStart.disabled = !hasData;
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = P.wantPlay ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
  }
  updatePlayerInfo();
}

function updatePlayerInfo() {
  let text;
  if (P.error) {
    text = P.error;
  } else if (S.loadingNum && P.wantPlay) {
    text = 'در حال بارگذاری ' + surahTitle(S.loadingNum) + '…';
  } else if (!S.data) {
    text = S.loadingNum ? ('در حال بارگذاری ' + surahTitle(S.loadingNum) + '…') : 'آماده پخش';
  } else if (S.pos < 0) {
    text = 'آماده پخش · ' + surahTitle(S.surah);
  } else {
    const where = surahTitle(S.surah) + '، ' + itemLabel(S.pos) + (P.loaded && P.loaded.fa && P.loaded.pos === S.pos ? ' · ترجمه' : '');
    if (P.wantPlay && P.buffering) text = 'در حال دریافت صدا · ' + where;
    else if (P.playing) text = 'در حال پخش · ' + where;
    else text = where;
  }
  dom.pStatus.textContent = text;
  updateMediaMetadata();
}

function updateSeekUI() {
  const a = curEl();
  const d = a.duration;
  const t = a.currentTime || 0;
  const ok = isFinite(d) && d > 0;
  const pct = ok ? clamp(t / d * 100, 0, 100) : 0;
  dom.seekFill.style.width = pct + '%';
  dom.seek.setAttribute('aria-valuenow', String(Math.round(pct)));
  dom.seek.setAttribute('aria-valuetext', formatTime(t) + ' از ' + formatTime(ok ? d : 0));
  dom.tCur.textContent = formatTime(t);
  dom.tDur.textContent = formatTime(ok ? d : 0);
}

function applyPlayerMin() {
  dom.player.classList.toggle('min', !!settings.minPlayer);
  const label = settings.minPlayer ? 'بزرگ‌کردن پخش‌کننده' : 'کوچک‌کردن پخش‌کننده';
  dom.btnMin.setAttribute('aria-label', label);
  dom.btnMin.title = label;
  updatePlayerHeightVar();
}

/* =========================================================
   MEDIA SESSION (دکمه‌های قفل صفحه و هدفون)
========================================================= */
function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined' || !S.data) return;
  const key = S.surah + ':' + S.pos;
  if (key === P.metaKey) return;
  P.metaKey = key;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S.pos >= 0 ? itemLabel(S.pos) : surahTitle(S.surah),
      artist: surahTitle(S.surah),
      album: 'قرآن کریم'
    });
  } catch (e) { /* ignore */ }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = function (name, fn) {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) { /* پشتیبانی نمی‌شود */ }
  };
  set('play', function () { if (!P.wantPlay) resumePlayback(); });
  set('pause', function () { pausePlayback(); });
  set('stop', function () { pausePlayback(); });
  set('previoustrack', function () { stepItem(-1); });
  set('nexttrack', function () { stepItem(1); });
  set('seekto', function (d) {
    const a = curEl();
    if (d && typeof d.seekTime === 'number' && isFinite(a.duration)) {
      a.currentTime = clamp(d.seekTime, 0, a.duration);
      updateSeekUI();
    }
  });
}

/* =========================================================
   ذخیره جای آخرین شنیدن / علامت‌گذاری
   (فقط هنگام پخش واقعی یا با دکمه «علامت‌گذاری» نوشته می‌شود؛ هیچ‌وقت هنگام باز شدن صفحه)
========================================================= */
function getBookmark() {
  const b = store.get(KEYS.bookmark, null);
  if (!b || !(Number(b.surah) >= 1 && Number(b.surah) <= 114) || !(Number(b.ayah) >= 1)) return null;
  return b;
}

function saveBookmark(ref, time) {
  return store.set(KEYS.bookmark, {
    surah: ref.surah,
    ayah: ref.ayah,
    bis: !!ref.bis,
    time: Math.max(0, Math.floor(time || 0)),
    updatedAt: Date.now()
  });
}

function savePlayingPosition(force) {
  if (P.markHold) return;                        // کاربر جای خواندن را دستی علامت زده؛ پخش آن را پاک نمی‌کند
  if (!force && !P.wantPlay) return;
  const now = Date.now();
  if (!force && now - P.lastSave < 5000) return;
  const L = P.loaded;
  const ref = currentRef();
  if (!ref || !L || L.pos !== S.pos || L.surah !== S.surah) return;
  P.lastSave = now;
  saveBookmark(ref, ref.bis ? 0 : curEl().currentTime);
  updateResumeUI();
}

function updateResumeUI() {
  const b = getBookmark();
  if (!b) { dom.continueBtn.hidden = true; refreshBookmarkMark(); return; }
  const cur = currentRef();
  const same = !!cur && cur.surah === Number(b.surah) && cur.ayah === Number(b.ayah);
  dom.continueBtn.hidden = same;
  dom.continueText.textContent = 'ادامه از ' + surahTitle(Number(b.surah)) + '، آیه ' + faNum(b.ayah);
  refreshBookmarkMark();
}

function refForPos(pos) {
  const it = S.items[pos];
  if (!it) return null;
  if (it.kind === 'bismillah') return { surah: S.surah, ayah: 1, bis: true };
  return { surah: S.surah, ayah: it.ayah.ayah_number, bis: false };
}

/* ذخیره جای خواندن از آیه‌ای که دکمه نشانک‌اش را زده‌اید */
function markPos(pos) {
  const ref = refForPos(pos);
  if (!ref) return;
  const time = (P.loaded && P.loaded.pos === pos && !ref.bis) ? curEl().currentTime : 0;
  if (!saveBookmark(ref, time)) {
    showToast('حافظه مرورگر در دسترس نیست؛ جای خواندن ذخیره نشد.');
    return;
  }
  P.markHold = true;
  updateResumeUI();
  showToast('جای خواندن ذخیره شد: ' + surahTitle(ref.surah) + '، آیه ' + faNum(ref.ayah));
}

/* آیه‌ای که نشانک روی آن است، در فهرست علامت می‌خورد */
function refreshBookmarkMark() {
  const b = getBookmark();
  S.els.forEach(function (el) {
    if (!el.classList.contains('ayah')) return;
    const on = !!b && !b.bis && Number(b.surah) === S.surah && Number(el.getAttribute('data-n')) === Number(b.ayah);
    el.classList.toggle('bookmarked', on);
    const btn = el.querySelector('.mark');
    if (btn) btn.classList.toggle('on', on);
  });
}

/* =========================================================
   صوت: ذخیره روی دستگاه، مسیر مستقیم و مسیر گوگل
========================================================= */
function chooseRoute() {
  if (settings.route === 'relay') return 'relay';
  if (settings.route === 'direct') return 'direct';
  const t = Number(store.get(KEYS.relay, 0));
  if (t && Date.now() - t < RELAY_PREF_TTL) return 'relay';
  return 'direct';
}

/* در حالت خودکار: اگر مسیر اول جواب نداد و دومی جواب داد، یادت بماند */
function noteRoute(route, wasFallback) {
  if (!wasFallback) return;
  if (route === 'relay') store.set(KEYS.relay, Date.now());
  else store.remove(KEYS.relay);
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/mpeg' });
}

/* دریافت از مسیر گوگل (بدون حافظهٔ مشترک؛ برای ذخیره آفلاین هم همین استفاده می‌شود) */
async function relayFetchRaw(surah, ayah, signal) {
  const json = await apiGet('audio', { surah: surah, ayah: ayah }, { timeout: 45000, retries: 1, signal: signal });
  if (!json.data) throw apiError('server', 'فایل صوتی خالی بود');
  return base64ToBlob(json.data, json.mime);
}

const relayBlobs = new Map();
const relayPending = new Map();

/* برای پخش: چند فایل اخیر در حافظه می‌ماند و درخواست تکراری ساخته نمی‌شود */
function relayBlob(surah, ayah) {
  const key = surah + ':' + ayah;
  if (relayBlobs.has(key)) return Promise.resolve(relayBlobs.get(key));
  if (relayPending.has(key)) return relayPending.get(key);
  const p = relayFetchRaw(surah, ayah).then(function (blob) {
    relayBlobs.set(key, blob);
    while (relayBlobs.size > BLOB_KEEP) relayBlobs.delete(relayBlobs.keys().next().value);
    return blob;
  });
  relayPending.set(key, p);
  const clear = function () { relayPending.delete(key); };
  p.then(clear, clear);
  return p;
}

/* دریافت مستقیم یک فایل صوتی به‌صورت Blob */
async function directBlob(url, signal) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const forward = function () { if (ctl) ctl.abort(); };
  if (signal) {
    if (signal.aborted) throw apiError('aborted', 'aborted');
    signal.addEventListener('abort', forward);
  }
  const timer = setTimeout(forward, FETCH_TIMEOUT);
  try {
    const res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
    if (!res.ok) throw apiError('http', 'HTTP ' + res.status, res.status);
    const blob = await res.blob();
    if (!blob || blob.size < 200) throw apiError('server', 'فایل صوتی خالی بود');
    return (blob.type && blob.type.indexOf('audio') === 0) ? blob : new Blob([blob], { type: 'audio/mpeg' });
  } catch (err) {
    if (signal && signal.aborted) throw apiError('aborted', 'aborted');
    if (err && err.kind) throw err;
    if (err && err.name === 'AbortError') throw apiError('timeout', 'timeout');
    throw apiError('network', String(err && err.message || err));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forward);
  }
}

/* یک آهنگ را به‌صورت Blob می‌دهد: دستگاه ← مسیر انتخابی ← مسیر دیگر (در حالت خودکار) */
async function fetchTrackBlob(t, signal) {
  const url = audioUrl(t.fa ? AUDIO_BASES.fa : AUDIO_BASES.ar, t.surah, t.ayah);
  if (typeof offlineHas === 'function' && offlineHas(url)) {
    const saved = await offlineBlob(url);
    if (saved) return saved;
  }
  const first = chooseRoute();
  const order = t.fa ? ['direct'] : (settings.route === 'auto' ? (first === 'relay' ? ['relay', 'direct'] : ['direct', 'relay']) : [first]);
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    try {
      const blob = order[i] === 'direct'
        ? await directBlob(url, signal)
        : (signal ? await relayFetchRaw(t.surah, t.ayah, signal) : await relayBlob(t.surah, t.ayah));
      if (settings.route === 'auto') noteRoute(order[i], i > 0);
      return blob;
    } catch (err) {
      lastErr = err;
      if (err && err.kind === 'aborted') throw err;
      if (typeof navigator.onLine === 'boolean' && !navigator.onLine) break;
    }
  }
  throw lastErr || apiError('network', 'failed');
}

function setAudioSrc(url, isObj) {
  P.switching = true;
  deckSetSrc(P.cur, url, isObj);
  updateSeekUI();
}

function safePlay(el, viaSwap) {
  let p;
  try { p = el.play(); } catch (e) { return; }
  if (p && typeof p.catch === 'function') {
    p.catch(function (err) {
      if (!err) return;
      if (err.name === 'AbortError') return;          // یک بارگذاری تازه جایش را گرفته
      if (err.name === 'NotAllowedError') {
        if (viaSwap && !P.singleDeck) { fallbackToSingleDeck(); return; }
        // مرورگر پخش خودکار را نپذیرفت (معمولاً iOS بعد از دریافت از مسیر گوگل)
        P.wantPlay = false;
        P.playing = false;
        setBuffering(false);
        showToast('برای شروع پخش یک بار دکمه پخش را بزنید.');
      }
      // خطاهای دیگر را رویداد error مدیریت می‌کند
    });
  }
}

/* مرورگر پخش خودکار عنصر دوم را نپذیرفت: از این به بعد فقط با همان عنصر اول کار می‌کنیم */
function fallbackToSingleDeck() {
  P.singleDeck = true;
  const failed = P.cur;
  P.cur = otherDeck();
  deckReset(failed);
  deckReset(P.cur);
  const L = P.loaded;
  if (L && L.surah === S.surah && S.pos === L.pos && P.wantPlay) startTrack(L.pos);
}

function armWatchdog(id) {
  clearTimeout(P.watchdog);
  P.watchdog = setTimeout(function () {
    if (!P.loaded || P.loaded.id !== id || !P.wantPlay || P.playing) return;
    audioFailed(id, new Error('timeout'));
  }, WATCHDOG_MS);
}

function rearmWatchdog() {
  if (P.loaded && P.wantPlay && !P.playing) armWatchdog(P.loaded.id);
}

function loadSource(id, route) {
  const L = P.loaded;
  if (!L || L.id !== id) return;
  const t = L.track;
  const direct = audioUrl(t.fa ? AUDIO_BASES.fa : AUDIO_BASES.ar, t.surah, t.ayah);
  if (t.fa) route = 'direct';                  // صدای ترجمه از مسیر گوگل پشتیبانی نمی‌شود

  // ۰) ذخیره‌شده روی دستگاه (بدون اینترنت هم پخش می‌شود)
  if (!L.cacheFailed && typeof offlineHas === 'function' && offlineHas(direct)) {
    L.route = 'cache';
    offlineBlob(direct).then(function (blob) {
      if (!P.loaded || P.loaded.id !== id || P.userPaused) return;
      if (!blob) { L.cacheFailed = true; loadSource(id, chooseRoute()); return; }
      setAudioSrc(URL.createObjectURL(blob), true);
      armWatchdog(id);
      safePlay(curEl());
    });
    return;
  }

  L.route = route;
  if (route === 'direct') {
    L.triedDirect = true;
    setAudioSrc(direct, false);
    armWatchdog(id);
    safePlay(curEl());
    return;
  }

  L.triedRelay = true;
  L.relayKey = trackKey(t);
  const have = relayBlobs.get(L.relayKey);
  if (have) {                                  // همگام، تا مجوز «پخش با لمس کاربر» از دست نرود
    setAudioSrc(URL.createObjectURL(have), true);
    armWatchdog(id);
    safePlay(curEl());
    return;
  }
  dom.pStatus.textContent = 'در حال دریافت صدا از مسیر گوگل…';
  relayBlob(t.surah, t.ayah).then(function (blob) {
    if (!P.loaded || P.loaded.id !== id || P.userPaused) return;      // در این فاصله کاربر توقف زده
    setAudioSrc(URL.createObjectURL(blob), true);
    armWatchdog(id);
    safePlay(curEl());
  }, function (err) {
    if (!P.loaded || P.loaded.id !== id) return;
    audioFailed(id, err);
  });
}

function audioFailed(id, why) {
  const L = P.loaded;
  if (!L || L.id !== id) return;
  clearTimeout(P.watchdog);
  if (P.userPaused) return;                      // کاربر توقف زده؛ خطای این آهنگ اهمیتی ندارد

  if (L.route === 'cache' && !L.cacheFailed) {   // فایل ذخیره‌شده خراب بود؛ از اینترنت می‌گیریم
    L.cacheFailed = true;
    loadSource(id, chooseRoute());
    return;
  }

  if (L.track.fa) {                              // صدای ترجمه نیامد: بی‌صدا رد شو و ادامه بده (متن ترجمه سر جایش است)
    advanceFrom(L);
    return;
  }

  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    P.wantPlay = false; P.playing = false; P.buffering = false;
    P.error = 'اینترنت قطع است';
    updatePlayUI();
    showToast('اینترنت قطع است و این آیه روی دستگاه ذخیره نشده؛ بعد از اتصال دوباره پخش کنید.', { action: 'تلاش دوباره', fn: retryTrack });
    return;
  }

  if (settings.route === 'auto') {
    if (L.route === 'direct' && !L.triedRelay) { loadSource(id, 'relay'); return; }
    if (L.route === 'relay' && !L.triedDirect) {
      loadSource(id, 'direct');
      return;
    }
  }

  P.wantPlay = false; P.playing = false; P.buffering = false;
  P.error = 'صدا بارگذاری نشد';
  updatePlayUI();
  showToast('صدا بارگذاری نشد.', { action: 'تلاش دوباره', fn: retryTrack, ms: 8000 });
}

function retryTrack() {
  if (S.pos >= 0) startTrack(S.pos);
}

/* =========================================================
   شروع و توقف آهنگ
========================================================= */
/* شروع یک آهنگ تازه (آیتم pos از فهرست فعلی) */
function startTrack(pos, opts) {
  opts = opts || {};
  const track = trackFor(pos, !!opts.fa);
  if (!track) return;
  const key = trackKey(track);
  const id = ++P.trackId;
  P.loaded = { id: id, fa: !!opts.fa, surah: S.surah, pos: pos, track: track, key: key, route: null, triedRelay: false, triedDirect: false, relayKey: '', cacheFailed: false };
  P.error = '';
  P.wantPlay = true;
  P.userPaused = false;
  P.playing = false;
  P.pendingSeek = 0;
  if (opts.resume && P.resume && P.resume.surah === S.surah && P.resume.pos === pos) P.pendingSeek = Number(P.resume.time) || 0;
  P.resume = null;
  clearTimeout(P.watchdog);

  // عنصر بیکار همین آهنگ را از قبل آماده دارد: بدون هیچ وقفه‌ای پخش می‌شود
  const spare = otherDeck();
  if (!P.singleDeck && !P.pendingSeek && spare.key === key && spare.state === 'ready') {
    activateDeck(spare, id);
    return;
  }

  P.switching = true;
  deckReset(P.cur);        // صدای آهنگ قبلی همین‌جا قطع می‌شود
  setBuffering(true);
  loadSource(id, chooseRoute());
}

/* عنصر آماده را فعال و پخش می‌کند */
function activateDeck(d, id) {
  const prev = P.cur;
  const L = P.loaded;
  P.cur = d;
  L.route = d.route || 'direct';
  d.state = 'active';
  P.switching = false;
  try { d.el.currentTime = 0; } catch (e) { /* ignore */ }
  P.buffering = false;
  P.playing = true;                        // رویداد playing این را تأیید می‌کند
  armWatchdog(id);
  safePlay(d.el, true);                    // اول صدا
  const tok = prev.token;
  setTimeout(function () { if (prev !== P.cur && prev.token === tok) deckReset(prev); }, 0);
  updatePlayUI();
  updateSeekUI();
}

/* آهنگ فعلی را رها کن، بدون دست‌زدن به «نیت» پخش */
function detachTrack() {
  P.trackId++;
  P.loaded = null;
  P.playing = false;
  P.switching = false;
  P.pendingSeek = 0;
  clearTimeout(P.watchdog);
  deckReset(P.cur);
  updateSeekUI();
}

function stopAudio() {
  if (P.playing) savePlayingPosition(true);
  detachTrack();
  P.wantPlay = false;
  P.buffering = false;
  P.error = '';
  P.resume = null;
  updatePlayUI();
}

/* =========================================================
   کنترل‌ها
========================================================= */
/* بارگذاریِ سوره بعدی که خودِ پخش خودکار شروع کرده؛ اگر کاربر در همین سوره کاری کرد لغو می‌شود */
function cancelPendingAutoplay() {
  if (!S.loadingNum || !S.autoLoading) return;
  S.navToken++;
  S.loadingNum = 0;
  S.autoLoading = false;
  setListLoading(false);
}

function playItem(pos, auto) {
  if (!S.data || pos < 0 || pos >= S.items.length) return;
  if (!auto) P.markHold = false;                 // کاربر خودش آیه دیگری را پخش کرد: ذخیره خودکار دوباره آزاد است
  cancelPendingAutoplay();
  startTrack(pos);                               // اول صدا، بعد نمایش
  setActive(pos, { scroll: 'nearest' });
}

function pausePlayback() {
  P.wantPlay = false;
  P.userPaused = true;
  clearTimeout(P.watchdog);
  try { curEl().pause(); } catch (e) { /* ignore */ }
  P.playing = false;
  P.buffering = false;
  savePlayingPosition(true);
  updatePlayUI();
}

function resumePlayback() {
  if (!S.data || !S.items.length) return;
  if (S.pos < 0) { playItem(0); return; }
  const L = P.loaded;
  const el = curEl();
  if (L && L.pos === S.pos && L.surah === S.surah && el.getAttribute('src') && !el.error && !el.ended) {
    P.wantPlay = true;
    P.userPaused = false;
    P.error = '';
    P.buffering = el.readyState < 3;
    updatePlayUI();
    safePlay(el);
    armWatchdog(L.id);
    return;
  }
  startTrack(S.pos, { resume: true });
}

function togglePlay() {
  if (!S.data || !S.items.length) return;
  if (P.wantPlay) pausePlayback();
  else resumePlayback();
}

function spareReadyFor(track) {
  const o = otherDeck();
  return !P.singleDeck && o.key === trackKey(track) && o.state === 'ready';
}

/* رفتن به سورهٔ بعد/قبل با ادامهٔ پخش. اگر صدای شروع سورهٔ بعد و متن آن آماده باشد، بدون وقفه عوض می‌شود. */
function playAdjacentSurah(dir) {
  const next = S.surah + dir;
  if (next < 1 || next > 114) return;
  const nd = peekSurahData(next);
  if (dir > 0 && nd && spareReadyFor(firstTrackOf(next))) {
    S.navToken++;
    S.loadingNum = 0;
    S.autoLoading = false;
    setListLoading(false);
    commitSurah(next, nd, { autoplay: true, where: 'first' });
    return;
  }
  detachTrack();
  P.wantPlay = true;
  P.userPaused = false;
  setBuffering(true);
  goToSurah(next, { autoplay: true, where: dir > 0 ? 'first' : 'last' });
}

/* آیه بعد/قبل؛ در مرز سوره به سوره بعد/قبل می‌رود و پخش ادامه پیدا می‌کند */
function stepItem(dir) {
  if (!S.data) return;
  const target = S.pos < 0 ? 0 : S.pos + dir;
  if (target >= 0 && target < S.items.length) { playItem(target); return; }

  const next = S.surah + dir;
  if (next < 1 || next > 114) {
    showToast(dir > 0 ? 'به پایان قرآن رسیدید.' : 'این ابتدای قرآن است.');
    return;
  }
  playAdjacentSurah(dir);
}

function onItemTap(i) {
  if (i === S.pos && P.loaded && P.loaded.pos === i) { togglePlay(); return; }
  playItem(i);
}

/* =========================================================
   رویدادهای عنصر صوتی
========================================================= */
function onEnded() {
  const L = P.loaded;
  if (!P.wantPlay || !L || L.surah !== S.surah || L.pos !== S.pos) return;
  advanceFrom(L);
}

/* بعد از پایان (یا ردشدنِ) یک آهنگ: آهنگ بعدی همین سوره، یا سورهٔ بعد */
function advanceFrom(L) {
  P.playing = false;
  const nx = afterTrack(L.pos, !!L.fa);
  if (nx) {
    if (nx.fa) startTrack(nx.pos, { fa: true });
    else playItem(nx.pos, true);
    return;
  }
  if (S.loadingNum) {
    // کاربر همین حالا سوره دیگری را انتخاب کرده و در حال بارگذاری است؛ پخش خودکار جلوی او را نگیرد
    P.wantPlay = false;
    P.buffering = false;
    updatePlayUI();
    return;
  }
  if (S.surah < 114) {
    playAdjacentSurah(1);
    return;
  }
  P.wantPlay = false;
  P.buffering = false;
  P.error = '';
  updatePlayUI();
  showToast('پایان قرآن. صدقه الله العظیم');
}

function onPlaying() {
  const L = P.loaded;
  if (!L || curEl().paused) return;
  clearTimeout(P.watchdog);
  P.playing = true;
  P.wantPlay = true;
  P.buffering = false;
  P.error = '';
  if (settings.route === 'auto') {
    if (L.route === 'relay' && L.triedDirect) store.set(KEYS.relay, Date.now());      // مسیر مستقیم جواب نداد، گوگل جواب داد: یادت بماند
    if (L.route === 'direct' && L.triedRelay) store.remove(KEYS.relay);               // برعکس
  }
  updatePlayUI();
  if (P.preloadedFor !== L.id) { P.preloadedFor = L.id; preloadNext(); }
}

function onPause() {
  if (P.switching || curEl().ended || !P.loaded) return;
  // پخش از بیرون متوقف شد (قطع هدفون، تماس تلفنی…)؛ دکمه را با واقعیت یکی کن
  P.playing = false;
  P.wantPlay = false;
  P.buffering = false;
  savePlayingPosition(true);
  updatePlayUI();
}

function onWaiting() {
  if (!P.loaded || !P.wantPlay) return;
  P.playing = false;
  setBuffering(true);
  armWatchdog(P.loaded.id);
}

function onCanPlay() {
  if (!P.loaded) return;
  if (P.buffering) setBuffering(false);
}

function onMetadata() {
  updateSeekUI();
  const d = curEl().duration;
  if (P.pendingSeek > 0 && isFinite(d) && d > P.pendingSeek + 1) {
    try { curEl().currentTime = P.pendingSeek; } catch (e) { /* ignore */ }
  }
  P.pendingSeek = 0;
}

let lastPositionState = 0;
function onTimeUpdate() {
  if (!P.seeking) updateSeekUI();
  savePlayingPosition(false);
  const now = Date.now();
  if (now - lastPositionState > 1000 && 'mediaSession' in navigator && navigator.mediaSession.setPositionState) {
    lastPositionState = now;
    const a = curEl();
    const d = a.duration;
    if (isFinite(d) && d > 0) {
      try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: 1, position: clamp(a.currentTime, 0, d) }); } catch (e) { /* ignore */ }
    }
  }
}

function onAudioError() {
  const L = P.loaded;
  if (!L || !curEl().getAttribute('src')) return;
  audioFailed(L.id, curEl().error);
}

/* عنصر بیکار (آهنگ بعدی) آماده یا خراب شد */
function onSpareReady(d) {
  if (d.state === 'loading' && d.el.getAttribute('src')) d.state = 'ready';
}

function onSpareError(d) {
  if (d.state === 'loading' && d.el.getAttribute('src')) d.state = 'failed';
}

function bindDeckEvents(d) {
  const a = d.el;
  const mine = function (fn) { return function (e) { if (d === P.cur) fn(e); }; };
  a.addEventListener('loadstart', mine(function () { P.switching = false; }));
  a.addEventListener('loadedmetadata', mine(onMetadata));
  a.addEventListener('durationchange', mine(updateSeekUI));
  a.addEventListener('timeupdate', mine(onTimeUpdate));
  a.addEventListener('progress', mine(rearmWatchdog));
  a.addEventListener('loadeddata', mine(rearmWatchdog));
  a.addEventListener('canplay', function () { if (d === P.cur) onCanPlay(); else onSpareReady(d); });
  a.addEventListener('waiting', mine(onWaiting));
  a.addEventListener('playing', mine(onPlaying));
  a.addEventListener('pause', mine(onPause));
  a.addEventListener('ended', mine(onEnded));
  a.addEventListener('error', function () { if (d === P.cur) onAudioError(); else onSpareError(d); });
}

function bindAudioEvents() {
  P.decks.forEach(bindDeckEvents);
}

/* =========================================================
   پیش‌بارگذاری آهنگ‌های بعدی (برای پخش بدون وقفه)
========================================================= */
/* چند آهنگ بعدی؛ در پایان سوره، اولین آهنگ سورهٔ بعد (صدایش به متن سوره نیازی ندارد) */
function upcomingTracks(pos, n, fa) {
  const out = [];
  let cur = { pos: pos, fa: !!fa };
  let more = true;
  while (out.length < n) {
    const nx = afterTrack(cur.pos, cur.fa);
    if (!nx) { more = false; break; }
    out.push(trackFor(nx.pos, nx.fa));
    cur = nx;
  }
  if (!more && out.length < n && S.surah < 114) out.push(firstTrackOf(S.surah + 1));
  return out;
}

function trimBlobs() {
  while (P.blobs.size > BLOB_KEEP) P.blobs.delete(P.blobs.keys().next().value);
}

function prefetchBlob(t) {
  const key = trackKey(t);
  if (P.blobs.has(key)) return Promise.resolve(P.blobs.get(key));
  if (P.fetching.has(key)) return P.fetching.get(key);
  const p = fetchTrackBlob(t).then(function (blob) {
    P.blobs.set(key, blob);
    trimBlobs();
    return blob;
  });
  P.fetching.set(key, p);
  const clear = function () { P.fetching.delete(key); };
  p.then(clear, clear);
  return p;
}

/* عنصر بیکار را با این آهنگ آماده می‌کند */
function prepareDeck(d, track) {
  const key = trackKey(track);
  if (d === P.cur) return;
  if (d.key === key && (d.state === 'loading' || d.state === 'ready')) return;
  deckReset(d);
  d.key = key;
  d.state = 'loading';
  const tok = d.token;
  prefetchBlob(track).then(function (blob) {
    if (d.token !== tok) return;
    d.route = 'blob';
    d.el.preload = 'auto';
    deckSetSrc(d, URL.createObjectURL(blob), true);
    try { d.el.load(); } catch (e) { /* ignore */ }
  }, function () {
    if (d.token !== tok) return;
    // Blob دریافت نشد (مثلاً مرورگر اجازهٔ خواندن مستقیم نداد): بگذار خودِ عنصر امتحان کند
    if (settings.route === 'relay') { d.state = 'failed'; return; }
    d.route = 'direct';
    d.el.preload = 'auto';
    deckSetSrc(d, audioUrl(track.fa ? AUDIO_BASES.fa : AUDIO_BASES.ar, track.surah, track.ayah), false);
    try { d.el.load(); } catch (e) { /* ignore */ }
  });
}

function preloadNext() {
  const L = P.loaded;
  if (!L || !S.data || L.surah !== S.surah) return;
  if (S.pos >= S.items.length - 3 && S.surah < 114) prefetchSurahData(S.surah + 1);

  const ahead = upcomingTracks(L.pos, PREFETCH_AHEAD, L.fa);
  if (!ahead.length) return;
  if (P.singleDeck) { prefetchBlob(ahead[0]).then(noop, noop); return; }
  prepareDeck(otherDeck(), ahead[0]);
  for (let i = 1; i < ahead.length; i++) prefetchBlob(ahead[i]).then(noop, noop);
}

/* =========================================================
   نوار پیشرفت
========================================================= */
function seekFromEvent(e) {
  const rect = dom.seek.getBoundingClientRect();
  if (!rect.width) return;
  const frac = clamp((rect.right - e.clientX) / rect.width, 0, 1);     // راست‌به‌چپ: لبه راست = ابتدا
  const a = curEl();
  const d = a.duration;
  if (isFinite(d) && d > 0) {
    try { a.currentTime = frac * d; } catch (err) { /* ignore */ }
    updateSeekUI();
  }
}

function bindSeek() {
  dom.seek.addEventListener('pointerdown', function (e) {
    P.seeking = true;
    try { dom.seek.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    seekFromEvent(e);
  });
  dom.seek.addEventListener('pointermove', function (e) { if (P.seeking) seekFromEvent(e); });
  const end = function () { P.seeking = false; };
  dom.seek.addEventListener('pointerup', end);
  dom.seek.addEventListener('pointercancel', end);
  dom.seek.addEventListener('keydown', function (e) {
    const a = curEl();
    const d = a.duration;
    if (!isFinite(d) || d <= 0) return;
    let t = a.currentTime;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') t += 5;         // راست‌به‌چپ: چپ = جلو
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') t -= 5;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = d - 0.1;
    else return;
    e.preventDefault();
    a.currentTime = clamp(t, 0, d);
    updateSeekUI();
  });
}
