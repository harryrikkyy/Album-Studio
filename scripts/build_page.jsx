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

  // J1: when on, place ORIGINAL sources and add editable, clipped adjustment
  // layers (instead of baking colour into the pixels). EXPERIMENTAL — the
  // Action Manager descriptors + value mapping need verification per PS version.
  var USE_ADJ = !!data.useAdjustmentLayers;

  function _makeAdjLayer(typeStringID, buildTypeDesc) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putClass(stringIDToTypeID("adjustmentLayer"));
    desc.putReference(stringIDToTypeID("null"), ref);
    var using = new ActionDescriptor();
    var typeDesc = new ActionDescriptor();
    typeDesc.putEnumerated(stringIDToTypeID("presetKind"), stringIDToTypeID("presetKindType"), stringIDToTypeID("presetKindDefault"));
    if (buildTypeDesc) buildTypeDesc(typeDesc);
    using.putObject(stringIDToTypeID("type"), stringIDToTypeID(typeStringID), typeDesc);
    desc.putObject(stringIDToTypeID("using"), stringIDToTypeID("adjustmentLayer"), using);
    executeAction(stringIDToTypeID("make"), desc, DialogModes.NO);
    // Clip the just-created adjustment layer to the layer below (the photo).
    executeAction(charIDToTypeID("GrpL"), new ActionDescriptor(), DialogModes.NO);
  }

  // Maps the libvips preview adjustments (-100..100) onto editable PS
  // adjustment layers, clipped to the active (photo) layer:
  //   exposure   → Exposure (stops = exposure/100)
  //   contrast   → Brightness/Contrast (contrast slider)
  //   saturation → Hue/Saturation (saturation slider)
  //   warmth     → Photo Filter (warming/cooling, density ~ |warmth|)
  function addAdjustmentLayers(adj) {
    if (!adj) return;
    var exposure = adj.exposure || 0, contrast = adj.contrast || 0;
    var saturation = adj.saturation || 0, warmth = adj.warmth || 0;
    if (exposure) {
      _makeAdjLayer("exposure", function (t) {
        t.putUnitDouble(stringIDToTypeID("exposure"), stringIDToTypeID("exposure"), exposure / 100);
        t.putUnitDouble(stringIDToTypeID("offset"), stringIDToTypeID("offset"), 0);
        t.putUnitDouble(stringIDToTypeID("gammaCorrection"), stringIDToTypeID("gammaCorrection"), 1);
      });
    }
    if (contrast) {
      _makeAdjLayer("brightnessEvent", function (t) {
        t.putInteger(stringIDToTypeID("brightness"), 0);
        t.putInteger(stringIDToTypeID("center"), Math.round(contrast));
        t.putBoolean(stringIDToTypeID("useLegacy"), false);
      });
    }
    if (saturation) {
      _makeAdjLayer("hueSaturation", function (t) {
        t.putBoolean(stringIDToTypeID("colorize"), false);
        var list = new ActionList();
        var a = new ActionDescriptor();
        a.putInteger(stringIDToTypeID("hue"), 0);
        a.putInteger(stringIDToTypeID("saturation"), Math.round(saturation));
        a.putInteger(stringIDToTypeID("lightness"), 0);
        list.putObject(stringIDToTypeID("hueSatAdjustmentV2"), a);
        t.putList(stringIDToTypeID("adjustment"), list);
      });
    }
    if (warmth) {
      _makeAdjLayer("photoFilter", function (t) {
        t.putBoolean(stringIDToTypeID("preserveLuminosity"), true);
        t.putInteger(stringIDToTypeID("density"), Math.min(100, Math.abs(Math.round(warmth))));
        var c = new ActionDescriptor();
        // Warm = amber filter; cool = blue filter (PS RGBColor: red/grain/blue).
        if (warmth > 0) { c.putDouble(stringIDToTypeID("red"), 236); c.putDouble(stringIDToTypeID("grain"), 138); c.putDouble(stringIDToTypeID("blue"), 0); }
        else { c.putDouble(stringIDToTypeID("red"), 0); c.putDouble(stringIDToTypeID("grain"), 181); c.putDouble(stringIDToTypeID("blue"), 255); }
        t.putObject(stringIDToTypeID("color"), stringIDToTypeID("RGBColor"), c);
      });
    }
  }

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

  function placeAndFit(filePath, frameLayer, rotation, layerName, placement, adjust) {
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

    // J1: editable clipped adjustment layers (instead of baked pixels). The
    // photo layer is active here, so each adjustment clips to it.
    if (USE_ADJ && adjust) {
      app.activeDocument.activeLayer = placedLayer;
      addAdjustmentLayers(adjust);
    }
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
      placeAndFit(hPhotos[h].filePath, hFrames[h], hPhotos[h].rotation, hPhotos[h].baseName, hPhotos[h].placement, hPhotos[h].adjust);

    for (var v = 0; v < vPhotos.length && v < vFrames.length; v++)
      placeAndFit(vPhotos[v].filePath, vFrames[v], vPhotos[v].rotation, vPhotos[v].baseName, vPhotos[v].placement, vPhotos[v].adjust);

  } catch(e) {
    // Non-blocking: the render queue awaits this JSX call, so a modal alert()
    // here would freeze the whole queue until a human clicks OK. Echo the
    // error as the script result instead — the renderer surfaces it as a toast.
    "BUILD_PAGE_ERROR: " + ((e && e.message) ? e.message : String(e));
  }
}