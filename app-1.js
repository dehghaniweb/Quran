'use strict';
/* =========================================================
   LIB — توابع خالص (بدون DOM)؛ در Node هم تست می‌شوند
========================================================= */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function faNum(value) {
  return String(value).replace(/\d/g, d => FA_DIGITS[Number(d)]);
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return faNum('0:00');
  const m = Math.floor(seconds / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return faNum(`${m}:${s}`);
}

/* مصحف مدینه: جزء ۱ = صفحه ۱ تا ۲۱، بعد هر جزء ۲۰ صفحه، جزء ۳۰ = صفحه ۵۸۲ تا ۶۰۴ */
function juzFromPage(page) {
  page = Number(page);
  if (!page || page < 1) return null;
  if (page <= 21) return 1;
  return Math.min(30, Math.floor((page - 2) / 20) + 1);
}

function revelationLabel(type) {
  const t = String(type || '').toLowerCase();
  if (/mecc|makk|mak|مک/.test(t)) return 'مکی';
  if (/medin|madan|mad|مد/.test(t)) return 'مدنی';
  return '';
}

/* ---------- جستجو: یکسان‌سازی املای فارسی/عربی و ارقام ---------- */
function normalizeSearch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
    .replace(/[يىی]/g, 'ی')
    .replace(/[كک]/g, 'ک')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ی')
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/[-_'’‘`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- جداسازی بسم‌الله (همان الگوریتم Code.gs؛ مستقل از املا و اعراب) ---------- */
const BISMILLAH_LETTERS = [
  'بسماللهالرحمنالرحيم',
  'بسماللهالرحمانالرحيم'
];

function isIgnorable(c) {
  return (c >= 0x09 && c <= 0x0D) || c === 0x20 || c === 0xA0 || c === 0x061C ||
    (c >= 0x2000 && c <= 0x200F) || c === 0x2028 || c === 0x2029 ||
    (c >= 0x202A && c <= 0x202F) || c === 0x205F || (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) || c === 0x3000 || c === 0xFEFF || c === 0x1680;
}

function isMark(c) {
  return (c >= 0x0610 && c <= 0x061A) || (c >= 0x064B && c <= 0x065F) || c === 0x0670 ||
    (c >= 0x06D6 && c <= 0x06DC) || (c >= 0x06DF && c <= 0x06E4) ||
    c === 0x06E7 || c === 0x06E8 || (c >= 0x06EA && c <= 0x06ED) ||
    c === 0x0640 || (c >= 0x08D3 && c <= 0x08E1) || (c >= 0x08E3 && c <= 0x08FF);
}

function normLetter(c) {
  switch (c) {
    case 0x0671: case 0x0622: case 0x0623: case 0x0625: case 0x0672: case 0x0673: case 0x0675:
      return 0x0627;
    case 0x0649: case 0x06CC: case 0x064A:
      return 0x064A;
    case 0x06A9: case 0x0643:
      return 0x0643;
    case 0x06C1: case 0x06BE: case 0x0647:
      return 0x0647;
    default:
      return c;
  }
}

function findBismillahEnd(s) {
  const n = s.length;
  let start = 0;
  while (start < n && isIgnorable(s.charCodeAt(start))) start++;
  if (start < n && s.charCodeAt(start) === 0xFDFD) return start + 1;

  for (const target of BISMILLAH_LETTERS) {
    let k = 0;
    let j = start;
    while (k < target.length && j < n) {
      const c = s.charCodeAt(j);
      if (isIgnorable(c) || isMark(c)) { j++; continue; }
      if (normLetter(c) !== target.charCodeAt(k)) break;
      k++; j++;
    }
    if (k === target.length) {
      while (j < n && isMark(s.charCodeAt(j))) j++;
      return j;
    }
  }
  return -1;
}

/* {bismillah, rest}. اگر متن بسم‌الله نداشته باشد (یا فقط بسم‌الله باشد) دست‌نخورده برمی‌گردد. */
function stripBismillah(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const end = findBismillahEnd(s);
  if (end < 0) return { bismillah: '', rest: s };
  let j = end;
  while (j < s.length && isIgnorable(s.charCodeAt(j))) j++;
  const rest = s.slice(j);
  if (!rest) return { bismillah: '', rest: s };
  let a = 0;
  const head = s.slice(0, end);
  while (a < head.length && isIgnorable(head.charCodeAt(a))) a++;
  return { bismillah: head.slice(a), rest };
}

/* بسم‌الله ندارد: سوره ۱ (آیه اول خودش بسم‌الله است) و سوره ۹ */
function surahHasBismillah(surah) {
  surah = Number(surah);
  return surah !== 1 && surah !== 9;
}

/* فهرست پخش یک سوره: بسم‌الله (اگر دارد) آیتم اول است، بعد آیه‌ها */
function buildItems(surah, ayahs) {
  const items = [];
  if (surahHasBismillah(surah)) items.push({ kind: 'bismillah' });
  for (const ayah of ayahs) items.push({ kind: 'ayah', ayah });
  return items;
}

/* اندیس آیتم برای شماره آیه؛ آیه ۱ در سوره‌های دارای بسم‌الله → خودِ بسم‌الله */
function posForAyah(items, ayahNumber, preferBismillah) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'ayah' && Number(it.ayah.ayah_number) === Number(ayahNumber)) {
      if (preferBismillah && Number(ayahNumber) === 1 && i > 0 && items[i - 1].kind === 'bismillah') return i - 1;
      return i;
    }
  }
  return 0;
}

