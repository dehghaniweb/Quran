'use strict';
/* =========================================================
   ACCOUNT + SYNC — «کد شخصی» و همگام‌سازی رنگ‌ها بین دستگاه‌ها

   - بدون ایمیل و رمز: برنامه یک کد تصادفی ۲۰ نویسه‌ای می‌سازد (۱۸ نویسهٔ تصادفی + ۲ نویسهٔ کنترل برای تشخیص اشتباه تایپی).
   - خودِ کد هرگز به سرور نمی‌رود؛ فقط SHA-256 آن («شناسه») فرستاده می‌شود. هر کس کد را داشته باشد همان رنگ‌ها را می‌بیند.
   - هر دستگاه هر چه تغییر داده باشد می‌فرستد و تغییراتِ تازه را می‌گیرد؛ در تعارض، تغییر جدیدتر برنده است.
   - همه‌چیز فقط با درخواست GET به گوگل‌اسکریپت (action=marks_sync) انجام می‌شود.
   - قطع اینترنت مشکلی نیست: رنگ‌ها روی دستگاه می‌مانند و بعداً خودکار فرستاده می‌شوند.
========================================================= */
const ACCT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';     // بدون I و L و O و U (شبیه ۱ و ۰ و V)
const ACCT_PAYLOAD = 18;
const MSYNC_OVERLAP = 120000;                                   // هر بار دو دقیقه عقب‌تر می‌خواند تا تغییراتِ دیررسیده جا نمانند
const MSYNC_CHUNK = 40;                                         // حداکثر رکوردی که در یک درخواست می‌رود
const MSYNC_PAGE = 400;
const MS_CODE = { red: 'r', orange: 'o', yellow: 'y', green: 'g', blue: 'b', purple: 'p', none: 'n' };
const MS_TIME_FLOOR = 1500000000001;                            // سرور زمان‌های قدیمی‌تر از این را نمی‌پذیرد (ساعت خراب دستگاه)
const MS_SKEW_MIN = 30000;                                      // اختلاف ساعتِ کمتر از ۳۰ ثانیه نادیده گرفته می‌شود

/* ---------- SHA-256 (همگام و مستقل از مرورگر) ---------- */
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function shaRotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function utf8Bytes(str) {
  const s = unescape(encodeURIComponent(String(str)));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function sha256Hex(msg) {
  const bytes = utf8Bytes(msg);
  const l = bytes.length;
  const total = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = l * 8;
  dv.setUint32(total - 4, bits >>> 0);
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = shaRotr(a, 7) ^ shaRotr(a, 18) ^ (a >>> 3);
      const s1 = shaRotr(b, 17) ^ shaRotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = shaRotr(e, 6) ^ shaRotr(e, 11) ^ shaRotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = shaRotr(a, 2) ^ shaRotr(a, 13) ^ shaRotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
}

/* ---------- کد شخصی ---------- */
function acctNormalize(text) {
  return String(text || '')
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
    .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/* دو نویسهٔ کنترل: اولی مجموع وزن‌دار (هر اشتباه یک‌نویسه‌ای را می‌گیرد)، دومی از روی SHA-256 (جابه‌جایی نویسه‌ها را هم می‌گیرد) */
function acctCheckChars(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += ACCT_ALPHABET.indexOf(payload.charAt(i)) * (2 * i + 1);
  const c1 = ACCT_ALPHABET.charAt(sum % 32);
  const c2 = ACCT_ALPHABET.charAt(parseInt(sha256Hex('qm1c|' + payload).slice(0, 2), 16) & 31);
  return c1 + c2;
}

function acctValid(code) {
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(code)) return false;
  return acctCheckChars(code.slice(0, ACCT_PAYLOAD)) === code.slice(ACCT_PAYLOAD);
}

function acctGenerate() {
  const bytes = new Uint8Array(ACCT_PAYLOAD);
  let strong = false;
  try {
    if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(bytes); strong = true; }
  } catch (e) { strong = false; }
  if (!strong) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let payload = '';
  for (let i = 0; i < bytes.length; i++) payload += ACCT_ALPHABET.charAt(bytes[i] & 31);   // ۲۵۶ بر ۳۲ بخش‌پذیر است؛ توزیع یکنواخت
  return payload + acctCheckChars(payload);
}

