'use strict';
/* =========================================================
   MARKS — رنگ‌دادن به آیه‌ها
   - هر آیه یکی از ۶ رنگ را می‌گیرد (قرمز، نارنجی، زرد، سبز، آبی، بنفش)؛ «سفید» یعنی بدون رنگ.
   - رنگ‌ها همان لحظه روی همین دستگاه (localStorage) ذخیره می‌شوند و بدون اینترنت هم کار می‌کنند.
   - اگر «کد شخصی» ساخته یا وارد شده باشد، همین داده‌ها بین دستگاه‌ها همگام می‌شود (app-7.js).
   - هر رکورد: { c: رنگ، یا 'none' = نشانهٔ پاک‌شدن برای همگام‌سازی، t: زمان آخرین تغییر (ms)، d: ۱ = هنوز به سرور نرفته }
========================================================= */
const MK_COLORS = [
  { id: 'red', fa: 'قرمز', code: 'r' },
  { id: 'orange', fa: 'نارنجی', code: 'o' },
  { id: 'yellow', fa: 'زرد', code: 'y' },
  { id: 'green', fa: 'سبز', code: 'g' },
  { id: 'blue', fa: 'آبی', code: 'b' },
  { id: 'purple', fa: 'بنفش', code: 'p' }
];
const MK_BY_ID = {};
MK_COLORS.forEach(function (c) { MK_BY_ID[c.id] = c; });
const MK_PAGE = 60;                       // تعداد ردیف‌هایی که در هر بار در گزارش نشان داده می‌شود

const mk = {
  data: {},                               // "سوره:آیه" ← { c, t, d }
  saveTimer: null,
  warned: false,
  filter: 'all',
  shown: MK_PAGE,
  target: null,                           // { s, a, back } آیه‌ای که پنجرهٔ رنگ برایش باز است
  token: 0
};

function mkName(id) { return MK_BY_ID[id] ? MK_BY_ID[id].fa : 'سفید'; }
function mkLabel(n, c) { return 'رنگ آیه ' + faNum(n) + (c ? ' (' + mkName(c) + ')' : ' (بدون رنگ)'); }
function mkKey(s, a) { return Number(s) + ':' + Number(a); }

/* =========================================================
   ذخیره و خواندن
========================================================= */
function mkLoad() {
  const raw = store.get(KEYS.marks, null);
  const out = {};
  if (raw && raw.v === 1 && raw.m && typeof raw.m === 'object') {
    Object.keys(raw.m).forEach(function (k) {
      const m = /^(\d{1,3}):(\d{1,3})$/.exec(k);
      const e = raw.m[k];
      if (!m || !Array.isArray(e)) return;
      const s = Number(m[1]);
      const a = Number(m[2]);
      if (!(s >= 1 && s <= 114 && a >= 1 && a <= 286)) return;
      const c = e[0] === 'none' ? 'none' : (MK_BY_ID[e[0]] ? e[0] : '');
      const t = Number(e[1]);
      if (!c || !(t > 0)) return;
      out[k] = { c: c, t: t, d: e[2] ? 1 : 0 };
    });
  }
  mk.data = out;
}

function mkFlush() {
  clearTimeout(mk.saveTimer);
  mk.saveTimer = null;
  const m = {};
  Object.keys(mk.data).forEach(function (k) {
    const e = mk.data[k];
    m[k] = e.d ? [e.c, e.t, 1] : [e.c, e.t];
  });
  if (!store.set(KEYS.marks, { v: 1, m: m }) && !mk.warned) {
    mk.warned = true;
    showToast('حافظهٔ مرورگر در دسترس نیست؛ رنگ‌ها فقط تا بستن صفحه می‌مانند.', { ms: 4200 });
  }
}

/* نوشتن با کمی تأخیر (چند تغییر پشت‌سرهم یک بار ذخیره می‌شود)؛ هنگام بستن صفحه فوراً نوشته می‌شود */
function mkSave() {
  clearTimeout(mk.saveTimer);
  mk.saveTimer = setTimeout(mkFlush, 250);
}

function mkGet(s, a) {
  const e = mk.data[mkKey(s, a)];
  return e && e.c !== 'none' ? e.c : '';
}

function mkCounts() {
  const c = { total: 0 };
  MK_COLORS.forEach(function (x) { c[x.id] = 0; });
  Object.keys(mk.data).forEach(function (k) {
    const e = mk.data[k];
    if (e.c !== 'none' && c[e.c] !== undefined) { c[e.c]++; c.total++; }
  });
  return c;
}

