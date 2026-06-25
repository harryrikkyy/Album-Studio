// extract_frames.jsx
//
// Reads a template PSD and writes its frame layer geometry to a JSON file so
// the JS-side fast renderer (proof_renderer.js) can composite without needing
// to reopen the PSD. Frame layers are anything containing "toolkithframe" or
// "toolkitvframe" in their name (matches build_page.jsx's convention).
//
// Output JSON shape:
//   {
//     ok: true,
//     canvasWidth, canvasHeight,
//     frames: [ { name, x, y, w, h }, ... ]
//   }
//
// Designed to be called via the same executeJSXFile bridge with __DATA_PATH__
// pointing at a JSON file holding { templatePath, outputPath }.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_extract_frames.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("extract_frames: data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  function findFrames(container, out) {
    for (var i = 0; i < container.layers.length; i++) {
      var l = container.layers[i];
      var n = l.name.toLowerCase();
      if (n.indexOf("toolkithframe") !== -1 || n.indexOf("toolkitvframe") !== -1) out.push(l);
      if (l.layers && l.layers.length > 0) findFrames(l, out);
    }
  }

  function getBounds(layer) {
    var b = layer.bounds;
    var x1 = b[0].as("px"), y1 = b[1].as("px");
    var x2 = b[2].as("px"), y2 = b[3].as("px");
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // Manual JSON serializer. ExtendScript SOMETIMES has JSON, but on older
  // Photoshop versions it doesn't. Worse, when it doesn't, the previous "{}"
  // fallback silently dropped the error message — surfacing as "unknown" in
  // the renderer. Write our own so we always get proper output.
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

  function describeError(e) {
    if (!e) return 'unknown error';
    // ExtendScript errors expose .message OR .description OR neither.
    // Combining them with .line / .number gives us a real signal.
    var parts = [];
    if (e.message) parts.push(String(e.message));
    if (e.description && (!e.message || String(e.description) !== String(e.message))) parts.push(String(e.description));
    if (typeof e.number !== 'undefined') parts.push('code=' + e.number);
    if (typeof e.line !== 'undefined') parts.push('line=' + e.line);
    if (parts.length === 0) {
      try { parts.push(e.toString()); } catch (_) { parts.push('(unstringifiable error)'); }
    }
    return parts.join(' · ');
  }

  var doc = null;
  var result = { ok: false, frames: [] };

  // Sanity-check the template path BEFORE handing it to app.open, so a typo or
  // moved file produces a clear error instead of an opaque ExtendScript bark.
  try {
    var tplFile = new File(data.templatePath);
    if (!tplFile.exists) {
      result.error = 'template file not found at ' + data.templatePath;
    }
  } catch (preErr) {
    result.error = 'invalid template path: ' + describeError(preErr);
  }

  if (!result.error) {
    try {
      app.preferences.rulerUnits = Units.PIXELS;
      doc = app.open(new File(data.templatePath));
      var collected = [];
      findFrames(doc, collected);
      var frames = [];
      for (var i = 0; i < collected.length; i++) {
        var b = getBounds(collected[i]);
        frames.push({ name: collected[i].name, x: b.x, y: b.y, w: b.w, h: b.h });
      }
      result.ok = true;
      result.canvasWidth = doc.width.as("px");
      result.canvasHeight = doc.height.as("px");
      result.frames = frames;
      if (frames.length === 0) {
        // Soft warning — caller can still render a backdrop-only proof, but
        // the user almost certainly wanted real frames.
        result.warning = 'no toolkithframe / toolkitvframe layers found';
      }
    } catch (e) {
      result.error = describeError(e);
    } finally {
      try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {}
    }
  }

  // Write the result so the main process can read it without parsing JSX stdout.
  try {
    var outFile = new File(data.outputPath);
    outFile.encoding = "UTF-8";
    outFile.open("w");
    outFile.write(toJSON(result));
    outFile.close();
  } catch (_) {}
}
