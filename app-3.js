'use strict';
/* =========================================================
   PLAYER

   اصل طراحی: پخش‌کننده همیشه به همان سوره‌ای وصل است که روی صفحه است.
   S.surah / S.items / S.pos فقط یک‌جا و با هم عوض می‌شوند (commitSurah) و هر آهنگ،
   سوره و آیه‌اش را در خودش دارد؛ بنابراین نشانگر هرگز روی سوره دیگری نمی‌رود.
========================================================= */
const WATCHDOG_MS = 12000;
const RELAY_MAX = 4;

const P = {
  wantPlay: false,       // نیت کاربر: پخش یا توقف
  playing: false,        // صدا واقعاً در حال پخش است
  buffering: false,
  trackId: 0,            // هر بارگذاری آهنگ یک شماره تازه می‌گیرد
  switching: false,      // بین عوض‌شدن src و رویداد loadstart
  loaded: null,          // { id, surah, pos, track, route, triedRelay, triedDirect, relayKey }
  watchdog: null,
  error: '',
  lastSave: 0,
  resume: null,          // { surah, pos, time } فقط برای دکمه پخش بعد از «ادامه»
  pendingSeek: 0,
  preloadedFor: 0,
  preloadUrl: '',
  preloader: null,
  seeking: false,
  metaKey: '',
  userPaused: false,     // فقط با دکمه توقف خودِ کاربر true می‌شود
  markHold: false        // بعد از علامت‌زدن دستی، تا پخش دستیِ بعدی ذخیره خودکار متوقف است
};

const relayCache = new Map();
const relayPending = new Map();

/* ---------- آهنگِ هر آیتم ---------- */
function trackFor(pos) {
  const it = S.items[pos];
  if (!it) return null;
  if (it.kind === 'bismillah') return { surah: 1, ayah: 1, bismillah: true };
  return { surah: S.surah, ayah: it.ayah.ayah_number, bismillah: false };
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
    const where = surahTitle(S.surah) + '، ' + itemLabel(S.pos);
    if (P.wantPlay && P.buffering) text = 'در حال دریافت صدا · ' + where;
    else if (P.playing) text = 'در حال پخش · ' + where;
    else text = where;
  }
  dom.pStatus.textContent = text;
  updateMediaMetadata();
}

