'use strict';
// Офлайн-запас: спершу мережа, а без мережі — збережена копія.
// Працює лише з файлами цієї ж сторінки; на інші адреси не звертається.
var CACHE = 'scan-proba-v1';
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

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('scan-proba-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) {
      if (r) return r;
      if (req.mode === 'navigate') return caches.match('./');
      return Response.error();
    });
  }));
});