/* آیه‌های رنگی به ترتیب مصحف؛ filter: 'all' یا شناسهٔ رنگ */
function mkEntries(filter) {
  const out = [];
  Object.keys(mk.data).forEach(function (k) {
    const e = mk.data[k];
    if (e.c === 'none') return;
    if (filter && filter !== 'all' && e.c !== filter) return;
    const p = k.split(':');
    out.push({ s: Number(p[0]), a: Number(p[1]), c: e.c, t: e.t });
  });
  out.sort(function (x, y) { return (x.s - y.s) || (x.a - y.a); });
  return out;
}

/* true = تغییری ثبت شد. color خالی یا 'none' = برداشتن رنگ */
function mkSet(s, a, color) {
  const key = mkKey(s, a);
  const cur = mk.data[key];
  const next = MK_BY_ID[color] ? color : 'none';
  const before = cur ? cur.c : 'none';
  if (before === next) return false;
  const attached = typeof acctActive === 'function' && acctActive();
  if (next === 'none' && !attached) {
    delete mk.data[key];                                    // بدون حساب، نشانهٔ حذف لازم نیست
  } else {
    const nowT = typeof msNow === 'function' ? msNow() : Date.now();           // ساعت دستگاه با ساعت سرور هم‌تراز می‌شود (app-7.js)
    mk.data[key] = { c: next, t: Math.max(nowT, cur ? cur.t + 1 : 0), d: attached ? 1 : 0 };
  }
  mkSave();
  mkChanged('local');
  return true;
}

/* ردیف دریافتی از سرور؛ true = چیزی در این دستگاه عوض شد */
function mkMergeRemote(s, a, c, t) {
  const key = mkKey(s, a);
  const cur = mk.data[key];
  if (!cur) {
    if (c === 'none') return false;
    mk.data[key] = { c: c, t: t, d: 0 };
    return true;
  }
  if (t > cur.t) {
    if (c === 'none') delete mk.data[key];
    else mk.data[key] = { c: c, t: t, d: 0 };
    return true;
  }
  if (t === cur.t && cur.d && cur.c === c) {              // همان رکوردِ خودمان است که به سرور رسیده
    if (c === 'none') delete mk.data[key];
    else cur.d = 0;
  }
  return false;
}

/* رکوردهای رفته‌به‌سرور: اگر از آن زمان دوباره عوض نشده باشند «تمیز» می‌شوند.
   serverNow: ساعت سرور؛ سرور زمان‌های بیش از ۱۰ دقیقه در آینده را به «اکنون» برمی‌گرداند، پس همین‌جا هم همان را ثبت می‌کنیم */
function mkMarkPushed(list, serverNow) {
  list.forEach(function (it) {
    const key = mkKey(it.s, it.a);
    const e = mk.data[key];
    if (!e || e.t !== it.t) return;
    if (e.c === 'none') delete mk.data[key];
    else {
      e.d = 0;
      if (serverNow > 0 && e.t > serverNow + 600000) e.t = serverNow;
    }
  });
  mkSave();
}

/* رکوردهایی که هنوز به سرور نرفته‌اند (قدیمی‌ترین‌ها اول) */
function mkDirtyList() {
  const out = [];
  Object.keys(mk.data).forEach(function (k) {
    const e = mk.data[k];
    if (!e.d) return;
    const p = k.split(':');
    out.push({ s: Number(p[0]), a: Number(p[1]), c: e.c, t: e.t });
  });
  out.sort(function (x, y) { return x.t - y.t; });
  return out;
}

/* ورود به حساب: هر رنگی که از قبل روی این دستگاه هست باید به سرور برود */
function mkMarkAllDirty() {
  Object.keys(mk.data).forEach(function (k) { mk.data[k].d = 1; });
  mkSave();
}

function mkClearAll() {
  mk.data = {};
  mkFlush();
  mkChanged('remote');
}

/* =========================================================
   نمایش روی صفحه
========================================================= */
function updateMarkBadge() {
  if (!dom.markCount) return;
  const total = mkCounts().total;
  dom.markCount.hidden = total === 0;
  dom.markCount.textContent = faNum(total);
}

function refreshMarkViews() {
  S.els.forEach(function (el) {
    if (!el.classList.contains('ayah')) return;
    const n = el.getAttribute('data-n');
    const c = mkGet(S.surah, n);
    if (c) el.setAttribute('data-mark', c);
    else el.removeAttribute('data-mark');
    const btn = el.querySelector('.mkb');
    if (btn) {
      btn.classList.toggle('on', !!c);
      btn.setAttribute('aria-label', mkLabel(n, c));
    }
  });
}

