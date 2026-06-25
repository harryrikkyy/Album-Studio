// jpeg_export.jsx
//
// Batch-converts every .psd in a source folder to TWO JPEGs:
//   • Quality 12 → <hiResFolder>/<basename>.jpg
//   • Quality 1  → <loResFolder>/<basename>.jpg
//
// Reads { sourceFolder, hiResFolder, loResFolder, outputPath, progressPath }
// from __DATA_PATH__'s JSON. Writes a progress file after each PSD so the
// JS side can poll it for live status. Writes a final result JSON to
// outputPath when done.
//
// Why two `saveAs` calls per doc instead of duplicate-then-save: saveAs with
// asCopy=true keeps the document's "modified" state clean so we can close
// without prompting AND saveAs twice without re-opening the PSD. That's the
// whole win — one open per PSD, two outputs.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_jpeg_export.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("jpeg_export: data file not found: " + DATA_PATH); }
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

  // ── enumerate .psd files in the source folder ─────────────────────
  var srcFolder = new Folder(data.sourceFolder);
  var hiFolder  = new Folder(data.hiResFolder);
  var loFolder  = new Folder(data.loResFolder);

  if (!hiFolder.exists) hiFolder.create();
  if (!loFolder.exists) loFolder.create();

  var allFiles = srcFolder.getFiles();
  var psds = [];
  for (var i = 0; i < allFiles.length; i++) {
    if (allFiles[i] instanceof File && /\.psd$/i.test(allFiles[i].name)) {
      psds.push(allFiles[i]);
    }
  }

  var result = {
    ok: true,
    total: psds.length,
    processed: 0,
    failed: 0,
    errors: []
  };

  if (psds.length === 0) {
    writeProgress(0, 0, "no PSDs found");
  } else {
    app.preferences.rulerUnits = Units.PIXELS;
    writeProgress(0, psds.length, psds[0].name);

    for (var p = 0; p < psds.length; p++) {
      var psd = psds[p];
      var doc = null;
      try {
        doc = app.open(psd);
        var baseName = psd.name.replace(/\.psd$/i, "");

        // High-res JPEG, quality 12 (Photoshop's max).
        var hiOpts = new JPEGSaveOptions();
        hiOpts.quality = 12;
        hiOpts.embedColorProfile = true;
        hiOpts.formatOptions = FormatOptions.STANDARDBASELINE;
        hiOpts.matte = MatteType.NONE;
        var hiFile = new File(hiFolder.fsName + "/" + baseName + ".jpg");
        doc.saveAs(hiFile, hiOpts, true, Extension.LOWERCASE);

        // Low-res JPEG, quality 1 (Photoshop's lowest — tiny preview).
        var loOpts = new JPEGSaveOptions();
        loOpts.quality = 1;
        loOpts.embedColorProfile = true;
        loOpts.formatOptions = FormatOptions.STANDARDBASELINE;
        loOpts.matte = MatteType.NONE;
        var loFile = new File(loFolder.fsName + "/" + baseName + ".jpg");
        doc.saveAs(loFile, loOpts, true, Extension.LOWERCASE);

        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = null;
        result.processed++;
      } catch (e) {
        result.failed++;
        result.errors.push(psd.name + ": " + ((e && e.message) ? e.message : String(e)));
        // Make sure we don't leave a doc open across iterations.
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eC) {}
        try { if (app.documents.length > 0) app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (eC2) {}
      }
      writeProgress(p + 1, psds.length,
        (p + 1 < psds.length) ? psds[p + 1].name : "finishing…");
    }
  }

  // Write final result JSON for the JS side.
  try {
    var outFile = new File(data.outputPath);
    outFile.encoding = "UTF-8";
    outFile.open("w");
    outFile.write(toJSON(result));
    outFile.close();
  } catch (eOut) {}
}
