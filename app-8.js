'use strict';
/* =========================================================
   NAVIGATION
========================================================= */
function resolvePos(opts) {
  if (!S.items.length) return -1;
  if (opts.where === 'last') return S.items.length - 1;
  if (opts.where === 'first') return 0;
  if (opts.ayah) return posForAyah(S.items, opts.ayah, opts.preferBismillah !== false);
  return -1;
}

/* جابه‌جایی داخل همان سوره (بدون پخش). اگر صدایی از آیه دیگری در حال پخش است متوقف می‌شود
   تا نشانگر و صدا هرگز از هم جدا نشوند. */
function focusItem(pos, opts) {
  opts = opts || {};
  if (pos < 0 || pos >= S.items.length) return;
  if (P.loaded && P.loaded.pos !== pos) stopAudio();
  setActive(pos, { scroll: opts.scroll || 'center' });
  P.resume = opts.resume ? { surah: S.surah, pos: pos, time: Number(opts.resume) } : null;
}

function showLoadError(num, err, opts) {
  S.retryFn = function () { goToSurah(num, opts); };
  showState('بارگذاری ' + surahTitle(num) + ' ممکن نشد', esc(describeApiError(err)),
    [{ act: 'retry', label: 'تلاش دوباره', primary: true }]);
  dom.surahAr.textContent = '';
  dom.surahFa.textContent = surahTitle(num);
  dom.surahMeta.innerHTML = '';
  dom.nowLine.innerHTML = '';
}

function showSetupNeeded() {
  S.retryFn = null;
  showState('اتصال به گوگل اسکریپت هنوز تنظیم نشده',
    'در فایل <code>app-1.js</code> مقدار <code>API_URL</code> را با آدرس وب‌اپ Google Apps Script (آدرسی که به <code>/exec</code> ختم می‌شود) جایگزین کنید.',
    [], 'مراحل کامل در فایل «راهنمای نصب» آمده است.');
  dom.surahAr.textContent = 'القرآن الكريم';
  dom.surahFa.textContent = 'قرآن کریم';
  dom.surahMeta.innerHTML = '';
}

async function goToSurah(num, opts) {
  opts = opts || {};
  num = Number(num);
  if (!(num >= 1 && num <= 114)) return false;

  // همین سوره روی صفحه است: فقط جابه‌جایی داخل آن
  if (num === S.surah && S.data && !opts.force) {
    S.navToken++;
    S.loadingNum = 0;
    S.autoLoading = false;
    setListLoading(false);
    if (P.wantPlay && !P.loaded) { P.wantPlay = false; P.buffering = false; updatePlayUI(); }   // پخش خودکارِ در انتظار لغو شد
    const same = resolvePos(opts);
    if (opts.autoplay && same >= 0) playItem(same);
    else if (same >= 0) focusItem(same, { scroll: opts.scroll, resume: opts.resume });
    else window.scrollTo(0, 0);
    updatePlayerInfo();
    return true;
  }

  const token = ++S.navToken;
  S.loadingNum = num;
  S.autoLoading = !!opts.autoplay;
  const cached = peekSurahData(num);
  if (!cached) {
    if (S.surah === 0) showSkeleton();
    else setListLoading(true, num);
  }
  updatePlayerInfo();

  let data;
  try {
    data = cached || await loadSurahData(num);
  } catch (err) {
    if (token !== S.navToken) return false;        // کاربر در این فاصله جای دیگری رفته است
    S.loadingNum = 0;
    S.autoLoading = false;
    setListLoading(false);
    if (opts.autoplay) { P.wantPlay = false; P.buffering = false; updatePlayUI(); }
    if (S.surah === 0) {
      showLoadError(num, err, opts);
    } else {
      showToast('بارگذاری ' + surahTitle(num) + ' ممکن نشد. ' + describeApiError(err), {
        action: 'تلاش دوباره', ms: 9000, fn: function () { goToSurah(num, opts); }
      });
    }
    updatePlayerInfo();
    return false;
  }
  if (token !== S.navToken) return false;          // پاسخ کهنه: دور بریز
  S.loadingNum = 0;
  S.autoLoading = false;
  if (opts.autoplay && P.userPaused) opts = Object.assign({}, opts, { autoplay: false });   // وسط بارگذاری توقف زده شد
  commitSurah(num, data, opts);
  return true;
}