/* source: 'local' (کاربر) یا 'remote' (همگام‌سازی/تب دیگر) */
function mkChanged(source) {
  refreshMarkViews();
  updateMarkBadge();
  if (sheets.open === 'marks') renderMarksSheet();
  if (source === 'local' && typeof msyncSchedule === 'function') msyncSchedule(1500);
}

/* =========================================================
   پنجرهٔ انتخاب رنگ برای یک آیه
========================================================= */
function openColorPicker(s, a, back, opener) {
  mk.target = { s: Number(s), a: Number(a), back: back || '' };
  openSheet('color', opener || document.activeElement);
}

function prepareColorSheet() {
  const t = mk.target;
  const box = $('swatches');
  if (!box) return;
  if (!t) { box.innerHTML = ''; return; }
  $('colorTarget').textContent = surahTitle(t.s) + '، آیهٔ ' + faNum(t.a);
  const cur = mkGet(t.s, t.a) || 'none';
  const all = [{ id: 'none', fa: 'سفید (بدون رنگ)' }].concat(MK_COLORS);
  box.innerHTML = all.map(function (c) {
    return '<button type="button" class="sw" role="radio" aria-checked="' + (c.id === cur ? 'true' : 'false') + '" data-c="' + c.id + '">' +
      '<i class="sw-dot" aria-hidden="true"></i><span>' + c.fa + '</span></button>';
  }).join('');
}

function onSwatchClick(e) {
  const b = e.target.closest('.sw');
  const t = mk.target;
  if (!b || !t) return;
  const c = b.getAttribute('data-c');
  const next = c === 'none' ? '' : c;
  const prev = mkGet(t.s, t.a);
  mk.target = null;
  const changed = mkSet(t.s, t.a, next);
  if (t.back) openSheet(t.back);
  else closeSheet();
  if (!changed) return;
  const label = surahTitle(t.s) + '، آیهٔ ' + faNum(t.a);
  showToast(next ? ('رنگ ' + mkName(next) + ' · ' + label) : ('رنگ برداشته شد · ' + label), {
    action: 'برگرداندن',
    fn: function () { mkSet(t.s, t.a, prev); }
  });
}

/* =========================================================
   گزارش: شمارش هر رنگ، فهرست آیه‌ها و کپی
========================================================= */
function mkChipHtml(id, label, count) {
  return '<button type="button" class="mk-chip" role="radio" aria-checked="' + (mk.filter === id ? 'true' : 'false') + '" data-c="' + id + '">' +
    '<i class="mk-chip-dot" aria-hidden="true"></i><span class="mk-chip-name">' + label + '</span><b>' + faNum(count) + '</b></button>';
}

function prepareMarksSheet() {
  mk.shown = MK_PAGE;
  renderMarksSheet();
  if (typeof msyncMaybe === 'function') msyncMaybe();
}

function renderMarksSheet() {
  const chips = $('mkChips');
  if (!chips) return;
  const counts = mkCounts();
  if (mk.filter !== 'all' && !MK_BY_ID[mk.filter]) mk.filter = 'all';

  if (typeof acctBarText === 'function') $('acctBarText').textContent = acctBarText();
  if (typeof acctApplyVisibility === 'function') acctApplyVisibility();

  let h = mkChipHtml('all', 'همه', counts.total);
  MK_COLORS.forEach(function (c) { h += mkChipHtml(c.id, c.fa, counts[c.id]); });
  chips.innerHTML = h;

  syncSegment('segCopy', settings.copyMode);
  const sel = mk.filter === 'all' ? counts.total : counts[mk.filter];
  const btn = $('mkCopy');
  btn.disabled = !sel;
  btn.textContent = !sel ? 'آیه‌ای برای کپی نیست'
    : (mk.filter === 'all' ? ('کپی همهٔ آیه‌های رنگی (' + faNum(sel) + ')') : ('کپی آیه‌های ' + mkName(mk.filter) + ' (' + faNum(sel) + ')'));

  renderMarksList();
}

