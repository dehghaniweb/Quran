/* Service Worker — conservative: only same-origin static files. API/audio (cross-origin) are never touched. */
'use strict';
var VERSION = 'db546034';
var CACHE = 'quran-static-' + VERSION;
var FILES = ["./", "index.html", "style.css?v=81efe3d5", "app-1.js?v=485670ae", "app-2.js?v=8c684716", "app-3.js?v=2b7aa699", "app-4.js?v=362a2e44", "app-5.js?v=bca97806", "app-6.js?v=8f2ba903", "UthmanicHafs-v22.woff2", "Vazirmatn-var.woff2"];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FILES.map(function (u) {
      return fetch(u, { cache: 'reload' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('quran-static-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function timeout(ms) { return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('t')); }, ms); }); }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      Promise.race([fetch(req), timeout(2500)]).then(function (r) {
        if (r && r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put('index.html', cp); }); }
        return r;
      }).catch(function () {
        return caches.match('index.html').then(function (m) { return m || fetch(req); });
      })
    );
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: false }).then(function (m) {
    if (m) return m;
    return fetch(req).then(function (r) {
      if (r && r.ok && /\.(js|css|woff2|txt)$/.test(url.pathname)) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
      return r;
    });
  }));
});