/* تنها جایی که سوره نمایش‌داده‌شده عوض می‌شود: همه چیز با هم و بدون فاصله.
   اگر پخش خودکار باشد، صدا پیش از ساختن فهرست روی صفحه شروع می‌شود تا هیچ تأخیری نیفتد. */
function commitSurah(num, data, opts) {
  if (!opts.autoplay) stopAudio();

  S.surah = num;
  S.data = data;
  S.items = buildItems(num, data.ayahs);
  S.pos = -1;

  const pos = resolvePos(opts);
  const start = effectivePos(pos >= 0 ? pos : 0);    // «فقط ترجمه»: از آیهٔ اول (ترجمهٔ بسم‌الله اول فایل آن است)
  if (opts.autoplay) startTrack(start);              // اول صدا

  renderHeader();
  renderList();
  setListLoading(false);
  updateSheetCurrent();

  if (opts.autoplay) {
    setActive(start, { scroll: 'center' });
  } else if (pos >= 0) {
    setActive(pos, { scroll: opts.scroll || 'center' });
    P.resume = opts.resume ? { surah: num, pos: pos, time: Number(opts.resume) } : null;
  } else {
    setActive(-1);
    window.scrollTo(0, 0);
  }
  updatePlayUI();
  ensureSurahList();
  schedulePrefetch(num);
  queueFabs();
}

/* سوره‌های کناری کمی بعد در پس‌زمینه گرفته می‌شوند تا رفتن به قبلی/بعدی فوری باشد */
let prefetchTimer = null;
function schedulePrefetch(num) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(function () {
    if (S.surah !== num || document.hidden) return;
    prefetchSurahData(num + 1);
    prefetchSurahData(num - 1);
  }, 900);
}

function onSurahsLoaded() {
  renderHeader();
  renderSurahRows();
  filterSurahRows(dom.surahSearch.value);
  updateSheetCurrent();
  updateResumeUI();
  updatePlayerInfo();
}

/* فهرست سوره‌ها (نام‌ها) جدا از متن سوره گرفته می‌شود. اگر در شروع نیامد، با هر سوره‌ای که
   با موفقیت باز شود دوباره امتحان می‌شود تا عنوان‌ها برای همیشه «سوره ۱» نمانند. */
function ensureSurahList() {
  if (S.surahs.length) return;
  loadSurahList().then(function (list) {
    if (S.surahs.length) return;
    setSurahs(list);
    onSurahsLoaded();
  }, noop);
}

function continueFromBookmark() {
  const b = getBookmark();
  if (!b) return;
  goToSurah(Number(b.surah), {
    ayah: Number(b.ayah),
    preferBismillah: b.bis === undefined ? true : !!b.bis,
    scroll: 'center',
    resume: b.time
  });
}

/* =========================================================
   رفتن به صفحه مصحف (رقم‌ها همیشه فارسی نمایش داده می‌شوند)
========================================================= */
const pageCache = new Map();
let pageBusy = false;

function toAsciiDigits(text) {
  return String(text || '')
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
    .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
}

/* هر رقم لاتین یا عربی را فارسی می‌کند */
function toFaDigits(text) {
  return String(text || '')
    .replace(/[0-9]/g, function (d) { return FA_DIGITS[Number(d)]; })
    .replace(/[٠-٩]/g, function (d) { return FA_DIGITS[d.charCodeAt(0) - 0x0660]; });
}

function onlyFaDigits(text) {
  return toFaDigits(text).replace(/[^۰-۹]/g, '');
}

/* هنگام تایپ، رقم‌ها را فارسی می‌کند و جای نشانگر را نگه می‌دارد */
function persianizeInput(el, digitsOnly) {
  const v = el.value;
  const fix = digitsOnly ? onlyFaDigits : toFaDigits;
  const nv = fix(v);
  if (nv === v) return;
  let caret = null;
  try { caret = el.selectionStart; } catch (e) { caret = null; }
  const head = caret === null ? nv.length : fix(v.slice(0, caret)).length;
  el.value = nv;
  try { el.setSelectionRange(head, head); } catch (e) { /* ignore */ }
}