function mkRowHtml(e, showName) {
  return '<div class="mrow" data-c="' + e.c + '" data-s="' + e.s + '" data-a="' + e.a + '">' +
    '<button type="button" class="go" data-act="go">' +
      '<strong>' + esc(surahTitle(e.s)) + '، آیهٔ ' + faNum(e.a) + (showName ? '<span class="mname"> · ' + mkName(e.c) + '</span>' : '') + '</strong>' +
      '<span class="snip" lang="ar" dir="rtl"></span><span class="snip-fa" lang="fa"></span>' +
    '</button>' +
    '<button type="button" class="mact" data-act="copy" aria-label="کپی این آیه">' + icon('i-copy') + '</button>' +
    '<button type="button" class="mact" data-act="color" aria-label="تغییر رنگ این آیه"><span class="mk-dot" aria-hidden="true"></span></button>' +
  '</div>';
}

function renderMarksList() {
  const box = $('mkList');
  const list = mkEntries(mk.filter);
  const token = ++mk.token;
  if (!list.length) {
    box.innerHTML = '<div class="empty-note">' + (mk.filter === 'all'
      ? 'هنوز آیه‌ای را رنگ نکرده‌اید.<br>در هر آیه، دکمهٔ دایره‌ای رنگ را لمس کنید و رنگ دلخواه را انتخاب کنید.'
      : ('آیه‌ای با رنگ «' + mkName(mk.filter) + '» ندارید.')) + '</div>';
    return;
  }
  const part = list.slice(0, mk.shown);
  const rest = list.length - part.length;
  box.innerHTML = part.map(function (e) { return mkRowHtml(e, mk.filter === 'all'); }).join('') +
    (rest > 0 ? '<button type="button" class="btn mk-more" id="mkMore">نمایش ' + faNum(Math.min(MK_PAGE, rest)) + ' مورد بعدی (' + faNum(rest) + ' مورد باقی است)</button>' : '');
  fillMarkSnippets(part, token);
}

/* خلاصهٔ متن هر ردیف (فقط از روی دستگاه؛ اگر سوره‌ای هنوز ذخیره نشده باشد و اینترنت باشد، گرفته می‌شود) */
function fillMarkSnippets(part, token) {
  const need = {};
  part.forEach(function (e) { need[e.s] = true; });
  Object.keys(need).forEach(function (sKey) {
    const s = Number(sKey);
    localSurahData(s).then(function (d) {
      if (d || !canPrefetch()) return d;
      return loadSurahData(s).then(function (x) { return x; }, function () { return null; });
    }).then(function (d) {
      if (!d || token !== mk.token || sheets.open !== 'marks') return;
      Array.prototype.forEach.call($('mkList').querySelectorAll('.mrow[data-s="' + s + '"]'), function (row) {
        const a = Number(row.getAttribute('data-a'));
        const ay = d.ayahs.find(function (x) { return Number(x.ayah_number) === a; });
        if (!ay) return;
        row.querySelector('.snip').textContent = fixMarks(ay.text_ar);
        row.querySelector('.snip-fa').textContent = ay.text_fa || '';
      });
    });
  });
}

/* ---------- کپی ---------- */
async function mkGatherData(surahs) {
  const out = {};
  for (let i = 0; i < surahs.length; i++) {
    const s = surahs[i];
    let d = peekSurahData(s) || await localSurahData(s);
    if (!d && canPrefetch()) {
      try { d = await loadSurahData(s); } catch (e) { d = null; }
    }
    if (d) out[s] = d;
  }
  return out;
}

function mkAyahText(s, a, mode, d) {
  const ay = d.ayahs.find(function (x) { return Number(x.ayah_number) === Number(a); });
  if (!ay) return '';
  const lines = [];
  if (mode !== 'fa' || !ay.text_fa) lines.push(ay.text_ar);        // «فقط ترجمه» ولی ترجمه نیست: عربی بیاید تا خالی نماند
  if (mode !== 'ar' && ay.text_fa) lines.push(ay.text_fa);
  lines.push('[' + surahTitle(s) + '، آیه ' + faNum(a) + ']');
  return lines.join('\n');
}

/* { text, done, missing } برای رنگ مشخص یا همهٔ رنگ‌ها (با تیتر هر رنگ) */
async function mkBuildCopy(items, grouped) {
  const surahs = [];
  items.forEach(function (e) { if (surahs.indexOf(e.s) < 0) surahs.push(e.s); });
  const data = await mkGatherData(surahs);
  const mode = settings.copyMode;
  const groups = grouped ? MK_COLORS.map(function (c) { return c.id; }) : ['*'];
  const blocks = [];
  let done = 0;
  let missing = 0;
  groups.forEach(function (cid) {
    const sub = items.filter(function (e) { return cid === '*' || e.c === cid; });
    if (!sub.length) return;
    const parts = [];
    sub.forEach(function (e) {
      const t = data[e.s] ? mkAyahText(e.s, e.a, mode, data[e.s]) : '';
      if (t) { parts.push(t); done++; } else missing++;
    });
    if (!parts.length) return;
    blocks.push((cid === '*' ? '' : ('آیه‌های ' + mkName(cid) + ' (' + faNum(sub.length) + ')\n\n')) + parts.join('\n\n'));
  });
  return { text: blocks.join('\n\n———\n\n'), done: done, missing: missing };
}

