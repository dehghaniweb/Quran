'use strict';
/* =========================================================
   DOM
========================================================= */
const $ = function (id) { return document.getElementById(id); };
const root = document.documentElement;

const dom = {
  topbar: document.querySelector('.topbar'),
  list: $('list'), spinner: $('listSpinner'),
  surahAr: $('surahAr'), surahFa: $('surahFa'), surahMeta: $('surahMeta'),
  prevSurah: $('prevSurah'), nextSurah: $('nextSurah'), prevName: $('prevName'), nextName: $('nextName'),
  nowLine: $('nowLine'),
  pageForm: $('pageForm'), pageInput: $('pageInput'), pageError: $('pageError'), pageGo: $('pageGo'),
  continueBtn: $('continueBtn'), continueText: $('continueText'),
  saveSurah: $('btnSaveSurah'), saveSurahText: $('saveSurahText'), saveSurahBar: $('saveSurahBar'),
  trSwitch: $('trSwitch'),
  player: $('player'), seek: $('seek'), seekFill: $('seekFill'), pStatus: $('pStatus'), tCur: $('tCur'), tDur: $('tDur'),
  btnStart: $('btnStart'), btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'), btnMin: $('btnMin'),
  toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
  audio: $('audio'), audio2: $('audio2'),
  btnSurahs: $('btnSurahs'), btnReminders: $('btnReminders'), btnSettings: $('btnSettings'), btnOffline: $('btnOffline'), remCount: $('remCount'),
  surahSearch: $('surahSearch'), surahRows: $('surahRows'), remRows: $('remRows'),
  sizeOut: $('sizeOut'), sizeRange: $('sizeRange'), sizePreview: $('sizePreview'),
  trSizeOut: $('trSizeOut'), trSizeRange: $('trSizeRange'), trPreview: $('trPreview'),
  fabTop: $('fabTop'), fabCur: $('fabCur')
};

const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
}

function icon(id, cls) {
  return '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#' + id + '" xlink:href="#' + id + '"/></svg>';
}

function setIcon(svg, id) {
  const use = svg.querySelector('use');
  if (!use) return;
  use.setAttribute('href', '#' + id);
  use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id);
}

/* =========================================================
   THEME / SETTINGS (ظاهر)
========================================================= */
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && !!darkQuery && darkQuery.matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-palette', settings.palette);
  root.style.setProperty('--ayah-size', settings.size + 'px');
  root.style.setProperty('--tr-size', settings.trSize + 'px');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d1222' : '#f5f1e6');
}

function updatePlayerHeightVar() {
  root.style.setProperty('--player-h', dom.player.offsetHeight + 'px');
}

/* =========================================================
   TOAST
========================================================= */
let toastTimer = null;

function hideToast() {
  dom.toast.classList.remove('show');
}

function showToast(text, opts) {
  opts = opts || {};
  dom.toastText.textContent = text;
  if (opts.action) {
    dom.toastAction.hidden = false;
    dom.toastAction.textContent = opts.action;
    dom.toastAction.onclick = function () { hideToast(); if (opts.fn) opts.fn(); };
  } else {
    dom.toastAction.hidden = true;
    dom.toastAction.onclick = null;
  }
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.ms || (opts.action ? 6500 : 2800));
}

/* =========================================================
   SCROLL
========================================================= */
function visibleBand() {
  const top = dom.topbar ? dom.topbar.getBoundingClientRect().height : 56;
  const playerTop = dom.player.getBoundingClientRect().top;
  return { top: top, bottom: Math.min(window.innerHeight, playerTop) };
}

function scrollByY(dy, smooth) {
  if (Math.abs(dy) < 1) return;
  try {
    window.scrollBy({ top: dy, left: 0, behavior: (smooth && !reduceMotion) ? 'smooth' : 'auto' });
  } catch (e) {
    window.scrollBy(0, dy);
  }
}

function scrollToEl(el, mode) {
  if (!el) return;
  const band = visibleBand();
  const rect = el.getBoundingClientRect();
  const bandH = band.bottom - band.top;
  if (mode === 'nearest') {
    if (rect.top >= band.top + 8 && rect.bottom <= band.bottom - 8) return;
    mode = 'center';
  }
  let dy;
  if (mode === 'start' || rect.height > bandH - 24) dy = rect.top - band.top - 12;
  else dy = rect.top - band.top - (bandH - rect.height) / 2;
  scrollByY(dy, true);
}