function acctFormat(code) {
  return String(code).replace(/(.{4})(?=.)/g, '$1-');
}

function acctOwnerOf(code) {
  return sha256Hex('qm1|' + code);
}

/* ---------- وضعیت حساب (روی همین دستگاه) ---------- */
const acct = { state: null, view: 'off', note: '', busy: false, confirm: null, pendingLogin: null };
const msync = { running: false, again: false, timer: null, fails: 0, status: 'idle', error: '', ctl: null, round: 0 };

function acctLoad() {
  const raw = store.get(KEYS.acct, null);
  acct.state = null;
  if (raw && raw.v === 1 && acctValid(String(raw.code || '')) && raw.owner === acctOwnerOf(raw.code)) {
    acct.state = { v: 1, code: raw.code, owner: raw.owner, cursor: Number(raw.cursor) || 0, lastOk: Number(raw.lastOk) || 0, skew: Number(raw.skew) || 0 };
  }
}

function acctSave() {
  if (acct.state) store.set(KEYS.acct, acct.state);
  else store.remove(KEYS.acct);
}

function acctActive() { return !!(acct.state && acct.state.owner); }

function agoText(ts) {
  if (!ts) return 'هنوز انجام نشده';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 45) return 'چند لحظه پیش';
  const min = Math.round(sec / 60);
  if (min < 60) return faNum(min) + ' دقیقه پیش';
  const hr = Math.round(min / 60);
  if (hr < 24) return faNum(hr) + ' ساعت پیش';
  return faNum(Math.round(hr / 24)) + ' روز پیش';
}

function msPendingCount() { return mkDirtyList().length; }

/* خلاصهٔ یک‌خطی برای نوار بالای گزارش رنگ‌ها */
function acctBarText() {
  if (!acctActive()) return 'رنگ‌ها فقط روی همین دستگاه ذخیره می‌شود. برای داشتن آن‌ها در دستگاه‌های دیگر، کد شخصی بسازید یا وارد شوید.';
  if (msync.status === 'running') return 'متصل به حساب شخصی · در حال همگام‌سازی…';
  if (msync.status === 'error') return 'متصل به حساب شخصی · همگام‌سازی انجام نشد (بعداً دوباره امتحان می‌شود)';
  if (msync.status === 'offline') return 'متصل به حساب شخصی · اینترنت قطع است؛ بعداً خودکار همگام می‌شود';
  const pending = msPendingCount();
  return 'متصل به حساب شخصی · همگام‌سازی: ' + agoText(acct.state.lastOk) + (pending ? ' · ' + faNum(pending) + ' مورد در انتظار ارسال' : '');
}

function acctStatusText() {
  const lines = ['به حساب شخصی وصل هستید؛ رنگ‌هایتان در دستگاه‌های دیگر با همین کد دیده می‌شود.'];
  if (msync.status === 'running') lines.push('در حال همگام‌سازی…');
  else if (msync.status === 'error') lines.push('همگام‌سازی انجام نشد: ' + msync.error + ' رنگ‌ها روی این دستگاه سالم است و بعداً دوباره تلاش می‌شود.');
  else if (msync.status === 'offline') lines.push('اینترنت قطع است؛ بعد از اتصال خودکار همگام می‌شود.');
  else lines.push('آخرین همگام‌سازی: ' + agoText(acct.state.lastOk) + '.');
  const pending = msPendingCount();
  if (pending) lines.push(faNum(pending) + ' مورد هنوز به سرور نرسیده است.');
  return lines.join('\n');
}

function updateAcctUI() {
  if (sheets.open === 'account') renderAccountSheet();
  else if (sheets.open === 'marks' && typeof acctBarText === 'function' && $('acctBarText')) $('acctBarText').textContent = acctBarText();
}

/* =========================================================
   همگام‌سازی
========================================================= */
function msErrorText(err) {
  const m = String(err && err.message || '');
  if (/marks_limit/.test(m)) return 'سقف تعداد رنگ‌های این کد پر شده است.';
  if (/Unknown action/i.test(m)) return 'نسخهٔ گوگل اسکریپت قدیمی است؛ نسخهٔ جدید Code.gs باید Deploy شود.';
  if (/marks_not_ready/.test(m)) return 'جدول رنگ‌ها در Supabase هنوز ساخته نشده است.';
  if (err && err.kind === 'server') return m || 'خطای سرور.';
  return describeApiError(err);
}