function updateSeekUI() {
  const a = dom.audio;
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
    if (d && typeof d.seekTime === 'number' && isFinite(dom.audio.duration)) {
      dom.audio.currentTime = clamp(d.seekTime, 0, dom.audio.duration);
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
  saveBookmark(ref, ref.bis ? 0 : dom.audio.currentTime);
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
  const time = (P.loaded && P.loaded.pos === pos && !ref.bis) ? dom.audio.currentTime : 0;
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
   صوت: مسیر مستقیم و مسیر گوگل
========================================================= */
function chooseRoute() {
  if (settings.route === 'relay') return 'relay';
  if (settings.route === 'direct') return 'direct';
  const t = Number(store.get(KEYS.relay, 0));
  if (t && Date.now() - t < RELAY_PREF_TTL) return 'relay';
  return 'direct';
}

function base64ToBlobUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
}

function trimRelayCache() {
  const keep = P.loaded && P.loaded.relayKey;
  while (relayCache.size > RELAY_MAX) {
    let victim = null;
    const it = relayCache.keys();
    for (let n = it.next(); !n.done; n = it.next()) {
      if (n.value !== keep) { victim = n.value; break; }
    }
    if (victim === null) break;
    try { URL.revokeObjectURL(relayCache.get(victim)); } catch (e) { /* ignore */ }
    relayCache.delete(victim);
  }
}

function dropRelay(key) {
  if (!relayCache.has(key)) return;
  try { URL.revokeObjectURL(relayCache.get(key)); } catch (e) { /* ignore */ }
  relayCache.delete(key);
}

function relayFetch(surah, ayah) {
  const key = surah + ':' + ayah;
  if (relayCache.has(key)) return Promise.resolve(relayCache.get(key));
  if (relayPending.has(key)) return relayPending.get(key);
  const p = apiGet('audio', { surah: surah, ayah: ayah }, { timeout: 45000, retries: 1 }).then(function (json) {
    if (!json.data) throw apiError('server', 'فایل صوتی خالی بود');
    const url = base64ToBlobUrl(json.data, json.mime);
    relayCache.set(key, url);
    trimRelayCache();
    return url;
  });
  relayPending.set(key, p);
  const clear = function () { relayPending.delete(key); };
  p.then(clear, clear);
  return p;
}

function setAudioSrc(url) {
  P.switching = true;
  dom.audio.src = url;
  updateSeekUI();
}

function safePlay() {
  let p;
  try { p = dom.audio.play(); } catch (e) { return; }
  if (p && typeof p.catch === 'function') {
    p.catch(function (err) {
      if (!err) return;
      if (err.name === 'AbortError') return;          // یک بارگذاری تازه جایش را گرفته
      if (err.name === 'NotAllowedError') {
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
  L.route = route;
  const t = L.track;

  if (route === 'direct') {
    L.triedDirect = true;
    setAudioSrc(audioUrl(AUDIO_BASES.ar, t.surah, t.ayah));
    armWatchdog(id);
    safePlay();
    return;
  }

  L.triedRelay = true;
  L.relayKey = t.surah + ':' + t.ayah;
  if (relayCache.has(L.relayKey)) {            // همگام، تا مجوز «پخش با لمس کاربر» از دست نرود
    setAudioSrc(relayCache.get(L.relayKey));
    armWatchdog(id);
    safePlay();
    return;
  }
  dom.pStatus.textContent = 'در حال دریافت صدا از مسیر گوگل…';
  relayFetch(t.surah, t.ayah).then(function (url) {
    if (!P.loaded || P.loaded.id !== id || P.userPaused) return;      // در این فاصله کاربر توقف زده
    setAudioSrc(url);
    armWatchdog(id);
    safePlay();
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

  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    P.wantPlay = false; P.playing = false; P.buffering = false;
    P.error = 'اینترنت قطع است';
    updatePlayUI();
    showToast('اینترنت قطع است؛ بعد از اتصال دوباره پخش کنید.', { action: 'تلاش دوباره', fn: retryTrack });
    return;
  }

  if (settings.route === 'auto') {
    if (L.route === 'direct' && !L.triedRelay) { loadSource(id, 'relay'); return; }
    if (L.route === 'relay' && !L.triedDirect) {
      if (L.relayKey) dropRelay(L.relayKey);
      loadSource(id, 'direct');
      return;
    }
  }

  if (L.relayKey) dropRelay(L.relayKey);
  P.wantPlay = false; P.playing = false; P.buffering = false;
  P.error = 'صدا بارگذاری نشد';
  updatePlayUI();
  showToast('صدا بارگذاری نشد.', { action: 'تلاش دوباره', fn: retryTrack, ms: 8000 });
}

function retryTrack() {
  if (S.pos >= 0) startTrack(S.pos);
}

/* شروع یک آهنگ تازه (آیتم pos از فهرست فعلی) */
function startTrack(pos, opts) {
  opts = opts || {};
  const track = trackFor(pos);
  if (!track) return;
  const id = ++P.trackId;
  P.loaded = { id: id, surah: S.surah, pos: pos, track: track, route: null, triedRelay: false, triedDirect: false, relayKey: '' };
  P.error = '';
  P.wantPlay = true;
  P.userPaused = false;
  P.playing = false;
  P.switching = true;
  P.pendingSeek = 0;
  if (opts.resume && P.resume && P.resume.surah === S.surah && P.resume.pos === pos) P.pendingSeek = Number(P.resume.time) || 0;
  P.resume = null;
  clearTimeout(P.watchdog);
  // صدای آهنگ قبلی همین‌جا قطع می‌شود تا هنگام دریافت آهنگ تازه (مثلاً از مسیر گوگل) چیزی از قبلی پخش نشود
  try { dom.audio.pause(); dom.audio.removeAttribute('src'); dom.audio.load(); } catch (e) { /* ignore */ }
  setBuffering(true);
  loadSource(id, chooseRoute());
}

/* آهنگ فعلی را رها کن، بدون دست‌زدن به «نیت» پخش */
function detachTrack() {
  P.trackId++;
  P.loaded = null;
  P.playing = false;
  P.switching = false;
  P.pendingSeek = 0;
  clearTimeout(P.watchdog);
  try {
    dom.audio.pause();
    dom.audio.removeAttribute('src');
    dom.audio.load();
  } catch (e) { /* ignore */ }
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
  setActive(pos, { scroll: 'nearest' });
  startTrack(pos);
}

function pausePlayback() {
  P.wantPlay = false;
  P.userPaused = true;
  clearTimeout(P.watchdog);
  try { dom.audio.pause(); } catch (e) { /* ignore */ }
  P.playing = false;
  P.buffering = false;
  savePlayingPosition(true);
  updatePlayUI();
}

function resumePlayback() {
  if (!S.data || !S.items.length) return;
  if (S.pos < 0) { playItem(0); return; }
  const L = P.loaded;
  if (L && L.pos === S.pos && L.surah === S.surah && dom.audio.getAttribute('src') && !dom.audio.error && !dom.audio.ended) {
    P.wantPlay = true;
    P.userPaused = false;
    P.error = '';
    P.buffering = dom.audio.readyState < 3;
    updatePlayUI();
    safePlay();
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
  detachTrack();
  P.wantPlay = true;
  P.userPaused = false;
  setBuffering(true);
  goToSurah(next, { autoplay: true, where: dir > 0 ? 'first' : 'last' });
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
  P.playing = false;
  if (S.pos + 1 < S.items.length) { playItem(S.pos + 1, true); return; }
  if (S.loadingNum) {
    // کاربر همین حالا سوره دیگری را انتخاب کرده و در حال بارگذاری است؛ پخش خودکار جلوی او را نگیرد
    P.wantPlay = false;
    P.buffering = false;
    updatePlayUI();
    return;
  }
  if (S.surah < 114) {
    detachTrack();
    setBuffering(true);
    goToSurah(S.surah + 1, { autoplay: true, where: 'first' });
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
  if (!L || dom.audio.paused) return;
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
  if (P.switching || dom.audio.ended || !P.loaded) return;
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
  const d = dom.audio.duration;
  if (P.pendingSeek > 0 && isFinite(d) && d > P.pendingSeek + 1) {
    try { dom.audio.currentTime = P.pendingSeek; } catch (e) { /* ignore */ }
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
    const d = dom.audio.duration;
    if (isFinite(d) && d > 0) {
      try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: 1, position: clamp(dom.audio.currentTime, 0, d) }); } catch (e) { /* ignore */ }
    }
  }
}

function onAudioError() {
  const L = P.loaded;
  if (!L || !dom.audio.getAttribute('src')) return;
  audioFailed(L.id, dom.audio.error);
}

function bindAudioEvents() {
  const a = dom.audio;
  a.addEventListener('loadstart', function () { P.switching = false; });
  a.addEventListener('loadedmetadata', onMetadata);
  a.addEventListener('durationchange', updateSeekUI);
  a.addEventListener('timeupdate', onTimeUpdate);
  a.addEventListener('progress', rearmWatchdog);
  a.addEventListener('loadeddata', rearmWatchdog);
  a.addEventListener('canplay', onCanPlay);
  a.addEventListener('waiting', onWaiting);
  a.addEventListener('playing', onPlaying);
  a.addEventListener('pause', onPause);
  a.addEventListener('ended', onEnded);
  a.addEventListener('error', onAudioError);
}

/* =========================================================
   پیش‌بارگذاری آهنگ بعدی (یک بار برای هر آهنگ)
========================================================= */
function prefetchSurahData(n) {
  if (n >= 1 && n <= 114) loadSurahData(n).then(noop, noop);
}

function preloadNext() {
  const L = P.loaded;
  if (!L || !S.data) return;
  if (S.pos >= S.items.length - 3 && S.surah < 114) prefetchSurahData(S.surah + 1);

  const nextPos = L.pos + 1;
  let t = null;
  if (nextPos < S.items.length) {
    t = trackFor(nextPos);
  } else if (S.surah < 114) {
    const ns = S.surah + 1;
    t = surahHasBismillah(ns) ? { surah: 1, ayah: 1 } : { surah: ns, ayah: 1 };
  }
  if (!t) return;

  if (L.route === 'relay') {
    relayFetch(t.surah, t.ayah).then(noop, noop);
    return;
  }
  const url = audioUrl(AUDIO_BASES.ar, t.surah, t.ayah);
  if (P.preloadUrl === url) return;
  P.preloadUrl = url;
  try {
    if (!P.preloader) P.preloader = new Audio();
    P.preloader.preload = 'auto';
    P.preloader.src = url;
  } catch (e) { /* ignore */ }
}

/* =========================================================
   نوار پیشرفت
========================================================= */
function seekFromEvent(e) {
  const rect = dom.seek.getBoundingClientRect();
  if (!rect.width) return;
  const frac = clamp((rect.right - e.clientX) / rect.width, 0, 1);     // راست‌به‌چپ: لبه راست = ابتدا
  const d = dom.audio.duration;
  if (isFinite(d) && d > 0) {
    try { dom.audio.currentTime = frac * d; } catch (err) { /* ignore */ }
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
    const d = dom.audio.duration;
    if (!isFinite(d) || d <= 0) return;
    let t = dom.audio.currentTime;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') t += 5;         // راست‌به‌چپ: چپ = جلو
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') t -= 5;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = d - 0.1;
    else return;
    e.preventDefault();
    dom.audio.currentTime = clamp(t, 0, d);
    updateSeekUI();
  });
}

