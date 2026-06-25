// build_page.jsx
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_page_data.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("Page data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

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

    // Placement transform (on-canvas zoom/pan). Defaults reduce to cover-fit
    // + centered, matching the libvips preview exactly:
    //   userScale ≥ 1 multiplies the cover scale (zoom in)
    //   ox/oy ∈ [-1,1] pan within the overscan (sign matches the renderer:
    //   ox=+1 shows the right part → shift the layer left)
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

  try {
    app.preferences.rulerUnits = Units.PIXELS;
    var originalDoc = app.open(new File(data.templatePath));
    var pageName = "Page_" + data.pageName;
    var safeDoc = originalDoc.duplicate(pageName);
    originalDoc.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = safeDoc;

    var hFrames = findFrames("toolkithframe", safeDoc);
    var vFrames = findFrames("toolkitvframe", safeDoc);
    hFrames.sort(function(a,b){ return a.name.localeCompare(b.name); });
    vFrames.sort(function(a,b){ return a.name.localeCompare(b.name); });

    var hPhotos = [], vPhotos = [];
    for (var j = 0; j < data.photos.length; j++) {
      var p = data.photos[j];
      if (p.orient === 'h') hPhotos.push(p);
      else vPhotos.push(p);
    }

    for (var h = 0; h < hPhotos.length && h < hFrames.length; h++)
      placeAndFit(hPhotos[h].filePath, hFrames[h], hPhotos[h].rotation, hPhotos[h].baseName, hPhotos[h].placement);

    for (var v = 0; v < vPhotos.length && v < vFrames.length; v++)
      placeAndFit(vPhotos[v].filePath, vFrames[v], vPhotos[v].rotation, vPhotos[v].baseName, vPhotos[v].placement);

  } catch(e) {
    // Non-blocking: the render queue awaits this JSX call, so a modal alert()
    // here would freeze the whole queue until a human clicks OK. Echo the
    // error as the script result instead — the renderer surfaces it as a toast.
    "BUILD_PAGE_ERROR: " + ((e && e.message) ? e.message : String(e));
  }
}