function msEncode(list) {
  return list.map(function (e) { return e.s + '.' + e.a + '.' + MS_CODE[e.c] + '.' + Math.max(e.t, MS_TIME_FLOOR).toString(36); }).join(',');
}

/* ساعت «درست» برای مهر زمانیِ تغییرها: ساعت دستگاه + اختلافی که از سرور یاد گرفته‌ایم (اگر ساعت گوشی غلط باشد، تغییرها در تعارض نمی‌بازند) */
function msNow() {
  return Date.now() + ((acct.state && acct.state.skew) || 0);
}

function msLearnSkew(resp, t0, t1) {
  const srv = Number(resp && resp.now);
  if (!(srv > MS_TIME_FLOOR) || !acctActive()) return;
  const est = srv - Math.round((t0 + t1) / 2);
  const skew = Math.abs(est) < MS_SKEW_MIN ? 0 : est;
  if (skew !== (acct.state.skew || 0)) { acct.state.skew = skew; acctSave(); }
}

function msApplyRows(rows) {
  if (!Array.isArray(rows)) return false;
  let changed = false;
  rows.forEach(function (r) {
    if (!Array.isArray(r) || r.length < 4) return;
    const s = Number(r[0]);
    const a = Number(r[1]);
    const c = String(r[2]);
    const t = Number(r[3]);
    if (!(s >= 1 && s <= 114 && a >= 1 && a <= 286 && t > 0)) return;
    if (c !== 'none' && !MK_BY_ID[c]) return;
    if (mkMergeRemote(s, a, c, t)) changed = true;
  });
  if (changed) { mkSave(); mkChanged('remote'); }
  return changed;
}

function msCall(owner, extra, signal) {
  const params = { owner: owner, limit: MSYNC_PAGE };
  Object.keys(extra || {}).forEach(function (k) { params[k] = extra[k]; });
  return apiGet('marks_sync', params, { timeout: 30000, retries: 1, signal: signal || undefined });
}

/* یک دور کامل: اول هر چه فرستادنی است (تکه‌تکه)، بعد گرفتنِ همهٔ تغییرات تازهٔ سرور */
async function msyncRound(signal) {
  const st = acct.state;
  const owner = st.owner;
  // اگر وسط کار از حساب خارج شده باشیم، پاسخ‌های رسیده نباید روی رنگ‌های دستگاه اعمال شود
  const mine = function () { return acctActive() && acct.state.owner === owner; };
  const since0 = Math.max(0, Number(st.cursor || 0) - MSYNC_OVERLAP);
  const dirty = mkDirtyList();
  const chunks = [];
  for (let i = 0; i < dirty.length; i += MSYNC_CHUNK) chunks.push(dirty.slice(i, i + MSYNC_CHUNK));
  const total = Math.max(chunks.length, 1);
  let resp = null;
  for (let i = 0; i < total; i++) {
    if (!mine()) throw apiError('aborted', 'aborted');
    const chunk = chunks[i] || [];
    const last = i === total - 1;
    const extra = { since: since0 };
    if (chunk.length) extra.push = msEncode(chunk);
    if (!last) extra.nopull = '1';
    const t0 = Date.now();
    resp = await msCall(owner, extra, signal);
    if (!mine()) throw apiError('aborted', 'aborted');
    msLearnSkew(resp, t0, Date.now());
    mkMarkPushed(chunk, Number(resp.now));
    if (last) msApplyRows(resp.rows);
  }
  let pages = 0;
  while (resp && resp.more && pages++ < 40) {
    const rows = Array.isArray(resp.rows) ? resp.rows : [];
    const lastSrv = rows.length ? Number(rows[rows.length - 1][4]) : 0;
    if (!(lastSrv > 0)) break;
    if (!mine()) throw apiError('aborted', 'aborted');
    resp = await msCall(owner, { since: lastSrv }, signal);
    if (!mine()) throw apiError('aborted', 'aborted');
    msApplyRows(resp.rows);
  }
  if (mine()) {
    st.cursor = Number(resp && resp.now) || Date.now();
    st.lastOk = Date.now();
    acctSave();
  }
  return resp;
}

