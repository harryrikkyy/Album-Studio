// export_open_docs.jsx
//
// Exports OPEN Photoshop documents to JPEG — the targeted counterpart to the
// bulk folder export. Use case: you re-edited sheets and want just those
// updated, without re-exporting the whole folder.
//
// Scope (data.scope):
//   'active' → export ONLY the frontmost document (the "JPEG Export" button)
//   'all'    → export every open document (the "JPEG Export all" button)
//
// For each eligible document that is a saved .psd/.psb:
//   quality 12 → <grandparent>/JPEG-High-Res/<base>.jpg
//   quality 1  → <grandparent>/JPEG-Low-Res/<base>.jpg
// where <grandparent> is the parent of the PSD's own folder — the SAME
// layout the bulk export uses, so the matching JPEGs are replaced in place.
//
// Rules:
//   • Documents are NOT closed — you keep working. saveAs(..., asCopy=true)
//     exports a flattened JPEG of the live canvas without modifying the PSD.
//   • Unsaved / "Untitled" documents are skipped (no path to map to).
//   • Non-PSD documents (e.g. an open reference JPEG) are skipped.
//   • The originally-active document is restored at the end.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_export_open.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("export_open_docs: data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  function quoteStr(s) {
    s = String(s); var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), code = s.charCodeAt(i);
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
    if (v instanceof Array) { var a = []; for (var i=0;i<v.length;i++) a.push(toJSON(v[i])); return '[' + a.join(',') + ']'; }
    if (typeof v === 'object') { var p=[]; for (var k in v){ if(!v.hasOwnProperty(k))continue; if(typeof v[k]==='undefined')continue; p.push(quoteStr(k)+':'+toJSON(v[k])); } return '{'+p.join(',')+'}'; }
    return 'null';
  }

  var result = { ok: true, total: 0, processed: 0, skipped: 0, failed: 0, names: [], errors: [] };

  if (app.documents.length === 0) {
    result.empty = true;
  } else {
    app.preferences.rulerUnits = Units.PIXELS;

    // Snapshot the active doc so we can restore focus after iterating.
    var originalActive = null;
    try { originalActive = app.activeDocument; } catch (e) {}

    // Build the working set based on scope.
    var docs = [];
    var scope = (data && data.scope) ? data.scope : 'all';
    if (scope === 'active') {
      if (originalActive) docs.push(originalActive);
    } else {
      // Copy the document list first — saveAs/activeDocument changes
      // shouldn't mutate the collection mid-loop.
      for (var i = 0; i < app.documents.length; i++) docs.push(app.documents[i]);
    }
    result.total = docs.length;

    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      try {
        app.activeDocument = doc;

        // Must be a saved file with a real path.
        var docFile = null;
        try { docFile = doc.fullName; } catch (eP) { docFile = null; }
        if (!docFile) { result.skipped++; continue; }

        // Must be a PSD/PSB — skip open reference JPEGs/PNGs etc.
        if (!/\.(psd|psb)$/i.test(docFile.name)) { result.skipped++; continue; }

        var psdFolder = docFile.parent;             // .../PSDs
        var outParent = psdFolder.parent;           // .../  (album root)
        var hiFolder = new Folder(outParent.fsName + "/JPEG-High-Res");
        var loFolder = new Folder(outParent.fsName + "/JPEG-Low-Res");
        if (!hiFolder.exists) hiFolder.create();
        if (!loFolder.exists) loFolder.create();

        var baseName = docFile.name.replace(/\.[^\.]+$/, "");

        // High-res JPEG, quality 12. asCopy=true → exports a flattened copy;
        // the open document keeps its layers and dirty state untouched.
        var hiOpts = new JPEGSaveOptions();
        hiOpts.quality = 12;
        hiOpts.embedColorProfile = true;
        hiOpts.formatOptions = FormatOptions.STANDARDBASELINE;
        hiOpts.matte = MatteType.NONE;
        doc.saveAs(new File(hiFolder.fsName + "/" + baseName + ".jpg"), hiOpts, true, Extension.LOWERCASE);

        // Low-res JPEG, quality 1.
        var loOpts = new JPEGSaveOptions();
        loOpts.quality = 1;
        loOpts.embedColorProfile = true;
        loOpts.formatOptions = FormatOptions.STANDARDBASELINE;
        loOpts.matte = MatteType.NONE;
        doc.saveAs(new File(loFolder.fsName + "/" + baseName + ".jpg"), loOpts, true, Extension.LOWERCASE);

        result.processed++;
        result.names.push(baseName);
      } catch (e) {
        result.failed++;
        if (result.errors.length < 20) result.errors.push(((e && e.message) ? e.message : String(e)));
      }
    }

    // Restore the document the user was on.
    try { if (originalActive) app.activeDocument = originalActive; } catch (eR) {}
  }

  try {
    var outFile = new File(data.outputPath);
    outFile.encoding = "UTF-8";
    outFile.open("w");
    outFile.write(toJSON(result));
    outFile.close();
  } catch (eOut) {}
}
