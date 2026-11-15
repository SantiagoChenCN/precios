// P-030 staff page. Asks the till for one product at a time; keeps nothing.
//
// The camera is reached through a plain file input rather than getUserMedia:
// on http://<till-address> a browser refuses live camera access (it needs a
// secure context), but it will still hand over a photo taken with the phone's
// own camera app. The barcode is then read from that photo, here, by zxing.
//
// P-032 (D-085): the same page is also published over HTTPS (GitHub Pages),
// where the camera is allowed live. There it talks to the till across origins:
// http://<till> from "?till=", which Chrome allows on the shop's network once
// the staff member grants "local network access". It cannot send the till a
// cookie, so it keeps the session value and sends it as X-Staff-Session.
"use strict";

(function () {
  var CODE_PATTERN = /^[0-9A-Za-z]{1,32}$/;
  var MAX_SIDE = 1600;

  var $ = function (id) { return document.getElementById(id); };
  var loginCard = $("login"), lookupView = $("lookup");
  var statusEl = $("status"), resultEl = $("result"), preview = $("preview");

  // --- Where the till is (P-032) ------------------------------------------------

  var REMOTE = location.protocol === "https:";
  var HTTPS_PAGE = "https://santiagochencn.github.io/precios/";
  // Only an address on the shop's own network, so a forged link cannot send
  // the staff code anywhere else.
  var OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
  var TILL_PATTERN = new RegExp("^(10\\." + OCTET + "\\." + OCTET + "\\." + OCTET +
    "|192\\.168\\." + OCTET + "\\." + OCTET +
    "|172\\.(1[6-9]|2\\d|3[01])\\." + OCTET + "\\." + OCTET +
    "|localhost|127\\.0\\.0\\.1):\\d{1,5}$");

  function remember(key, value) {
    try {
      if (value === null) { localStorage.removeItem(key); } else { localStorage.setItem(key, value); }
    } catch (e) { /* private window: the page still works for this visit */ }
  }
  function recalled(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var base = "";
  if (REMOTE) {
    var asked = new URLSearchParams(location.search).get("till");
    if (asked !== null) {
      if (TILL_PATTERN.test(asked)) { remember("till", asked); }
      history.replaceState(null, "", location.pathname);
    }
    var till = recalled("till");
    base = till && TILL_PATTERN.test(till) ? "http://" + till : null;
  }

  var OFFLINE = REMOTE
    ? "No se puede conectar con la caja. Verifique que está en el WiFi del local y que Chrome tiene permiso de «red local» (toque el candado junto a la dirección)."
    : "No se puede conectar con la caja. Verifique que está en el WiFi del local.";


  function show(view) {
    loginCard.classList.toggle("hidden", view !== "login");
    lookupView.classList.toggle("hidden", view !== "lookup");
    if (view === "login") { $("login-code").focus(); }
  }

  function setStatus(el, text, bad) {
    el.textContent = text || "";
    el.classList.toggle("bad", !!bad);
    el.classList.remove("ok");
  }

  function request(method, url, body) {
    if (base === null) { return Promise.reject(new Error("no till address")); }
    var options = { method: method, credentials: REMOTE ? "omit" : "same-origin", cache: "no-store", headers: {} };
    if (REMOTE) {
      var session = recalled("session");
      if (session) { options.headers["X-Staff-Session"] = session; }
    }
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(base + url, options).then(function (response) {
      if (REMOTE && response.status === 401) { remember("session", null); }
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { status: response.status, data: data };
      });
    });
  }

  // --- Login -----------------------------------------------------------------

  $("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var status = $("login-status");
    setStatus(status, "Verificando…");
    request("POST", "/api/login", { code: $("login-code").value.trim() }).then(function (r) {
      if (r.status === 200) {
        if (REMOTE && r.data.token) { remember("session", String(r.data.token)); }
        $("login-code").value = "";
        setStatus(status, "");
        show("lookup");
        handleReturnedScan();
      } else if (r.status === 429) {
        setStatus(status, "Demasiados intentos. Espere un minuto y vuelva a probar.", true);
      } else {
        setStatus(status, "Código incorrecto.", true);
      }
    }).catch(function () {
      setStatus(status, OFFLINE, true);
    });
  });

  // --- Lookup ----------------------------------------------------------------

  // The shop's shelf format, the same as the phone's PriceFormat.java:
  // "." between thousands, "," before cents, cents only when there are any.
  function formatPrice(value) {
    var cents = Math.round(Number(value) * 100);
    var whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    var rest = cents % 100;
    return "$ " + whole + (rest ? "," + (rest < 10 ? "0" : "") + rest : "");
  }

  function escapeText(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function renderResult(code, items) {
    resultEl.classList.remove("hidden");
    offerReport(code, items);
    if (!items.length) {
      resultEl.innerHTML =
        '<p class="result-flag bad">Este producto no está en el sistema de caja</p>' +
        '<p class="result-meta">Código buscado: ' + escapeText(code) + "</p>";
      return;
    }
    resultEl.innerHTML = items.map(function (item) {
      var priced = Number(item.price) > 0;
      var stopped = item.on_sale ? "" : '<span class="tag">Discontinuado</span>';
      var priceLine = priced
        ? '<p class="result-price">' + formatPrice(item.price) + "</p>"
        : '<p class="result-flag warn">Sin precio en el sistema de caja</p>';
      return '<div class="item">' +
        '<p class="result-name">' + escapeText(item.name || "(sin nombre)") + stopped + "</p>" +
        priceLine +
        '<p class="result-meta">Código de barras ' + escapeText(item.barcode || "—") +
        " · Código interno " + escapeText(item.gid) + "</p>" +
        "</div>";
    }).join("");
  }

  function lookup(code) {
    code = (code || "").trim();
    if (!CODE_PATTERN.test(code)) {
      setStatus(statusEl, "El código solo puede tener números o letras, hasta 32.", true);
      return;
    }
    $("code").value = code;
    hideReport();
    setStatus(statusEl, "Buscando " + code + " …");
    request("GET", "/api/price?code=" + encodeURIComponent(code)).then(function (r) {
      if (r.status === 401) { setStatus(statusEl, ""); show("login"); return; }
      if (r.status === 503) { setStatus(statusEl, "El sistema de caja no responde. Intente de nuevo en un momento.", true); return; }
      if (r.status !== 200) { setStatus(statusEl, "Error en la búsqueda (" + r.status + ").", true); return; }
      setStatus(statusEl, "");
      renderResult(code, r.data.items || []);
    }).catch(function () {
      setStatus(statusEl, OFFLINE, true);
    });
  }

  $("code-form").addEventListener("submit", function (event) {
    event.preventDefault();
    lookup($("code").value);
  });

  // --- Photo -> barcode --------------------------------------------------------

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () { resolve({ image: image, url: url }); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error("image")); };
      image.src = url;
    });
  }

  // A region of the photo (fractions of its width and height), drawn so its
  // longer side is at most maxSide. Phones take photos of 12 to 50 megapixels,
  // and one big jump down aliases thin bars into grey, so large reductions go
  // in halving steps with high-quality smoothing.
  // A zoom above 1 enlarges the region instead: a barcode a few metres of
  // shelf away has bars under two pixels wide, which the reader misses at
  // their own size and reads once doubled.
  function drawRegion(image, region, maxSide, rotate, zoom) {
    var sx = Math.round(region.x * image.naturalWidth), sy = Math.round(region.y * image.naturalHeight);
    var sw = Math.round(region.w * image.naturalWidth), sh = Math.round(region.h * image.naturalHeight);
    var source = image, srcX = sx, srcY = sy, srcW = sw, srcH = sh;
    var scale = zoom || Math.min(1, maxSide / Math.max(sw, sh));
    while (scale < 0.5) {
      var half = document.createElement("canvas");
      half.width = Math.round(srcW / 2);
      half.height = Math.round(srcH / 2);
      var hctx = half.getContext("2d");
      hctx.imageSmoothingQuality = "high";
      hctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, half.width, half.height);
      source = half; srcX = 0; srcY = 0; srcW = half.width; srcH = half.height;
      scale *= 2;
    }
    var w = Math.round(srcW * scale), h = Math.round(srcH * scale);
    var canvas = document.createElement("canvas");
    canvas.width = rotate ? h : w;
    canvas.height = rotate ? w : h;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    if (rotate) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, w, h);
    return canvas;
  }

  function drawScaled(image, rotate) {
    return drawRegion(image, WHOLE, MAX_SIDE, rotate);
  }

  var WHOLE = { x: 0, y: 0, w: 1, h: 1 };
  // What to try, cheapest first. The whole photo at three sizes (a large
  // barcode reads best small, a small one large), then overlapping crops of
  // the middle and the four quarters, for a barcode that fills little of the
  // frame.
  var ATTEMPTS = [
    { region: WHOLE, side: 1024 },
    { region: WHOLE, side: 1600 },
    { region: WHOLE, side: 2400 },
    { region: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, side: 1600 },
    { region: { x: 0, y: 0, w: 0.6, h: 0.6 }, side: 1600 },
    { region: { x: 0.4, y: 0, w: 0.6, h: 0.6 }, side: 1600 },
    { region: { x: 0, y: 0.4, w: 0.6, h: 0.6 }, side: 1600 },
    { region: { x: 0.4, y: 0.4, w: 0.6, h: 0.6 }, side: 1600 },
    // Last, the middle enlarged: staff aim the barcode at the centre.
    { region: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, zoom: 2 },
    { region: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, zoom: 2 }
  ];

  // ZXing-C++ compiled to WebAssembly (barcode-detector.js + zxing_reader.wasm,
  // served from the till): it reads tilted, small and rotated barcodes far
  // better than zxing-js, which stays only as the fallback for a browser that
  // cannot run it.
  var FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar"];
  var detector = null;
  function getDetector() {
    if (detector) { return detector; }
    var api = window.BarcodeDetectionAPI;
    if (!api || typeof WebAssembly !== "object") { return null; }
    api.prepareZXingModule({
      overrides: {
        locateFile: function (path, prefix) {
          return /\.wasm$/.test(path) ? "zxing_reader.wasm" : prefix + path;
        }
      }
    });
    detector = new api.BarcodeDetector({ formats: FORMATS });
    return detector;
  }

  function firstCode(codes) {
    for (var i = 0; i < codes.length; i++) {
      if (CODE_PATTERN.test(codes[i].rawValue)) { return codes[i].rawValue; }
    }
    return null;
  }

  function readWithZxingCpp(image) {
    var d = getDetector();
    if (!d) { return Promise.reject(new Error("no wasm")); }
    var index = 0;
    function next() {
      if (index >= ATTEMPTS.length) { return Promise.resolve(null); }
      var attempt = ATTEMPTS[index++];
      return d.detect(drawRegion(image, attempt.region, attempt.side, false, attempt.zoom)).then(function (codes) {
        return firstCode(codes) || next();
      });
    }
    return next();
  }

  function readWithZxingJs(image) {
    return decodeCanvas(drawScaled(image, false)) || decodeCanvas(drawScaled(image, true));
  }

  var reader = null;
  function getReader() {
    if (reader) { return reader; }
    var Z = window.ZXing;
    var hints = new Map();
    var F = Z.BarcodeFormat;
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.CODABAR
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    return reader;
  }

  function decodeCanvas(canvas) {
    var Z = window.ZXing;
    var source = new Z.HTMLCanvasElementLuminanceSource(canvas);
    var bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
    try {
      return getReader().decode(bitmap).getText();
    } catch (error) {
      return null;
    } finally {
      getReader().reset();
    }
  }

  // Exported for the page's own checks; nothing else uses it.
  // Resolves to the code, or null.
  window.staffDecodeImage = function (image) {
    return readWithZxingCpp(image).catch(function () {
      return readWithZxingJs(image);
    });
  };

  $("photo").addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) { return; }
    setStatus(statusEl, "Leyendo el código de barras…");
    resultEl.classList.add("hidden");
    hideReport();
    loadImage(file).then(function (loaded) {
      if (preview.dataset.url) { URL.revokeObjectURL(preview.dataset.url); }
      preview.src = loaded.url;
      preview.dataset.url = loaded.url;
      preview.classList.remove("hidden");
      // Let the status paint before the decoder blocks the thread.
      setTimeout(function () {
        window.staffDecodeImage(loaded.image).then(function (text) {
          if (text) {
            lookup(text);
          } else {
            setStatus(statusEl, "No se reconoció el código. Acérquese, enfoque el código de barras y saque otra foto, o escríbalo.", true);
            $("code").focus();
          }
        });
      }, 30);
    }).catch(function () {
      setStatus(statusEl, "No se pudo abrir la foto. Saque otra.", true);
    });
  });

  // --- Report to the Owner (Stage B, D-080) -------------------------------------
  //
  // After a lookup, staff can tell the Owner about the product. One that has a
  // price only lost its label, so a photo is optional; one with no price, or
  // not in the POS at all, needs a photo of the product, because the Owner has
  // to see what to price. The photo is shrunk here and sent once; nothing is
  // kept in the browser.

  var REPORT_TEXT = {
    label: { button: "Avisar: falta la etiqueta", hint: "La foto es opcional.", photo: false },
    no_price: { button: "Avisar: no tiene precio", hint: "Saque una foto del producto entero.", photo: true },
    not_in_pos: { button: "Avisar: no está en caja", hint: "Saque una foto del producto entero.", photo: true }
  };
  var PHOTO_SIDE = 1280;
  var PHOTO_TARGET_BYTES = 200000;
  var reportEl = $("report"), reportStatus = $("report-status"), reportPreview = $("report-preview");
  var report = null;

  function hideReport() {
    report = null;
    reportEl.classList.add("hidden");
    clearReportPhoto();
  }

  function clearReportPhoto() {
    if (reportPreview.dataset.url) { URL.revokeObjectURL(reportPreview.dataset.url); delete reportPreview.dataset.url; }
    reportPreview.removeAttribute("src");
    reportPreview.classList.add("hidden");
    $("report-photo-label").textContent = "Foto del producto";
  }

  function offerReport(code, items) {
    var kind = !items.length ? "not_in_pos"
      : items.some(function (item) { return Number(item.price) > 0; }) ? "label" : "no_price";
    report = { code: code, kind: kind, photo: null };
    clearReportPhoto();
    $("report-open").textContent = REPORT_TEXT[kind].button;
    $("report-open").classList.remove("hidden");
    $("report-hint").textContent = REPORT_TEXT[kind].hint;
    $("report-note").value = "";
    $("report-form").classList.add("hidden");
    $("report-send").disabled = false;
    setStatus(reportStatus, "");
    reportEl.classList.remove("hidden");
  }

  $("report-open").addEventListener("click", function () {
    $("report-open").classList.add("hidden");
    $("report-form").classList.remove("hidden");
  });

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", quality); });
  }

  // A JPEG of at most PHOTO_SIDE on its longer side, at the best quality that
  // stays under PHOTO_TARGET_BYTES.
  function shrinkPhoto(image) {
    var scale = Math.min(1, PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    var canvas = drawScaledTo(image, scale);
    var qualities = [0.8, 0.65, 0.5, 0.4];
    function attempt(i) {
      return canvasToBlob(canvas, qualities[i]).then(function (blob) {
        if (!blob) { throw new Error("jpeg"); }
        if (blob.size <= PHOTO_TARGET_BYTES || i === qualities.length - 1) { return blob; }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  function drawScaledTo(image, scale) {
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    var context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).replace(/^data:[^,]*,/, "")); };
      reader.onerror = function () { reject(new Error("read")); };
      reader.readAsDataURL(blob);
    });
  }

  $("report-photo").addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file || !report) { return; }
    var forCode = report.code;
    setStatus(reportStatus, "Preparando la foto…");
    loadImage(file).then(function (loaded) {
      return shrinkPhoto(loaded.image).then(function (blob) {
        URL.revokeObjectURL(loaded.url);
        if (!report || report.code !== forCode) { return; }
        report.photo = blob;
        clearReportPhoto();
        reportPreview.dataset.url = URL.createObjectURL(blob);
        reportPreview.src = reportPreview.dataset.url;
        reportPreview.classList.remove("hidden");
        $("report-photo-label").textContent = "Cambiar la foto";
        setStatus(reportStatus, "");
      });
    }).catch(function () {
      setStatus(reportStatus, "No se pudo abrir la foto. Saque otra.", true);
    });
  });

  $("report-send").addEventListener("click", function () {
    if (!report) { return; }
    if (REPORT_TEXT[report.kind].photo && !report.photo) {
      setStatus(reportStatus, "Falta la foto del producto.", true);
      return;
    }
    var sending = report;
    $("report-send").disabled = true;
    setStatus(reportStatus, "Enviando…");
    var photo = sending.photo ? blobToBase64(sending.photo) : Promise.resolve("");
    photo.then(function (base64) {
      return request("POST", "/api/report", {
        code: sending.code, kind: sending.kind, note: $("report-note").value.trim(), photo: base64
      });
    }).then(function (r) {
      if (report !== sending) { return; }
      if (r.status === 401) { show("login"); return; }
      if (r.status !== 200) {
        $("report-send").disabled = false;
        var why = r.data && r.data.error;
        setStatus(reportStatus,
          why === "photo_required" ? "Falta la foto del producto." :
          why === "too_many_reports" ? "Hay demasiados avisos pendientes. Avise al dueño." :
          r.status === 413 ? "La foto es demasiado grande. Saque otra." :
          "No se pudo enviar el aviso (" + r.status + ").", true);
        return;
      }
      $("report-form").classList.add("hidden");
      setStatus(reportStatus, r.data.merged
        ? "Ya estaba avisado. Ahora son " + r.data.count + " avisos."
        : "Aviso enviado. Gracias.");
      reportStatus.classList.add("ok");
      clearReportPhoto();
      report = null;
    }).catch(function () {
      if (report !== sending) { return; }
      $("report-send").disabled = false;
      setStatus(reportStatus, OFFLINE, true);
    });
  });

  // --- Google scanner (Android) ------------------------------------------------
  //
  // The Owner's app scans with Google's code scanner, which a web page cannot
  // call. On Android the page hands over to a small app, «Escáner de precios»
  // (android/staffscan, D-079): it runs that scanner and opens this page again
  // with "#code=<code>" (or "#scan=cancel|error|invalid"), in the same browser,
  // where the code is looked up. Without the app installed, the browser follows
  // the fallback to /escaner, which explains how to install it.

  var SCANNER_PACKAGE = "com.supermarket.staffscan";
  var googleScan = $("google-scan");

  function scannerLink() {
    var page = location.protocol + "//" + location.host + "/";
    return "intent://scan?ret=" + encodeURIComponent(page) +
      "#Intent;scheme=supermercado-scan;package=" + SCANNER_PACKAGE +
      ";S.browser_fallback_url=" + encodeURIComponent(page + "escaner") + ";end";
  }

  // The scanner app only returns to the plain-HTTP page, so the HTTPS page,
  // which scans live itself, does not offer it.
  if (!REMOTE && /Android/i.test(navigator.userAgent)) {
    googleScan.classList.remove("hidden");
    $("photo-button").classList.add("secondary");
    googleScan.addEventListener("click", function () {
      setStatus(statusEl, "Abriendo el escáner de Google…");
      location.href = scannerLink();
    });
    // P-032: the way to the HTTPS copy, which scans live (Chrome on Android).
    var httpsLink = $("https-link");
    httpsLink.href = HTTPS_PAGE + "?till=" + encodeURIComponent(location.host);
    httpsLink.classList.remove("hidden");
    googleScan.classList.add("secondary");
  }

  // --- Live camera (HTTPS page only, P-032) ------------------------------------
  //
  // A browser allows getUserMedia only in a secure context, which the HTTPS
  // copy is. Chrome's own BarcodeDetector reads the video when it knows EAN-13;
  // otherwise the ZXing-C++ detector above does. Every start bumps liveRun, so
  // a camera that opens after the staff member closed it is stopped at once.

  var liveButton = $("live-scan"), liveBox = $("live"), liveVideo = $("live-video");
  var liveStream = null, liveTimer = null, liveRun = 0, liveDetector = null;

  function getLiveDetector() {
    if (liveDetector) { return Promise.resolve(liveDetector); }
    var native = window.BarcodeDetector && window.BarcodeDetector.getSupportedFormats
      ? window.BarcodeDetector.getSupportedFormats().catch(function () { return []; })
      : Promise.resolve([]);
    return native.then(function (formats) {
      var usable = FORMATS.filter(function (f) { return formats.indexOf(f) >= 0; });
      liveDetector = usable.indexOf("ean_13") >= 0
        ? new window.BarcodeDetector({ formats: usable })
        : getDetector();
      if (!liveDetector) { throw new Error("no detector"); }
      return liveDetector;
    });
  }

  function stopLive() {
    liveRun++;
    clearTimeout(liveTimer);
    if (liveStream) { liveStream.getTracks().forEach(function (track) { track.stop(); }); }
    liveStream = null;
    liveVideo.srcObject = null;
    liveBox.classList.add("hidden");
    liveButton.disabled = false;
  }

  function startLive() {
    stopLive();
    var run = liveRun;
    liveButton.disabled = true;
    setStatus(statusEl, "Abriendo la cámara…");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(function (stream) {
        if (run !== liveRun) { stream.getTracks().forEach(function (track) { track.stop(); }); return null; }
        liveStream = stream;
        liveBox.classList.remove("hidden");
        liveVideo.srcObject = stream;
        return liveVideo.play().then(getLiveDetector);
      })
      .then(function (detector) {
        if (!detector || run !== liveRun) { return; }
        setStatus(statusEl, "Apunte la cámara al código de barras.");
        (function scan() {
          if (run !== liveRun) { return; }
          var found = liveVideo.videoWidth ? detector.detect(liveVideo) : Promise.resolve([]);
          found.then(function (codes) {
            if (run !== liveRun) { return; }
            var code = firstCode(codes);
            if (code) {
              stopLive();
              if (navigator.vibrate) { navigator.vibrate(60); }
              lookup(code);
              return;
            }
            liveTimer = setTimeout(scan, 150);
          }, function () {
            if (run === liveRun) { liveTimer = setTimeout(scan, 300); }
          });
        })();
      })
      .catch(function (error) {
        if (run !== liveRun) { return; }
        stopLive();
        setStatus(statusEl, error && error.name === "NotAllowedError"
          ? "Chrome no tiene permiso para la cámara. Permítalo (candado junto a la dirección) o saque una foto."
          : "No se pudo abrir la cámara. Saque una foto del código o escríbalo.", true);
      });
  }

  if (REMOTE && window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    liveButton.classList.remove("hidden");
    $("photo-button").classList.add("secondary");
    liveButton.addEventListener("click", startLive);
    $("live-stop").addEventListener("click", function () { stopLive(); setStatus(statusEl, ""); });
    window.addEventListener("pagehide", stopLive);
    document.addEventListener("visibilitychange", function () { if (document.hidden) { stopLive(); } });
  }

  // What the scanner sent back, read once and then removed from the address,
  // so a reload does not look the same code up again.
  function takeReturnedScan() {
    var match = /^#(code|scan)=([0-9A-Za-z]{1,32})$/.exec(location.hash);
    if (location.hash) { history.replaceState(null, "", location.pathname); }
    if (!match) { return null; }
    return { kind: match[1], value: match[2] };
  }

  var returned = takeReturnedScan();

  function handleReturnedScan() {
    var scan = returned;
    returned = null;
    if (!scan) { return; }
    if (scan.kind === "code") {
      if (preview.dataset.url) { URL.revokeObjectURL(preview.dataset.url); delete preview.dataset.url; }
      preview.classList.add("hidden");
      lookup(scan.value);
    } else if (scan.value === "error") {
      setStatus(statusEl, "No se pudo usar el escáner de Google. Saque una foto del código.", true);
    } else if (scan.value === "invalid") {
      setStatus(statusEl, "El código leído no es válido. Pruebe otra vez o escríbalo.", true);
    }
  }

  // --- Start -------------------------------------------------------------------

  if (base === null) {
    show("login");
    $("login-form").classList.add("hidden");
    setStatus($("login-status"),
      "Esta página no sabe dónde está la caja. Ábrala con el botón «Escanear con la cámara (nuevo)» de la página de precios de la caja.", true);
    return;
  }

  request("GET", "/api/session").then(function (r) {
    show(r.status === 200 ? "lookup" : "login");
    if (r.status === 200) { handleReturnedScan(); }
  }).catch(function () {
    show("login");
    setStatus($("login-status"), OFFLINE, true);
  });
})();