async function msyncNow(manual) {
  if (!acctActive() || !API_READY) return false;
  if (msync.running) { msync.again = true; return false; }
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    msync.status = 'offline';
    updateAcctUI();
    if (manual) showToast('اینترنت قطع است؛ بعد از اتصال خودکار همگام می‌شود.');
    return false;
  }
  clearTimeout(msync.timer);
  const round = ++msync.round;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  msync.ctl = ctl;
  msync.running = true;
  msync.status = 'running';
  msync.error = '';
  updateAcctUI();
  let ok = false;
  let aborted = false;
  try {
    await msyncRound(ctl ? ctl.signal : undefined);
    ok = true;
    msync.fails = 0;
    msync.status = 'idle';
  } catch (err) {
    if (err && err.kind === 'aborted') {
      aborted = true;
    } else if (msync.round === round) {
      msync.fails++;
      msync.status = (typeof navigator.onLine === 'boolean' && !navigator.onLine) ? 'offline' : 'error';
      msync.error = msErrorText(err);
      if (msync.status === 'error') msyncSchedule(Math.min(300000, 5000 * Math.pow(2, msync.fails)));
    }
  }
  if (msync.round !== round) return ok;              // وسط کار از حساب خارج شده‌ایم (یا حساب عوض شده)؛ وضعیت تازه را دست نمی‌زنیم
  if (msync.ctl === ctl) msync.ctl = null;
  if (aborted) msync.status = 'idle';
  msync.running = false;
  updateAcctUI();
  if (msync.again) { msync.again = false; msyncSchedule(400); }
  else if (ok && msPendingCount() > 0) msyncSchedule(1000);       // در همین فاصله چیزی عوض شده بود
  if (manual) {
    if (ok) showToast('همگام‌سازی انجام شد.');
    else if (msync.status === 'error') showToast('همگام‌سازی انجام نشد: ' + msync.error, { ms: 5200 });
  }
  return ok;
}

function msyncSchedule(ms) {
  if (!acctActive()) return;
  clearTimeout(msync.timer);
  msync.timer = setTimeout(function () { msyncNow(false); }, ms);
}

/* اگر از آخرین همگام‌سازی کمی گذشته باشد */
function msyncMaybe() {
  if (!acctActive() || msync.running) return;
  if (Date.now() - Number(acct.state.lastOk || 0) > 30000 || msPendingCount() > 0) msyncSchedule(200);
}

/* =========================================================
   ساخت کد، ورود و خروج
========================================================= */
function acctSetState(code) {
  acct.state = { v: 1, code: code, owner: acctOwnerOf(code), cursor: 0, lastOk: 0, skew: 0 };
  acctSave();
  mkMarkAllDirty();                                  // هر رنگی که تا حالا روی این دستگاه بوده باید به حساب برود
  msync.status = 'idle';
  msync.error = '';
  msync.fails = 0;
}

function acctCreate() {
  if (acctActive()) return;
  if (!API_READY) { acct.note = 'اتصال به سرور تنظیم نشده است.'; renderAccountSheet(); return; }
  acctSetState(acctGenerate());
  acct.view = 'code';
  acct.note = '';
  renderAccountSheet();
  msyncSchedule(300);
  updateMarkBadge();
}

async function acctLogin() {
  if (acct.busy) return;
  const input = $('acctCodeInput');
  const code = acctNormalize(input.value);
  if (code.length !== 20) { acct.note = 'کد باید ۲۰ نویسه (حرف انگلیسی و عدد) باشد؛ نشانهٔ «-» اهمیتی ندارد.'; renderAccountSheet(); return; }
  if (!acctValid(code)) { acct.note = 'این کد درست نیست؛ یکی از نویسه‌ها را اشتباه وارد کرده‌اید. دوباره با دقت بخوانید.'; renderAccountSheet(); return; }
  if (!API_READY) { acct.note = 'اتصال به سرور تنظیم نشده است.'; renderAccountSheet(); return; }
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) { acct.note = 'برای ورود، اینترنت لازم است.'; renderAccountSheet(); return; }
  acct.busy = true;
  acct.note = 'در حال بررسی کد…';
  renderAccountSheet();
  let resp = null;
  try {
    resp = await msCall(acctOwnerOf(code), { since: 0 });
  } catch (err) {
    acct.busy = false;
    acct.note = 'ورود انجام نشد: ' + msErrorText(err);
    renderAccountSheet();
    return;
  }
  acct.busy = false;
  const count = Array.isArray(resp.rows) ? resp.rows.length : 0;
  if (count === 0) {
    acct.pendingLogin = code;
    acct.confirm = {
      kind: 'login-empty',
      text: 'برای این کد هنوز هیچ رنگی روی سرور ذخیره نشده است. اگر قبلاً در دستگاه دیگری رنگ داده‌اید، ابتدا همان دستگاه را باز کنید تا همگام شود، یا کد را دوباره بررسی کنید. با همین کد ادامه می‌دهید؟',
      yes: 'بله، با این کد ادامه بده',
      no: 'برگشت'
    };
    acct.note = '';
    renderAccountSheet();
    return;
  }
  acctFinishLogin(code);
}

