/**
 * JSX Template Library
 * ─────────────────────
 * Single source of truth for every JSX snippet we ship to Photoshop.
 *
 * Why this module exists:
 * - Previously these strings lived inline in app.js IPC handlers, which made
 *   them hard to test and easy to typo when copy-pasted.
 * - Centralizing them lets us snapshot-test the generated JSX in vitest,
 *   diff it across versions, and audit user-input escaping in one place.
 *
 * Every builder accepts plain JavaScript values (paths, booleans, layer names)
 * and returns a complete JSX program ready for `executeJSX`. All user-supplied
 * strings are escaped via `jsxString` to make injection impossible.
 */

const { jsxString } = require('../photoshop')

/**
 * Open a PSD/PSB/JPG and immediately duplicate to a "_Safe" working document.
 * Returns the new document name from PS. Used by Tab 1 → "Open Safe Template".
 */
function openInPhotoshop(filePath) {
  return `
    var file = new File(${jsxString(filePath)});
    var doc = app.open(file);
    var safeName = doc.name.replace(/\\.[^.]+$/, "") + "_Safe";
    var safeDoc = doc.duplicate(safeName);
    doc.close(SaveOptions.DONOTSAVECHANGES);
    safeDoc.name;
  `
}

/**
 * Replace any existing "Pro_Wallpaper(_HighRes)" layer with a freshly placed
 * background image, scaled to fit, centered, moved to the bottom of the stack.
 * `isHr` controls the layer name suffix.
 */
function placeWallpaper(filePath, isHr) {
  return `
    var step = "start";
    try {
      step = "get doc";
      var doc = app.activeDocument;
      step = "delete existing";
      for (var i = doc.layers.length - 1; i >= 0; i--) {
        var ln = doc.layers[i].name;
        if (ln === "Pro_Wallpaper" || ln === "Pro_Wallpaper_HighRes") {
          doc.layers[i].allLocked = false;
          doc.layers[i].remove();
        }
      }
      step = "reset zoom";
      app.preferences.rulerUnits = Units.PIXELS;
      step = "place image";
      var idPlc = charIDToTypeID("Plc ");
      var desc = new ActionDescriptor();
      desc.putPath(charIDToTypeID("null"), new File(${jsxString(filePath)}));
      desc.putBoolean(charIDToTypeID("Lnkd"), false);
      executeAction(idPlc, desc, DialogModes.NO);
      step = "commit";
      try { executeAction(charIDToTypeID("Cmmt"), new ActionDescriptor(), DialogModes.NO); } catch(e) {}
      step = "get bounds";
      var layer = doc.activeLayer;
      var docW = doc.width.as("px");
      var docH = doc.height.as("px");
      step = "resize";
      var resizeDesc = new ActionDescriptor();
      var resizeRef = new ActionReference();
      resizeRef.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
      resizeDesc.putReference(charIDToTypeID("null"), resizeRef);
      var bounds = layer.bounds;
      var lW = bounds[2].as("px") - bounds[0].as("px");
      var lH = bounds[3].as("px") - bounds[1].as("px");
      var scale = Math.max(docW / lW, docH / lH) * 100;
      resizeDesc.putUnitDouble(charIDToTypeID("Wdth"), charIDToTypeID("#Prc"), scale);
      resizeDesc.putUnitDouble(charIDToTypeID("Hght"), charIDToTypeID("#Prc"), scale);
      resizeDesc.putEnumerated(stringIDToTypeID("transformAroundPoint"), stringIDToTypeID("quadCenterState"), stringIDToTypeID("QCSAverage"));
      executeAction(stringIDToTypeID("transform"), resizeDesc, DialogModes.NO);
      step = "translate";
      bounds = layer.bounds;
      var tx = docW/2 - (bounds[0].as("px") + bounds[2].as("px"))/2;
      var ty = docH/2 - (bounds[1].as("px") + bounds[3].as("px"))/2;
      layer.translate(tx, ty);
      step = "move to bottom";
      var bottom = doc.layers[doc.layers.length - 1];
      if (bottom.id !== layer.id) {
        if (bottom.isBackgroundLayer) {
          layer.move(bottom, ElementPlacement.PLACEBEFORE);
        } else {
          layer.move(bottom, ElementPlacement.PLACEAFTER);
        }
      }
      step = "rename and lock";
      layer.name = ${isHr ? '"Pro_Wallpaper_HighRes"' : '"Pro_Wallpaper"'};
      try { layer.allLocked = true; } catch(e) {}
      "success";
    } catch(e) { "Failed at step [" + step + "]: " + e.message; }
  `
}

