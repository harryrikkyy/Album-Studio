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

  // J1: editable clipped adjustment layers instead of baked pixels (EXPERIMENTAL).
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
    executeAction(charIDToTypeID("GrpL"), new ActionDescriptor(), DialogModes.NO);
  }

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

  // Apply the Page Editor's template-layer overrides (hide/show, opacity)
  // before photos go in, so the delivered PSD matches the proof. Paths arrive
  // ALREADY converted to ExtendScript's top-down indexing by
  // psd_layers.toPhotoshopLayerOps — ag-psd counts children bottom-up, and
  // silently hiding the wrong layer is the failure mode that inversion avoids.
  function applyLayerOps(doc, ops) {
    if (!ops || !ops.length) return;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      try {
        var node = doc;
        for (var d = 0; d < op.path.length; d++) {
          if (!node.layers || op.path[d] >= node.layers.length) { node = null; break; }
          node = node.layers[op.path[d]];
        }
        // Name check: if the template was re-authored after the project was
        // saved, the stored index can point at a different layer. Skipping is
        // the safe failure — better an un-applied override than the wrong
        // layer silently switched off in a delivered album.
        if (!node || (op.name && node.name !== op.name)) continue;
        if (typeof op.hidden !== 'undefined') node.visible = !op.hidden;
        // Live type: Photoshop re-renders in the template's own font, so the
        // delivered PSD is exact and the client can still retype it.
        if (typeof op.text === 'string' && node.kind == LayerKind.TEXT) {
          // Replacing contents resets the layer's character style to the
          // document default — measured on a real template, where a 192pt
          // display line came back as 38pt Myriad. So snapshot the style from
          // PHOTOSHOP first and put it back afterwards.
          //
          // Reading it from the live layer rather than from our own parsed
          // metadata is deliberate: no point/pixel conversion to get wrong,
          // and it preserves whatever face Photoshop actually resolved —
          // including a substitution for a font the machine doesn't have,
          // which is what the template was already displaying anyway.
          var ti = node.textItem;
          var prev = {};
          var keys = ['font', 'size', 'color', 'tracking', 'justification', 'leading', 'autoLeading'];
          for (var k = 0; k < keys.length; k++) {
            try { prev[keys[k]] = ti[keys[k]]; } catch (pe) {}
          }
          var prevPt = null;
          try { prevPt = prev.size && prev.size.as ? prev.size.as('pt') : prev.size; } catch (se) {}

          ti.contents = op.text;

          for (var k2 = 0; k2 < keys.length; k2++) {
            var key = keys[k2];
            if (key === 'size') continue;   // handled below
            if (typeof prev[key] === 'undefined') continue;
            // Each restore is guarded on its own: one property Photoshop
            // refuses must not abandon the rest of the style.
            try { ti[key] = prev[key]; } catch (re) {}
          }

          // Size needs compensating, not just restoring. On a text layer that
          // carries a transform, every assignment to `contents` re-applies the
          // transform's divisor — measured on a real template as 38pt -> 31.3pt
          // (a 1.21 scale), and restoring the old value verbatim just gets
          // divided again. So measure the ratio Photoshop actually applied and
          // pre-multiply by it. Self-calibrating, which beats passing the
          // transform in from our own parse and hoping the two agree.
          try {
            var nowPt = ti.size && ti.size.as ? ti.size.as('pt') : ti.size;
            if (prevPt > 0 && nowPt > 0 && Math.abs(nowPt - prevPt) > 0.01) {
              ti.size = UnitValue(prevPt * (prevPt / nowPt), 'pt');
            }
          } catch (ze) {}
        }
        if (typeof op.opacity !== 'undefined') node.opacity = Math.round(op.opacity * 100);

        // Move / scale. Photoshop resizes about a chosen anchor, not about the
        // layer's top-left, so scaling alone shifts the origin. Resize about
        // the centre, then translate by the offset the editor asked for MINUS
        // the drift the resize introduced — that lands the layer's top-left
        // exactly where the on-screen box showed it.
        var sx = (typeof op.sx === 'number') ? op.sx : 1;
        var sy = (typeof op.sy === 'number') ? op.sy : 1;
        if (sx !== 1 || sy !== 1) node.resize(sx * 100, sy * 100, AnchorPosition.MIDDLECENTER);
        var driftX = (op.w || 0) * (1 - sx) / 2;
        var driftY = (op.h || 0) * (1 - sy) / 2;
        var tx = (op.dx || 0) - driftX;
        var ty = (op.dy || 0) - driftY;
        if (tx || ty) node.translate(tx, ty);
      } catch (e) { /* one bad override must not cost the page */ }
    }
  }

  // ── OVERLAYS (text + shapes drawn in the app's Page Editor) ──────────
  //
  // Shapes arrive pre-rasterized as one transparent PNG. TEXT is rebuilt here
  // as native Photoshop text so the delivered PSD stays editable — the client
  // can retype a name without going back to the app.
  //
  // The lines are ALREADY wrapped by the app (data.overlayTextLayers[].contents
  // uses \r between them) and each layer is POINT text, so Photoshop is never
  // asked to make a wrapping decision and cannot re-flow the copy differently
  // from the preview. Line widths can still differ slightly, because the app's
  // advance-width estimate is not the real font's.

  // Rotate a layer by `deg` about an arbitrary canvas pivot. Photoshop only
  // rotates about the layer's own bounds, but the preview turns text about its
  // BOX centre — which is a different point whenever the text doesn't fill its
  // box. Rotate, then translate the difference.
  function rotateAboutPivot(layer, deg, pivotX, pivotY) {
    var b = getBounds(layer);
    var rad = deg * Math.PI / 180;
    var dx = b.cx - pivotX, dy = b.cy - pivotY;
    var nx = pivotX + dx * Math.cos(rad) - dy * Math.sin(rad);
    var ny = pivotY + dx * Math.sin(rad) + dy * Math.cos(rad);
    layer.rotate(deg, AnchorPosition.MIDDLECENTER);
    var b2 = getBounds(layer);
    layer.translate(nx - b2.cx, ny - b2.cy);
  }

  function createTextLayers(doc, list) {
    if (!list || !list.length) return;
    var prevTypeUnits = app.preferences.typeUnits;
    // Every measurement in the payload is canvas pixels.
    app.preferences.typeUnits = TypeUnits.PIXELS;
    try {
      for (var i = 0; i < list.length; i++) {
        var T = list[i];
        try {
          var layer = doc.artLayers.add();
          layer.kind = LayerKind.TEXT;
          var ti = layer.textItem;
          ti.kind = TextType.POINTTEXT;

          // Font first: changing it after the fact re-measures the text and
          // shifts the anchor. An unavailable PostScript name throws, so fall
          // back to Photoshop's current font rather than losing the layer.
          if (T.fontName) { try { ti.font = T.fontName; } catch (fe) {} }
          ti.size = T.sizePx;
          // Leading is ignored unless auto-leading is explicitly off.
          ti.autoLeading = false;
          ti.leading = T.leadingPx;
          if (T.tracking) { try { ti.tracking = T.tracking; } catch (te) {} }
          if (T.fauxItalic) { try { ti.fauxItalic = true; } catch (ie) {} }
          if (T.underline) { try { ti.underline = UnderlineType.UNDERLINELEFT; } catch (ue) {} }

          var col = new SolidColor();
          col.rgb.red = T.color.r; col.rgb.green = T.color.g; col.rgb.blue = T.color.b;
          ti.color = col;
          ti.justification = (T.justification === 'center') ? Justification.CENTER
            : (T.justification === 'right') ? Justification.RIGHT
            : Justification.LEFT;

          ti.contents = T.contents;
          // Position last — it is the baseline anchor of the first line, and
          // the properties above all move it.
          ti.position = [T.x, T.y];

          layer.name = T.name;
          if (T.opacity < 100) layer.opacity = T.opacity;
          if (T.rot) rotateAboutPivot(layer, T.rot, T.pivotX, T.pivotY);
          // Created bottom-to-top in the app's own order, each moved to the
          // front, so the final stack matches the editor's layer list.
          layer.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
        } catch (e) {
          // One bad layer must not cost the whole page.
        }
      }
    } finally {
      app.preferences.typeUnits = prevTypeUnits;
    }
  }

  // Place the rasterized SHAPE overlay. The PNG is generated at the page's own
  // pixel dimensions, and Photoshop centres a placed image on the canvas, so
  // it lands aligned with no adjustment at all.
  //
  // Do NOT position or scale this from layer.bounds: for a placed smart object
  // Photoshop reports the bounds of the non-transparent PIXELS, not the layer's
  // full extent. An overlay containing one thin rule would measure as that rule
  // and get stretched across the whole page (which is exactly what happened the
  // first time this ran against a real template). Scale only from the PNG's
  // known dimensions, and only when they differ from the document.
  function placeOverlayPng(doc, pngPath, pngW, pngH) {
    if (!pngPath) return;
    var f = new File(pngPath);
    if (!f.exists) return;
    var desc = new ActionDescriptor();
    desc.putPath(charIDToTypeID("null"), f);
    desc.putBoolean(charIDToTypeID("Lnkd"), false);
    executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);

    var layer = doc.activeLayer;
    layer.name = "Album Studio \u2014 text & shapes";
    var docW = doc.width.as("px"), docH = doc.height.as("px");
    if (pngW && pngH && (Math.abs(pngW - docW) > 1 || Math.abs(pngH - docH) > 1)) {
      // Uniform-ish rescale about the centre; the placement stays centred.
      layer.resize((docW / pngW) * 100, (docH / pngH) * 100, AnchorPosition.MIDDLECENTER);
    }
    layer.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
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

    if (USE_ADJ && adjust) {
      app.activeDocument.activeLayer = placedLayer;
      addAdjustmentLayers(adjust);
    }
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

        applyLayerOps(safeDoc, page.layerOps);

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
          placeAndFit(hPhotos[h].filePath, hFrames[h], hPhotos[h].rotation, hPhotos[h].baseName, hPhotos[h].placement, hPhotos[h].adjust);
        for (var v = 0; v < vPhotos.length && v < vFrames.length; v++)
          placeAndFit(vPhotos[v].filePath, vFrames[v], vPhotos[v].rotation, vPhotos[v].baseName, vPhotos[v].placement, vPhotos[v].adjust);

        placeOverlayPng(safeDoc, page.overlayPngPath, page.overlayPngWidth, page.overlayPngHeight);
        createTextLayers(safeDoc, page.overlayTextLayers);

        var saveOptions = new PhotoshopSaveOptions();
        saveOptions.maximizeCompatibility = true;
        safeDoc.saveAs(new File(data.outputPath + "/" + pageName + ".psd"), saveOptions, true, Extension.LOWERCASE);
        safeDoc.close(SaveOptions.DONOTSAVECHANGES);
        successes++;
      } catch(e) {
        failures++;
        failedPages.push(page.pageName);
        try { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch(ex) {}
      }
    }

    // Close the template last, without saving — it was opened read-only-style.
    try { templateDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(_) {}

  } catch(e) {
    // Non-blocking: the render queue awaits this call, so a modal alert()
    // would freeze the queue until a human clicked OK. Record the error and
    // let it be the RESULT — an earlier version wrote this string as a bare
    // expression, which the "OK" line below then overwrote, so a batch that
    // rendered nothing still reported success and the caller marked every
    // page as rendered in the persistent cache.
    fatal = (e && e.message) ? e.message : String(e);
  }

  // The result the renderer-side queue parses. Failures are reported even
  // when some pages succeeded, so a partial batch cannot be mistaken for a
  // clean one.
  if (fatal) {
    "BATCH_ERROR: " + fatal;
  } else if (failures > 0) {
    "PARTIAL " + successes + "/" + (successes + failures) + ": " + failedPages.join(",");
  } else {
    "OK " + successes + "/" + successes;
  }
}