function firstVisibleIndex() {
  const edge = (dom.topbar ? dom.topbar.offsetHeight : 56) + 24;
  for (let i = 0; i < S.els.length; i++) {
    if (S.els[i].getBoundingClientRect().bottom > edge) return i;
  }
  return -1;
}

/* وقتی ارتفاع فهرست عوض می‌شود (نمایش ترجمه، اندازه خط) آیه‌ای که می‌خوانید سر جایش می‌ماند */
function withScrollAnchor(fn) {
  const idx = firstVisibleIndex();
  const el = idx >= 0 ? S.els[idx] : null;
  const before = el ? el.getBoundingClientRect().top : 0;
  fn();
  if (el) scrollByY(el.getBoundingClientRect().top - before, false);
}

/* =========================================================
   فلش‌های شناور: «ابتدای سوره» و «برگشت به آیه‌ای که می‌خوانید»
========================================================= */
let fabQueued = false;

function updateFabs() {
  fabQueued = false;
  if (!dom.fabTop || !dom.fabCur) return;
  const y = window.pageYOffset || root.scrollTop || 0;
  dom.fabTop.classList.toggle('show', y > 260);

  let showCur = false;
  let up = false;
  const el = S.activeEl;
  if (el && el.isConnected) {
    const band = visibleBand();
    const r = el.getBoundingClientRect();
    if (r.bottom < band.top + 6) { showCur = true; up = true; }
    else if (r.top > band.bottom - 6) { showCur = true; up = false; }
  }
  dom.fabCur.classList.toggle('show', showCur);
  if (showCur) {
    setIcon(dom.fabCur.querySelector('svg'), up ? 'i-arrow-up' : 'i-arrow-down');
    dom.fabCur.setAttribute('data-dir', up ? 'up' : 'down');
  }
}

function queueFabs() {
  if (fabQueued) return;
  fabQueued = true;
  if (window.requestAnimationFrame) window.requestAnimationFrame(updateFabs);
  else setTimeout(updateFabs, 50);
}