/* آدرس صوت یک آیه (سوره ۱ آیه ۱ = بسم‌الله) */
function audioUrl(base, surah, ayah) {
  return `${base}${pad3(surah)}/${pad3(surah)}${pad3(ayah)}.mp3`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    faNum, pad3, clamp, formatTime, juzFromPage, revelationLabel, normalizeSearch,
    stripBismillah, findBismillahEnd, surahHasBismillah, buildItems, posForAyah, audioUrl,
  };
}


/* =========================================================
   CONFIG — فقط همین بخش را در صورت نیاز ویرایش کنید
========================================================= */

// آدرس وب‌اپ Google Apps Script (آدرسی که به /exec ختم می‌شود)
const API_URL = 'https://script.google.com/macros/s/AKfycbxFcsdW0PN74Efzdro_6zh3Z-YR6lJck2EXE92PIb9UkJXkCymIEk0EgtoMChv4zGQv0g/exec';

// آدرس پروژه Supabase؛ فقط برای فایل‌های صوتیِ عمومی (هیچ کلیدی اینجا نیست)
const SUPABASE_URL = 'https://wiulmslaensqnwlcjxtp.supabase.co';

// منبع صوت. برای مرحله بعد (صوت ترجمه فارسی) یک ورودی دیگر مثل fa اینجا اضافه می‌شود.
const AUDIO_BASES = {
  ar: SUPABASE_URL + '/storage/v1/object/public/quran-audio/arabic/'
};

const API_READY = /^https?:\/\//i.test(API_URL) && API_URL.indexOf('PUT_YOUR') === -1;

/* بسم‌الله به املای عثمانی؛ فقط وقتی سرور متنی نفرستاده باشد استفاده می‌شود */
const BISMILLAH_FALLBACK = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';

const KEYS = {
  bookmark: 'quran_last_position_v1',
  reminders: 'quran_ayah_reminders_v1',
  settings: 'quran_settings_v2',
  cachePrefix: 'quran_cache_v2:',
  relay: 'quran_audio_relay_v1'
};

const CACHE_VERSION = 2;
const CACHE_TTL = 24 * 3600 * 1000;
const RELAY_PREF_TTL = 24 * 3600 * 1000;

function noop() {}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* =========================================================
   STORAGE — همه‌جا try/catch (حالت خصوصی مرورگر و پر بودن حافظه خطا می‌دهند)
========================================================= */
const store = {
  get: function (key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set: function (key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
  remove: function (key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
};

function storageKeys(prefix) {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) out.push(k);
    }
  } catch (e) { /* ignore */ }
  return out;
}

/* کش سوره‌ها روی دستگاه */
function cacheRead(name, maxAge) {
  const entry = store.get(KEYS.cachePrefix + name, null);
  if (!entry || entry.v !== CACHE_VERSION || !entry.data) return null;
  return { data: entry.data, fresh: (Date.now() - Number(entry.at || 0)) < maxAge };
}

function cacheWrite(name, data) {
  const entry = { v: CACHE_VERSION, at: Date.now(), data: data };
  if (store.set(KEYS.cachePrefix + name, entry)) return;
  // حافظه پر است: سوره‌های ذخیره‌شده قبلی را پاک کن و یک بار دیگر امتحان کن
  storageKeys(KEYS.cachePrefix + 'surah:').forEach(store.remove);
  store.set(KEYS.cachePrefix + name, entry);
}

function cacheClearAll() {
  storageKeys(KEYS.cachePrefix).forEach(store.remove);
}

/* =========================================================
   SETTINGS
========================================================= */
const SETTING_DEFAULTS = {
  theme: 'auto',        // auto | light | dark
  palette: 'meadow',    // meadow | lapis | emerald
  size: 30,             // اندازه متن عربی (px)
  route: 'auto',        // auto | direct | relay  (مسیر دریافت صوت)
  mode: 'arabic',       // arabic | translation | both
  minPlayer: false
};

const SIZE_MIN = 22;
const SIZE_MAX = 52;

