'use strict';
// Офлайн-запас. Працює лише з файлами цієї ж сторінки; на інші адреси не звертається.
// - сама сторінка (перехід на неї): спершу мережа, але не довше 3 с — далі збережена копія,
//   щоб на слабкому звʼязку сторінка не висіла порожньою;
// - файли з номером версії в адресі (app.js?v=1, style.css?v=1), бібліотека, значки, тестові коди:
//   спершу збережена копія. Нова версія сторінки посилається на нові адреси (?v=2), тож стара сторінка
//   завжди отримує свої старі файли, а нова — нові: версії не змішуються.
// - сама сторінка лягає в копію ЛИШЕ під час установлення обробника, разом зі своїми файлами (SHELL).
//   Відповіді з мережі в копію не кладемо: інакше в копії могла б опинитись нова сторінка без своїх
//   файлів, і без мережі вона б не завантажилась. Нова версія = новий sw.js = новий повний набір.
var CACHE = 'scan-proba-v12';
var SHELL = [
  './',
  'style.css?v=10',
  'app.js?v=10',
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
  if (res && res.ok && res.type === 'basic' && !res.redirected) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { return c.put(req, copy); });
  }
  return res;
}

// мережа з запасом: якщо мережа не відповіла за ms — копія (якщо є); якщо мережа впала — копія або помилка
// Мережу питаємо повз HTTP-кеш браузера (GitHub Pages дозволяє тримати сторінку 10 хв), щоб після
// оновлення з іконки відкривалась свіжа версія. Переадресацію не розгортаємо — віддаємо браузерові як є.
// Відповідь мережі в копію не кладемо (див. угорі).
function networkFirst(req, fallbackKey, ms) {
  var net = new Request(req.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' });
  var fresh = fetch(net);
  function fromCache() {
    return caches.match(req, { ignoreSearch: true }).then(function (r) {
      return r || (fallbackKey ? caches.match(fallbackKey) : null);
    }).catch(function () { return null; });
  }
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      fromCache().then(function (r) { if (r && !done) { done = true; resolve(r); } });
    }, ms);
    fresh.then(function (res) {
      clearTimeout(timer);
      if (!done) { done = true; resolve(res); }
    }, function (err) {
      clearTimeout(timer);
      fromCache().then(function (r) {
        if (done) return;
        done = true;
        if (r) resolve(r); else reject(err);
      });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // номер опублікованої версії — лише з мережі: збережений новіший номер без мережі давав би марне перезавантаження
  if (/\/version\.json$/.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, './', 3000));
    return;
  }
  if (STATIC.test(url.pathname) || /(^|&)v=/.test(url.search.slice(1))) {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { return put(req, res); });
    }));
    return;
  }
  e.respondWith(networkFirst(req, null, 3000));
});
