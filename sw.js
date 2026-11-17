'use strict';
// Офлайн-запас. Працює лише з файлами цієї ж сторінки; на інші адреси не звертається.
// - бібліотека, значки й тестові коди: спершу збережена копія (вони не змінюються без зміни CACHE);
// - сама сторінка (html, js, css, маніфест): спершу мережа, повз HTTP-кеш браузера, але не довше 3 с —
//   далі збережена копія, щоб на слабкому звʼязку сторінка не висіла порожньою.
var CACHE = 'scan-proba-v2';
var SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'vendor/zxing-wasm/zxing-reader.iife.js',
  'vendor/zxing-wasm/zxing_reader.wasm',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png'
];
var STATIC = /\/(vendor|icons|test-codes)\//;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('scan-proba-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function put(req, res) {
  if (res && res.ok && res.type === 'basic') {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { return c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (STATIC.test(url.pathname)) {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { return put(req, res); });
    }));
    return;
  }

  // свіжа сторінка з мережі (без HTTP-кешу, щоб після оновлення не змішались версії файлів)
  var fresh = fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })).then(function (res) { return put(req, res); });
  e.respondWith(new Promise(function (resolve, reject) {
    var done = false;
    function fromCache() {
      return caches.match(req, { ignoreSearch: true }).then(function (r) {
        if (r) return r;
        if (req.mode === 'navigate') return caches.match('./');
        return null;
      });
    }
    var timer = setTimeout(function () {
      fromCache().then(function (r) { if (r && !done) { done = true; resolve(r); } });
    }, 3000);
    fresh.then(function (res) {
      clearTimeout(timer);
      if (!done) { done = true; resolve(res); }
    }, function () {
      clearTimeout(timer);
      fromCache().then(function (r) {
        if (done) return;
        done = true;
        if (r) resolve(r); else reject(new Error('немає мережі й копії'));
      });
    });
  }));
});