async function jumpToPage(raw) {
  if (pageBusy) return;
  const text = toAsciiDigits(raw).trim();
  const page = /^\d{1,3}$/.test(text) ? Number(text) : 0;
  if (page < 1 || page > 604) {
    dom.pageError.textContent = 'شماره صفحه باید عددی بین ۱ تا ۶۰۴ باشد.';
    return;
  }
  dom.pageError.textContent = '';
  pageBusy = true;
  dom.pageGo.disabled = true;
  dom.pageGo.textContent = 'در حال جستجو…';
  try {
    let first = pageCache.get(page);
    if (!first) {
      first = await localPageFirst(page);            // متن همهٔ سوره‌ها روی دستگاه باشد، بدون اینترنت هم پیدا می‌شود
      if (first) pageCache.set(page, first);
    }
    if (!first) {
      const tok = S.navToken;
      const json = await apiGet('page', { page: page });
      if (tok !== S.navToken) return;               // کاربر در این فاصله جای دیگری رفته است
      first = json.first_ayah;
      if (!first || !first.surah_id) throw apiError('server', 'صفحه پیدا نشد');
      pageCache.set(page, first);
    }
    dom.pageInput.blur();
    await goToSurah(Number(first.surah_id), { ayah: Number(first.ayah_number), scroll: 'start' });
  } catch (err) {
    dom.pageError.textContent = describeApiError(err);
  } finally {
    pageBusy = false;
    dom.pageGo.disabled = false;
    dom.pageGo.textContent = 'برو';
  }
}

/* =========================================================
   UI: یادآوری با نگه‌داشتن انگشت
========================================================= */
const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE = 10;
let press = null;
let suppressClick = false;
let suppressTimer = null;
let lastPointerType = 'mouse';

function cancelPress() {
  if (press) { clearTimeout(press.timer); press = null; }
}

function remindAyah(n) {
  const surah = S.surah;
  const added = toggleReminder(surah, n);
  const label = surahTitle(surah) + '، آیه ' + faNum(n);
  showToast(added ? ('یادآوری ثبت شد · ' + label) : ('یادآوری برداشته شد · ' + label), {
    action: 'برگرداندن',
    fn: function () { toggleReminder(surah, n); }
  });
}

function fireLongPress(el) {
  press = null;
  suppressClick = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(function () { suppressClick = false; }, 4000);
  remindAyah(Number(el.getAttribute('data-n')));
  try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* ignore */ }
}

function bindLongPress() {
  dom.list.addEventListener('pointerdown', function (e) {
    lastPointerType = e.pointerType || 'mouse';
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button')) return;
    const el = e.target.closest('.ayah');
    if (!el) return;
    cancelPress();
    press = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      timer: setTimeout(function () { fireLongPress(el); }, LONG_PRESS_MS)
    };
  });
  dom.list.addEventListener('pointermove', function (e) {
    if (!press || e.pointerId !== press.id) return;
    if (Math.abs(e.clientX - press.x) > MOVE_TOLERANCE || Math.abs(e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  const end = function () {
    cancelPress();
    if (suppressClick) {
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(function () { suppressClick = false; }, 350);   // کلیکِ پس از رها کردن را بخور
    }
  };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { dom.list.addEventListener(t, end); });
  // منوی لمسیِ مرورگر هنگام نگه‌داشتن انگشت نباید باز شود (با ماوس، منوی راست‌کلیک سر جایش است)
  dom.list.addEventListener('contextmenu', function (e) {
    if (lastPointerType !== 'mouse' && e.target.closest('.ayah')) e.preventDefault();
  });
}

/* =========================================================
   UI: اتصال رویدادها
========================================================= */
function setTranslation(on) {
  on = !!on;
  if (settings.translation === on) return;
  withScrollAnchor(function () {
    settings.translation = on;
    saveSettings();
    applyListClasses();
    if (on) fillBismillahTranslation();
  });
  queueFabs();
}

function bindList() {
  dom.list.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
    if (e.target.closest('[data-act="retry"]')) { if (S.retryFn) S.retryFn(); return; }
    const itemEl = e.target.closest('[data-i]');
    if (!itemEl) return;
    const i = Number(itemEl.getAttribute('data-i'));
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const act = btn.getAttribute('data-act');
      if (act === 'copy') {
        const it = S.items[i];
        if (it && it.kind === 'ayah') {
          copyText(ayahCopyText(it.ayah)).then(function (ok) { showToast(ok ? 'آیه کپی شد.' : 'کپی انجام نشد.'); });
        }
      } else if (act === 'remind') {
        remindAyah(Number(itemEl.getAttribute('data-n')));
      } else if (act === 'mark') {
        markPos(i);
      } else if (act === 'color') {
        openColorPicker(S.surah, Number(itemEl.getAttribute('data-n')), '', btn);
      }
      return;
    }
    onItemTap(i);
  });

  dom.list.addEventListener('keydown', function (e) {
    const itemEl = e.target;
    if (!itemEl || !itemEl.hasAttribute || !itemEl.hasAttribute('data-i')) return;
    const i = Number(itemEl.getAttribute('data-i'));
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onItemTap(i);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = S.els[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { next.focus(); scrollToEl(next, 'nearest'); }
    }
  });

  bindLongPress();
}

