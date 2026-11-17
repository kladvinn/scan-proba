'use strict';
(function () {
  var CODES = [
    ['code128', 'Code 128', 'Code128', 'code_128', '59000123456789'],
    ['itf', 'ITF', 'ITF', 'itf', '00012345678905'],
    ['code39', 'Code 39', 'Code39', 'code_39', 'PROBA-39'],
    ['ean13', 'EAN-13', 'EAN13', 'ean_13', '4821234567895'],
    ['qr', 'QR', 'QRCode', 'qr_code', 'QR-PROBA-001'],
    ['datamatrix', 'Data Matrix', 'DataMatrix', 'data_matrix', 'DM-PROBA-002'],
    ['pdf417', 'PDF417', 'PDF417', 'pdf417', 'PDF417-PROBA-003'],
    ['ean8', 'EAN-8', 'EAN8', 'ean_8', '48201230'],
    ['upca', 'UPC-A', 'UPCA', 'upc_a', '0036000291452'],
    ['code93', 'Code 93', 'Code93', 'code_93', 'PROBA93'],
    ['aztec', 'Aztec', 'Aztec', 'aztec', 'AZTEC-PROBA-004']
  ];
  function $(id) { return document.getElementById(id); }

  function loadImageData(name) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        var x = c.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, c.width, c.height);
        x.drawImage(img, 0, 0);
        res({ img: img, canvas: c, data: x.getImageData(0, 0, c.width, c.height) });
      };
      img.onerror = function () { rej(new Error('немає файлу ' + name)); };
      img.src = 'test-codes/' + name + '.png';
    });
  }

  function run() {
    var env = [];
    var t0 = performance.now();
    var lib = window.ZXingWASM ? Promise.resolve(window.ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: function (path, prefix) {
          return /\.wasm$/.test(path) ? new URL('vendor/zxing-wasm/' + path, document.baseURI).href : prefix + path;
        }
      },
      fireImmediately: true
    })) : Promise.reject(new Error('файл бібліотеки не завантажився'));
    var detector = null;
    var nat = !('BarcodeDetector' in window) ? Promise.resolve('немає') :
      window.BarcodeDetector.getSupportedFormats().then(function (sup) {
        var fm = CODES.map(function (c) { return c[3]; }).filter(function (f) { return sup.indexOf(f) >= 0; });
        if (!fm.length) return 'є, але без потрібних форматів';
        detector = new window.BarcodeDetector({ formats: fm });
        return 'є (' + fm.length + ' форматів)';
      }, function (e) { return 'помилка: ' + e.message; });

    Promise.all([lib.then(function () { return Math.round(performance.now() - t0); }), nat]).then(function (r) {
      env.push('Бібліотека zxing-wasm 3.1.6 завантажилась за ' + r[0] + ' мс.');
      env.push('Вбудоване читання: ' + r[1] + '.');
      var okLib = 0, okNat = 0, chain = Promise.resolve();
      CODES.forEach(function (c) {
        chain = chain.then(function () {
          return loadImageData(c[0]).then(function (im) {
            var t1 = performance.now();
            return window.ZXingWASM.readBarcodes(im.data, { formats: [c[2]], tryHarder: true }).then(function (out) {
              var ms = Math.round(performance.now() - t1);
              var got = out.filter(function (x) { return x.isValid; }).map(function (x) { return x.text; });
              var libOk = got.indexOf(c[4]) >= 0;
              if (libOk) okLib++;
              var natP = detector ? detector.detect(im.canvas).then(function (o) {
                return o.map(function (x) { return x.rawValue; });
              }, function () { return null; }) : Promise.resolve(null);
              return natP.then(function (ng) {
                var natOk = ng ? ng.indexOf(c[4]) >= 0 : null;
                if (natOk) okNat++;
                var li = document.createElement('li');
                var v = document.createElement('div');
                v.className = 'val';
                v.textContent = (libOk ? '✓ ' : '✗ ') + c[1] + ': ' + c[4];
                var m = document.createElement('div');
                m.className = 'meta';
                m.textContent = 'бібліотека: ' + (libOk ? 'прочитано, ' + ms + ' мс' : 'НЕ прочитано (' + (got.join(', ') || 'нічого') + ')') +
                  (natOk === null ? '' : ' · вбудоване: ' + (natOk ? 'прочитано' : 'НЕ прочитано'));
                li.appendChild(v);
                li.appendChild(m);
                $('st-list').appendChild(li);
              });
            });
          }).catch(function (e) {
            var li = document.createElement('li');
            li.textContent = '✗ ' + c[1] + ': ' + e.message;
            $('st-list').appendChild(li);
          });
        });
      });
      return chain.then(function () {
        $('st-summary').textContent = 'Бібліотека прочитала ' + okLib + ' з ' + CODES.length +
          (detector ? '; вбудоване — ' + okNat + ' з ' + CODES.length : '') + '.';
        $('st-env').textContent = env.join(' ') + ' ' + navigator.userAgent;
        document.body.dataset.done = String(okLib);
      });
    }).catch(function (e) {
      $('st-summary').textContent = 'Помилка: ' + (e && e.message ? e.message : e);
      document.body.dataset.done = 'error';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