const settings = (function () {
  const saved = store.get(KEYS.settings, {});
  const s = Object.assign({}, SETTING_DEFAULTS);
  if (saved && typeof saved === 'object') {
    if (['auto', 'light', 'dark'].indexOf(saved.theme) >= 0) s.theme = saved.theme;
    if (['meadow', 'lapis', 'emerald'].indexOf(saved.palette) >= 0) s.palette = saved.palette;
    if (typeof saved.size === 'number' && saved.size >= SIZE_MIN && saved.size <= SIZE_MAX) s.size = Math.round(saved.size);
    if (['auto', 'direct', 'relay'].indexOf(saved.route) >= 0) s.route = saved.route;
    if (['arabic', 'translation', 'both'].indexOf(saved.mode) >= 0) s.mode = saved.mode;
    s.minPlayer = !!saved.minPlayer;
  }
  return s;
})();

function saveSettings() {
  store.set(KEYS.settings, settings);
}

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
    default: return err.message || 'خطای ناشناخته';
  }
}

async function apiGet(action, params, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeout || 25000;
  const retries = opts.retries === undefined ? 1 : opts.retries;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    try {
      // درخواست ساده (بدون هدر سفارشی) تا مرورگر preflight نفرستد
      const res = await fetch(apiUrl(action, params), ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) throw apiError('http', 'HTTP ' + res.status, res.status);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { throw apiError('format', 'invalid json'); }
      if (!json || json.ok === false) throw apiError('server', (json && json.error) ? String(json.error) : 'خطای ناشناخته از سرور');
      clearTimeout(timer);
      return json;
    } catch (err) {
      clearTimeout(timer);
      if (err && err.kind) lastErr = err;
      else if (err && err.name === 'AbortError') lastErr = apiError('timeout', 'timeout');
      else lastErr = apiError('network', String(err && err.message || err));
      if (attempt < retries && lastErr.retryable) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/* =========================================================
   DATA — فهرست سوره‌ها و آیه‌ها (حافظه + کش دستگاه + شبکه)
========================================================= */
const mem = { surahs: null, data: new Map(), inflight: new Map(), listInflight: null };

function validSurahList(list) {
  return Array.isArray(list) && list.length > 0 && list.every(function (s) { return s && Number(s.number) >= 1; });
}

function loadSurahList() {
  if (mem.surahs) return Promise.resolve(mem.surahs);
  if (mem.listInflight) return mem.listInflight;

  mem.listInflight = (async function () {
    const cached = cacheRead('surahs', CACHE_TTL);
    if (cached && cached.fresh && validSurahList(cached.data)) {
      mem.surahs = cached.data;
      return mem.surahs;
    }
    try {
      const json = await apiGet('surahs');
      if (!validSurahList(json.surahs)) throw apiError('server', 'فهرست سوره‌ها نامعتبر است');
      cacheWrite('surahs', json.surahs);
      mem.surahs = json.surahs;
      return mem.surahs;
    } catch (err) {
      if (cached && validSurahList(cached.data)) { mem.surahs = cached.data; return mem.surahs; }
      throw err;
    }
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
    const cached = cacheRead('surah:' + num, CACHE_TTL);
    if (cached && cached.fresh) {
      try {
        const d = prepareSurahData(num, cached.data);
        mem.data.set(num, d);
        return d;
      } catch (e) { /* کش خراب است؛ از شبکه می‌گیریم */ }
    }
    try {
      const json = await apiGet('ayahs', { surah: num });
      const d = prepareSurahData(num, json);
      cacheWrite('surah:' + num, {
        surah: json.surah, total_ayahs: json.total_ayahs, has_bismillah: json.has_bismillah,
        bismillah: json.bismillah, ayahs: json.ayahs
      });
      mem.data.set(num, d);
      return d;
    } catch (err) {
      if (cached) {
        try {
          const d = prepareSurahData(num, cached.data);
          mem.data.set(num, d);
          return d;
        } catch (e) { /* ignore */ }
      }
      throw err;
    }
  })();

  mem.inflight.set(num, p);
  const clear = function () { mem.inflight.delete(num); };
  p.then(clear, clear);
  return p;
}

/* فقط از حافظه/کش (همگام)، برای نمایش خلاصه آیه در فهرست یادآوری‌ها */
function peekSurahData(num) {
  if (mem.data.has(num)) return mem.data.get(num);
  const cached = cacheRead('surah:' + num, Infinity);
  if (cached) {
    try {
      const d = prepareSurahData(num, cached.data);
      mem.data.set(num, d);
      return d;
    } catch (e) { /* ignore */ }
  }
  return null;
}

/* =========================================================
   نام سوره‌ها
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
  retryFn: null,
  mode: settings.mode
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

