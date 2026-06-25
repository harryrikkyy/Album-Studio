// inject_photo.jsx
//
// Injects a photo into the ACTIVE layer of the active Photoshop document —
// the engine behind Tab 6's double-click "smart inject". Runs through the
// osascript/JSX bridge (the path that actually works in this Electron build),
// NOT the UXP stub.
//
// Reads { filePath, layerName, outputPath } from __DATA_PATH__.
// Behavior mirrors the old UXP intent:
//   • Requires an open document and exactly one selected/active layer.
//   • Places the photo, scales it to COVER the active layer's bounds,
//     centers it, and clips/groups it so it sits in that frame.
//   • Writes { ok, error?, reason? } JSON back for a clean renderer toast.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_inject.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("inject_photo: data file not found: " + DATA_PATH); }
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
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return quoteStr(v);
    if (typeof v === 'object') { var p=[]; for (var k in v){ if(!v.hasOwnProperty(k))continue; if(typeof v[k]==='undefined')continue; p.push(quoteStr(k)+':'+toJSON(v[k])); } return '{'+p.join(',')+'}'; }
    return 'null';
  }
  function writeResult(obj) {
    try {
      var outFile = new File(data.outputPath);
      outFile.encoding = "UTF-8";
      outFile.open("w");
      outFile.write(toJSON(obj));
      outFile.close();
    } catch (e) {}
  }

  function getBounds(layer) {
    var b = layer.bounds;
    var x1 = b[0].as("px"), y1 = b[1].as("px");
    var x2 = b[2].as("px"), y2 = b[3].as("px");
    return { w: x2 - x1, h: y2 - y1, cx: x1 + (x2 - x1) / 2, cy: y1 + (y2 - y1) / 2 };
  }

  // ── Preconditions, checked against REAL Photoshop state ──────────────
  if (app.documents.length === 0) {
    writeResult({ ok: false, reason: 'no_document' });
  } else {
    try {
      app.preferences.rulerUnits = Units.PIXELS;
      var doc = app.activeDocument;
      var frameLayer = doc.activeLayer; // the layer the user has selected
      if (!frameLayer) {
        writeResult({ ok: false, reason: 'no_layer' });
      } else {
        var fb = getBounds(frameLayer);

        // Place the photo as a new (embedded) layer.
        var idPlc = charIDToTypeID("Plc ");
        var desc = new ActionDescriptor();
        desc.putPath(charIDToTypeID("null"), new File(data.filePath));
        desc.putBoolean(charIDToTypeID("Lnkd"), false);
        executeAction(idPlc, desc, DialogModes.NO);

        var placedLayer = doc.activeLayer;
        if (data.layerName) placedLayer.name = data.layerName;

        // Move directly above the frame layer and clip into it.
        placedLayer.move(frameLayer, ElementPlacement.PLACEBEFORE);
        doc.activeLayer = placedLayer;
        executeAction(charIDToTypeID("GrpL"), new ActionDescriptor(), DialogModes.NO); // create clipping mask

        // Cover-fit: scale so the photo fully covers the frame, then center.
        var pb = getBounds(placedLayer);
        var scale = Math.max(fb.w / pb.w, fb.h / pb.h) * 100;
        placedLayer.resize(scale, scale, AnchorPosition.MIDDLECENTER);
        pb = getBounds(placedLayer);
        placedLayer.translate(fb.cx - pb.cx, fb.cy - pb.cy);

        writeResult({ ok: true });
      }
    } catch (e) {
      writeResult({ ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  }
}
