// resize_psds.jsx
//
// Batch-resizes every .psd in a source folder proportionally to a target
// HEIGHT of 12 inches at 300 ppi (= 3600 px tall, width scales to keep aspect),
// then saves as PSD. Two modes:
//   • mode "overwrite" → save back over the original file
//   • mode "copy"      → save into <sourceFolder>/Resized/<name>.psd
//
// Reads { sourceFolder, mode, outputPath, progressPath } from __DATA_PATH__'s
// JSON. Writes a progress file after each PSD (polled by the JS side) and a
// final result JSON to outputPath. Mirrors jpeg_export.jsx's structure.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_resize_psds.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("resize_psds: data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  // ── manual JSON serializer (older PS versions ship without JSON) ──────
  function quoteStr(s) {
    s = String(s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"' || c === '\\') out += '\\' + c;
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 0x20) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }
  function toJSON(v) {
    if (v === null || typeof v === 'undefined') return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return quoteStr(v);
    if (v instanceof Array) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (typeof v === 'object') {
      var pairs = [];
      for (var k in v) {
        if (!v.hasOwnProperty(k)) continue;
        if (typeof v[k] === 'undefined') continue;
        pairs.push(quoteStr(k) + ':' + toJSON(v[k]));
      }
      return '{' + pairs.join(',') + '}';
    }
    return 'null';
  }

  function writeProgress(done, total, current) {
    if (!data.progressPath) return;
    try {
      var pf = new File(data.progressPath);
      pf.encoding = "UTF-8";
      pf.open("w");
      pf.write(toJSON({ done: done, total: total, current: current || "" }));
      pf.close();
    } catch (eP) { /* progress is best-effort */ }
  }

  var TARGET_H_PX = 3600;   // 12 inches × 300 ppi
  var TARGET_RES  = 300;

  var srcFolder = new Folder(data.sourceFolder);
  var overwrite = (data.mode === "overwrite");

  var outFolder = srcFolder;
  if (!overwrite) {
    outFolder = new Folder(srcFolder.fsName + "/Resized");
    if (!outFolder.exists) outFolder.create();
  }

  var allFiles = srcFolder.getFiles();
  var psds = [];
  for (var i = 0; i < allFiles.length; i++) {
    if (allFiles[i] instanceof File && /\.psd$/i.test(allFiles[i].name)) {
      psds.push(allFiles[i]);
    }
  }

  var result = { ok: true, total: psds.length, processed: 0, failed: 0, errors: [] };

  if (psds.length === 0) {
    writeProgress(0, 0, "no PSDs found");
  } else {
    var origUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    writeProgress(0, psds.length, psds[0].name);

    var psdOpts = new PhotoshopSaveOptions();
    psdOpts.embedColorProfile = true;
    psdOpts.maximizeCompatibility = true;

    // Pick a resample method that exists in this PS version.
    var resample = ResampleMethod.BICUBIC;
    try { if (ResampleMethod.BICUBICAUTOMATIC) resample = ResampleMethod.BICUBICAUTOMATIC; } catch (eR) {}

    for (var p = 0; p < psds.length; p++) {
      var psd = psds[p];
      var doc = null;
      try {
        doc = app.open(psd);
        // Proportional: only height is constrained; width follows. Resolution
        // 300 + height 3600 px = 12 in tall at 300 ppi.
        doc.resizeImage(undefined, UnitValue(TARGET_H_PX, "px"), TARGET_RES, resample);

        var baseName = psd.name.replace(/\.psd$/i, "");
        var outFile = overwrite
          ? new File(psd.fsName)
          : new File(outFolder.fsName + "/" + baseName + ".psd");
        doc.saveAs(outFile, psdOpts, true, Extension.LOWERCASE);

        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = null;
        result.processed++;
      } catch (e) {
        result.failed++;
        result.errors.push(psd.name + ": " + ((e && e.message) ? e.message : String(e)));
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eC) {}
        try { if (app.documents.length > 0) app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (eC2) {}
      }
      writeProgress(p + 1, psds.length,
        (p + 1 < psds.length) ? psds[p + 1].name : "finishing…");
    }

    try { app.preferences.rulerUnits = origUnits; } catch (eU) {}
  }

  try {
    var rf = new File(data.outputPath);
    rf.encoding = "UTF-8";
    rf.open("w");
    rf.write(toJSON(result));
    rf.close();
  } catch (eOut) {}
}