function bindFabs() {
  window.addEventListener('scroll', queueFabs, { passive: true });
  window.addEventListener('resize', queueFabs);
  dom.fabTop.addEventListener('click', function () {
    try { window.scrollTo({ top: 0, left: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  });
  dom.fabCur.addEventListener('click', function () {
    if (S.activeEl) scrollToEl(S.activeEl, 'center');
  });
}

/* =========================================================
   SHEETS (پنجره‌های پایین‌صفحه) + دکمه برگشت مرورگر
========================================================= */
const sheetEls = { surahs: $('sheetSurahs'), reminders: $('sheetReminders'), settings: $('sheetSettings'), offline: $('sheetOffline') };
const sheets = { open: null, opener: null, ignorePop: 0 };

function focusables(container) {
  return Array.prototype.slice.call(container.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex="0"]'))
    .filter(function (n) { return n.offsetParent !== null; });
}

function showSheetUI(name) {
  const el = sheetEls[name];
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-open');
  const close = el.querySelector('.panel-head .icon-btn');
  if (close) close.focus();
}

function hideSheetUI(name) {
  const el = sheetEls[name];
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

function afterSheetClosed() {
  document.body.classList.remove('sheet-open');
  const opener = sheets.opener;
  sheets.opener = null;
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
}

function openSheet(name, opener) {
  if (sheets.open === name) return;
  hideToast();
  const had = sheets.open;
  if (had) hideSheetUI(had);
  sheets.open = name;
  if (!had) sheets.opener = opener || document.activeElement;
  if (name === 'surahs') prepareSurahSheet();
  if (name === 'reminders') renderRemindersSheet();
  if (name === 'settings') syncSettingsUI();
  if (name === 'offline' && typeof prepareOfflineSheet === 'function') prepareOfflineSheet();
  showSheetUI(name);
  try {
    if (had) history.replaceState({ sheet: name }, '');
    else history.pushState({ sheet: name }, '');
  } catch (e) { /* ignore */ }
}

function closeSheet() {
  if (!sheets.open) return;
  const name = sheets.open;
  sheets.open = null;
  hideSheetUI(name);
  afterSheetClosed();
  try {
    if (history.state && history.state.sheet) { sheets.ignorePop++; history.back(); }
  } catch (e) { /* ignore */ }
}

window.addEventListener('popstate', function () {
  if (sheets.ignorePop > 0) { sheets.ignorePop--; return; }
  if (sheets.open) {
    const name = sheets.open;
    sheets.open = null;
    hideSheetUI(name);
    afterSheetClosed();
  }
});

/* =========================================================
   HEADER / NOW LINE
========================================================= */
function renderHeader() {
  const n = S.surah;
  if (!n) return;
  const s = S.surahMap[n];
  dom.surahAr.textContent = s && s.name_ar ? s.name_ar : '';
  dom.surahFa.textContent = surahTitle(n);
  const total = S.data ? S.data.ayahs.length : (s ? Number(s.ayah_count) : 0);
  const type = s ? revelationLabel(s.revelation_type) : '';
  const parts = ['<span>سوره شماره ' + faNum(n) + '</span>'];
  if (type) parts.push('<span>' + type + '</span>');
  if (total) parts.push('<span>' + faNum(total) + ' آیه</span>');
  dom.surahMeta.innerHTML = parts.join('');
  document.title = surahTitle(n) + ' — قرآن کریم';
  updateSurahNav();
  if (typeof updateSaveSurahButton === 'function') updateSaveSurahButton();
}

function updateSurahNav() {
  const n = S.surah;
  dom.prevSurah.disabled = !(n > 1);
  dom.nextSurah.disabled = !(n >= 1 && n < 114);
  dom.prevName.textContent = n > 1 ? surahShort(n - 1) : '';
  dom.nextName.textContent = (n >= 1 && n < 114) ? surahShort(n + 1) : '';
}

/* آیه‌ای که صفحه و جزء را از آن می‌خوانیم */
function refAyah() {
  if (!S.data) return null;
  const it = S.items[S.pos];
  if (it && it.kind === 'ayah') return it.ayah;
  return S.data.ayahs[0] || null;
}

function updateNow() {
  const a = refAyah();
  if (!a) { dom.nowLine.innerHTML = ''; return; }
  const parts = [];
  if (a.page) parts.push('<span><b>صفحه</b> ' + faNum(a.page) + '</span>');
  if (a.juz) parts.push('<span><b>جزء</b> ' + faNum(a.juz) + '</span>');
  parts.push('<span><b>آیه</b> ' + faNum(a.ayah_number) + ' از ' + faNum(S.data.ayahs.length) + '</span>');
  dom.nowLine.innerHTML = parts.join('');
}

/* =========================================================
   LIST
========================================================= */
function applyListClasses() {
  const L = dom.list.classList;
  L.toggle('tr-on', !!settings.translation);
  L.toggle('no-fa', !!(S.data && !S.data.hasFa));
  dom.trSwitch.setAttribute('aria-checked', settings.translation ? 'true' : 'false');
}

function ayahHtml(a, i) {
  const n = a.ayah_number;
  return '<article class="ayah" data-i="' + i + '" data-n="' + n + '" tabindex="-1">' +
    '<div class="a-head">' +
      '<span class="rosette" aria-hidden="true"><svg viewBox="0 0 40 40"><use href="#rosette" xlink:href="#rosette"/></svg><b>' + faNum(n) + '</b></span>' +
      '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="a-tools">' +
        '<button type="button" data-act="mark" class="mark" aria-label="ذخیره جای خواندن از آیه ' + faNum(n) + '" title="ذخیره جای خواندن">' + icon('i-bookmark') + '</button>' +
        '<button type="button" data-act="remind" class="bell" aria-pressed="false" aria-label="یادآوری برای آیه ' + faNum(n) + '" title="یادآوری">' + icon('i-bell') + '</button>' +
        '<button type="button" data-act="copy" aria-label="کپی آیه ' + faNum(n) + '" title="کپی">' + icon('i-copy') + '</button>' +
      '</span>' +
    '</div>' +
    '<p class="arabic" lang="ar" dir="rtl">' + esc(a.text_ar) + '</p>' +
    (a.text_fa ? '<p class="translation" lang="fa">' + esc(a.text_fa) + '</p>' : '') +
  '</article>';
}

function renderList() {
  const d = S.data;
  const html = [];
  if (!d.hasFa) {
    html.push('<div class="fa-note">ترجمه فارسی این سوره هنوز اضافه نشده است؛ فعلاً فقط متن عربی نمایش داده می‌شود.</div>');
  }
  S.items.forEach(function (it, i) {
    if (it.kind === 'bismillah') {
      html.push('<div class="bismillah" data-i="' + i + '" role="button" tabindex="-1" lang="ar" dir="rtl" aria-label="بسم الله الرحمن الرحیم (پخش)">' +
        '<span class="bis-ar">' + esc(d.bismillah) + '</span><span class="translation bis-tr" lang="fa" hidden></span></div>');
    } else {
      html.push(ayahHtml(it.ayah, i));
    }
  });
  dom.list.innerHTML = html.join('');
  S.els = Array.prototype.slice.call(dom.list.querySelectorAll('[data-i]'));
  S.activeEl = null;
  if (S.els[0]) S.els[0].tabIndex = 0;
  applyListClasses();
  refreshReminderMarks();
  refreshBookmarkMark();
  if (settings.translation) fillBismillahTranslation();
}

/* ترجمهٔ بسم‌الله همان ترجمهٔ آیه ۱ سورهٔ حمد است */
function fillBismillahTranslation() {
  if (!S.data || !S.data.hasBismillah) return;
  const num = S.surah;
  const put = function (d) {
    if (S.surah !== num) return;
    const el = dom.list.querySelector('.bis-tr');
    const a = d && d.ayahs[0];
    if (el && a && a.ayah_number === 1 && a.text_fa) { el.textContent = a.text_fa; el.hidden = false; }
  };
  const d = peekSurahData(1);
  if (d) { put(d); return; }
  loadSurahData(1).then(put, noop);
}

function showSkeleton() {
  let h = '';
  for (let i = 0; i < 4; i++) h += '<div class="skeleton"><i></i><i></i><i></i></div>';
  dom.list.innerHTML = h;
  S.els = [];
  S.activeEl = null;
}

function showState(title, message, buttons, hint) {
  let h = '<div class="state" role="alert"><h2>' + esc(title) + '</h2><p>' + message + '</p>';
  (buttons || []).forEach(function (b) {
    h += '<button type="button" class="btn ' + (b.primary ? 'btn-primary' : '') + '" data-act="' + b.act + '">' + esc(b.label) + '</button>';
  });
  if (hint) h += '<p class="hint">' + hint + '</p>';
  h += '</div>';
  dom.list.innerHTML = h;
  S.els = [];
  S.activeEl = null;
}

function setListLoading(on, num) {
  dom.list.classList.toggle('is-loading', !!on);
  dom.spinner.hidden = !on;
  if (on) dom.spinner.textContent = num ? ('در حال بارگذاری ' + surahTitle(num) + '…') : 'در حال بارگذاری…';
}

/* نشانگر آیه فعال. تنها جایی که S.pos عوض می‌شود. */
function setActive(pos, opts) {
  opts = opts || {};
  if (S.activeEl) {
    S.activeEl.classList.remove('active');
    S.activeEl.removeAttribute('aria-current');
    S.activeEl.tabIndex = -1;
  }
  S.pos = pos;
  S.activeEl = pos >= 0 ? (S.els[pos] || null) : null;
  if (S.activeEl) {
    S.activeEl.classList.add('active');
    S.activeEl.setAttribute('aria-current', 'true');
    S.activeEl.tabIndex = 0;
  } else if (S.els[0]) {
    S.els[0].tabIndex = 0;
  }
  updateNow();
  updatePlayerInfo();
  updateResumeUI();
  if (opts.scroll && S.activeEl) scrollToEl(S.activeEl, opts.scroll);
  queueFabs();
}

/* =========================================================
   REMINDERS (یادآوری با نگه‌داشتن انگشت روی آیه)
========================================================= */
let remMemory = null;       // اگر حافظه مرورگر در دسترس نبود، تا پایان همین نشست

function getReminders() {
  if (remMemory) return remMemory;
  const list = store.get(KEYS.reminders, []);
  return Array.isArray(list) ? list.filter(function (r) { return r && Number(r.surah) >= 1 && Number(r.ayah) >= 1; }) : [];
}

function saveReminders(list) {
  if (!store.set(KEYS.reminders, list)) {
    remMemory = list;
    return false;
  }
  remMemory = null;
  return true;
}

function remKey(surah, ayah) { return Number(surah) + ':' + Number(ayah); }

function isReminded(surah, ayah) {
  const k = remKey(surah, ayah);
  return getReminders().some(function (r) { return r.key === k; });
}

/* true = اضافه شد، false = برداشته شد */
function toggleReminder(surah, ayah) {
  const list = getReminders().slice();
  const k = remKey(surah, ayah);
  const idx = list.findIndex(function (r) { return r.key === k; });
  let added;
  if (idx >= 0) { list.splice(idx, 1); added = false; }
  else { list.push({ key: k, surah: Number(surah), ayah: Number(ayah), createdAt: Date.now() }); added = true; }
  const persisted = saveReminders(list);
  refreshReminderMarks();
  if (!persisted) showToast('حافظه مرورگر در دسترس نیست؛ یادآوری فقط تا بستن صفحه می‌ماند.', { ms: 4200 });
  return added;
}

function refreshReminderMarks() {
  const set = {};
  getReminders().forEach(function (r) { set[r.key] = true; });
  S.els.forEach(function (el) {
    if (!el.classList.contains('ayah')) return;
    const on = !!set[remKey(S.surah, el.getAttribute('data-n'))];
    el.classList.toggle('reminded', on);
    const bell = el.querySelector('.bell');
    if (bell) {
      bell.classList.toggle('rem', on);
      bell.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  });
  const count = getReminders().length;
  dom.remCount.hidden = count === 0;
  dom.remCount.textContent = faNum(count);
  if (sheets.open === 'reminders') renderRemindersSheet();
}

function reminderRowHtml(r, d) {
  let snip = '';
  if (d) {
    const a = d.ayahs.find(function (x) { return x.ayah_number === Number(r.ayah); });
    if (a) snip = '<span class="snip" lang="ar">' + esc(a.text_ar) + '</span>';
  }
  return '<div class="rrow">' +
    '<button type="button" class="go" data-s="' + Number(r.surah) + '" data-a="' + Number(r.ayah) + '">' +
      '<strong>' + esc(surahTitle(Number(r.surah))) + '، آیه ' + faNum(r.ayah) + '</strong>' + snip +
    '</button>' +
    '<button type="button" class="del" data-s="' + Number(r.surah) + '" data-a="' + Number(r.ayah) + '" aria-label="حذف یادآوری">' + icon('i-trash') + '</button>' +
  '</div>';
}

function renderRemindersSheet() {
  const list = getReminders().slice().sort(function (a, b) { return Number(b.createdAt || 0) - Number(a.createdAt || 0); });
  if (!list.length) {
    dom.remRows.innerHTML = '<div class="empty-note">هنوز یادآوری‌ای ثبت نکرده‌اید.<br>روی هر آیه چند لحظه انگشت را نگه دارید تا یادآوری ثبت شود.</div>';
    return;
  }
  dom.remRows.innerHTML = list.map(function (r) { return reminderRowHtml(r, peekSurahData(Number(r.surah))); }).join('');

  // خلاصهٔ آیه‌هایی که متنشان فقط روی دستگاه ذخیره شده (نه در حافظهٔ فعلی)
  const asked = {};
  list.forEach(function (r) {
    const s = Number(r.surah);
    if (asked[s] || peekSurahData(s)) return;
    asked[s] = true;
    localSurahData(s).then(function (d) {
      if (!d || sheets.open !== 'reminders') return;
      Array.prototype.forEach.call(dom.remRows.querySelectorAll('.go[data-s="' + s + '"]'), function (go) {
        if (go.querySelector('.snip')) return;
        const a = d.ayahs.find(function (x) { return x.ayah_number === Number(go.getAttribute('data-a')); });
        if (a) go.insertAdjacentHTML('beforeend', '<span class="snip" lang="ar">' + esc(a.text_ar) + '</span>');
      });
    });
  });
}

/* =========================================================
   SURAH SHEET
========================================================= */
function renderSurahRows() {
  if (!S.surahs.length) {
    dom.surahRows.innerHTML = '<div class="empty-note" id="surahListNote">در حال بارگذاری فهرست سوره‌ها…</div>';
    return;
  }
  dom.surahRows.innerHTML = S.surahs.map(function (s) {
    const n = Number(s.number);
    const type = revelationLabel(s.revelation_type);
    const subParts = [type, faNum(s.ayah_count) + ' آیه'].filter(Boolean);
    if (s.name_en) subParts.push('<bdi dir="ltr">' + esc(s.name_en) + '</bdi>');
    const sub = subParts.join(' · ');
    const q = normalizeSearch([n, s.name_ar, s.name_fa, s.name_en].join(' '));
    return '<button type="button" class="srow" data-n="' + n + '" data-q="' + esc(q) + '"' + (n === S.surah ? ' aria-current="true"' : '') + '>' +
      '<span class="snum" aria-hidden="true"><svg viewBox="0 0 40 40"><use href="#rosette" xlink:href="#rosette"/></svg><b>' + faNum(n) + '</b></span>' +
      '<span class="sname"><strong>' + esc(surahTitle(n)) + '</strong><span>' + sub + '</span></span>' +
      '<span class="off-dot" aria-hidden="true" title="ذخیره‌شده برای استفادهٔ آفلاین">' + icon('i-check') + '</span>' +
      '<span class="sar" lang="ar">' + esc(s.name_ar || '') + '</span>' +
    '</button>';
  }).join('') + '<div class="empty-note" id="surahNoMatch" hidden>سوره‌ای با این مشخصات پیدا نشد.</div>';
  refreshSurahBadges();
}

/* نشان «ذخیره‌شده برای آفلاین» کنار سوره‌هایی که صوتشان کامل روی دستگاه است */
function refreshSurahBadges() {
  Array.prototype.forEach.call(dom.surahRows.querySelectorAll('.srow'), function (row) {
    const n = Number(row.getAttribute('data-n'));
    row.classList.toggle('is-saved', typeof offlineComplete === 'function' && offlineComplete(n));
  });
}

function filterSurahRows(text) {
  const q = normalizeSearch(text);
  let shown = 0;
  Array.prototype.forEach.call(dom.surahRows.querySelectorAll('.srow'), function (row) {
    const match = !q || row.getAttribute('data-q').indexOf(q) >= 0;
    row.hidden = !match;
    if (match) shown++;
  });
  const none = $('surahNoMatch');
  if (none) none.hidden = shown > 0;
}

function updateSheetCurrent() {
  Array.prototype.forEach.call(dom.surahRows.querySelectorAll('.srow'), function (row) {
    if (Number(row.getAttribute('data-n')) === S.surah) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
}

function prepareSurahSheet() {
  if (!S.surahs.length) {
    renderSurahRows();
    loadSurahList().then(function (list) {
      setSurahs(list);
      onSurahsLoaded();
    }, function (err) {
      dom.surahRows.innerHTML = '<div class="empty-note">فهرست سوره‌ها بارگذاری نشد.<br>' + esc(describeApiError(err)) +
        '<br><br><button type="button" class="btn" data-act="retry-surahs">تلاش دوباره</button></div>';
    });
  } else if (!dom.surahRows.querySelector('.srow')) {
    renderSurahRows();
  } else {
    refreshSurahBadges();
  }
  dom.surahSearch.value = '';
  filterSurahRows('');
  updateSheetCurrent();
  setTimeout(function () {
    const cur = dom.surahRows.querySelector('.srow[aria-current="true"]');
    if (cur && sheets.open === 'surahs') {
      try { cur.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    }
  }, 30);
}

/* =========================================================
   SETTINGS UI
========================================================= */
const TR_SAMPLE = 'به نام خداوند رحمتگر مهربان';

function syncSegment(id, value) {
  Array.prototype.forEach.call($(id).querySelectorAll('button'), function (b) {
    b.setAttribute('aria-checked', b.getAttribute('data-value') === value ? 'true' : 'false');
  });
}

function syncSettingsUI() {
  syncSegment('segTheme', settings.theme);
  syncSegment('segPalette', settings.palette);
  syncSegment('segAudio', settings.route);
  dom.sizeOut.textContent = faNum(settings.size);
  dom.sizeRange.value = String(settings.size);
  dom.sizePreview.textContent = BISMILLAH_FALLBACK;
  $('sizeUp').disabled = settings.size >= SIZE_MAX;
  $('sizeDown').disabled = settings.size <= SIZE_MIN;
  dom.trSizeOut.textContent = faNum(settings.trSize);
  dom.trSizeRange.value = String(settings.trSize);
  dom.trPreview.textContent = TR_SAMPLE;
  $('trSizeUp').disabled = settings.trSize >= TR_MAX;
  $('trSizeDown').disabled = settings.trSize <= TR_MIN;
}

/* =========================================================
   COPY
========================================================= */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

function ayahCopyText(a) {
  const lines = [a.text_ar];
  if (settings.translation && a.text_fa) lines.push(a.text_fa);
  lines.push('[' + surahTitle(S.surah) + '، آیه ' + faNum(a.ayah_number) + ']');
  return lines.join('\n');
}