/**
 * Place a PNG into the active document and rename the resulting layer.
 * No clipping, no scaling — just a plain placement.
 */
function placePngFrame(filePath, layerName) {
  return `
    var step = "start";
    try {
      step = "place";
      var doc = app.activeDocument;
      var idPlc = charIDToTypeID("Plc ");
      var desc = new ActionDescriptor();
      desc.putPath(charIDToTypeID("null"), new File(${jsxString(filePath)}));
      desc.putBoolean(charIDToTypeID("Lnkd"), false);
      executeAction(idPlc, desc, DialogModes.NO);
      step = "rename";
      doc.activeLayer.name = ${jsxString(layerName)};
      "success";
    } catch(e) { "Failed at [" + step + "]: " + e.message; }
  `
}

/**
 * Place an image, convert to a smart object, and (only when the source is a
 * JPEG) edit the smart-object contents to add a black mask layer where the
 * image used to be. Used to preserve the original pixel area as a mask while
 * allowing the user to swap the underlying photo.
 */
function placeMaskedFrame(filePath, layerName, isJpg) {
  const jpgBlock = isJpg ? `
      step = "edit contents";
      executeAction(stringIDToTypeID("placedLayerEditContents"), new ActionDescriptor(), DialogModes.NO);
      step = "select rgb";
      var psbDoc = app.activeDocument;
      var selDesc = new ActionDescriptor();
      var selRef = new ActionReference();
      selRef.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
      selDesc.putReference(charIDToTypeID("null"), selRef);
      var toRef = new ActionReference();
      toRef.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("RGB "));
      selDesc.putReference(charIDToTypeID("T   "), toRef);
      executeAction(charIDToTypeID("setd"), selDesc, DialogModes.NO);
      step = "inverse";
      executeAction(charIDToTypeID("Invs"), new ActionDescriptor(), DialogModes.NO);
      step = "solid color";
      var newLayer = psbDoc.artLayers.add();
      newLayer.name = "BlackMask";
      var fillDesc = new ActionDescriptor();
      fillDesc.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("FlCn"), charIDToTypeID("Blck"));
      fillDesc.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100.0);
      fillDesc.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));
      executeAction(charIDToTypeID("Fl  "), fillDesc, DialogModes.NO);
      step = "hide black layer";
      newLayer.visible = false;
      step = "save and close";
      var saveOptions = new PhotoshopSaveOptions();
      psbDoc.saveAs(new File(psbDoc.fullName.fsName), saveOptions, true, Extension.LOWERCASE);
      psbDoc.close(SaveOptions.DONOTSAVECHANGES);
      ` : ''

  return `
    var step = "start";
    try {
      step = "place";
      var doc = app.activeDocument;
      var idPlc = charIDToTypeID("Plc ");
      var desc = new ActionDescriptor();
      desc.putPath(charIDToTypeID("null"), new File(${jsxString(filePath)}));
      desc.putBoolean(charIDToTypeID("Lnkd"), false);
      executeAction(idPlc, desc, DialogModes.NO);
      step = "convert to smart object";
      executeAction(stringIDToTypeID("newPlacedLayer"), new ActionDescriptor(), DialogModes.NO);
      step = "rename";
      var maskLayer = doc.activeLayer;
      maskLayer.name = ${jsxString(layerName)};
      ${jpgBlock}
      "success";
    } catch(e) { "Failed at [" + step + "]: " + e.message; }
  `
}

/**
 * Place an image into the active document and clip it to the currently active
 * (selected) layer — i.e. the placed photo becomes a clipping mask of the
 * layer below it. Mirrors the place+GrpL pattern used in build_page.jsx.
 */
function placeClipped(filePath) {
  return `
    var step = "start";
    try {
      if (app.documents.length === 0) { "No document open in Photoshop"; }
      else {
        step = "place";
        var doc = app.activeDocument;
        var desc = new ActionDescriptor();
        desc.putPath(charIDToTypeID("null"), new File(${jsxString(filePath)}));
        desc.putBoolean(charIDToTypeID("Lnkd"), false);
        executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);
        step = "commit";
        try { executeAction(charIDToTypeID("Cmmt"), new ActionDescriptor(), DialogModes.NO); } catch(e) {}
        step = "clip to layer below";
        executeAction(charIDToTypeID("GrpL"), new ActionDescriptor(), DialogModes.NO);
        "success";
      }
    } catch(e) { "Failed at [" + step + "]: " + e.message; }
  `
}

module.exports = {
  openInPhotoshop,
  placeWallpaper,
  placePngFrame,
  placeMaskedFrame,
  placeClipped
}
