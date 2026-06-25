// build_pages_batch.jsx
//
// Warm-process batch builder. Reads a list of page jobs that all share the
// same template path, opens the template ONCE, then for each page duplicates
// the open template, places photos, saves the result, and closes the safe
// duplicate. The original template stays open across pages.
//
// Why: opening a multi-MB PSD costs 1–4 seconds depending on its complexity.
// On an iterative render of 50 pages that all use the same template, this
// drops total render time by ~30–50%.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_pages_batch.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("Batch data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  // data = { templatePath, outputPath, pages: [{ pageName, photos: [...] }, ...] }

  function findFrames(pattern, container) {
    var result = [];
    for (var i = 0; i < container.layers.length; i++) {
      var l = container.layers[i];
      if (l.name.toLowerCase().indexOf(pattern) !== -1) result.push(l);
      if (l.layers && l.layers.length > 0) {
        var nested = findFrames(pattern, l);
        result = result.concat(nested);
      }
    }
    return result;
  }

  function getBounds(layer) {
    var b = layer.bounds;
    var x1 = b[0].as("px"), y1 = b[1].as("px");
    var x2 = b[2].as("px"), y2 = b[3].as("px");
    return { w:x2-x1, h:y2-y1, cx:x1+(x2-x1)/2, cy:y1+(y2-y1)/2 };
  }

  function placeAndFit(filePath, frameLayer, rotation, layerName, placement) {
    app.activeDocument.activeLayer = frameLayer;
    var idPlc = charIDToTypeID("Plc ");
    var desc = new ActionDescriptor();
    desc.putPath(charIDToTypeID("null"), new File(filePath));
    desc.putBoolean(charIDToTypeID("Lnkd"), false);
    executeAction(idPlc, desc, DialogModes.NO);

    var placedLayer = app.activeDocument.activeLayer;
    placedLayer.name = layerName;
    placedLayer.move(frameLayer, ElementPlacement.PLACEBEFORE);
    app.activeDocument.activeLayer = placedLayer;
    executeAction(charIDToTypeID("GrpL"), new ActionDescriptor(), DialogModes.NO);

    if (rotation && rotation !== 0) {
      var rotDesc = new ActionDescriptor();
      var rotRef = new ActionReference();
      rotRef.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
      rotDesc.putReference(charIDToTypeID("null"), rotRef);
      rotDesc.putUnitDouble(charIDToTypeID("Angl"), charIDToTypeID("#Ang"), rotation);
      rotDesc.putEnumerated(stringIDToTypeID("freeTransformCenterState"), stringIDToTypeID("quadCenterState"), stringIDToTypeID("QCSAverage"));
      executeAction(charIDToTypeID("Rtte"), rotDesc, DialogModes.NO);
    }

    // Placement transform (zoom/pan), matching the libvips preview. Defaults
    // reduce to cover-fit + centered.
    var userScale = (placement && placement.scale) ? placement.scale : 1;
    if (userScale < 1) userScale = 1;
    var ox = (placement && placement.ox) ? placement.ox : 0;
    var oy = (placement && placement.oy) ? placement.oy : 0;
    if (ox < -1) ox = -1; if (ox > 1) ox = 1;
    if (oy < -1) oy = -1; if (oy > 1) oy = 1;

    var fb = getBounds(frameLayer);
    var pb = getBounds(placedLayer);
    var scale = Math.max(fb.w / pb.w, fb.h / pb.h) * userScale * 100;
    placedLayer.resize(scale, scale, AnchorPosition.MIDDLECENTER);
    pb = getBounds(placedLayer);
    var tx = (fb.cx - pb.cx) + (-ox * (pb.w - fb.w) / 2);
    var ty = (fb.cy - pb.cy) + (-oy * (pb.h - fb.h) / 2);
    placedLayer.translate(tx, ty);
  }

  var failures = 0, successes = 0;

  try {
    app.preferences.rulerUnits = Units.PIXELS;
    // Open the template ONCE for the whole batch. Every page duplicates from it.
    var templateDoc = app.open(new File(data.templatePath));

    for (var pIdx = 0; pIdx < data.pages.length; pIdx++) {
      var page = data.pages[pIdx];
      try {
        app.activeDocument = templateDoc;
        var pageName = "Page_" + page.pageName;
        var safeDoc = templateDoc.duplicate(pageName);
        app.activeDocument = safeDoc;

        var hFrames = findFrames("toolkithframe", safeDoc);
        var vFrames = findFrames("toolkitvframe", safeDoc);
        hFrames.sort(function(a,b){ return a.name.localeCompare(b.name); });
        vFrames.sort(function(a,b){ return a.name.localeCompare(b.name); });

        var hPhotos = [], vPhotos = [];
        for (var j = 0; j < page.photos.length; j++) {
          var p = page.photos[j];
          if (p.orient === 'h') hPhotos.push(p); else vPhotos.push(p);
        }

        for (var h = 0; h < hPhotos.length && h < hFrames.length; h++)
          placeAndFit(hPhotos[h].filePath, hFrames[h], hPhotos[h].rotation, hPhotos[h].baseName, hPhotos[h].placement);
        for (var v = 0; v < vPhotos.length && v < vFrames.length; v++)
          placeAndFit(vPhotos[v].filePath, vFrames[v], vPhotos[v].rotation, vPhotos[v].baseName, vPhotos[v].placement);

        var saveOptions = new PhotoshopSaveOptions();
        saveOptions.maximizeCompatibility = true;
        safeDoc.saveAs(new File(data.outputPath + "/" + pageName + ".psd"), saveOptions, true, Extension.LOWERCASE);
        safeDoc.close(SaveOptions.DONOTSAVECHANGES);
        successes++;
      } catch(e) {
        failures++;
        try { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch(ex) {}
      }
    }

    // Close the template last, without saving — it was opened read-only-style.
    try { templateDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(_) {}

  } catch(e) {
    // Non-blocking: render queue awaits this call. Surface via the result
    // string instead of a modal that would freeze the queue.
    "BATCH_ERROR: " + ((e && e.message) ? e.message : String(e));
  }

  // Echo a result summary for the renderer-side queue.
  "OK " + successes + "/" + (successes + failures);
}