function acctFinishLogin(code) {
  acct.pendingLogin = null;
  acct.confirm = null;
  acctSetState(code);
  acct.view = 'on';
  acct.note = '';
  $('acctCodeInput').value = '';
  renderAccountSheet();
  showToast('وارد شدید؛ رنگ‌ها در حال همگام‌سازی است.');
  msyncNow(false);
}

function acctAskLogout() {
  const pending = msPendingCount();
  acct.confirm = {
    kind: 'logout',
    text: 'از حساب این دستگاه خارج می‌شوید. رنگ‌های روی سرور و دستگاه‌های دیگر دست‌نخورده می‌مانند و هر وقت دوباره با کد وارد شوید برمی‌گردند.' +
      (pending ? '\n\nتوجه: ' + faNum(pending) + ' رنگ هنوز به سرور نرسیده است؛ اگر رنگ‌های این دستگاه را پاک کنید، این‌ها از بین می‌روند.' : ''),
    yes: 'خروج؛ رنگ‌ها روی این دستگاه بماند',
    alt: 'خروج و پاک‌کردن رنگ‌های این دستگاه',
    no: 'انصراف'
  };
  renderAccountSheet();
}

function acctLogout(clearLocal) {
  clearTimeout(msync.timer);
  msync.round++;                                     // هر همگام‌سازیِ نیمه‌کاره بی‌اثر می‌شود
  if (msync.ctl) { try { msync.ctl.abort(); } catch (e) { /* ignore */ } msync.ctl = null; }
  msync.again = false;
  acct.state = null;
  acctSave();
  acct.confirm = null;
  acct.view = 'off';
  acct.note = '';
  msync.status = 'idle';
  msync.error = '';
  msync.running = false;
  if (clearLocal) mkClearAll();
  else {                                             // دیگر به سرور نمی‌رود؛ نشانه‌های پاک‌شدن لازم نیست
    Object.keys(mk.data).forEach(function (k) {
      if (mk.data[k].c === 'none') delete mk.data[k];
      else mk.data[k].d = 0;
    });
    mkFlush();
  }
  renderAccountSheet();
  updateMarkBadge();
  showToast(clearLocal ? 'از حساب خارج شدید و رنگ‌های این دستگاه پاک شد.' : 'از حساب خارج شدید؛ رنگ‌ها روی این دستگاه ماند.');
}

function acctAskWipe() {
  acct.confirm = {
    kind: 'wipe',
    text: 'همهٔ رنگ‌های این کد از سرور پاک می‌شود و این دستگاه هم از حساب خارج می‌شود (رنگ‌های روی خودِ دستگاه می‌مانند). اگر دستگاه‌های دیگری با همین کد وصل‌اند، در آن‌ها هم از حساب خارج شوید. ادامه می‌دهید؟',
    yes: 'بله، از سرور پاک کن',
    no: 'انصراف'
  };
  renderAccountSheet();
}

async function acctWipe() {
  const owner = acct.state.owner;
  acct.confirm = null;
  acct.busy = true;
  acct.note = 'در حال پاک‌کردن از سرور…';
  renderAccountSheet();
  try {
    await apiGet('marks_delete', { owner: owner }, { timeout: 30000, retries: 1 });
  } catch (err) {
    acct.busy = false;
    acct.note = 'پاک‌کردن انجام نشد: ' + msErrorText(err);
    renderAccountSheet();
    return;
  }
  acct.busy = false;
  acctLogout(false);
  showToast('اطلاعات این کد از سرور پاک شد.');
}