async function mkCopyItems(items, grouped) {
  if (!items.length) { showToast('آیه‌ای برای کپی نیست.'); return; }
  const r = await mkBuildCopy(items, grouped);
  if (!r.text) { showToast('متن این آیه‌ها روی دستگاه نیست؛ برای گرفتن آن اینترنت لازم است.', { ms: 4200 }); return; }
  const ok = await copyText(r.text);
  if (ok) {
    showToast(faNum(r.done) + ' آیه کپی شد.' + (r.missing ? ' (متن ' + faNum(r.missing) + ' آیه در دسترس نبود)' : ''), { ms: 3200 });
  } else {
    showTextFallback(r.text);
  }
}

/* اگر مرورگر اجازهٔ کپی خودکار ندهد، متن در یک کادر نشان داده می‌شود تا دستی کپی شود */
function showTextFallback(text) {
  const ta = $('textBox');
  ta.value = text;
  const had = sheets.open;
  openSheet('text', had ? null : document.activeElement);
  setTimeout(function () { try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); } catch (e) { /* ignore */ } }, 60);
}

function onMarksListClick(e) {
  const more = e.target.closest('#mkMore');
  if (more) { mk.shown += MK_PAGE; renderMarksList(); return; }
  const btn = e.target.closest('button[data-act]');
  const row = e.target.closest('.mrow');
  if (!btn || !row) return;
  const s = Number(row.getAttribute('data-s'));
  const a = Number(row.getAttribute('data-a'));
  const act = btn.getAttribute('data-act');
  if (act === 'go') {
    closeSheet();
    goToSurah(s, { ayah: a, preferBismillah: false, scroll: 'center' });
  } else if (act === 'copy') {
    mkCopyItems([{ s: s, a: a, c: row.getAttribute('data-c') }], false);
  } else if (act === 'color') {
    openColorPicker(s, a, 'marks', btn);
  }
}

function bindMarks() {
  // هر بار که گزارش از دکمهٔ بالای صفحه باز می‌شود از «همه» شروع می‌کند (برگشت از پنجرهٔ رنگ، فیلتر را نگه می‌دارد)
  dom.btnMarks.addEventListener('click', function () { mk.filter = 'all'; openSheet('marks', dom.btnMarks); });
  $('swatches').addEventListener('click', onSwatchClick);

  $('mkChips').addEventListener('click', function (e) {
    const b = e.target.closest('.mk-chip');
    if (!b) return;
    mk.filter = b.getAttribute('data-c');
    mk.shown = MK_PAGE;
    renderMarksSheet();
  });
  $('segCopy').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    settings.copyMode = b.getAttribute('data-value');
    saveSettings();
    syncSegment('segCopy', settings.copyMode);
  });
  $('mkCopy').addEventListener('click', function () {
    const items = mkEntries(mk.filter);
    mkCopyItems(items, mk.filter === 'all');
  });
  $('mkList').addEventListener('click', onMarksListClick);
  $('acctBar').addEventListener('click', function () { openSheet('account', $('acctBar')); });
  // ورود صاحب برنامه: ۵ بار پشت‌سرهم لمس عنوان «رنگ‌های من»
  let taps = 0, tapT = 0;
  $('hMarks').addEventListener('click', function () {
    const now = Date.now();
    taps = now - tapT < 1500 ? taps + 1 : 1; tapT = now;
    if (taps >= 5) { taps = 0; openSheet('account', $('hMarks')); }
  });
  if (typeof acctApplyVisibility === 'function') acctApplyVisibility();
  $('textSelect').addEventListener('click', function () {
    const ta = $('textBox');
    try { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); } catch (e) { /* ignore */ }
    if (legacyCopy(ta.value)) showToast('کپی شد.');
  });

  // تب یا پنجرهٔ دیگری رنگی داده است
  window.addEventListener('storage', function (e) {
    if (e.key !== KEYS.marks) return;
    mkLoad();
    mkChanged('remote');
  });
  window.addEventListener('pagehide', function () { if (mk.saveTimer) mkFlush(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && mk.saveTimer) mkFlush(); });
}

mkLoad();
