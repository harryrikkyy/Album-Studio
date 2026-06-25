// raw_thumbnails.jsx
//
// RAW-only thumbnail lane. The fast lane (sharp/libvips, main process) handles
// every JPEG/PNG/TIFF/HEIC; this script only processes the RAW files that
// genuinely need Camera Raw. Reads { folderPath, rawFiles[], outputPath,
// progressPath } and writes a `<basename>.jpg` proxy into _Thumbnails for each.
//
// Progress is streamed via progressPath (polled by the main process), matching
// the jpeg_export.jsx pattern — no blocking alert() in the loop.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_raw_thumbs.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("raw_thumbnails: data file not found: " + DATA_PATH); }
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
  function writeProgress(done, total, current) {
    if (!data.progressPath) return;
    try { var pf = new File(data.progressPath); pf.encoding = "UTF-8"; pf.open("w"); pf.write(toJSON({ done: done, total: total, current: current || "" })); pf.close(); } catch (e) {}
  }

  var folderPath = data.folderPath;
  var rawFiles = data.rawFiles || [];
  var thumbFolder = new Folder(folderPath + "/_Thumbnails");
  if (!thumbFolder.exists) thumbFolder.create();

  var result = { ok: true, processed: 0, failed: 0, total: rawFiles.length, errors: [] };

  if (rawFiles.length > 0) {
    app.preferences.rulerUnits = Units.PIXELS;
    writeProgress(0, rawFiles.length, rawFiles[0]);

    for (var i = 0; i < rawFiles.length; i++) {
      var file = new File(folderPath + "/" + rawFiles[i]);
      var doc = null;
      try {
        doc = app.open(file);
        try { doc.flatten(); } catch(e) {}
        try { doc.bitsPerChannel = BitsPerChannelType.EIGHT; } catch(e) {}
        var w = doc.width.as("px"), h = doc.height.as("px");
        if (w > h) doc.resizeImage(UnitValue(400, "px"), null, null, ResampleMethod.BICUBIC);
        else       doc.resizeImage(null, UnitValue(400, "px"), null, ResampleMethod.BICUBIC);

        var baseName = rawFiles[i].replace(/\.[^\.]+$/, "");
        var saveFile = new File(folderPath + "/_Thumbnails/" + baseName + ".jpg");
        var jpegOptions = new JPEGSaveOptions();
        jpegOptions.quality = 6;
        jpegOptions.matte = MatteType.NONE;
        doc.saveAs(saveFile, jpegOptions, true, Extension.LOWERCASE);
        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = null;
        result.processed++;
      } catch(e) {
        result.failed++;
        if (result.errors.length < 20) result.errors.push(rawFiles[i] + ": " + ((e && e.message) ? e.message : String(e)));
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch(ex) {}
        try { if (app.documents.length > 0) app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch(ex2) {}
      }
      writeProgress(i + 1, rawFiles.length, (i + 1 < rawFiles.length) ? rawFiles[i + 1] : "finishing…");
    }
  }

  try { var outFile = new File(data.outputPath); outFile.encoding = "UTF-8"; outFile.open("w"); outFile.write(toJSON(result)); outFile.close(); } catch (eOut) {}
}