function bindSheets() {
  Object.keys(sheetEls).forEach(function (name) {
    if (!sheetEls[name]) return;
    sheetEls[name].addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeSheet();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (!sheets.open) return;
    if (e.key === 'Escape') { closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const panel = sheetEls[sheets.open].querySelector('.panel');
    const f = focusables(panel);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  dom.surahSearch.addEventListener('input', function () {
    persianizeInput(dom.surahSearch, false);
    filterSurahRows(dom.surahSearch.value);
  });
  dom.surahRows.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="retry-surahs"]')) { prepareSurahSheet(); return; }
    const row = e.target.closest('.srow');
    if (!row) return;
    const n = Number(row.getAttribute('data-n'));
    closeSheet();
    goToSurah(n, {});
  });

  dom.remRows.addEventListener('click', function (e) {
    const del = e.target.closest('.del');
    if (del) {
      toggleReminder(Number(del.getAttribute('data-s')), Number(del.getAttribute('data-a')));
      return;
    }
    const go = e.target.closest('.go');
    if (go) {
      const s = Number(go.getAttribute('data-s'));
      const a = Number(go.getAttribute('data-a'));
      closeSheet();
      goToSurah(s, { ayah: a, preferBismillah: false, scroll: 'center' });
    }
  });
}

function bindSettings() {
  const seg = function (id, apply) {
    $(id).addEventListener('click', function (e) {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      apply(b.getAttribute('data-value'));
      saveSettings();
      syncSettingsUI();
    });
  };
  seg('segTheme', function (v) { settings.theme = v; applyTheme(); });
  seg('segPalette', function (v) { settings.palette = v; applyTheme(); });
  seg('segPlay', function (v) {
    settings.audioMode = v;
    if (v !== 'ar' && S.data && !S.data.hasFa) showToast('ترجمهٔ فارسی این سوره هنوز در پایگاه داده نیست.');
    else showToast(v === 'both' ? 'بعد از هر آیه، ترجمهٔ فارسی هم خوانده می‌شود.' : (v === 'fa' ? 'فقط صوت ترجمهٔ فارسی پخش می‌شود.' : 'فقط صوت عربی پخش می‌شود.'));
    if (P.loaded && P.wantPlay) { P.preloadedFor = 0; preloadNext(); }
    refreshOfflineUI();
  });
  seg('segAudio', function (v) {
    settings.route = v;
    store.remove(KEYS.relay);       // انتخاب تازه، حافظه «مسیر گوگل» را پاک می‌کند
  });

  const setSize = function (key, min, max, value) {
    const next = clamp(Math.round(Number(value) || 0), min, max);
    if (next === settings[key]) return;
    withScrollAnchor(function () {
      settings[key] = next;
      applyTheme();
    });
    syncSettingsUI();
    queueFabs();
  };
  dom.sizeRange.addEventListener('input', function () { setSize('size', SIZE_MIN, SIZE_MAX, dom.sizeRange.value); });
  dom.sizeRange.addEventListener('change', saveSettings);
  $('sizeUp').addEventListener('click', function () { setSize('size', SIZE_MIN, SIZE_MAX, settings.size + 2); saveSettings(); });
  $('sizeDown').addEventListener('click', function () { setSize('size', SIZE_MIN, SIZE_MAX, settings.size - 2); saveSettings(); });
  dom.trSizeRange.addEventListener('input', function () { setSize('trSize', TR_MIN, TR_MAX, dom.trSizeRange.value); });
  dom.trSizeRange.addEventListener('change', saveSettings);
  $('trSizeUp').addEventListener('click', function () { setSize('trSize', TR_MIN, TR_MAX, settings.trSize + 1); saveSettings(); });
  $('trSizeDown').addEventListener('click', function () { setSize('trSize', TR_MIN, TR_MAX, settings.trSize - 1); saveSettings(); });

  $('btnClearCache').addEventListener('click', function () {
    clearTextCache().then(function () {
      showToast('حافظهٔ موقت سوره‌ها پاک شد؛ سوره‌های ذخیره‌شده برای آفلاین می‌مانند.');
    });
  });
  $('btnOpenOffline').addEventListener('click', function () { openSheet('offline', $('btnOpenOffline')); });

  if (darkQuery) {
    const onChange = function () { if (settings.theme === 'auto') applyTheme(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onChange);
    else if (darkQuery.addListener) darkQuery.addListener(onChange);
  }
}

function bindUI() {
  bindMarks();
  bindAccount();
  dom.btnSurahs.addEventListener('click', function () { openSheet('surahs', dom.btnSurahs); });
  $('titleBtn').addEventListener('click', function () { openSheet('surahs', $('titleBtn')); });
  dom.btnReminders.addEventListener('click', function () { openSheet('reminders', dom.btnReminders); });
  dom.btnOffline.addEventListener('click', function () { openSheet('offline', dom.btnOffline); });
  dom.btnSettings.addEventListener('click', function () { openSheet('settings', dom.btnSettings); });

  dom.prevSurah.addEventListener('click', function () { if (S.surah > 1) goToSurah(S.surah - 1, {}); });
  dom.nextSurah.addEventListener('click', function () { if (S.surah >= 1 && S.surah < 114) goToSurah(S.surah + 1, {}); });

  dom.pageForm.addEventListener('submit', function (e) { e.preventDefault(); jumpToPage(dom.pageInput.value); });
  dom.pageInput.addEventListener('input', function () {
    persianizeInput(dom.pageInput, true);
    dom.pageError.textContent = '';
  });

  dom.continueBtn.addEventListener('click', continueFromBookmark);
  dom.trSwitch.addEventListener('click', function () { setTranslation(!settings.translation); });

  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnPrev.addEventListener('click', function () { stepItem(-1); });
  dom.btnNext.addEventListener('click', function () { stepItem(1); });
  dom.btnStart.addEventListener('click', function () { playItem(0); });
  dom.btnMin.addEventListener('click', function () {
    settings.minPlayer = !settings.minPlayer;
    saveSettings();
    applyPlayerMin();
  });

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || e.defaultPrevented || sheets.open) return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    e.preventDefault();
    togglePlay();
  });

  const flush = function () { if (P.playing) savePlayingPosition(true); };
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

  window.addEventListener('resize', updatePlayerHeightVar);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updatePlayerHeightVar).observe(dom.player);

  bindList();
  bindSheets();
  bindSettings();
  bindSeek();
  bindAudioEvents();
  bindFabs();
  bindOffline();
  setupMediaSession();
}

/* =========================================================
   Service Worker: باز شدن برنامه بدون اینترنت
========================================================= */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  const go = function () {
    try {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(noop, noop);
    } catch (e) { /* ignore */ }
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go);
}

/* =========================================================
   BOOT
========================================================= */
function boot() {
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
  purgeOldCaches();
  applyTheme();
  bindUI();
  applyPlayerMin();
  applyListClasses();
  updateSurahNav();          // تا سوره‌ای باز نشده، دکمه‌های قبلی/بعدی غیرفعال‌اند
  refreshReminderMarks();
  updateMarkBadge();
  updateSeekUI();
  updatePlayUI();
  updateResumeUI();
  syncSettingsUI();
  queueFabs();
  offlineInit();
  registerServiceWorker();

  if (!API_READY) { showSetupNeeded(); return; }

  ensureSurahList();

  const b = getBookmark();
  if (b) {
    goToSurah(Number(b.surah), {
      ayah: Number(b.ayah),
      preferBismillah: b.bis === undefined ? true : !!b.bis,
      scroll: 'center',
      resume: b.time
    });
  } else {
    goToSurah(1, {});
  }
}

boot();
window.__quranBooted = true;
