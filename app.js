'use strict';
(function () {
  // ---------------------------------------------------------------- сталі
  var APP_VERSION = '9'; // змінюючи app.js чи style.css, підняти і цей номер, і ?v= у index.html та sw.js, і число у version.json
  var LIB_NAME = 'zxing-wasm';
  var LIB_VERSION = '3.1.6';
  var KEY = 'scan-proba';
  var LS_MARK = KEY + '.mark';
  var LS_SESSION = KEY + '.session';
  var COOKIE = 'scan_proba_mark';
  var IDB_NAME = 'scan-proba';
  var IDB_STORE = 'kv';
  var BASE_PATH = location.pathname.replace(/[^/]*$/, '') || '/';
  var IS_HTTPS = location.protocol === 'https:';

  // Формати, які шукаємо: потрібні для проби + кілька поширених поруч.
  var LIB_FORMATS = ['Code128', 'ITF', 'Code39', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code93', 'QRCode', 'DataMatrix', 'PDF417', 'Aztec'];
  var NATIVE_FORMATS = ['code_128', 'itf', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_93', 'qr_code', 'data_matrix', 'pdf417', 'aztec'];
  var LIB_OPTIONS = {
    formats: LIB_FORMATS,
    tryHarder: true,
    tryRotate: true,
    tryInvert: false,
    tryDownscale: true,
    maxNumberOfSymbols: 4
  };
  var TYPE_LABEL = {
    Code128: 'Code 128', ITF: 'ITF', ITF14: 'ITF-14', Code39: 'Code 39', Code39Std: 'Code 39', Code39Ext: 'Code 39',
    EAN13: 'EAN-13', EAN8: 'EAN-8', UPCA: 'UPC-A', UPCE: 'UPC-E', EANUPC: 'EAN/UPC', Code93: 'Code 93',
    QRCode: 'QR', QRCodeModel1: 'QR', QRCodeModel2: 'QR', DataMatrix: 'Data Matrix',
    PDF417: 'PDF417', CompactPDF417: 'PDF417', Aztec: 'Aztec', AztecCode: 'Aztec',
    code_128: 'Code 128', itf: 'ITF', code_39: 'Code 39', ean_13: 'EAN-13', ean_8: 'EAN-8', upc_a: 'UPC-A',
    upc_e: 'UPC-E', code_93: 'Code 93', qr_code: 'QR', data_matrix: 'Data Matrix', pdf417: 'PDF417', aztec: 'Aztec'
  };
  var METHOD_LABEL = { lib: 'бібліотека', native: 'вбудоване', manual: 'вручну' };

  var UA = navigator.userAgent || '';
  var IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // вбудований браузер месенджера: Android WebView («; wv)»), iOS без «Safari/» (але не сторінка з іконки),
  // або відомі позначки програм
  var IN_APP = /; wv\)/.test(UA) || /FBAN|FBAV|Instagram|Line\/|Viber|MicroMessenger/i.test(UA) ||
    (IS_IOS && navigator.standalone !== true && !/Safari\//.test(UA));
  var photoReloadNote = false;

  // ---------------------------------------------------------------- дрібниці
  function $(id) { return document.getElementById(id); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtClock(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtBytes(b) {
    if (b < 1024) return b + ' Б';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' КБ';
    return (b / 1048576).toFixed(1).replace('.', ',') + ' МБ';
  }
  function visible(s) {
    // керівні символи (напр. роздільник GS у кодах GS1) показуємо явно
    return String(s).replace(/[\u0000-\u001f\u007f]/g, function (c) {
      return c === '\u001d' ? '⟨GS⟩' : '⟨' + c.charCodeAt(0).toString(16).padStart(2, '0') + '⟩';
    });
  }
  function typeLabel(f, family) { return TYPE_LABEL[f] || TYPE_LABEL[family] || String(f || '?'); }
  function withTimeout(p, ms, what) {
    return Promise.race([p, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error((what || 'дія') + ': немає відповіді ' + ms + ' мс')); }, ms);
    })]);
  }
  function openedFrom() {
    var mm = window.matchMedia ? function (q) { return window.matchMedia(q).matches; } : function () { return false; };
    var standalone = mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)') || navigator.standalone === true;
    return standalone ? 'icon' : 'browser';
  }
  var OPENED_TEXT = { icon: 'з іконки', browser: 'з браузера' };

  // ---------------------------------------------------------------- позначка в трьох сховищах
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return undefined; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return localStorage.getItem(k) === v; } catch (e) { return false; } }
  // needPin: localStorage і IndexedDB тримають відбиток PIN; cookie — лише дату й звідки (cookie браузер
  // сам відсилає на сервер сторінки з кожним запитом, тож у ньому не має бути нічого зайвого)
  function parseMark(s, needPin) {
    if (typeof s !== 'string') return null;
    try {
      var m = JSON.parse(s);
      if (m && typeof m.first === 'string' && (!needPin || (typeof m.pin === 'string' && typeof m.salt === 'string'))) return m;
    } catch (e) { /* пошкоджено */ }
    return null;
  }

  function cookieGet() {
    try {
      var parts = document.cookie ? document.cookie.split('; ') : [];
      for (var i = 0; i < parts.length; i++) {
        var j = parts[i].indexOf('=');
        if (parts[i].slice(0, j) === COOKIE) return decodeURIComponent(parts[i].slice(j + 1));
      }
      return null;
    } catch (e) { return undefined; }
  }
  function cookieSet(v) {
    try {
      document.cookie = COOKIE + '=' + encodeURIComponent(v) + '; Max-Age=34560000; Path=' + BASE_PATH + '; SameSite=Lax' + (IS_HTTPS ? '; Secure' : '');
      return cookieGet() === v;
    } catch (e) { return false; }
  }
  function cookieDel() {
    [BASE_PATH, '/'].forEach(function (p) {
      try { document.cookie = COOKIE + '=; Max-Age=0; Path=' + p + '; SameSite=Lax' + (IS_HTTPS ? '; Secure' : ''); } catch (e) { /* немає */ }
    });
  }

  var idbConn = null;
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!('indexedDB' in window) || !window.indexedDB) { rej(new Error('немає IndexedDB')); return; }
      var r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = function () {
        idbConn = r.result;
        idbConn.onversionchange = function () { try { idbConn.close(); } catch (e) { /* */ } idbConn = null; };
        res(idbConn);
      };
      r.onerror = function () { rej(r.error || new Error('помилка IndexedDB')); };
      r.onblocked = function () { rej(new Error('IndexedDB зайнята')); };
    });
  }
  function idbDb() { return idbConn ? Promise.resolve(idbConn) : withTimeout(idbOpen(), 4000, 'IndexedDB'); }
  function idbGet() {
    return idbDb().then(function (db) {
      return withTimeout(new Promise(function (res, rej) {
        var rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get('mark');
        rq.onsuccess = function () { res(rq.result === undefined ? null : rq.result); };
        rq.onerror = function () { rej(rq.error); };
      }), 4000, 'IndexedDB');
    });
  }
  function idbSet(v) {
    return idbDb().then(function (db) {
      return withTimeout(new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(v, 'mark');
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error || new Error('скасовано')); };
      }), 4000, 'IndexedDB');
    });
  }
  function idbDelete() {
    return new Promise(function (res) {
      if (idbConn) { try { idbConn.close(); } catch (e) { /* */ } idbConn = null; }
      if (!window.indexedDB) { res('немає'); return; }
      var r = indexedDB.deleteDatabase(IDB_NAME);
      r.onsuccess = function () { res('стерто'); };
      r.onerror = function () { res('помилка'); };
      r.onblocked = function () { res('зайнято'); };
      setTimeout(function () { res('немає відповіді'); }, 4000);
    });
  }

  // стан кожної позначки: {state: 'ok'|'none'|'err', m, why}
  function readMarks() {
    var out = {};
    var ls = lsGet(LS_MARK);
    out.ls = ls === undefined ? { state: 'err', why: 'localStorage недоступне' } : (parseMark(ls, true) ? { state: 'ok', m: parseMark(ls, true) } : { state: 'none' });
    var ck = cookieGet();
    out.ck = ck === undefined ? { state: 'err', why: 'cookie недоступні' } : (parseMark(ck, false) ? { state: 'ok', m: parseMark(ck, false) } : { state: 'none' });
    return idbGet().then(function (v) {
      out.idb = parseMark(v, true) ? { state: 'ok', m: parseMark(v, true) } : { state: 'none' };
      return out;
    }, function (e) {
      out.idb = { state: 'err', why: e && e.message ? e.message : String(e) };
      return out;
    });
  }
  function pickMark(marks) {
    var list = [marks.ls, marks.idb, marks.ck].filter(function (x) { return x && x.state === 'ok'; });
    if (!list.length) return null;
    list.sort(function (a, b) { return a.m.first < b.m.first ? -1 : 1; });
    return list[0].m;
  }
  // позначка з відбитком PIN (лише localStorage або IndexedDB)
  function pickPinMark(marks) {
    var list = [marks.ls, marks.idb].filter(function (x) { return x && x.state === 'ok' && x.m.pin; });
    return list.length ? list[0].m : null;
  }
  function markLine(name, s) {
    if (!s) return name + ' — ?';
    if (s.state === 'ok') return name + ' — є, з ' + fmtDate(s.m.first);
    if (s.state === 'none') return name + ' — немає';
    return name + ' — не читається (' + s.why + ')';
  }

  function randomHex(n) {
    var a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  function hashPin(salt, pin) {
    var s = salt + ':' + pin;
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
        return 'sha256:' + Array.prototype.map.call(new Uint8Array(buf), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      });
    }
    // запасний простий хеш (лише для імітації входу)
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return Promise.resolve('fnv:' + h.toString(16));
  }

  var marks = null;       // останнє прочитане
  var mark = null;        // чинна позначка
  var persisted = null;   // постійне сховище: true/false/null
  var setupResult = null; // що вдалося записати при першому запуску (лише в цьому відкритті)

  function createMarks(pin) {
    var salt = randomHex(16);
    return hashPin(salt, pin).then(function (h) {
      var m = { v: 1, first: new Date().toISOString(), how: openedFrom(), salt: salt, pin: h };
      var s = JSON.stringify(m);
      var r = { ls: lsSet(LS_MARK, s), ck: cookieSet(JSON.stringify({ v: 1, first: m.first, how: m.how })), idb: false };
      return idbSet(s).then(function () { r.idb = true; }, function () { r.idb = false; }).then(function () {
        setupResult = r;
        mark = m;
        return requestPersist();
      });
    });
  }
  function requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) { persisted = null; return Promise.resolve(); }
    return withTimeout(navigator.storage.persist(), 3000, 'persist').then(function (v) { persisted = !!v; }, function () { /* */ });
  }
  function checkPersisted() {
    if (!navigator.storage || !navigator.storage.persisted) return Promise.resolve();
    return withTimeout(navigator.storage.persisted(), 3000, 'persisted').then(function (v) { persisted = !!v; }, function () { /* */ });
  }

  // ---------------------------------------------------------------- сеанс проби (лише на телефоні)
  function defaultSession() {
    return {
      reads: [], photos: [], note: '', model: '', mode: 'lib',
      frames: { lib: { n: 0, ms: 0 }, native: { n: 0, ms: 0 } },
      runs: 0, cam: '', torch: '', libLoadMs: null, camErrors: []
    };
  }
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SESSION));
      if (s && Array.isArray(s.reads)) {
        var d = defaultSession();
        for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) d[k] = s[k];
        if (!d.frames || !d.frames.lib || !d.frames.native) d.frames = defaultSession().frames;
        return d;
      }
    } catch (e) { /* немає або пошкоджено */ }
    return defaultSession();
  }
  var session = defaultSession();
  var wiping = false; // під час «почати заново» нічого не записуємо назад
  function saveSession() {
    if (wiping) return;
    try { localStorage.setItem(LS_SESSION, JSON.stringify(session)); } catch (e) { /* */ }
  }

  // ---------------------------------------------------------------- телефон і браузер
  var DEV = { model: '', os: '', browser: '', ua: UA };
  function detectDevice() {
    var m;
    if (/(iPhone|iPad|iPod)/.test(UA) && (m = UA.match(/OS (\d+[_\d]*) like Mac OS X/))) DEV.os = 'iOS ' + m[1].replace(/_/g, '.');
    else if ((m = UA.match(/Android ([\d.]+)/))) DEV.os = 'Android ' + m[1];
    else if (/Mac OS X/.test(UA)) DEV.os = IS_IOS ? 'iPadOS' : 'macOS';
    else if (/Windows/.test(UA)) DEV.os = 'Windows';
    if ((m = UA.match(/CriOS\/([\d.]+)/))) DEV.browser = 'Chrome ' + m[1];
    else if ((m = UA.match(/FxiOS\/([\d.]+)/))) DEV.browser = 'Firefox ' + m[1];
    else if ((m = UA.match(/EdgiOS\/([\d.]+)|EdgA\/([\d.]+)/))) DEV.browser = 'Edge ' + (m[1] || m[2]);
    else if ((m = UA.match(/SamsungBrowser\/([\d.]+)/))) DEV.browser = 'Samsung Internet ' + m[1];
    else if ((m = UA.match(/Firefox\/([\d.]+)/))) DEV.browser = 'Firefox ' + m[1];
    else if ((m = UA.match(/Chrome\/([\d.]+)/))) DEV.browser = 'Chrome ' + m[1];
    else if ((m = UA.match(/Version\/([\d.]+).*Safari/))) DEV.browser = 'Safari ' + m[1];
    // Safari з iOS 26 «заморожує» версію системи в рядку браузера на 18.6; справжню видно з версії Safari
    var sv = UA.match(/Version\/(\d+)(\.\d+)?/);
    if (IS_IOS && sv && Number(sv[1]) >= 26 && /^iOS 18\.6/.test(DEV.os)) DEV.os = 'iOS ' + sv[1] + (sv[2] || '') + ' (за версією Safari)';
    if ((m = UA.match(/Android [\d.]+; ([^;)]+)/)) && m[1].trim() !== 'K') DEV.model = m[1].trim();
    var uad = navigator.userAgentData;
    if (uad && uad.getHighEntropyValues) {
      return withTimeout(uad.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']), 2000, 'uaData').then(function (h) {
        if (h.model) DEV.model = h.model;
        if (h.platform === 'Android' && h.platformVersion) DEV.os = 'Android ' + h.platformVersion;
        var list = h.fullVersionList || [];
        var b = list.filter(function (x) { return !/Not.?A.?Brand|Chromium/i.test(x.brand); })[0];
        if (b && !/SamsungBrowser|EdgA/.test(UA)) DEV.browser = b.brand + ' ' + b.version;
      }, function () { /* немає */ });
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- екрани і переходи
  var current = 'boot';
  var unlocked = false;
  function show(name) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].hidden = screens[i].id !== 'scr-' + name;
    current = name;
    window.scrollTo(0, 0);
  }
  function enter(name) {
    if (reloading) return; // сторінка вже перезавантажується на нову версію — нічого не відкривати
    var prev = current;
    if (prev === 'scan' && name !== 'scan') stopScanner();
    if (prev === 'photo' && name !== 'photo') clearPhoto();
    show(name);
    if (name === 'main') renderMain();
    if (name === 'scan') { renderReads(); renderMode(); startScanner(); }
    if (name === 'photo') renderPhotoTotal();
    if (name === 'report') {
      renderReport();
      // позначки перечитати: на старті IndexedDB могла не відповісти вчасно
      readMarks().then(function (m) { marks = m; if (current === 'report') $('report-text').value = buildReport(); });
    }
    if (updateTarget) applyUpdate(); // нова версія чекала, поки людина вийде зі сканера чи фото
  }

  // ---------------------------------------------------------------- оновлення сторінки
  // iPhone тримає програму з іконки в памʼяті, і тоді вона не перезавантажується сама. Тому при кожному
  // поверненні на сторінку вона питає version.json (повз кеші). Якщо там новіша версія — перезавантажується,
  // але лише там, де нічого не губиться: не під час сканування чи фото і не посеред набору коду.
  // Позначки й список зчитувань лежать у сховищах телефона, тож перезавантаження їх не чіпає.
  // Перед перезавантаженням сторінка сама забирає нову index.html і перевіряє в ній номер версії: так нова
  // версія лягає в офлайн-копію, і перезавантаження не відкриє стару навіть на слабкому звʼязку.
  var updateTarget = null;
  var lastUpdateCheck = 0;
  var reloading = false;   // перезавантаження вже йде
  var updateBusy = false;  // нова index.html ще завантажується
  var RELOAD_KEY = KEY + '.reloaded-for';
  function checkForUpdate() {
    var now = Date.now();
    if (now - lastUpdateCheck < 5000) return;
    lastUpdateCheck = now;
    if (!window.fetch) return;
    fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var v = j && Number(j.v);
      if (!v || v <= Number(APP_VERSION)) return;
      updateTarget = v;
      applyUpdate();
    }, function () { /* без мережі — лишаємось на збереженій версії */ });
  }
  // чи можна перезавантажити зараз, нічого не загубивши
  function canReloadNow() {
    if (!updateTarget || wiping || reloading) return false;
    if (current === 'scan' || current === 'photo') return false;
    if (current === 'code') {
      if (entry.mode === 'pin-repeat') return false;          // перший PIN уже набрано
      if (entry.mode === 'pin-new' && !pinOnly) return false; // код запрошення вже набрано
      // у «Введіть PIN» набрані цифри не шкода: після перезавантаження буде той самий екран
      if (entry.mode !== 'pin' && entry.value.length) return false;
    }
    return true;
  }
  function readReloadMark() {
    try { var g = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || 'null'); return g && typeof g === 'object' ? g : null; } catch (e) { return null; }
  }
  function applyUpdate() {
    if (updateBusy || !canReloadNow()) return;
    // не крутитись у петлі: на одну версію — не частіше ніж раз на хвилину і не більше трьох разів за сеанс
    var g = readReloadMark();
    var same = g && g.v === updateTarget;
    if (same && (g.n >= 3 || Date.now() - g.t < 60000)) return;
    var target = updateTarget;
    updateBusy = true;
    fetch('./', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (html) {
      updateBusy = false;
      // нова index.html ще не доїхала (або прийшла стара копія) — спробуємо при наступному поверненні
      if (!new RegExp('app\\.js\\?v=' + target + '\\b').test(html)) return;
      if (!canReloadNow() || updateTarget !== target) return;
      try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ v: target, t: Date.now(), n: (same ? (g.n || 0) : 0) + 1 })); } catch (e) { /* */ }
      reloading = true;
      saveSession();
      show('boot');
      $('boot-msg').textContent = 'Оновлюю сторінку…';
      location.reload();
    }, function () { updateBusy = false; /* без мережі — лишаємось на збереженій версії */ });
  }
  function go(name) {
    history.pushState({ s: name }, '', '#' + name);
    enter(name);
  }
  window.addEventListener('popstate', function (e) {
    if (!unlocked) return;
    var s = (e.state && e.state.s) || 'main';
    enter(s);
  });

  // ---------------------------------------------------------------- код запрошення і PIN
  var entry = { mode: 'invite', len: 6, value: '' };
  var pinMark = null;   // позначка з відбитком PIN
  var pinOnly = false;  // телефон упізнано лише за cookie: PIN придумати знову, нічого не записуючи
  var firstPin = '';
  var busy = false;
  var ENTRY_TEXT = {
    invite: ['Код запрошення', 'Введіть 6 цифр. Для проби підходять будь-які 6 цифр.'],
    'pin-new': ['Придумайте PIN', '4 цифри. Його треба буде вводити щоразу, коли відкриваєте сторінку.'],
    'pin-repeat': ['Повторіть PIN', 'Введіть ті самі 4 цифри ще раз.'],
    pin: ['Введіть PIN', '4 цифри, які ви придумали при першому запуску.']
  };
  function buildKeypad() {
    var kp = $('keypad');
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      if (k === '') { b.className = 'empty'; b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); }
      else if (k === 'del') { b.className = 'del'; b.textContent = '⌫ Стерти'; b.setAttribute('aria-label', 'Стерти цифру'); b.dataset.k = 'del'; }
      else { b.textContent = k; b.dataset.k = k; }
      kp.appendChild(b);
    });
    // Натискання — у мить дотику. Швидкі повторні дотики до тієї ж цифри (1111) iPhone сприймає як подвійний дотик
    // і частину з них ковтає; touchstart із preventDefault забирає цей дотик у системних жестів.
    // Миша — через pointerdown; «click» лишається для клавіатури й читачів екрана, але після дотику ігнорується.
    var lastPointer = 0;
    function keyOf(target) {
      var t = target && target.closest ? target.closest('button') : null;
      return t && t.dataset.k ? t.dataset.k : null;
    }
    kp.addEventListener('touchstart', function (e) {
      var k = keyOf(e.target);
      if (!k) return;
      e.preventDefault();
      lastPointer = Date.now();
      var b = e.target.closest('button');
      b.classList.add('pressed'); // :active після preventDefault на iPhone не спрацьовує — підсвічуємо самі
      setTimeout(function () { b.classList.remove('pressed'); }, 140);
      press(k);
    }, { passive: false });
    kp.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return; // дотики обробляє touchstart
      var k = keyOf(e.target);
      if (!k) return;
      e.preventDefault();
      lastPointer = Date.now();
      press(k);
    });
    kp.addEventListener('click', function (e) {
      if (Date.now() - lastPointer < 800) return;
      var t = e.target.closest('button');
      if (t && t.dataset.k) press(t.dataset.k);
    });
    document.addEventListener('keydown', function (e) {
      if (current !== 'code') return;
      if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
    });
  }
  function setEntry(mode, errText) {
    entry.mode = mode;
    entry.len = mode === 'invite' ? 6 : 4;
    entry.value = '';
    $('code-title').textContent = ENTRY_TEXT[mode][0];
    $('code-hint').textContent = pinOnly && mode === 'pin-new' ?
      'Телефон памʼятає вас: збереглась лише cookie-позначка, а PIN стерто. Придумайте 4 цифри — лише на цей раз.' : ENTRY_TEXT[mode][1];
    $('code-err').textContent = errText || '';
    $('code-forgot').hidden = mode !== 'pin';
    renderDots();
    if (current !== 'code') show('code');
  }
  function renderDots() {
    var box = $('code-dots');
    box.textContent = '';
    for (var i = 0; i < entry.len; i++) {
      var d = document.createElement('div');
      d.className = 'dot' + (i < entry.value.length ? ' filled' : '');
      if (i < entry.value.length) d.textContent = entry.mode === 'invite' ? entry.value[i] : '●';
      box.appendChild(d);
    }
    box.setAttribute('aria-label', 'Введено цифр: ' + entry.value.length + ' з ' + entry.len);
  }
  function press(k) {
    if (busy) return;
    unlockAudio();
    if (k === 'del') entry.value = entry.value.slice(0, -1);
    else if (entry.value.length < entry.len) entry.value += k;
    if (entry.value.length) $('code-err').textContent = '';
    renderDots();
    if (entry.value.length === entry.len) {
      // Код і перший PIN перемикають екран одразу, без паузи: інакше швидкий дотик одразу після
      // останньої цифри губився б. Пауза (busy) — лише поки перевіряється або записується PIN.
      busy = true;
      submitEntry().then(function () { busy = false; }, function (e) { busy = false; $('code-err').textContent = 'Помилка: ' + (e && e.message ? e.message : e); });
    }
  }
  function submitEntry() {
    var v = entry.value;
    if (entry.mode === 'invite') { setEntry('pin-new'); return Promise.resolve(); }
    if (entry.mode === 'pin-new') { firstPin = v; setEntry('pin-repeat'); return Promise.resolve(); }
    if (entry.mode === 'pin-repeat') {
      if (v !== firstPin) { firstPin = ''; setEntry('pin-new', 'PIN не збігся. Придумайте його ще раз.'); return Promise.resolve(); }
      firstPin = '';
      // збереглась лише cookie: позначок не відновлюємо, щоб проба бачила, що саме пережило перерву
      if (pinOnly) { unlock(); return Promise.resolve(); }
      $('code-hint').textContent = 'Запамʼятовую телефон…';
      return createMarks(v).then(function () { return readMarks(); }).then(function (m) { marks = m; unlock(); });
    }
    // pin
    return hashPin(pinMark.salt, v).then(function (h) {
      if (h === pinMark.pin) { unlock(); return; }
      entry.value = '';
      renderDots();
      $('code-err').textContent = 'Неправильний PIN. Спробуйте ще раз.';
    });
  }
  function unlock() {
    unlocked = true;
    history.replaceState({ s: 'main' }, '', location.pathname + location.search);
    enter('main');
    ensureLib().catch(function () { /* покажемо на екрані сканера */ });
  }

  // ---------------------------------------------------------------- головний екран
  function renderMain() {
    var how = openedFrom();
    var m = pickMark(marks || {});
    $('main-status').textContent = (m ? 'Телефон запамʼятано з ' + fmtDate(m.first) :
      'Телефон НЕ запамʼятано: жодне сховище не прийняло позначку') + '. Відкрито: ' + OPENED_TEXT[how] + '.';
    var box = $('main-marks');
    box.textContent = '';
    var notes = [];
    if (IN_APP) notes.push('Здається, сторінку відкрито всередині іншої програми (месенджера). Відкрийте її в ' + (IS_IOS ? 'Safari' : 'Chrome') + ': меню програми → «Відкрити в браузері».');
    if (photoReloadNote) notes.push('Під час останнього фото телефон перезавантажив сторінку — знімок не дійшов. Це записано у звіт.');
    notes.forEach(function (t) {
      var n = document.createElement('p');
      n.className = 'err';
      n.textContent = t;
      box.appendChild(n);
    });
    var p = document.createElement('p');
    p.textContent = 'Позначки на цьому телефоні:';
    p.style.margin = '2px 0';
    box.appendChild(p);
    var ul = document.createElement('ul');
    [['localStorage', marks && marks.ls], ['cookie', marks && marks.ck], ['IndexedDB', marks && marks.idb]].forEach(function (x) {
      var li = document.createElement('li');
      li.textContent = markLine(x[0], x[1]);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var p2 = document.createElement('p');
    p2.style.margin = '2px 0';
    p2.textContent = 'Постійне сховище: ' + (persisted === null ? 'невідомо' : persisted ? 'так' : 'ні') +
      (m && m.how ? '. Перший запуск — ' + OPENED_TEXT[m.how] + '.' : '');
    box.appendChild(p2);
    $('main-ver').textContent = 'Версія сторінки: ' + APP_VERSION + ' · читач кодів: ' + LIB_NAME + ' ' + LIB_VERSION;
  }

  // ---------------------------------------------------------------- звук і вібрація
  var audioCtx = null;
  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state !== 'running') audioCtx.resume();
      var b = audioCtx.createBuffer(1, 1, 22050);
      var s = audioCtx.createBufferSource();
      s.buffer = b;
      s.connect(audioCtx.destination);
      s.start(0);
    } catch (e) { /* без звуку */ }
  }
  function beep() {
    try {
      if (!audioCtx) return;
      if (audioCtx.state !== 'running') audioCtx.resume();
      var t = audioCtx.currentTime;
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 1250;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.14);
    } catch (e) { /* */ }
  }
  function vibrate() { try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* */ } }

  // ---------------------------------------------------------------- читачі кодів
  // Один і той самий обʼєкт налаштувань: бібліотека за ним упізнає вже створений модуль і не вантажить wasm удруге.
  // Без locateFile вона взяла б wasm зі стороннього CDN — тут він береться лише з цієї ж сторінки.
  var LIB_OVERRIDES = {
    locateFile: function (path, prefix) {
      if (/\.wasm$/.test(path)) return new URL('vendor/zxing-wasm/' + path, document.baseURI).href;
      return prefix + path;
    }
  };
  var lib = { state: 'idle', promise: null, why: '' }; // idle | loading | ready | failed
  function errText(e) { return e && e.message ? e.message : String(e); }
  function ensureLib() {
    if (lib.state === 'ready') return Promise.resolve();
    if (lib.promise) return lib.promise;
    lib.state = 'loading';
    var t0 = performance.now();
    // Повільне завантаження не обриваємо: на слабкому звʼязку воно таки дійде.
    lib.promise = new Promise(function (res, rej) {
      if (!window.ZXingWASM) { rej(new Error('файл бібліотеки не завантажився')); return; }
      Promise.resolve(window.ZXingWASM.prepareZXingModule({ overrides: LIB_OVERRIDES, fireImmediately: true })).then(res, rej);
    }).then(function () {
      lib.state = 'ready';
      lib.promise = null;
      session.libLoadMs = Math.round(performance.now() - t0);
    }, function (e) {
      lib.state = 'failed';
      lib.why = errText(e);
      lib.promise = null;
      try { if (window.ZXingWASM) window.ZXingWASM.purgeZXingModule(); } catch (x) { /* */ }
      throw e;
    });
    return lib.promise;
  }

  var native = { state: 'unknown', detector: null, formats: [] };
  function initNative() {
    if (!('BarcodeDetector' in window)) { native.state = 'none'; return Promise.resolve(); }
    return withTimeout(window.BarcodeDetector.getSupportedFormats(), 4000, 'BarcodeDetector').then(function (sup) {
      var fm = NATIVE_FORMATS.filter(function (f) { return sup.indexOf(f) >= 0; });
      if (!fm.length) { native.state = 'noformats'; return; }
      native.detector = new window.BarcodeDetector({ formats: fm });
      native.formats = fm;
      native.state = 'ok';
    }, function (e) { native.state = 'err'; native.why = e && e.message; });
  }

  // ---------------------------------------------------------------- сканер
  var video, canvas, ctx;
  var sc = { gen: 0, running: false, stream: null, track: null, startAt: 0, lastAt: 0, torchOn: false, wake: null, seen: {}, errors: 0, lastErr: '' };
  var mode = 'lib';

  function setScanState(t) { $('scan-state').textContent = t; }
  function showCamMsg(t, retry) {
    $('cam-msg-text').textContent = t;
    $('cam-retry').hidden = !retry;
    $('cam-msg').hidden = false;
  }
  function hideCamMsg() { $('cam-msg').hidden = true; }

  function camErrorText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') {
      var tail2 = '\n\nПотім поверніться сюди й натисніть «Спробувати ще раз». Номер можна ввести руками нижче.';
      var fromIcon = openedFrom() === 'icon';
      if (IS_IOS) {
        // назви пунктів звірено на iPhone з iOS 26.5 українською (блок П3а). Після «Скасувати» iPhone питає
        // знову на «Спробувати ще раз»; не питає лише тоді, коли в «Параметрах» стоїть «Заборонити».
        // Після зміни в «Параметрах» закривати «Пробу» не треба — досить «Спробувати ще раз».
        return 'Камеру не дозволено.\n\n' +
          'Натисніть «Спробувати ще раз». Якщо iPhone спитає про камеру — «Дозволити».\n\n' +
          'Якщо не питає: ' + (fromIcon ?
          '«Параметри» → «Програми» → «Safari» (унизу списку) → унизу «Камера» → «Питати».' :
          'кнопка ліворуч від адреси → «⋯» → унизу, у «Параметри вебсайту для ' + location.host + '», рядок «Камера» → «Дозволити». ' +
          'Або: «Параметри» → «Програми» → «Safari» (унизу списку) → унизу «Камера» → «Питати».') +
          '\nПотім поверніться сюди й знову натисніть «Спробувати ще раз». Номер можна ввести руками нижче.';
      }
      return 'Камеру не дозволено.\n\n' + (fromIcon ?
        'Що натиснути: утримуйте іконку «Проба» → «Про застосунок» (ⓘ) → «Дозволи» → «Камера» → «Дозволити».\n' :
        'Що натиснути: значок ліворуч від адреси (замок або повзунки) → «Дозволи» → «Камера» → «Дозволити».\n') +
        'Якщо камеру заборонено самому Chrome: «Налаштування» телефона → «Програми» → «Chrome» → «Дозволи» → «Камера» → «Дозволити».' + tail2;
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'Камеру не знайдено. Номер можна ввести руками нижче.';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'Камера зайнята іншою програмою або не запускається. Закрийте інші програми з камерою й натисніть «Спробувати ще раз».';
    return 'Камера не запустилась: ' + (n || '') + ' ' + (e && e.message ? e.message : '') + '\nНомер можна ввести руками нижче.';
  }

  function startScanner() {
    stopScanner();
    var gen = ++sc.gen;
    hideCamMsg();
    unlockAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamMsg('Цей браузер не дає сторінці доступу до камери. Спробуйте Safari (iPhone) або Chrome (Android). Номер можна ввести руками нижче.', false);
      setScanState('');
      return;
    }
    setScanState('Запускаю камеру…');
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (stream) {
      if (gen !== sc.gen || current !== 'scan') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      sc.stream = stream;
      sc.track = stream.getVideoTracks()[0];
      if (sc.track) {
        sc.track.addEventListener('ended', function () {
          if (gen !== sc.gen) return;
          stopScanner();
          showCamMsg('Камера вимкнулась — мабуть, її забрала інша програма або дзвінок. Натисніть «Спробувати ще раз».', true);
          setScanState('');
        });
      }
      video.srcObject = stream;
      var pl = video.play();
      if (pl && pl.catch) pl.catch(function () { /* autoplay без звуку дозволений */ });
      return waitVideo(gen).then(function () {
        if (gen !== sc.gen) return;
        session.cam = video.videoWidth + '×' + video.videoHeight;
        setupTorch(gen);
        requestWake(gen);
        prepareAndBegin(gen);
      });
    }).catch(function (e) {
      if (gen !== sc.gen) return;
      session.camErrors.push((e && e.name ? e.name : 'Error') + (e && e.message ? ': ' + e.message : ''));
      if (session.camErrors.length > 10) session.camErrors.shift();
      saveSession();
      showCamMsg(camErrorText(e), true);
      setScanState('');
    });
  }

  var READY_TEXT = 'Наведіть камеру на штрихкод. Тримайте телефон за 15–20 см від етикетки.';
  // камера вже працює; запускає розбір кадрів, щойно готовий обраний спосіб читання
  function prepareAndBegin(gen) {
    if (gen !== sc.gen || sc.running) return;
    if (mode === 'native' && native.detector) { beginScan(gen); return; }
    setScanState('Готую читач кодів…');
    var slow = setTimeout(function () {
      if (gen === sc.gen && !sc.running) setScanState('Читач кодів ще завантажується — мабуть, слабкий звʼязок. Зачекайте.');
    }, 12000);
    ensureLib().then(function () {
      clearTimeout(slow);
      if (gen === sc.gen && mode === 'lib') beginScan(gen);
    }, function (e) {
      clearTimeout(slow);
      if (gen !== sc.gen || sc.running) return;
      session.libError = errText(e);
      saveSession();
      showCamMsg('Не вдалося завантажити читач кодів — мабуть, обірвався звʼязок.' +
        (native.state === 'ok' ? '\nМожна перемкнути нижче на «Вбудоване».' : '') +
        '\nНатисніть «Спробувати ще раз». Номер можна ввести руками нижче.', true);
      setScanState('');
    });
  }
  function beginScan(gen) {
    if (gen !== sc.gen || sc.running) return;
    hideCamMsg();
    sc.running = true;
    sc.startAt = sc.lastAt = performance.now();
    sc.seen = {};
    sc.errRun = 0;
    session.runs++;
    saveSession();
    setScanState(READY_TEXT);
    loop(gen);
  }

  function waitVideo(gen) {
    return new Promise(function (res) {
      var t0 = performance.now();
      (function check() {
        if (gen !== sc.gen) { res(); return; }
        if (video.readyState >= 2 && video.videoWidth > 0) { res(); return; }
        if (performance.now() - t0 > 8000) { res(); return; }
        setTimeout(check, 50);
      })();
    });
  }

  function stopScanner() {
    sc.running = false;
    sc.gen++;
    if (sc.stream) sc.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* */ } });
    sc.stream = null;
    sc.track = null;
    sc.torchOn = false;
    if (video) { try { video.pause(); } catch (e) { /* */ } video.srcObject = null; }
    var tb = $('btn-torch');
    tb.hidden = true;
    tb.classList.remove('on');
    tb.textContent = 'Ліхтарик';
    releaseWake();
    saveSession();
  }

  function nextFrame() {
    return new Promise(function (res) {
      var done = false;
      function fin() { if (!done) { done = true; res(); } }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(fin);
      else requestAnimationFrame(fin);
      setTimeout(fin, 250);
    });
  }

  // Кадр обрізаємо до тієї частини, яку людина бачить на екрані (відео заповнює вікно з обрізанням країв),
  // і обидва способи читання отримують однаковий шматок — порівняння чесне.
  function drawVisible() {
    var vw = video.videoWidth, vh = video.videoHeight;
    var ew = video.clientWidth || vw, eh = video.clientHeight || vh;
    var s = Math.max(ew / vw, eh / vh);
    var sw = Math.min(vw, ew / s), sh = Math.min(vh, eh / s);
    var sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    var k = Math.min(1, 1920 / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    session.crop = w + '×' + h;
    return { w: w, h: h };
  }
  function decodeLib() {
    var r = drawVisible();
    return window.ZXingWASM.readBarcodes(ctx.getImageData(0, 0, r.w, r.h), LIB_OPTIONS).then(function (out) {
      return out.filter(function (x) { return x.isValid && x.text; }).map(function (x) {
        return { text: x.text, type: typeLabel(x.format, x.symbology) };
      });
    });
  }
  function decodeNative() {
    drawVisible();
    // якщо вбудований засіб завис, нових запитів не накопичуємо, поки не відповість попередній
    sc.nativeBusy = true;
    var d = native.detector.detect(canvas);
    var free = function () { sc.nativeBusy = false; };
    d.then(free, free);
    return withTimeout(d, 3000, 'вбудоване читання').then(function (out) {
      return out.filter(function (b) { return b.rawValue; }).map(function (b) { return { text: b.rawValue, type: typeLabel(b.format) }; });
    });
  }

  function loop(gen) {
    if (!sc.running || gen !== sc.gen) return;
    var m = mode === 'native' && native.detector ? 'native' : 'lib';
    // кадр готовий і обраний спосіб готовий (бібліотека могла ще вантажитись після перемикання)
    var ready = video.readyState >= 2 && video.videoWidth > 0 && (m === 'native' ? !sc.nativeBusy : lib.state === 'ready');
    var t0 = performance.now();
    var p = !ready ? Promise.resolve([]) : (m === 'native' ? decodeNative() : decodeLib());
    p.then(function (found) {
      if (!sc.running || gen !== sc.gen) return;
      if (ready) {
        var st = session.frames[m];
        st.n++;
        st.ms += performance.now() - t0;
        if (sc.errRun >= 5) setScanState(READY_TEXT); // знову працює — прибрати повідомлення про помилку
        sc.errRun = 0;
      }
      for (var i = 0; i < found.length; i++) handleCode(found[i].text, found[i].type, m);
    }, function (e) {
      sc.errors++;
      sc.lastErr = errText(e);
      session.decodeErrors = (session.decodeErrors || 0) + 1;
      session.lastDecodeError = sc.lastErr;
      sc.errRun = (sc.errRun || 0) + 1;
      if (sc.errRun === 5) setScanState('Читач кодів дає помилку: ' + sc.lastErr);
    }).then(function () {
      if (!sc.running || gen !== sc.gen) return;
      return nextFrame().then(function () { loop(gen); });
    });
  }

  var toastTimer = null, hitTimer = null;
  function showToast(text, kind) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 1300);
  }
  function flashHit() {
    var f = $('frame');
    f.classList.add('hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(function () { f.classList.remove('hit'); }, 450);
  }
  function tail(v) { v = visible(v); return v.length > 18 ? '…' + v.slice(-16) : v; }

  // method: 'lib' | 'native' | 'manual'
  function handleCode(raw, type, method) {
    var value = String(raw);
    if (!value) return false;
    var now = performance.now();
    var exists = session.reads.some(function (r) { return r.v === value && (r.m === method || method === 'manual'); });
    if (method === 'manual') {
      if (exists) { showToast('Вже є: ' + tail(value), 'dup'); return false; }
    } else {
      // той самий код, що досі в кадрі, не показуємо як «вже є» щокадру
      var key = method + '|' + value;
      var prevSeen = sc.seen[key];
      sc.seen[key] = now;
      if (exists) {
        if (prevSeen === undefined || now - prevSeen > 1500) showToast('Вже є: ' + tail(value), 'dup');
        return false;
      }
    }
    var row = { v: value, t: type, m: method, ms: null, at: Date.now() };
    if (method !== 'manual') {
      row.ms = Math.round(now - sc.lastAt);
      sc.lastAt = now;
    }
    session.reads.push(row);
    saveSession();
    renderReads();
    beep();
    vibrate();
    flashHit();
    showToast('✓ ' + tail(value), 'ok');
    return true;
  }

  function rowMeta(r) {
    if (r.m === 'manual') return 'введено вручну · ' + fmtClock(r.at);
    return r.t + ' · ' + (r.ms === null ? '—' : r.ms + ' мс') + ' · ' + METHOD_LABEL[r.m] + ' · ' + fmtClock(r.at);
  }

  function renderReads() {
    var ol = $('reads');
    ol.textContent = '';
    var list = session.reads;
    for (var i = list.length - 1; i >= 0; i--) {
      var r = list[i];
      var li = document.createElement('li');
      var v = document.createElement('div');
      v.className = 'val';
      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = (i + 1) + '.';
      v.appendChild(num);
      v.appendChild(document.createTextNode(visible(r.v)));
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = rowMeta(r);
      li.appendChild(v);
      li.appendChild(meta);
      ol.appendChild(li);
    }
    $('scan-count').textContent = 'Зчитано: ' + list.length;
    var lr = $('last-read');
    if (list.length) {
      var last = list[list.length - 1];
      lr.textContent = 'Останнє: ';
      var b = document.createElement('b');
      b.textContent = visible(last.v);
      lr.appendChild(b);
      lr.appendChild(document.createTextNode(' · ' + rowMeta(last)));
      lr.hidden = false;
    } else lr.hidden = true;
  }

  function renderMode() {
    var box = $('mode-box');
    var note = $('mode-note');
    if (native.state === 'ok') {
      box.hidden = false;
      note.hidden = true;
      var bs = $('mode-seg').querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('active', bs[i].dataset.mode === mode);
    } else {
      box.hidden = true;
      note.hidden = false;
      note.textContent = 'Спосіб читання: бібліотека (вбудованого читання кодів у цьому браузері немає).';
    }
  }
  function setMode(m) {
    if (m === mode) return;
    if (m === 'native' && native.state !== 'ok') return;
    mode = m;
    session.mode = m;
    saveSession();
    renderMode();
    sc.seen = {};
    if (current !== 'scan' || !sc.stream) return;
    if (!sc.running) {
      // камера є, але розбір ще не йшов (бібліотека вантажилась або не завантажилась) — почати новим способом
      hideCamMsg();
      prepareAndBegin(sc.gen);
      return;
    }
    sc.lastAt = performance.now();
    if (m === 'lib' && lib.state !== 'ready') {
      setScanState('Готую читач кодів…');
      ensureLib().then(function () { if (mode === 'lib' && current === 'scan') setScanState('Читає бібліотека.'); },
        function (e) {
          session.libError = errText(e);
          saveSession();
          if (mode === 'lib' && current === 'scan') setScanState('Не вдалося завантажити читач кодів. Натисніть «Назад» і знову «Сканувати».');
        });
      return;
    }
    setScanState(m === 'native' ? 'Читає вбудований засіб телефона.' : 'Читає бібліотека.');
  }

  function setupTorch(gen) {
    var tb = $('btn-torch');
    function check() {
      if (gen !== sc.gen || !sc.track) return;
      try {
        var caps = sc.track.getCapabilities ? sc.track.getCapabilities() : {};
        if (caps && caps.torch) { tb.hidden = false; session.torch = 'є'; }
        else if (session.torch !== 'є') session.torch = 'немає';
      } catch (e) { if (session.torch !== 'є') session.torch = 'немає'; }
    }
    check();
    setTimeout(check, 800);
    setTimeout(check, 2500); // деякі Android повідомляють про ліхтарик пізніше
  }
  function toggleTorch() {
    var t = sc.track;
    if (!t) return;
    var want = !sc.torchOn;
    t.applyConstraints({ advanced: [{ torch: want }] }).then(function () {
      sc.torchOn = want;
      var tb = $('btn-torch');
      tb.classList.toggle('on', want);
      tb.textContent = want ? 'Ліхтарик: увімкнено' : 'Ліхтарик';
    }, function (e) { setScanState('Ліхтарик не вмикається: ' + (e && e.message ? e.message : e)); });
  }

  function requestWake(gen) {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (w) {
          if (gen !== sc.gen) { try { w.release(); } catch (e) { /* */ } return; } // сканер уже закрили
          sc.wake = w;
        }, function () { /* */ });
      }
    } catch (e) { /* */ }
  }
  function releaseWake() {
    try { if (sc.wake) sc.wake.release(); } catch (e) { /* */ }
    sc.wake = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (current === 'scan') stopScanner();
      saveSession();
    } else {
      checkForUpdate();
      if (current === 'scan' && unlocked) startScanner();
      // повернулись із камери телефона без знімка (скасували) — позначку «фото в дорозі» прибрати
      if (photoPicking) setTimeout(function () { if (photoPicking) photoPendingClear(); }, 3000);
    }
  });
  window.addEventListener('pagehide', saveSession);

  // ---------------------------------------------------------------- фото
  // Позначка в sessionStorage переживає перезавантаження сторінки, поки відкрита камера телефона:
  // так видно, що знімок загубився не з вини людини.
  var PHOTO_PENDING = KEY + '.photo-pending';
  var photoPicking = false;
  function photoPendingSet() {
    photoPicking = true;
    try { sessionStorage.setItem(PHOTO_PENDING, String(Date.now())); } catch (e) { /* */ }
  }
  function photoPendingClear() {
    photoPicking = false;
    try { sessionStorage.removeItem(PHOTO_PENDING); } catch (e) { /* */ }
  }
  function checkPhotoReload() {
    var t = null;
    try { t = sessionStorage.getItem(PHOTO_PENDING); sessionStorage.removeItem(PHOTO_PENDING); } catch (e) { /* */ }
    if (t && Date.now() - Number(t) < 15 * 60 * 1000) {
      session.photoReloads = (session.photoReloads || 0) + 1;
      photoReloadNote = true;
      saveSession();
    }
  }
  var previewUrl = null;
  function clearPhoto(keepInput) {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    var img = $('photo-preview');
    img.removeAttribute('src');
    $('photo-result').hidden = true;
    $('photo-stats').textContent = '';
    $('photo-state').textContent = '';
    if (!keepInput) { try { $('photo-input').value = ''; } catch (e) { /* */ } }
  }
  function onPhoto() {
    var input = $('photo-input');
    photoPendingClear();
    var f = input.files && input.files[0];
    if (!f) return;
    clearPhoto(true);
    $('photo-state').textContent = 'Стискаю…';
    var t0 = performance.now();
    var srcUrl = URL.createObjectURL(f);
    var img = new Image();
    img.decoding = 'async';
    var loaded = new Promise(function (res, rej) {
      img.onload = function () { res(); };
      img.onerror = function () { rej(new Error('не вдалося відкрити фото (формат ' + (f.type || 'невідомий') + ')')); };
    });
    img.src = srcUrl;
    loaded.then(function () {
      var w0 = img.naturalWidth, h0 = img.naturalHeight;
      var k = Math.min(1, 1600 / Math.max(w0, h0));
      var w1 = Math.max(1, Math.round(w0 * k)), h1 = Math.max(1, Math.round(h0 * k));
      var c = document.createElement('canvas');
      c.width = w1;
      c.height = h1;
      var cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, w1, h1);
      return new Promise(function (res, rej) {
        c.toBlob(function (b) {
          c.width = 0; c.height = 0;
          if (b) res({ blob: b, w0: w0, h0: h0, w1: w1, h1: h1 }); else rej(new Error('не вдалося стиснути'));
        }, 'image/jpeg', 0.8);
      });
    }).then(function (r) {
      var ms = Math.round(performance.now() - t0);
      var rec = { before: f.size, after: r.blob.size, w0: r.w0, h0: r.h0, w1: r.w1, h1: r.h1, ms: ms, type: f.type || '?' };
      session.photos.push(rec);
      saveSession();
      $('photo-state').textContent = '';
      $('photo-stats').textContent = 'До стискання: ' + fmtBytes(rec.before) + ' (' + rec.w0 + '×' + rec.h0 + ')\n' +
        'Після: ' + fmtBytes(rec.after) + ' (' + rec.w1 + '×' + rec.h1 + ', JPEG)\n' +
        'Стискання тривало: ' + rec.ms + ' мс';
      $('photo-stats').style.whiteSpace = 'pre-line';
      previewUrl = URL.createObjectURL(r.blob);
      $('photo-preview').src = previewUrl;
      $('photo-result').hidden = false;
      renderPhotoTotal();
    }).catch(function (e) {
      $('photo-state').textContent = 'Помилка: ' + (e && e.message ? e.message : e);
    }).then(function () {
      URL.revokeObjectURL(srcUrl);
      img.removeAttribute('src');
      try { input.value = ''; } catch (e) { /* */ }
    });
  }
  function renderPhotoTotal() {
    var n = session.photos.length;
    $('photo-total').textContent = n ? 'Зроблено знімків за пробу: ' + n + '. Підсумок буде у звіті.' : '';
  }

  // ---------------------------------------------------------------- звіт
  function avg(st) { return st.n ? Math.round(st.ms / st.n) : null; }
  function nativeText() {
    if (native.state === 'ok') return 'є (' + native.formats.length + ' з ' + NATIVE_FORMATS.length + ' потрібних форматів)';
    if (native.state === 'none') return 'немає';
    if (native.state === 'noformats') return 'є, але без потрібних форматів';
    if (native.state === 'err') return 'помилка: ' + (native.why || '');
    return 'невідомо';
  }
  function buildReport() {
    var L = [];
    var m = pickMark(marks || {});
    var model = ($('model-input').value || '').trim();
    L.push('Проба сканера — звіт');
    L.push('Версія сторінки: ' + APP_VERSION + ' · складено ' + fmtDate(new Date().toISOString()));
    L.push('Телефон: ' + (model || DEV.model || 'модель не вказано') + (model && DEV.model && model !== DEV.model ? ' (браузер каже: ' + DEV.model + ')' : '') +
      ' · ' + (DEV.os || '?') + ' · ' + (DEV.browser || '?'));
    L.push('Екран: ' + screen.width + '×' + screen.height + ', щільність ×' + (window.devicePixelRatio || 1));
    L.push('Відкрито зараз: ' + OPENED_TEXT[openedFrom()] + (IN_APP ? ' (схоже, всередині іншої програми)' : ''));
    if (pinOnly) L.push('PIN цього разу придумано знову: збереглась лише cookie-позначка');
    L.push('Перший запуск: ' + (m ? fmtDate(m.first) + (m.how ? ' (' + OPENED_TEXT[m.how] + ')' : '') : '—'));
    L.push('Позначки:');
    L.push('  ' + markLine('localStorage', marks && marks.ls));
    L.push('  ' + markLine('cookie', marks && marks.ck));
    L.push('  ' + markLine('IndexedDB', marks && marks.idb));
    L.push('Постійне сховище: ' + (persisted === null ? 'невідомо' : persisted ? 'так' : 'ні'));
    L.push('Вбудоване читання кодів: ' + nativeText());
    L.push('Бібліотека: ' + LIB_NAME + ' ' + LIB_VERSION + (session.libLoadMs !== null ? ', завантаження ' + session.libLoadMs + ' мс' : '') +
      (session.libError ? ' · помилка завантаження: ' + session.libError : ''));
    L.push('Спосіб читання зараз: ' + METHOD_LABEL[mode]);
    L.push('Камера: ' + (session.cam || 'не запускалась') + (session.crop ? ' (читається видима частина ' + session.crop + ')' : '') +
      ' · ліхтарик: ' + (session.torch || '—'));
    L.push('Звук: ' + (audioCtx ? audioCtx.state : 'немає') + ' · вібрація: ' + (navigator.vibrate ? 'є' : 'немає'));
    if (session.camErrors.length) L.push('Помилки камери: ' + session.camErrors.join('; '));
    L.push('Запусків сканера: ' + session.runs);
    if (session.decodeErrors) L.push('Помилок читача: ' + session.decodeErrors + ' (остання: ' + session.lastDecodeError + ')');
    var fl = session.frames.lib, fn = session.frames.native;
    L.push('Кадрів розібрано: бібліотека — ' + fl.n + (fl.n ? ', у середньому ' + avg(fl) + ' мс' : '') +
      '; вбудоване — ' + fn.n + (fn.n ? ', у середньому ' + avg(fn) + ' мс' : ''));
    var cnt = { lib: 0, native: 0, manual: 0 };
    session.reads.forEach(function (r) { cnt[r.m] = (cnt[r.m] || 0) + 1; });
    L.push('Зчитано: ' + session.reads.length + ' (бібліотека ' + cnt.lib + ', вбудоване ' + cnt.native + ', вручну ' + cnt.manual + ')');
    if (session.reads.length) {
      L.push('Зчитування (значення · тип · мс від попереднього або від запуску · спосіб · час):');
      session.reads.forEach(function (r, i) {
        L.push((i + 1) + '. ' + visible(r.v) + ' · ' + rowMeta(r));
      });
    }
    L.push('Фото: ' + session.photos.length + (session.photoReloads ? ' · сторінку перезавантажено під час фото: ' + session.photoReloads : ''));
    session.photos.forEach(function (p, i) {
      L.push((i + 1) + '. ' + fmtBytes(p.before) + ' → ' + fmtBytes(p.after) + ' · ' + p.w0 + '×' + p.h0 + ' → ' + p.w1 + '×' + p.h1 + ' · ' + p.ms + ' мс · ' + p.type);
    });
    if (session.photos.length) {
      var sb = 0, sa = 0, sm = 0;
      session.photos.forEach(function (p) { sb += p.before; sa += p.after; sm += p.ms; });
      var n = session.photos.length;
      L.push('У середньому: ' + fmtBytes(Math.round(sb / n)) + ' → ' + fmtBytes(Math.round(sa / n)) + ', ' + Math.round(sm / n) + ' мс');
    }
    L.push('Що було не так:');
    var note = ($('note-input').value || '').trim();
    L.push(note || '—');
    L.push('Рядок браузера: ' + UA);
    return L.join('\n');
  }
  function renderReport() {
    $('model-input').value = session.model || DEV.model || '';
    $('note-input').value = session.note || '';
    $('copy-msg').textContent = '';
    $('report-text').value = buildReport();
  }
  function copyReport() {
    session.model = ($('model-input').value || '').trim();
    session.note = $('note-input').value || '';
    saveSession();
    var text = buildReport();
    var ta = $('report-text');
    ta.value = text;
    var msg = $('copy-msg');
    function fallback() {
      var ok = false;
      $('report-details').open = true;
      try {
        ta.removeAttribute('readonly');
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
      ta.setAttribute('readonly', '');
      if (ok) { msg.className = 'ok'; msg.textContent = 'Скопійовано. Вставте в повідомлення.'; }
      else {
        msg.className = 'err';
        msg.textContent = 'Не вдалося скопіювати самостійно. Утримуйте палець на тексті нижче → «Виділити все» → «Скопіювати».';
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        msg.className = 'ok';
        msg.textContent = 'Скопійовано. Вставте в повідомлення.';
      }, fallback);
    } else fallback();
  }

  // ---------------------------------------------------------------- підтвердження і «почати заново»
  function confirmBox(text, yesText) {
    return new Promise(function (res) {
      $('modal-text').textContent = text;
      $('modal-yes').textContent = yesText;
      $('modal').hidden = false;
      function done(v) {
        $('modal').hidden = true;
        $('modal-yes').onclick = null;
        $('modal-no').onclick = null;
        res(v);
      }
      $('modal-yes').onclick = function () { done(true); };
      $('modal-no').onclick = function () { done(false); };
    });
  }
  function resetAll() {
    stopScanner();
    clearPhoto();
    wiping = true;
    session = defaultSession();
    // Адреса kladvinn.github.io спільна з іншими сторінками акаунта — стираємо лише свої ключі
    try {
      var ks = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(KEY + '.') === 0) ks.push(k); }
      ks.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* */ }
    try { sessionStorage.removeItem(PHOTO_PENDING); } catch (e) { /* */ }
    cookieDel();
    var jobs = [idbDelete()];
    if (window.caches && caches.keys) {
      jobs.push(caches.keys().then(function (ks) {
        return Promise.all(ks.filter(function (k) { return k.indexOf(KEY) === 0; }).map(function (k) { return caches.delete(k); }));
      }).catch(function () { /* */ }));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      var scope = location.origin + BASE_PATH;
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
        return Promise.all(rs.filter(function (r) { return r.scope.indexOf(scope) === 0; }).map(function (r) { return r.unregister(); }));
      }).catch(function () { /* */ }));
    }
    // якщо щось зависло — однаково перезавантажити за 5 с
    return withTimeout(Promise.all(jobs), 5000, 'стирання').catch(function () { /* */ }).then(function () {
      location.replace(location.pathname + location.search);
    });
  }
  function askReset() {
    confirmBox('Стерти все на цьому телефоні?\nПозначки, PIN, список зчитувань і підсумок фото зникнуть, і проба почнеться з коду запрошення.', 'Так, стерти все').then(function (yes) {
      if (yes) resetAll();
    });
  }

  // ---------------------------------------------------------------- старт
  function bind() {
    document.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { go(b.dataset.go); });
    });
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (history.state && history.state.s && history.state.s !== 'main') history.back();
        else enter('main');
      });
    });
    $('cam-retry').addEventListener('click', startScanner);
    $('btn-torch').addEventListener('click', toggleTorch);
    $('mode-seg').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) setMode(b.dataset.mode);
    });
    $('manual-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = $('manual-input');
      var v = (inp.value || '').replace(/\s+/g, '');
      if (!v) return;
      if (handleCode(v, '—', 'manual')) inp.value = '';
    });
    // будь-який дотик до сторінки означає, що камера телефона вже закрита: стару позначку «фото в дорозі» прибрати
    // (на iPhone камера не ховає сторінку, а подія «cancel» є не всюди)
    document.addEventListener('pointerdown', function () { if (photoPicking) photoPendingClear(); }, true);
    $('photo-input').addEventListener('click', photoPendingSet);
    $('photo-input').addEventListener('cancel', photoPendingClear);
    $('photo-input').addEventListener('change', onPhoto);
    $('btn-photo-clear').addEventListener('click', function () { clearPhoto(); });
    // «Почати заново» в іншому вікні цієї ж сторінки (вкладка й іконка на Android) — не записати старе назад
    window.addEventListener('storage', function (e) {
      if (e.key === LS_MARK && e.newValue === null) { wiping = true; location.reload(); }
    });
    $('btn-copy').addEventListener('click', copyReport);
    $('model-input').addEventListener('input', function () { session.model = this.value.trim(); saveSession(); });
    $('note-input').addEventListener('input', function () { session.note = this.value; saveSession(); });
    $('btn-clear-reads').addEventListener('click', function () {
      confirmBox('Очистити список зчитувань?\nПозначки й PIN лишаться.', 'Так, очистити').then(function (yes) {
        if (!yes) return;
        session.reads = [];
        session.frames = defaultSession().frames;
        session.runs = 0;
        saveSession();
        renderReport();
      });
    });
    $('btn-reset').addEventListener('click', askReset);
    $('code-forgot').addEventListener('click', askReset);
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* без офлайну */ });
  }

  function boot() {
    video = $('video');
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    buildKeypad();
    bind();
    session = loadSession();
    checkPhotoReload();
    mode = session.mode === 'native' ? 'native' : 'lib';
    Promise.all([detectDevice(), initNative(), checkPersisted(), readMarks()]).then(function (r) {
      marks = r[3];
      // cookie з першої редакції сторінки ще могла нести відбиток PIN — переписати без нього
      if (marks.ck && marks.ck.state === 'ok' && (marks.ck.m.pin || marks.ck.m.salt)) {
        cookieSet(JSON.stringify({ v: 1, first: marks.ck.m.first, how: marks.ck.m.how }));
      }
      if (mode === 'native' && native.state !== 'ok') mode = 'lib';
      mark = pickMark(marks);
      pinMark = pickPinMark(marks);
      firstPin = '';
      if (!mark) setEntry('invite');
      else if (pinMark) setEntry('pin');
      else { pinOnly = true; setEntry('pin-new'); }
      registerSW();
      checkForUpdate();
    }).catch(function (e) {
      $('boot-msg').textContent = 'Помилка запуску: ' + (e && e.message ? e.message : e);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // для автоматичної перевірки на тестових зображеннях (нічого не надсилає)
  window.__proba = {
    version: APP_VERSION,
    decodeImageData: function (img) {
      return ensureLib().then(function () { return window.ZXingWASM.readBarcodes(img, LIB_OPTIONS); }).then(function (out) {
        return out.filter(function (r) { return r.isValid; }).map(function (r) { return { text: r.text, type: typeLabel(r.format, r.symbology) }; });
      });
    },
    readMarks: readMarks,
    nativeState: function () { return native.state; }
  };
})();