/* =========================================================
   پنجرهٔ حساب
========================================================= */
function prepareAccountSheet() {
  acct.view = acctActive() ? 'on' : 'off';
  acct.confirm = null;
  acct.pendingLogin = null;
  acct.note = '';
  renderAccountSheet();
  msyncMaybe();
}

function renderAccountSheet() {
  if (!$('acctOff')) return;
  const active = acctActive();
  if (!active && acct.view !== 'off') acct.view = 'off';
  if (active && acct.view === 'off') acct.view = 'on';
  $('acctOff').hidden = acct.view !== 'off';
  $('acctOn').hidden = acct.view !== 'on';
  $('acctCode').hidden = acct.view !== 'code';
  const err = $('acctError');
  err.textContent = acct.note;
  err.hidden = !acct.note;
  $('acctLogin').disabled = acct.busy;
  $('acctCreate').disabled = acct.busy;
  if (acct.view === 'on' && active) {
    $('acctStatus').textContent = acctStatusText();
    $('acctSyncNow').disabled = msync.running || acct.busy;
    $('acctWipe').disabled = acct.busy;
  }
  if (acct.view === 'code' && active) $('acctCodeText').textContent = acctFormat(acct.state.code);
  const c = acct.confirm;
  $('acctConfirm').hidden = !c;
  if (c) {
    $('acctConfirmText').textContent = c.text;
    $('acctConfirmYes').textContent = c.yes;
    $('acctConfirmAlt').hidden = !c.alt;
    $('acctConfirmAlt').textContent = c.alt || '';
    $('acctConfirmNo').textContent = c.no;
  }
}

function bindAccount() {
  $('acctCreate').addEventListener('click', acctCreate);
  $('acctLogin').addEventListener('click', acctLogin);
  $('acctCodeInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); acctLogin(); }
  });
  $('acctCodeInput').addEventListener('input', function () {
    if (acct.note) { acct.note = ''; $('acctError').textContent = ''; $('acctError').hidden = true; }
  });
  $('acctShow').addEventListener('click', function () { acct.view = 'code'; acct.confirm = null; renderAccountSheet(); });
  $('acctCodeDone').addEventListener('click', function () { acct.view = acctActive() ? 'on' : 'off'; renderAccountSheet(); });
  $('acctCopyCode').addEventListener('click', function () {
    if (!acctActive()) return;
    copyText(acctFormat(acct.state.code)).then(function (ok) {
      showToast(ok ? 'کد شخصی کپی شد؛ همین حالا آن را جایی امن نگه دارید (مثلاً «Saved Messages» تلگرام).' : 'کپی انجام نشد؛ کد را از روی صفحه یادداشت کنید.', { ms: 5200 });
    });
  });
  $('acctSyncNow').addEventListener('click', function () { msyncNow(true); });
  $('acctLogout').addEventListener('click', acctAskLogout);
  $('acctWipe').addEventListener('click', acctAskWipe);
  $('acctConfirmNo').addEventListener('click', function () { acct.confirm = null; acct.pendingLogin = null; renderAccountSheet(); });
  $('acctConfirmAlt').addEventListener('click', function () {
    const c = acct.confirm;
    if (c && c.kind === 'logout') acctLogout(true);
  });
  $('acctConfirmYes').addEventListener('click', function () {
    const c = acct.confirm;
    if (!c) return;
    if (c.kind === 'login-empty' && acct.pendingLogin) acctFinishLogin(acct.pendingLogin);
    else if (c.kind === 'logout') acctLogout(false);
    else if (c.kind === 'wipe') acctWipe();
  });
  $('btnOpenAccount').addEventListener('click', function () { openSheet('account', $('btnOpenAccount')); });

  // تب دیگری در همین مرورگر وارد شد یا خارج شد
  window.addEventListener('storage', function (e) {
    if (e.key !== KEYS.acct) return;
    acctLoad();
    updateAcctUI();
    if (acctActive()) msyncSchedule(800);
    else clearTimeout(msync.timer);
  });
  window.addEventListener('online', function () { if (acctActive()) { msync.status = 'idle'; msyncSchedule(500); } });
  window.addEventListener('offline', function () { if (acctActive()) { msync.status = 'offline'; updateAcctUI(); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) msyncMaybe(); });
  setInterval(function () { if (!document.hidden) msyncMaybe(); }, 180000);
  if (acctActive()) msyncSchedule(1200);
}

acctLoad();
