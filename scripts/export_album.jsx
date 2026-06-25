// export_album.jsx
#target photoshop

// __DATA_PATH__ is substituted by the main process at runtime with a per-call
// temp file path. Falls back to the legacy fixed path if invoked directly.
var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_export_data.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("Export data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  var outputPath = data.outputPath;
  var pages = data.pages;
  var successCount = 0;
  var failures = [];   // accumulate per-page failures; report once at the end

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
    return { left:x1, top:y1, right:x2, bottom:y2, w:x2-x1, h:y2-y1, cx:x1+(x2-x1)/2, cy:y1+(y2-y1)/2 };
  }

  function placeAndFit(filePath, frameLayer, rotation, layerName) {
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

    var fb = getBounds(frameLayer);
    var pb = getBounds(placedLayer);
    var scale = Math.max(fb.w / pb.w, fb.h / pb.h) * 100;
    placedLayer.resize(scale, scale, AnchorPosition.MIDDLECENTER);
    pb = getBounds(placedLayer);
    placedLayer.translate(fb.cx - pb.cx, fb.cy - pb.cy);
  }

  app.preferences.rulerUnits = Units.PIXELS;

  for (var pageNum in pages) {
    var pageData = pages[pageNum];
    try {
      var originalDoc = app.open(new File(pageData.templatePath));
      var pageName = "Page_" + ("000" + pageNum).slice(-3);
      var safeDoc = originalDoc.duplicate(pageName);
      originalDoc.close(SaveOptions.DONOTSAVECHANGES);
      app.activeDocument = safeDoc;

      var hFrames = findFrames("toolkithframe", safeDoc);
      var vFrames = findFrames("toolkitvframe", safeDoc);
      hFrames.sort(function(a,b){ return a.name.localeCompare(b.name); });
      vFrames.sort(function(a,b){ return a.name.localeCompare(b.name); });

      var hPhotos = [], vPhotos = [];
      for (var j = 0; j < pageData.photos.length; j++) {
        var p = pageData.photos[j];
        if (p.orient === 'h') hPhotos.push(p);
        else vPhotos.push(p);
      }

      for (var h = 0; h < hPhotos.length && h < hFrames.length; h++)
        placeAndFit(hPhotos[h].filePath, hFrames[h], hPhotos[h].rotation, hPhotos[h].baseName);

      for (var v = 0; v < vPhotos.length && v < vFrames.length; v++)
        placeAndFit(vPhotos[v].filePath, vFrames[v], vPhotos[v].rotation, vPhotos[v].baseName);

      var saveOptions = new PhotoshopSaveOptions();
      saveOptions.maximizeCompatibility = true;
      safeDoc.saveAs(new File(outputPath + "/" + pageName + ".psd"), saveOptions, true, Extension.LOWERCASE);
      safeDoc.close(SaveOptions.DONOTSAVECHANGES);
      successCount++;
    } catch(e) {
      // Don't block the whole batch with a modal alert mid-loop — accumulate.
      failures.push("Page " + pageNum + ": " + ((e && e.message) ? e.message : String(e)));
      try { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch(ex) {}
    }
  }

  // Single end-of-run summary instead of one alert per failed page. An
  // unattended export now runs to completion without waiting on a human.
  if (failures.length === 0) {
    alert("Export Complete! " + successCount + " pages exported.");
  } else {
    var maxShown = 8;
    var shown = failures.slice(0, maxShown).join("\n");
    var more = failures.length > maxShown ? ("\n…and " + (failures.length - maxShown) + " more.") : "";
    alert("Export finished: " + successCount + " ok, " + failures.length + " failed.\n\n" + shown + more);
  }
}