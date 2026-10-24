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

const ZERO_WIDTH_RE = new RegExp('[' + String.fromCharCode(0x200B) + '-' + String.fromCharCode(0x200F) + String.fromCharCode(0x202A) + '-' + String.fromCharCode(0x202E) + String.fromCharCode(0xFEFF) + ']', 'g');

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
    .replace(ZERO_WIDTH_RE, '')
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


/* ---------- آهنگ‌های صوتی (برای پخش بدون وقفه و ذخیره آفلاین) ---------- */

/* کلید یک آهنگ: «سوره:آیه» (بسم‌الله همیشه ۱:۱ است) */
function trackKey(t) {
  return (t.fa ? 'fa:' : '') + Number(t.surah) + ':' + Number(t.ayah);
}

/* اولین آهنگی که با شروع یک سوره پخش می‌شود */
function firstTrackOf(surah) {
  surah = Number(surah);
  return surahHasBismillah(surah)
    ? { surah: 1, ayah: 1, bismillah: true }
    : { surah: surah, ayah: 1, bismillah: false };
}

/* همهٔ آهنگ‌های یک سوره به ترتیب پخش: بسم‌الله (اگر دارد) + آیه‌ها */
function tracksForSurah(surah, count) {
  surah = Number(surah);
  const out = [];
  if (surahHasBismillah(surah)) out.push({ surah: 1, ayah: 1, bismillah: true });
  for (let a = 1; a <= Number(count); a++) out.push({ surah: surah, ayah: a, bismillah: false });
  return out;
}

function trackUrls(base, surah, count) {
  return tracksForSurah(surah, count).map(function (t) { return audioUrl(base, t.surah, t.ayah); });
}

/* «…/002/002255.mp3» ← {surah: 2, ayah: 255}  (یا null) */
function parseAudioUrl(url) {
  const m = /\/(\d{3})\/(\d{3})(\d{3})\.mp3(?:[?#].*)?$/.exec(String(url));
  if (!m || m[1] !== m[2]) return null;
  return { surah: Number(m[1]), ayah: Number(m[3]) };
}

/* حجم فایل به فارسی: «۳٫۲ مگابایت» */
function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return faNum(Math.round(n)) + ' بایت';
  if (n < 1048576) return faNum(Math.round(n / 1024)) + ' کیلوبایت';
  if (n < 1073741824) {
    const mb = n / 1048576;
    const t = mb >= 100 ? String(Math.round(mb)) : (Math.round(mb * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return faNum(t).replace('.', '٫') + ' مگابایت';
  }
  const gb = Math.round(n / 1073741824 * 100) / 100;
  return faNum(String(gb)).replace('.', '٫') + ' گیگابایت';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    faNum, pad3, clamp, formatTime, juzFromPage, revelationLabel, normalizeSearch,
    stripBismillah, findBismillahEnd, surahHasBismillah, buildItems, posForAyah, audioUrl,
    trackKey, firstTrackOf, tracksForSurah, parseAudioUrl, formatBytes, trackUrls,
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
  ar: SUPABASE_URL + '/storage/v1/object/public/quran-audio/arabic/',
  fa: SUPABASE_URL + '/storage/v1/object/public/quran-audio/persian/'
};

const API_READY = /^https?:\/\//i.test(API_URL) && API_URL.indexOf('PUT_YOUR') === -1;

/* بسم‌الله به املای عثمانی؛ فقط وقتی سرور متنی نفرستاده باشد استفاده می‌شود */
const BISMILLAH_FALLBACK = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';

const KEYS = {
  bookmark: 'quran_last_position_v1',
  reminders: 'quran_ayah_reminders_v1',
  settings: 'quran_settings_v2',
  cachePrefix: 'quran_cache_v3:',
  oldCachePrefix: 'quran_cache_v2:',
  relay: 'quran_audio_relay_v1'
};

const CACHE_VERSION = 3;
const STALE_MS = 7 * 24 * 3600 * 1000;        // متن قرآن تقریباً هیچ‌وقت عوض نمی‌شود؛ بعد از یک هفته در پس‌زمینه تازه می‌شود
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

/* =========================================================
   SETTINGS
========================================================= */
const SETTINGS_VERSION = 3;

const SETTING_DEFAULTS = {
  v: SETTINGS_VERSION,
  theme: 'auto',        // auto | light | dark
  palette: 'meadow',    // meadow | lapis | emerald
  size: 34,             // اندازه متن عربی (px)
  trSize: 17,           // اندازه ترجمه (px)
  translation: false,   // نمایش ترجمه فارسی زیر آیه‌ها
  faAudio: false,       // پخش صوت ترجمهٔ فارسی بعد از هر آیه
  route: 'auto',        // auto | direct | relay  (مسیر دریافت صوت)
  minPlayer: false
};

const SIZE_MIN = 24;
const SIZE_MAX = 72;
const TR_MIN = 13;
const TR_MAX = 30;

const settings = (function () {
  const saved = store.get(KEYS.settings, {});
  const s = Object.assign({}, SETTING_DEFAULTS);
  if (saved && typeof saved === 'object') {
    if (['auto', 'light', 'dark'].indexOf(saved.theme) >= 0) s.theme = saved.theme;
    if (['meadow', 'lapis', 'emerald'].indexOf(saved.palette) >= 0) s.palette = saved.palette;
    if (['auto', 'direct', 'relay'].indexOf(saved.route) >= 0) s.route = saved.route;
    s.minPlayer = !!saved.minPlayer;
    s.faAudio = !!saved.faAudio;
    if (saved.v === SETTINGS_VERSION) {
      if (typeof saved.size === 'number' && saved.size >= SIZE_MIN && saved.size <= SIZE_MAX) s.size = Math.round(saved.size);
      if (typeof saved.trSize === 'number' && saved.trSize >= TR_MIN && saved.trSize <= TR_MAX) s.trSize = Math.round(saved.trSize);
      s.translation = !!saved.translation;
    } else {
      // تنظیمات نسخهٔ قبلی: فونت عوض شده و اندازه از نو شروع می‌شود؛ «حالت نمایش» به کلید ترجمه تبدیل می‌شود
      s.translation = saved.mode === 'translation' || saved.mode === 'both';
    }
  }
  return s;
})();

function saveSettings() {
  store.set(KEYS.settings, settings);
}
