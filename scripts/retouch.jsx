// retouch.jsx
//
// Portrait retouching toolkit — ported from the legacy 2018 CEP panel
// (~/jsx/*.jsx, "$._ext_*" wrappers). One script, one dispatcher: reads
// {tool, radius?, opacity?, outputPath} from __DATA_PATH__, runs the matching
// action-recorder sequence against the ACTIVE document, writes {ok, error?}
// back. The step bodies below are kept verbatim from the recorded originals;
// the only edits are:
//   - the 10 DodgeIntensityNN / 10 BurnIntensityNN blocks collapsed into
//     SetLayerOpacity(layerName, opacity) — the blocks differed only in the
//     opacity constant (and a recorder-captured layer-ID list, dropped here
//     because those IDs were specific to the original author's document),
//   - the 6 SkinSmoothing / 5 SkinTexture blocks collapsed into one function
//     each with the filter radius as a parameter,
//   - SkinTexture uses the variant that reselects the RGB composite at the
//     end (the LOW+ recording omitted that step; the omission was clearly an
//     authoring slip, not intent).
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_retouch.json";

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//──────────────────────────────────────────────────────────────────
// Stamp Visible — merge all visible layers into a NEW layer on top,
// leaving every source layer intact (Cmd+Opt+Shift+E). The original CEP
// panel flattened the document before most tools; here we stamp instead,
// so every retouch/effect/skin-look is NON-DESTRUCTIVE — the user's layer
// stack survives underneath the merged working layer.
function StampVisible() {
  var desc = new ActionDescriptor();
  desc.putBoolean(cTID('Dplc'), true);
  executeAction(sTID('mergeVisible'), desc, DialogModes.NO);
};

//──────────────────────────────────────────────────────────────────
// Shared leaf-page controls, ported from the CEP pages:
// OPACITY10..100, Compare Before/After, Eraser, Color Changer.

// Set the active layer's opacity (generalises OPACITY10..100 into a slider).
function setActiveLayerOpacity(n) {
  n = Number(n);
  if (isNaN(n)) return;
  if (n < 0) n = 0; else if (n > 100) n = 100;
  app.activeDocument.activeLayer.opacity = n;
};

// Compare — hide the active (top) layer to reveal the original beneath.
function CompareImageBefore() {
  var desc1 = new ActionDescriptor();
  var list1 = new ActionList();
  var ref1 = new ActionReference();
  ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
  list1.putReference(ref1);
  desc1.putList(cTID('null'), list1);
  executeAction(cTID('Hd  '), desc1, DialogModes.NO);
};

// Compare — show the active (top) layer again.
function CompareImageAfter() {
  var desc1 = new ActionDescriptor();
  var list1 = new ActionList();
  var ref1 = new ActionReference();
  ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
  list1.putReference(ref1);
  desc1.putList(cTID('null'), list1);
  executeAction(cTID('Shw '), desc1, DialogModes.NO);
};

// Select the Eraser tool (Change-Eye-Color cleanup).
function SelectEraser() {
  var desc1 = new ActionDescriptor();
  var ref1 = new ActionReference();
  ref1.putClass(cTID('ErTl'));
  desc1.putReference(cTID('null'), ref1);
  executeAction(cTID('slct'), desc1, DialogModes.NO);
};

// Color changer — original selects the History Brush command; it can be
// unavailable depending on document state, so failures are swallowed.
function SelectColorChanger() {
  try { executeAction(cTID('HStr'), undefined, DialogModes.NO); } catch (eCC) {}
};

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
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return quoteStr(v);
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
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

//──────────────────────────────────────────────────────────────────
// Dodge/Burn intensity — DodgeIntensity.jsx + BurnIntensity.jsx
// (20 blocks collapsed: select the named layer, set its opacity).
function SetLayerOpacity(layerName, opacity) {
  // Select
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Lyr '), layerName);
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putUnitDouble(cTID('Opct'), cTID('#Prc'), opacity);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Select
  step2();      // Set
};
//──────────────────────────────────────────────────────────────────
// Automatic Dodge & Burn — AutomaticDodgeandBurn.jsx
function AutomaticDodgeandBurn() {
  // Make
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('AdjL'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var desc3 = new ActionDescriptor();
    desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
    desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
    desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Select
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Burn");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    desc3.putReference(cTID('Chnl'), ref2);
    var list2 = new ActionList();
    var desc4 = new ActionDescriptor();
    desc4.putDouble(cTID('Hrzn'), 0);
    desc4.putDouble(cTID('Vrtc'), 0);
    list2.putObject(cTID('Pnt '), desc4);
    var desc5 = new ActionDescriptor();
    desc5.putDouble(cTID('Hrzn'), 151);
    desc5.putDouble(cTID('Vrtc'), 76);
    list2.putObject(cTID('Pnt '), desc5);
    var desc6 = new ActionDescriptor();
    desc6.putDouble(cTID('Hrzn'), 255);
    desc6.putDouble(cTID('Vrtc'), 255);
    list2.putObject(cTID('Pnt '), desc6);
    desc3.putList(cTID('Crv '), list2);
    list1.putObject(cTID('CrvA'), desc3);
    desc2.putList(cTID('Adjs'), list1);
    desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 0);
    desc3.putInteger(cTID('Dstl'), 0);
    desc3.putInteger(cTID('DstW'), 0);
    desc3.putInteger(cTID('Dstt'), 127);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Make
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('AdjL'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var desc3 = new ActionDescriptor();
    desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
    desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
    desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Select
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Dodge");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step9(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    desc3.putReference(cTID('Chnl'), ref2);
    var list2 = new ActionList();
    var desc4 = new ActionDescriptor();
    desc4.putDouble(cTID('Hrzn'), 0);
    desc4.putDouble(cTID('Vrtc'), 0);
    list2.putObject(cTID('Pnt '), desc4);
    var desc5 = new ActionDescriptor();
    desc5.putDouble(cTID('Hrzn'), 104);
    desc5.putDouble(cTID('Vrtc'), 180);
    list2.putObject(cTID('Pnt '), desc5);
    var desc6 = new ActionDescriptor();
    desc6.putDouble(cTID('Hrzn'), 255);
    desc6.putDouble(cTID('Vrtc'), 255);
    list2.putObject(cTID('Pnt '), desc6);
    desc3.putList(cTID('Crv '), list2);
    list1.putObject(cTID('CrvA'), desc3);
    desc2.putList(cTID('Adjs'), list1);
    desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step10(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 127);
    desc3.putInteger(cTID('Dstl'), 255);
    desc3.putInteger(cTID('DstW'), 255);
    desc3.putInteger(cTID('Dstt'), 255);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step11(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Lyr '), "Burn");
    desc1.putReference(cTID('null'), ref1);
    desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
    desc1.putBoolean(cTID('MkVs'), false);
    var list1 = new ActionList();
    list1.putInteger(7);
    list1.putInteger(8);
    desc1.putList(cTID('LyrI'), list1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Make
  function step12(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(sTID("layerSection"));
    desc1.putReference(cTID('null'), ref1);
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('From'), ref2);
    desc1.putInteger(sTID("layerSectionStart"), 9);
    desc1.putInteger(sTID("layerSectionEnd"), 10);
    desc1.putString(cTID('Nm  '), "Group 1");
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step13(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Automatic Dodge and Burn");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Make
  step2();      // Select
  step3();      // Set
  step4();      // Set
  step5();      // Set
  step6();      // Make
  step7();      // Select
  step8();      // Set
  step9();      // Set
  step10();      // Set
  step11();      // Select
  step12();      // Make
  step13();      // Set
};

//──────────────────────────────────────────────────────────────────
// Manual Dodge & Burn setup — DodgeandBurnManual.jsx
function DodgeandBurnManual() {
  // Make
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('AdjL'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var desc3 = new ActionDescriptor();
    desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
    desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
    desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    desc3.putReference(cTID('Chnl'), ref2);
    var list2 = new ActionList();
    var desc4 = new ActionDescriptor();
    desc4.putDouble(cTID('Hrzn'), 0);
    desc4.putDouble(cTID('Vrtc'), 0);
    list2.putObject(cTID('Pnt '), desc4);
    var desc5 = new ActionDescriptor();
    desc5.putDouble(cTID('Hrzn'), 102);
    desc5.putDouble(cTID('Vrtc'), 176);
    list2.putObject(cTID('Pnt '), desc5);
    var desc6 = new ActionDescriptor();
    desc6.putDouble(cTID('Hrzn'), 255);
    desc6.putDouble(cTID('Vrtc'), 255);
    list2.putObject(cTID('Pnt '), desc6);
    desc3.putList(cTID('Crv '), list2);
    list1.putObject(cTID('CrvA'), desc3);
    desc2.putList(cTID('Adjs'), list1);
    desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Invert
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(cTID('Invr'), undefined, dialogMode);
  };

  // Select
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putUnitDouble(cTID('Opct'), cTID('#Prc'), 30);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Dodge");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Make
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('AdjL'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var desc3 = new ActionDescriptor();
    desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
    desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
    desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    desc3.putReference(cTID('Chnl'), ref2);
    var list2 = new ActionList();
    var desc4 = new ActionDescriptor();
    desc4.putDouble(cTID('Hrzn'), 0);
    desc4.putDouble(cTID('Vrtc'), 0);
    list2.putObject(cTID('Pnt '), desc4);
    var desc5 = new ActionDescriptor();
    desc5.putDouble(cTID('Hrzn'), 155);
    desc5.putDouble(cTID('Vrtc'), 74);
    list2.putObject(cTID('Pnt '), desc5);
    var desc6 = new ActionDescriptor();
    desc6.putDouble(cTID('Hrzn'), 255);
    desc6.putDouble(cTID('Vrtc'), 255);
    list2.putObject(cTID('Pnt '), desc6);
    desc3.putList(cTID('Crv '), list2);
    list1.putObject(cTID('CrvA'), desc3);
    desc2.putList(cTID('Adjs'), list1);
    desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Invert
  function step9(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(cTID('Invr'), undefined, dialogMode);
  };

  // Set
  function step10(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putUnitDouble(cTID('Opct'), cTID('#Prc'), 20);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step11(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step12(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Burn");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step13(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Lyr '), "Dodge");
    desc1.putReference(cTID('null'), ref1);
    desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
    desc1.putBoolean(cTID('MkVs'), false);
    var list1 = new ActionList();
    list1.putInteger(23);
    list1.putInteger(24);
    desc1.putList(cTID('LyrI'), list1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Make
  function step14(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(sTID("layerSection"));
    desc1.putReference(cTID('null'), ref1);
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('From'), ref2);
    desc1.putInteger(sTID("layerSectionStart"), 25);
    desc1.putInteger(sTID("layerSectionEnd"), 26);
    desc1.putString(cTID('Nm  '), "Group 1");
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step15(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Dodge and Burn");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step16(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step17(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Reset
  function step18(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('Clrs'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('Rset'), desc1, dialogMode);
  };

  // Exchange
  function step19(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('Clrs'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('Exch'), desc1, dialogMode);
  };

  step1();      // Make
  step2();      // Set
  step3();      // Invert
  step4();      // Select
  step5();      // Set
  step6();      // Set
  step7();      // Make
  step8();      // Set
  step9();      // Invert
  step10();      // Set
  step11();      // Select
  step12();      // Set
  step13();      // Select
  step14();      // Make
  step15();      // Set
  step16();      // Select
  step17();      // Select
  step18();      // Reset
  step19();      // Exchange
};

//──────────────────────────────────────────────────────────────────
// Manual D&B finish (merge + regroup) — ManualDodgeandBurnBackButton.jsx
function ManualDodgeandBurnBackButton() {
  // Merge Visible
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    desc1.putBoolean(cTID('Dplc'), true);
    executeAction(sTID('mergeVisible'), desc1, dialogMode);
  };

  // Select
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Lyr '), "Dodge and Burn");
    desc1.putReference(cTID('null'), ref1);
    desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
    desc1.putBoolean(cTID('MkVs'), false);
    var list1 = new ActionList();
    list1.putInteger(39);
    list1.putInteger(41);
    desc1.putList(cTID('LyrI'), list1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Merge Layers
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Dodge & Burn");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Merge Visible
  step2();      // Select
  step3();      // Merge Layers
  step4();      // Set
};

//──────────────────────────────────────────────────────────────────
// Target the Dodge layer + reset colors — Dodge.jsx
function Dodge() {
  // Select
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Lyr '), "Dodge");
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Reset
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('Clrs'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('Rset'), desc1, dialogMode);
  };

  step1();      // Select
  step2();      // Reset
};

//──────────────────────────────────────────────────────────────────
// Target the Burn layer + reset colors — Burn.jsx
function Burn() {
  // Select
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Lyr '), "Burn");
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Reset
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('Clrs'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('Rset'), desc1, dialogMode);
  };

  step1();      // Select
  step2();      // Reset
};

//──────────────────────────────────────────────────────────────────
// Skin smoothing — SkinSmoothing.jsx (6 blocks collapsed; radius is the only difference)
function SkinSmoothing(radius) {
  // Select
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putIndex(sTID("filterFX"), 1);
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var desc3 = new ActionDescriptor();
    desc3.putUnitDouble(cTID('Rds '), cTID('#Pxl'), radius);
    desc2.putObject(cTID('Fltr'), cTID('HghP'), desc3);
    desc1.putObject(sTID("filterFX"), sTID("filterFX"), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  step1();      // Select
  step2();      // Set
  step3();      // Select
};

//──────────────────────────────────────────────────────────────────
// Skin texture — SkinTexture.jsx (5 blocks collapsed; radius is the only difference)
function SkinTexture(radius) {
  // Select
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putIndex(sTID("filterFX"), 2);
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var desc3 = new ActionDescriptor();
    desc3.putUnitDouble(cTID('Rds '), cTID('#Pxl'), radius);
    desc2.putObject(cTID('Fltr'), cTID('GsnB'), desc3);
    desc1.putObject(sTID("filterFX"), sTID("filterFX"), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  step1();      // Select
  step2();      // Set
  step3();      // Select
};

//──────────────────────────────────────────────────────────────────
// Advanced skin retouching setup — AdvancedRetouching.jsx
function AdvancedRetouching() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Layer Via Copy
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(sTID('copyToLayer'), undefined, dialogMode);
  };

  // Set
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "1");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Ovrl'));
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Invert
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(cTID('Invr'), undefined, dialogMode);
  };

  // Convert to Smart Object
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(sTID('newPlacedLayer'), undefined, dialogMode);
  };

  // High Pass
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    desc1.putUnitDouble(cTID('Rds '), cTID('#Pxl'), 5);
    executeAction(sTID('highPass'), desc1, dialogMode);
  };

  // Gaussian Blur
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    desc1.putUnitDouble(cTID('Rds '), cTID('#Pxl'), 1);
    executeAction(sTID('gaussianBlur'), desc1, dialogMode);
  };

  // Set
  function step9(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Advanced Skin Retouching");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Make
  function step10(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    desc1.putClass(cTID('Nw  '), cTID('Chnl'));
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc1.putReference(cTID('At  '), ref1);
    desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Select
  function step11(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step12(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Reset
  function step13(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('Clrs'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('Rset'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Layer Via Copy
  step3();      // Set
  step4();      // Set
  step5();      // Invert
  step6();      // Convert to Smart Object
  step7();      // High Pass
  step8();      // Gaussian Blur
  step9();      // Set
  step10();      // Make
  step11();      // Select
  step12();      // Select
  step13();      // Reset
};

//──────────────────────────────────────────────────────────────────
// Blemish removal layer — CreateBlemishRemovalLayer.jsx
function CreateBlemishRemovalLayer() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Make
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('Lyr '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putInteger(cTID('LyrI'), 3);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Blemish Removal Layer");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('FrgC'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 359.994506835938);
    desc2.putDouble(cTID('Strt'), 100);
    desc2.putDouble(cTID('Brgh'), 100);
    desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
    desc1.putString(cTID('Srce'), "photoshopPicker");
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Hard Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Make
  step3();      // Set
  step4();      // Set
  step5();      // Select
  step6();      // Select
};

//──────────────────────────────────────────────────────────────────
// Blush-on layer — CreateBlushonLayer.jsx
function CreateBlushonLayer() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Make
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('Lyr '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putInteger(cTID('LyrI'), 4);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Select
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Ovrl'));
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 0);
    desc3.putInteger(cTID('Dstl'), 0);
    desc3.putInteger(cTID('DstW'), 130);
    desc3.putInteger(cTID('Dstt'), 255);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    var desc4 = new ActionDescriptor();
    desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 416.666666666667);
    desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Blushon Layer");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('FrgC'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putDouble(cTID('Rd  '), 255);
    desc2.putDouble(cTID('Grn '), 157);
    desc2.putDouble(cTID('Bl  '), 199);
    desc1.putObject(cTID('T   '), sTID("RGBColor"), desc2);
    desc1.putString(cTID('Srce'), "photoshopPicker");
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Make
  step3();      // Select
  step4();      // Select
  step5();      // Set
  step6();      // Set
  step7();      // Set
  step8();      // Set
};

//──────────────────────────────────────────────────────────────────
// Eye color layer — CreateEyeColorLayer.jsx
function CreateEyeColorLayer() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Make
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('Lyr '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putInteger(cTID('LyrI'), 4);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Clr '));
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 0);
    desc3.putInteger(cTID('Dstl'), 0);
    desc3.putInteger(cTID('DstW'), 0);
    desc3.putInteger(cTID('Dstt'), 255);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    var desc4 = new ActionDescriptor();
    desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 416.666666666667);
    desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('FrgC'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putDouble(cTID('Rd  '), 0);
    desc2.putDouble(cTID('Grn '), 239.996108949416);
    desc2.putDouble(cTID('Bl  '), 255);
    desc1.putObject(cTID('T   '), sTID("RGBColor"), desc2);
    desc1.putString(cTID('Srce'), "photoshopPicker");
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Eye Color Layer");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Make
  step3();      // Set
  step4();      // Set
  step5();      // Select
  step6();      // Select
  step7();      // Set
  step8();      // Set
};

//──────────────────────────────────────────────────────────────────
// Eyeshade layer — CreateEyeshadeLayer.jsx
function CreateEyeshadeLayer() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Make
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('Lyr '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putInteger(cTID('LyrI'), 4);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('FrgC'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putDouble(cTID('Rd  '), 0);
    desc2.putDouble(cTID('Grn '), 239.996108949416);
    desc2.putDouble(cTID('Bl  '), 255);
    desc1.putObject(cTID('T   '), sTID("RGBColor"), desc2);
    desc1.putString(cTID('Srce'), "photoshopPicker");
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 0);
    desc3.putInteger(cTID('Dstl'), 0);
    desc3.putInteger(cTID('DstW'), 0);
    desc3.putInteger(cTID('Dstt'), 255);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    var desc4 = new ActionDescriptor();
    desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 416.666666666667);
    desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Ovrl'));
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Eyeshade Layer");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Make
  step3();      // Set
  step4();      // Set
  step5();      // Select
  step6();      // Select
  step7();      // Set
  step8();      // Set
};

//──────────────────────────────────────────────────────────────────
// Hair color layer — CreateHairColorLayer.jsx
function CreateHairColorLayer() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Make
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('Lyr '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putInteger(cTID('LyrI'), 4);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Select
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Ovrl'));
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Hair Color Layer");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('FrgC'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putDouble(cTID('Rd  '), 167.996108949416);
    desc2.putDouble(cTID('Grn '), 2);
    desc2.putDouble(cTID('Bl  '), 165.996108949416);
    desc1.putObject(cTID('T   '), sTID("RGBColor"), desc2);
    desc1.putString(cTID('Srce'), "photoshopPicker");
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 0);
    desc3.putInteger(cTID('Dstl'), 0);
    desc3.putInteger(cTID('DstW'), 0);
    desc3.putInteger(cTID('Dstt'), 255);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    var desc4 = new ActionDescriptor();
    desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 416.666666666667);
    desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Make
  step3();      // Select
  step4();      // Select
  step5();      // Set
  step6();      // Set
  step7();      // Set
  step8();      // Set
};

//──────────────────────────────────────────────────────────────────
// Lipstick layer — CreateLipstickLayer.jsx
function CreateLipstickLayer() {
  // Stamp Visible (non-destructive)
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    StampVisible();
  };

  // Make
  function step2(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('Lyr '));
    desc1.putReference(cTID('null'), ref1);
    desc1.putInteger(cTID('LyrI'), 4);
    executeAction(cTID('Mk  '), desc1, dialogMode);
  };

  // Set
  function step3(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Ovrl'));
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step4(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    var list1 = new ActionList();
    var desc3 = new ActionDescriptor();
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
    desc3.putReference(cTID('Chnl'), ref2);
    desc3.putInteger(cTID('SrcB'), 0);
    desc3.putInteger(cTID('Srcl'), 0);
    desc3.putInteger(cTID('SrcW'), 255);
    desc3.putInteger(cTID('Srcm'), 255);
    desc3.putInteger(cTID('DstB'), 0);
    desc3.putInteger(cTID('Dstl'), 0);
    desc3.putInteger(cTID('DstW'), 0);
    desc3.putInteger(cTID('Dstt'), 255);
    list1.putObject(cTID('Blnd'), desc3);
    desc2.putList(cTID('Blnd'), list1);
    var desc4 = new ActionDescriptor();
    desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 416.666666666667);
    desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Select
  function step5(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putClass(cTID('PbTl'));
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Select
  function step6(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Brsh'), "Soft Round");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('slct'), desc1, dialogMode);
  };

  // Set
  function step7(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putProperty(cTID('Clr '), cTID('FrgC'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putDouble(cTID('Rd  '), 167.996108949416);
    desc2.putDouble(cTID('Grn '), 2);
    desc2.putDouble(cTID('Bl  '), 165.996108949416);
    desc1.putObject(cTID('T   '), sTID("RGBColor"), desc2);
    desc1.putString(cTID('Srce'), "photoshopPicker");
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  // Set
  function step8(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    desc1.putReference(cTID('null'), ref1);
    var desc2 = new ActionDescriptor();
    desc2.putString(cTID('Nm  '), "Lipstick");
    desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
    executeAction(cTID('setd'), desc1, dialogMode);
  };

  step1();      // Stamp Visible (non-destructive)
  step2();      // Make
  step3();      // Set
  step4();      // Set
  step5();      // Select
  step6();      // Select
  step7();      // Set
  step8();      // Set
};

//══════════════════════════════════════════════════════════════════
// PORTED CEP ACTIONS — the full CreativeHubRetouchPro panel
// (Effects, Skin Looks, Retouching extras, Makeup/Lips, Post-Process).
// Each body is the verbatim action-recorder sequence from the original
// jsx/Photoshop.jsx $._ext_* wrappers, with two mechanical edits:
//   • every leading Flatten Image → StampVisible() (non-destructive), and
//   • Post-Process's Windows-only "Darker (RGB).acv" load → inline curve.
// PORTED_TOOLS (bottom) maps tool ids to these functions for the dispatcher.
//══════════════════════════════════════════════════════════════════

//── effect-autumn  ($._ext_AUTUMN)  [flatten->stamp: 1]
function Run_effect_autumn() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 22:13:25 GMT+0500
  //
  
  
  //
  //==================== Autumn ==============
  //
  function Autumn() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Lmnc'), 67.06);
      desc4.putDouble(cTID('A   '), 32);
      desc4.putDouble(cTID('B   '), 120);
      desc3.putObject(cTID('Clr '), cTID('LbCl'), desc4);
      desc3.putInteger(cTID('Dnst'), 25);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), sTID("photoFilter"), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(cTID('Dnst'), 10);
      desc1.putObject(cTID('T   '), sTID("photoFilter"), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(16);
      list1.putInteger(0);
      list1.putInteger(-48);
      desc2.putList(cTID('MdtL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('SlcC'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(cTID('Clrs'), cTID('Clrs'), cTID('Grns'));
      desc3.putUnitDouble(cTID('Cyn '), cTID('#Prc'), -2);
      desc3.putUnitDouble(cTID('Ylw '), cTID('#Prc'), 100);
      list1.putObject(cTID('ClrC'), desc3);
      desc2.putList(cTID('ClrC'), list1);
      desc1.putObject(cTID('T   '), cTID('SlcC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Color Balance 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(9);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(16);
      list1.putInteger(0);
      list1.putInteger(-40);
      desc2.putList(cTID('MdtL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(29);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Selective Color 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(29);
      list1.putInteger(30);
      list1.putInteger(31);
      list1.putInteger(32);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Autumn (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Make
    step6();      // Set
    step7();      // Make
    step8();      // Set
    step9();      // Select
    step10();      // Set
    step11();      // Select
    step12();      // Select
    step13();      // Merge Layers
    step14();      // Set
  };
  
  
  
  //=========================================
  //                    Autumn.main
  //=========================================
  //
  
  Autumn.main = function () {
    Autumn();
  };
  
  Autumn.main();
}

//── effect-bleached  ($._ext_BLEACHEDEFFECT)  [flatten->stamp: 1]
function Run_effect_bleached() {
  //
  //
  
  //
  // Generated Mon Jul 03 2017 21:09:17 GMT+0500
  //
  
  
  //
  //==================== Bleached ==============
  //
  function Bleached() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Set
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Scrn'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -52);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(7);
      list1.putInteger(8);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Scrn'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Bleached (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Set
    step4();      // Make
    step5();      // Set
    step6();      // Select
    step7();      // Merge Layers
    step8();      // Set
    step9();      // Set
  };
  
  
  
  //=========================================
  //                    Bleached.main
  //=========================================
  //
  
  Bleached.main = function () {
    Bleached();
  };
  
  Bleached.main();
}

//── effect-camerafilm01  ($._ext_CAMERAFILM01EFFECT)  [flatten->stamp: 1]
function Run_effect_camerafilm01() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Camera Film 01 ==============
  //
  function CameraFilm01() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Bl  '));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 0);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 61);
      desc5.putDouble(cTID('Vrtc'), 84);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 204);
      desc6.putDouble(cTID('Vrtc'), 160);
      list2.putObject(cTID('Pnt '), desc6);
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Hrzn'), 255);
      desc7.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc7);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(9);
      list1.putInteger(10);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Camera FIlm 01 (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Merge Layers
    step7();      // Set
  };
  
  
  
  //=========================================
  //                    CameraFilm01.main
  //=========================================
  //
  
  CameraFilm01.main = function () {
    CameraFilm01();
  };
  
  CameraFilm01.main();
}

//── effect-camerafilm02  ($._ext_CAMERAFILMEFFECT02)  [flatten->stamp: 1]
function Run_effect_camerafilm02() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Camera Film 02 ==============
  //
  function CameraFilm02() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Rd  '));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 0);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 73);
      desc5.putDouble(cTID('Vrtc'), 42);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 203);
      desc6.putDouble(cTID('Vrtc'), 188);
      list2.putObject(cTID('Pnt '), desc6);
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Hrzn'), 255);
      desc7.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc7);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(18);
      list1.putInteger(19);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Camera Film 02 (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Merge Layers
    step7();      // Set
  };
  
  
  
  //=========================================
  //                    CameraFilm02.main
  //=========================================
  //
  
  CameraFilm02.main = function () {
    CameraFilm02();
  };
  
  CameraFilm02.main();
}

//── effect-camerafilm03  ($._ext_CAMERAFILMEFFECT03)  [flatten->stamp: 1]
function Run_effect_camerafilm03() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Camera Film 03 ==============
  //
  function CameraFilm03() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Grn '));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 0);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 76);
      desc5.putDouble(cTID('Vrtc'), 43);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 188);
      desc6.putDouble(cTID('Vrtc'), 211);
      list2.putObject(cTID('Pnt '), desc6);
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Hrzn'), 255);
      desc7.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc7);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(27);
      list1.putInteger(28);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Camera Film 03 (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Merge Layers
    step7();      // Set
  };
  
  
  
  //=========================================
  //                    CameraFilm03.main
  //=========================================
  //
  
  CameraFilm03.main = function () {
    CameraFilm03();
  };
  
  CameraFilm03.main();
}

//── effect-camerafilm04  ($._ext_CAMERAFILM04)  [flatten->stamp: 1]
function Run_effect_camerafilm04() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Camera Film 04 ==============
  //
  function CameraFilm04() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Rd  '));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 0);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 77);
      desc5.putDouble(cTID('Vrtc'), 53);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 204);
      desc6.putDouble(cTID('Vrtc'), 187);
      list2.putObject(cTID('Pnt '), desc6);
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Hrzn'), 255);
      desc7.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc7);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      var desc8 = new ActionDescriptor();
      var ref3 = new ActionReference();
      ref3.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Bl  '));
      desc8.putReference(cTID('Chnl'), ref3);
      var list3 = new ActionList();
      var desc9 = new ActionDescriptor();
      desc9.putDouble(cTID('Hrzn'), 0);
      desc9.putDouble(cTID('Vrtc'), 0);
      list3.putObject(cTID('Pnt '), desc9);
      var desc10 = new ActionDescriptor();
      desc10.putDouble(cTID('Hrzn'), 53);
      desc10.putDouble(cTID('Vrtc'), 76);
      list3.putObject(cTID('Pnt '), desc10);
      var desc11 = new ActionDescriptor();
      desc11.putDouble(cTID('Hrzn'), 211);
      desc11.putDouble(cTID('Vrtc'), 156);
      list3.putObject(cTID('Pnt '), desc11);
      var desc12 = new ActionDescriptor();
      desc12.putDouble(cTID('Hrzn'), 255);
      desc12.putDouble(cTID('Vrtc'), 255);
      list3.putObject(cTID('Pnt '), desc12);
      desc8.putList(cTID('Crv '), list3);
      list1.putObject(cTID('CrvA'), desc8);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -50);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(36);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Hue/Saturation 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(36);
      list1.putInteger(37);
      list1.putInteger(38);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Camera Film 04 (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Make
    step6();      // Set
    step7();      // Select
    step8();      // Select
    step9();      // Merge Layers
    step10();      // Set
  };
  
  
  
  //=========================================
  //                    CameraFilm04.main
  //=========================================
  //
  
  CameraFilm04.main = function () {
    CameraFilm04();
  };
  
  CameraFilm04.main();
}

//── effect-camerafilm05  ($._ext_CAMERAFILMEFFECT05)  [flatten->stamp: 1]
function Run_effect_camerafilm05() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Camera Film 05 ==============
  //
  function CameraFilm05() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putBoolean(sTID("useLegacy"), false);
      desc2.putObject(cTID('Type'), cTID('BrgC'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(cTID('Brgh'), -11);
      desc2.putInteger(cTID('Cntr'), 78);
      desc2.putBoolean(sTID("useLegacy"), false);
      desc1.putObject(cTID('T   '), cTID('BrgC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -26);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(-45);
      list1.putInteger(0);
      list1.putInteger(28);
      desc2.putList(cTID('ShdL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(50);
      list1.putInteger(51);
      list1.putInteger(52);
      list1.putInteger(53);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Camera Film 05 (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Make
    step6();      // Set
    step7();      // Make
    step8();      // Set
    step9();      // Select
    step10();      // Merge Layers
    step11();      // Set
  };
  
  
  
  //=========================================
  //                    CameraFilm05.main
  //=========================================
  //
  
  CameraFilm05.main = function () {
    CameraFilm05();
  };
  
  CameraFilm05.main();
}

//── effect-chilling  ($._ext_CHILLINGEFFECT)  [flatten->stamp: 1]
function Run_effect_chilling() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Chilling ==============
  //
  function Chilling() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(-72);
      list1.putInteger(0);
      list1.putInteger(27);
      desc2.putList(cTID('MdtL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 114);
      desc3.putInteger(cTID('DstW'), 189);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      var desc4 = new ActionDescriptor();
      desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 333.333333333333);
      desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(46);
      list1.putInteger(47);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Chilling (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Set
    step7();      // Select
    step8();      // Merge Layers
    step9();      // Set
  };
  
  
  
  //=========================================
  //                    Chilling.main
  //=========================================
  //
  
  Chilling.main = function () {
    Chilling();
  };
  
  Chilling.main();
}

//── effect-cinematic  ($._ext_CINEMATICEFFECT)  [flatten->stamp: 1]
function Run_effect_cinematic() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Cinematic ==============
  //
  function Cinematic() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putBoolean(sTID("useLegacy"), false);
      desc2.putObject(cTID('Type'), cTID('BrgC'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(cTID('Brgh'), 0);
      desc2.putInteger(cTID('Cntr'), 100);
      desc2.putBoolean(sTID("useLegacy"), false);
      desc1.putObject(cTID('T   '), cTID('BrgC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Lmns'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 31);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 60);
      desc5.putDouble(cTID('Vrtc'), 52);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 124);
      desc6.putDouble(cTID('Vrtc'), 127);
      list2.putObject(cTID('Pnt '), desc6);
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Hrzn'), 255);
      desc7.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc7);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(63);
      list1.putInteger(64);
      list1.putInteger(65);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Cinematic (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Set
    step6();      // Make
    step7();      // Set
    step8();      // Select
    step9();      // Merge Layers
    step10();      // Set
  };
  
  
  
  //=========================================
  //                    Cinematic.main
  //=========================================
  //
  
  Cinematic.main = function () {
    Cinematic();
  };
  
  Cinematic.main();
}

//── effect-duality  ($._ext_DUALITYEFFECT)  [flatten->stamp: 1]
function Run_effect_duality() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Duality ==============
  //
  function Duality() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Camera Raw Filter
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putString(cTID('CMod'), "Filter");
      desc1.putEnumerated(cTID('Sett'), cTID('Sett'), cTID('Cst '));
      desc1.putEnumerated(cTID('WBal'), cTID('WBal'), cTID('AsSh'));
      desc1.putInteger(cTID('Temp'), 0);
      desc1.putInteger(cTID('Tint'), 0);
      desc1.putInteger(cTID('AWBV'), 134348800);
      desc1.putBoolean(cTID('CtoG'), false);
      desc1.putInteger(cTID('Strt'), 0);
      desc1.putInteger(cTID('Shrp'), 0);
      desc1.putInteger(cTID('LNR '), 0);
      desc1.putInteger(cTID('CNR '), 0);
      desc1.putInteger(cTID('VigA'), 0);
      desc1.putInteger(cTID('BlkB'), 0);
      desc1.putInteger(cTID('RHue'), 50);
      desc1.putInteger(cTID('RSat'), 0);
      desc1.putInteger(cTID('GHue'), 0);
      desc1.putInteger(cTID('GSat'), 0);
      desc1.putInteger(cTID('BHue'), -63);
      desc1.putInteger(cTID('BSat'), 0);
      desc1.putInteger(cTID('Vibr'), 0);
      desc1.putInteger(cTID('HA_R'), 0);
      desc1.putInteger(cTID('HA_O'), 0);
      desc1.putInteger(cTID('HA_Y'), 0);
      desc1.putInteger(cTID('HA_G'), 0);
      desc1.putInteger(cTID('HA_A'), 0);
      desc1.putInteger(cTID('HA_B'), 0);
      desc1.putInteger(cTID('HA_P'), 0);
      desc1.putInteger(cTID('HA_M'), 0);
      desc1.putInteger(cTID('SA_R'), 0);
      desc1.putInteger(cTID('SA_O'), 0);
      desc1.putInteger(cTID('SA_Y'), 0);
      desc1.putInteger(cTID('SA_G'), 0);
      desc1.putInteger(cTID('SA_A'), 0);
      desc1.putInteger(cTID('SA_B'), 0);
      desc1.putInteger(cTID('SA_P'), 0);
      desc1.putInteger(cTID('SA_M'), 0);
      desc1.putInteger(cTID('LA_R'), 0);
      desc1.putInteger(cTID('LA_O'), 0);
      desc1.putInteger(cTID('LA_Y'), 0);
      desc1.putInteger(cTID('LA_G'), 0);
      desc1.putInteger(cTID('LA_A'), 0);
      desc1.putInteger(cTID('LA_B'), 0);
      desc1.putInteger(cTID('LA_P'), 0);
      desc1.putInteger(cTID('LA_M'), 0);
      desc1.putInteger(cTID('STSH'), 0);
      desc1.putInteger(cTID('STSS'), 0);
      desc1.putInteger(cTID('STHH'), 0);
      desc1.putInteger(cTID('STHS'), 0);
      desc1.putInteger(cTID('STB '), 0);
      desc1.putInteger(cTID('PC_S'), 0);
      desc1.putInteger(cTID('PC_D'), 0);
      desc1.putInteger(cTID('PC_L'), 0);
      desc1.putInteger(cTID('PC_H'), 0);
      desc1.putInteger(cTID('PC_1'), 25);
      desc1.putInteger(cTID('PC_2'), 50);
      desc1.putInteger(cTID('PC_3'), 75);
      desc1.putDouble(cTID('ShpR'), 1);
      desc1.putInteger(cTID('ShpD'), 25);
      desc1.putInteger(cTID('ShpM'), 0);
      desc1.putInteger(cTID('PCVA'), 0);
      desc1.putInteger(cTID('GRNA'), 0);
      desc1.putInteger(cTID('LPEn'), 0);
      desc1.putInteger(cTID('MDis'), 0);
      desc1.putInteger(cTID('PerV'), 0);
      desc1.putInteger(cTID('PerH'), 0);
      desc1.putDouble(cTID('PerR'), 0);
      desc1.putInteger(cTID('PerS'), 100);
      desc1.putInteger(cTID('PerA'), 0);
      desc1.putInteger(cTID('PerU'), 0);
      desc1.putDouble(cTID('PerX'), 0);
      desc1.putDouble(cTID('PerY'), 0);
      desc1.putInteger(cTID('AuCA'), 0);
      desc1.putDouble(cTID('Ex12'), 0);
      desc1.putInteger(cTID('Cr12'), 0);
      desc1.putInteger(cTID('Hi12'), 0);
      desc1.putInteger(cTID('Sh12'), 0);
      desc1.putInteger(cTID('Wh12'), 0);
      desc1.putInteger(cTID('Bk12'), 0);
      desc1.putInteger(cTID('Cl12'), 0);
      desc1.putInteger(cTID('DfPA'), 0);
      desc1.putInteger(cTID('DPHL'), 30);
      desc1.putInteger(cTID('DPHH'), 70);
      desc1.putInteger(cTID('DfGA'), 0);
      desc1.putInteger(cTID('DPGL'), 40);
      desc1.putInteger(cTID('DPGH'), 60);
      desc1.putInteger(cTID('Dhze'), 0);
      desc1.putInteger(cTID('TMMs'), 0);
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(255);
      list1.putInteger(255);
      desc1.putList(cTID('Crv '), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(255);
      list2.putInteger(255);
      desc1.putList(cTID('CrvR'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(255);
      list3.putInteger(255);
      desc1.putList(cTID('CrvG'), list3);
      var list4 = new ActionList();
      list4.putInteger(0);
      list4.putInteger(0);
      list4.putInteger(255);
      list4.putInteger(255);
      desc1.putList(cTID('CrvB'), list4);
      desc1.putString(cTID('CamP'), "Embedded");
      desc1.putString(cTID('CP_D'), "54650A341B5B5CCAE8442D0B43A92BCE");
      desc1.putInteger(cTID('PrVe'), 101122048);
      desc1.putString(cTID('Rtch'), "");
      desc1.putString(cTID('REye'), "");
      desc1.putString(cTID('LCs '), "");
      desc1.putString(cTID('Upri'), "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Adobe XMP Core 5.6-c128 79.159124, 2016/03/18-14:01:55        \">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\"\n    xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n   crs:UprightVersion=\"151388160\"\n   crs:UprightCenterMode=\"0\"\n   crs:UprightCenterNormX=\"0.5\"\n   crs:UprightCenterNormY=\"0.5\"\n   crs:UprightFocalMode=\"0\"\n   crs:UprightFocalLength35mm=\"35\"\n   crs:UprightPreview=\"False\"\n   crs:UprightTransformCount=\"6\"/>\n </rdf:RDF>\n</x:xmpmeta>\n");
      desc1.putString(cTID('GuUr'), "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Adobe XMP Core 5.6-c128 79.159124, 2016/03/18-14:01:55        \">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\"\n    xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n   crs:UprightFourSegmentsCount=\"0\"/>\n </rdf:RDF>\n</x:xmpmeta>\n");
      executeAction(sTID('Adobe Camera Raw Filter'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -27);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(16);
      list1.putInteger(17);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Duality (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Camera Raw Filter
    step4();      // Make
    step5();      // Set
    step6();      // Select
    step7();      // Merge Layers
    step8();      // Set
  };
  
  
  
  //=========================================
  //                    Duality.main
  //=========================================
  //
  
  Duality.main = function () {
    Duality();
  };
  
  Duality.main();
}

//── effect-hazynight  ($._ext_HAZYNIGHTEFFECT)  [flatten->stamp: 1]
function Run_effect_hazynight() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Hazy Night ==============
  //
  function HazyNight() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putBoolean(sTID("useLegacy"), false);
      desc2.putObject(cTID('Type'), cTID('BrgC'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(cTID('Brgh'), -106);
      desc2.putInteger(cTID('Cntr'), 0);
      desc2.putBoolean(sTID("useLegacy"), false);
      desc1.putObject(cTID('T   '), cTID('BrgC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(cTID('Brgh'), -106);
      desc2.putInteger(cTID('Cntr'), -50);
      desc2.putBoolean(sTID("useLegacy"), false);
      desc1.putObject(cTID('T   '), cTID('BrgC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Lmnc'), 67.06);
      desc4.putDouble(cTID('A   '), 32);
      desc4.putDouble(cTID('B   '), 120);
      desc3.putObject(cTID('Clr '), cTID('LbCl'), desc4);
      desc3.putInteger(cTID('Dnst'), 25);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), sTID("photoFilter"), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putUnitDouble(cTID('H   '), cTID('#Ang'), 232.937622070313);
      desc3.putDouble(cTID('Strt'), 87.4509803921569);
      desc3.putDouble(cTID('Brgh'), 91.7647058823529);
      desc2.putObject(cTID('Clr '), cTID('HSBC'), desc3);
      desc2.putInteger(cTID('Dnst'), 60);
      desc1.putObject(cTID('T   '), sTID("photoFilter"), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Lvls'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putDouble(cTID('Gmm '), 0.81);
      list1.putObject(cTID('LvlA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Lvls'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(-10);
      list1.putInteger(0);
      list1.putInteger(16);
      desc2.putList(cTID('MdtL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -41);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(27);
      list1.putInteger(28);
      list1.putInteger(29);
      list1.putInteger(30);
      list1.putInteger(31);
      list1.putInteger(32);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step15(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step16(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Hazy Night (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Set
    step6();      // Make
    step7();      // Set
    step8();      // Make
    step9();      // Set
    step10();      // Make
    step11();      // Set
    step12();      // Make
    step13();      // Set
    step14();      // Select
    step15();      // Merge Layers
    step16();      // Set
  };
  
  
  
  //=========================================
  //                    HazyNight.main
  //=========================================
  //
  
  HazyNight.main = function () {
    HazyNight();
  };
  
  HazyNight.main();
}

//── effect-noblue  ($._ext_NOBLUE)  [flatten->stamp: 1]
function Run_effect_noblue() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== No Blue ==============
  //
  function NoBlue() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('LclR'), 4);
      desc3.putInteger(cTID('BgnR'), 135);
      desc3.putInteger(cTID('BgnS'), 165);
      desc3.putInteger(cTID('EndS'), 195);
      desc3.putInteger(cTID('EndR'), 225);
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -100);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      var desc4 = new ActionDescriptor();
      desc4.putInteger(cTID('LclR'), 5);
      desc4.putInteger(cTID('BgnR'), 195);
      desc4.putInteger(cTID('BgnS'), 225);
      desc4.putInteger(cTID('EndS'), 255);
      desc4.putInteger(cTID('EndR'), 285);
      desc4.putInteger(cTID('H   '), 0);
      desc4.putInteger(cTID('Strt'), -100);
      desc4.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc4);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(19);
      list1.putInteger(20);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "No Blue (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Merge Layers
    step7();      // Set
  };
  
  
  
  //=========================================
  //                    NoBlue.main
  //=========================================
  //
  
  NoBlue.main = function () {
    NoBlue();
  };
  
  NoBlue.main();
}

//── effect-sepia  ($._ext_SEPIATONING)  [flatten->stamp: 1]
function Run_effect_sepia() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 21:58:32 GMT-0700
  //
  
  
  //
  //==================== Effect: Sepia Toning  ==============
  //
  function Effect_SepiaToning() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Make
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('SnpS'));
      desc1.putReference(cTID('null'), ref1);
      var ref2 = new ActionReference();
      ref2.putProperty(cTID('HstS'), cTID('CrnH'));
      desc1.putReference(cTID('From'), ref2);
      desc1.putEnumerated(cTID('Usng'), cTID('HstS'), cTID('FllD'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('Lyr '));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Merge Visible
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putBoolean(cTID('Dplc'), true);
      executeAction(sTID('mergeVisible'), desc1, dialogMode);
    };
  
    // Desaturate
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(cTID('Dstt'), undefined, dialogMode);
    };
  
    // Make
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var desc2 = new ActionDescriptor();
      desc2.putBoolean(cTID('Grup'), true);
      var desc3 = new ActionDescriptor();
      desc3.putBoolean(cTID('Clrz'), true);
      var list1 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putInteger(cTID('H   '), 30);
      desc4.putInteger(cTID('Strt'), 25);
      desc4.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc4);
      desc3.putList(cTID('Adjs'), list1);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Nw  '), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(63);
      list1.putInteger(64);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Sepia Toning");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Make
    step3();      // Make
    step4();      // Merge Visible
    step5();      // Desaturate
    step6();      // Make
    step7();      // Select
    step8();      // Merge Layers
    step9();      // Set
  };
  
  
  
  //=========================================
  //                    Effect_SepiaToning.main
  //=========================================
  //
  
  Effect_SepiaToning.main = function () {
    Effect_SepiaToning();
  };
  
  Effect_SepiaToning.main();
}

//── effect-sunset  ($._ext_SUNSET)  [flatten->stamp: 1]
function Run_effect_sunset() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Sunset ==============
  //
  function Sunset() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 0);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 211);
      desc5.putDouble(cTID('Vrtc'), 189);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 255);
      desc6.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc6);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(65);
      list1.putInteger(0);
      list1.putInteger(-74);
      desc2.putList(cTID('MdtL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(22);
      list1.putInteger(23);
      list1.putInteger(24);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Sunset (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Make
    step6();      // Set
    step7();      // Select
    step8();      // Merge Layers
    step9();      // Set
  };
  
  
  
  //=========================================
  //                    Sunset.main
  //=========================================
  //
  
  Sunset.main = function () {
    Sunset();
  };
  
  Sunset.main();
}

//── effect-triad  ($._ext_TRIAD)  [flatten->stamp: 1]
function Run_effect_triad() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Triad ==============
  //
  function Triad() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var desc4 = new ActionDescriptor();
      desc4.putString(cTID('Nm  '), "Foreground to Background");
      desc4.putEnumerated(cTID('GrdF'), cTID('GrdF'), cTID('CstS'));
      desc4.putDouble(cTID('Intr'), 4096);
      var list1 = new ActionList();
      var desc5 = new ActionDescriptor();
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Rd  '), 255);
      desc6.putDouble(cTID('Grn '), 255);
      desc6.putDouble(cTID('Bl  '), 255);
      desc5.putObject(cTID('Clr '), sTID("RGBColor"), desc6);
      desc5.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
      desc5.putInteger(cTID('Lctn'), 0);
      desc5.putInteger(cTID('Mdpn'), 50);
      list1.putObject(cTID('Clrt'), desc5);
      var desc7 = new ActionDescriptor();
      var desc8 = new ActionDescriptor();
      desc8.putDouble(cTID('Rd  '), 0);
      desc8.putDouble(cTID('Grn '), 0);
      desc8.putDouble(cTID('Bl  '), 0);
      desc7.putObject(cTID('Clr '), sTID("RGBColor"), desc8);
      desc7.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
      desc7.putInteger(cTID('Lctn'), 4096);
      desc7.putInteger(cTID('Mdpn'), 50);
      list1.putObject(cTID('Clrt'), desc7);
      desc4.putList(cTID('Clrs'), list1);
      var list2 = new ActionList();
      var desc9 = new ActionDescriptor();
      desc9.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
      desc9.putInteger(cTID('Lctn'), 0);
      desc9.putInteger(cTID('Mdpn'), 50);
      list2.putObject(cTID('TrnS'), desc9);
      var desc10 = new ActionDescriptor();
      desc10.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
      desc10.putInteger(cTID('Lctn'), 4096);
      desc10.putInteger(cTID('Mdpn'), 50);
      list2.putObject(cTID('TrnS'), desc10);
      desc4.putList(cTID('Trns'), list2);
      desc3.putObject(cTID('Grad'), cTID('Grdn'), desc4);
      desc2.putObject(cTID('Type'), cTID('GdMp'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putString(cTID('Nm  '), "Custom");
      desc3.putEnumerated(cTID('GrdF'), cTID('GrdF'), cTID('CstS'));
      desc3.putDouble(cTID('Intr'), 4096);
      var list1 = new ActionList();
      var desc4 = new ActionDescriptor();
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Rd  '), 243.000000715256);
      desc5.putDouble(cTID('Grn '), 114.35408860445);
      desc5.putDouble(cTID('Bl  '), 0);
      desc4.putObject(cTID('Clr '), sTID("RGBColor"), desc5);
      desc4.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
      desc4.putInteger(cTID('Lctn'), 0);
      desc4.putInteger(cTID('Mdpn'), 50);
      list1.putObject(cTID('Clrt'), desc4);
      var desc6 = new ActionDescriptor();
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Rd  '), 234.007783234119);
      desc7.putDouble(cTID('Grn '), 255);
      desc7.putDouble(cTID('Bl  '), 0);
      desc6.putObject(cTID('Clr '), sTID("RGBColor"), desc7);
      desc6.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
      desc6.putInteger(cTID('Lctn'), 2037);
      desc6.putInteger(cTID('Mdpn'), 50);
      list1.putObject(cTID('Clrt'), desc6);
      var desc8 = new ActionDescriptor();
      var desc9 = new ActionDescriptor();
      desc9.putDouble(cTID('Rd  '), 0);
      desc9.putDouble(cTID('Grn '), 234.015565216541);
      desc9.putDouble(cTID('Bl  '), 255);
      desc8.putObject(cTID('Clr '), sTID("RGBColor"), desc9);
      desc8.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
      desc8.putInteger(cTID('Lctn'), 4096);
      desc8.putInteger(cTID('Mdpn'), 50);
      list1.putObject(cTID('Clrt'), desc8);
      desc3.putList(cTID('Clrs'), list1);
      var list2 = new ActionList();
      var desc10 = new ActionDescriptor();
      desc10.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
      desc10.putInteger(cTID('Lctn'), 0);
      desc10.putInteger(cTID('Mdpn'), 50);
      list2.putObject(cTID('TrnS'), desc10);
      var desc11 = new ActionDescriptor();
      desc11.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
      desc11.putInteger(cTID('Lctn'), 4096);
      desc11.putInteger(cTID('Mdpn'), 50);
      list2.putObject(cTID('TrnS'), desc11);
      desc3.putList(cTID('Trns'), list2);
      desc2.putObject(cTID('Grad'), cTID('Grdn'), desc3);
      desc1.putObject(cTID('T   '), cTID('GdMp'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Ovrl'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(34);
      list1.putInteger(35);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Triad (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Set
    step6();      // Select
    step7();      // Merge Layers
    step8();      // Set
  };
  
  
  
  //=========================================
  //                    Triad.main
  //=========================================
  //
  
  Triad.main = function () {
    Triad();
  };
  
  Triad.main();
}

//── effect-warmlight  ($._ext_WARMLIGHT)  [flatten->stamp: 1]
function Run_effect_warmlight() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Warm Light ==============
  //
  function WarmLight() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(28);
      list1.putInteger(0);
      list1.putInteger(-20);
      desc2.putList(cTID('MdtL'), list1);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Lmnc'), 67.06);
      desc4.putDouble(cTID('A   '), 32);
      desc4.putDouble(cTID('B   '), 120);
      desc3.putObject(cTID('Clr '), cTID('LbCl'), desc4);
      desc3.putInteger(cTID('Dnst'), 25);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), sTID("photoFilter"), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(34);
      list1.putInteger(35);
      list1.putInteger(36);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Warm Light (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Make
    step6();      // Select
    step7();      // Merge Layers
    step8();      // Set
  };
  
  
  
  //=========================================
  //                    WarmLight.main
  //=========================================
  //
  
  WarmLight.main = function () {
    WarmLight();
  };
  
  WarmLight.main();
}

//── effect-warmth  ($._ext_WARMTH)  [flatten->stamp: 1]
function Run_effect_warmth() {
  //
  //
  
  //
  // Generated Sun Jul 02 2017 21:54:45 GMT+0500
  //
  
  
  //
  //==================== Warmth ==============
  //
  function Warmth() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(0);
      desc3.putList(cTID('ShdL'), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(0);
      desc3.putList(cTID('MdtL'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(0);
      desc3.putList(cTID('HghL'), list3);
      desc3.putBoolean(cTID('PrsL'), true);
      desc2.putObject(cTID('Type'), cTID('ClrB'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      list1.putInteger(43);
      list1.putInteger(0);
      list1.putInteger(-45);
      desc2.putList(cTID('MdtL'), list1);
      var list2 = new ActionList();
      list2.putInteger(29);
      list2.putInteger(0);
      list2.putInteger(-36);
      desc2.putList(cTID('HghL'), list2);
      desc1.putObject(cTID('T   '), cTID('ClrB'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(40);
      list1.putInteger(41);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Layer Via Copy
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Desaturate
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(cTID('Dstt'), undefined, dialogMode);
    };
  
    // Make
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Lvls'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      list2.putInteger(196);
      list2.putInteger(255);
      desc3.putList(cTID('Inpt'), list2);
      list1.putObject(cTID('LvlA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Lvls'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Color Balance 1 copy");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(42);
      list1.putInteger(43);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Gaussian Blur
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putUnitDouble(cTID('Rds '), cTID('#Pxl'), 41.5);
      executeAction(sTID('gaussianBlur'), desc1, dialogMode);
    };
  
    // Set
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Scrn'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step15(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Color Balance 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(41);
      list1.putInteger(43);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step16(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step17(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Warmth (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Merge Layers
    step7();      // Layer Via Copy
    step8();      // Desaturate
    step9();      // Make
    step10();      // Set
    step11();      // Select
    step12();      // Merge Layers
    step13();      // Gaussian Blur
    step14();      // Set
    step15();      // Select
    step16();      // Merge Layers
    step17();      // Set
  };
  
  
  
  //=========================================
  //                    Warmth.main
  //=========================================
  //
  
  Warmth.main = function () {
    Warmth();
  };
  
  Warmth.main();
}

//── skinlook-candy  ($._ext_CANDYSKIN)  [flatten->stamp: 1]
function Run_skinlook_candy() {
  //
  //
  
  //
  // Generated Mon Jul 03 2017 21:28:01 GMT+0500
  //
  
  
  //
  //==================== Candy Skin ==============
  //
  function CandySkin() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
      desc3.putReference(cTID('Chnl'), ref2);
      var list2 = new ActionList();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Hrzn'), 0);
      desc4.putDouble(cTID('Vrtc'), 0);
      list2.putObject(cTID('Pnt '), desc4);
      var desc5 = new ActionDescriptor();
      desc5.putDouble(cTID('Hrzn'), 72);
      desc5.putDouble(cTID('Vrtc'), 47);
      list2.putObject(cTID('Pnt '), desc5);
      var desc6 = new ActionDescriptor();
      desc6.putDouble(cTID('Hrzn'), 171);
      desc6.putDouble(cTID('Vrtc'), 218);
      list2.putObject(cTID('Pnt '), desc6);
      var desc7 = new ActionDescriptor();
      desc7.putDouble(cTID('Hrzn'), 255);
      desc7.putDouble(cTID('Vrtc'), 255);
      list2.putObject(cTID('Pnt '), desc7);
      desc3.putList(cTID('Crv '), list2);
      list1.putObject(cTID('CrvA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 113);
      desc3.putInteger(cTID('DstW'), 255);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(8);
      list1.putInteger(9);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Candy Skin (Magic Retouch Pro)");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('RvlA'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Fill
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putEnumerated(cTID('Usng'), cTID('FlCn'), cTID('Blck'));
      desc1.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
      desc1.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
      executeAction(cTID('Fl  '), desc1, dialogMode);
    };
  
    // Set
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 0);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step15(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Lmns'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step16(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Select
    step5();      // Set
    step6();      // Set
    step7();      // Select
    step8();      // Merge Layers
    step9();      // Set
    step10();      // Make
    step11();      // Fill
    step12();      // Set
    step13();      // Select
    step14();      // Select
    step15();      // Set
    step16();      // Select
  };
  
  
  
  //=========================================
  //                    CandySkin.main
  //=========================================
  //
  
  CandySkin.main = function () {
    CandySkin();
  };
  
  CandySkin.main();
}

//── skinlook-gritty  ($._ext_GRITTYSKIN)  [flatten->stamp: 1]
function Run_skinlook_gritty() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 21:58:32 GMT-0700
  //
  
  
  //
  //==================== Gritty Skin ==============
  //
  function GrittySkin() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Shadow/Highlight
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('Amnt'), cTID('#Prc'), 0);
      desc2.putUnitDouble(cTID('Wdth'), cTID('#Prc'), 50);
      desc2.putInteger(cTID('Rds '), 30);
      desc1.putObject(cTID('sdwM'), sTID("adaptCorrectTones"), desc2);
      var desc3 = new ActionDescriptor();
      desc3.putUnitDouble(cTID('Amnt'), cTID('#Prc'), 0);
      desc3.putUnitDouble(cTID('Wdth'), cTID('#Prc'), 50);
      desc3.putInteger(cTID('Rds '), 30);
      desc1.putObject(cTID('hglM'), sTID("adaptCorrectTones"), desc3);
      desc1.putDouble(cTID('BlcC'), 0.01);
      desc1.putDouble(cTID('WhtC'), 0.01);
      desc1.putInteger(cTID('Cntr'), 100);
      desc1.putInteger(cTID('ClrC'), 0);
      executeAction(sTID('adaptCorrect'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Gritty Skin");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 0);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Shadow/Highlight
    step4();      // Make
    step5();      // Select
    step6();      // Set
    step7();      // Select
    step8();      // Select
    step9();      // Select
    step10();      // Set
  };
  
  
  
  //=========================================
  //                    GrittySkin.main
  //=========================================
  //
  
  GrittySkin.main = function () {
    GrittySkin();
  };
  
  GrittySkin.main();
}

//── skinlook-highkey  ($._ext_HKEYSKIN)  [flatten->stamp: 1]
function Run_skinlook_highkey() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 21:57:50 GMT-0700
  //
  
  
  //
  //==================== High Key Skin ==============
  //
  function HighKeySkin() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putInteger(cTID('Rd  '), 40);
      desc3.putInteger(cTID('Yllw'), 60);
      desc3.putInteger(cTID('Grn '), 40);
      desc3.putInteger(cTID('Cyn '), 60);
      desc3.putInteger(cTID('Bl  '), 20);
      desc3.putInteger(cTID('Mgnt'), 80);
      desc3.putBoolean(sTID("useTint"), false);
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Rd  '), 225.000457763672);
      desc4.putDouble(cTID('Grn '), 211.000671386719);
      desc4.putDouble(cTID('Bl  '), 179.001159667969);
      desc3.putObject(sTID("tintColor"), sTID("RGBColor"), desc4);
      desc2.putObject(cTID('Type'), cTID('BanW'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Scrn'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(73);
      list1.putInteger(74);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "High Key Skin");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 0);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 255);
      desc3.putInteger(cTID('DstW'), 255);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      var desc4 = new ActionDescriptor();
      desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 416.666666666667);
      desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step15(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Set
    step5();      // Select
    step6();      // Merge Layers
    step7();      // Set
    step8();      // Make
    step9();      // Select
    step10();      // Select
    step11();      // Set
    step12();      // Select
    step13();      // Select
    step14();      // Set
    step15();      // Select
  };
  
  
  
  //=========================================
  //                    HighKeySkin.main
  //=========================================
  //
  
  HighKeySkin.main = function () {
    HighKeySkin();
  };
  
  HighKeySkin.main();
}

//── skinlook-tan  ($._ext_TANSKIN)  [flatten->stamp: 1]
function Run_skinlook_tan() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 21:50:52 GMT-0700
  //
  
  
  //
  //==================== Tan Skin ==============
  //
  function TanSkin() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Set
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Mltp'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Tan Skin");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 334.281005859375);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Set
    step4();      // Make
    step5();      // Select
    step6();      // Set
    step7();      // Select
    step8();      // Select
    step9();      // Set
    step10();      // Select
  };
  
  
  
  //=========================================
  //                    TanSkin.main
  //=========================================
  //
  
  TanSkin.main = function () {
    TanSkin();
  };
  
  TanSkin.main();
}

//── retouch-basic  ($._ext_CREATERETOUCHLAYER)  [flatten->stamp: 1]
function Run_retouch_basic() {
  //
  //
  
  //
  // Generated Sun Jun 22 2014 12:07:34 GMT-0700
  //
  
  
  //
  //==================== Step 1: Create Retouch Layer ==============
  //
  function Step1_CreateRetouchLayer() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Set
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Retouch Layer");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Lghn'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Retouch Layer");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('MixB'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(sTID("toolPreset"), "Retouch Preset");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Set
    step4();      // Set
    step5();      // Set
    step6();      // Select
    step7();      // Select
  };
  
  
  
  //=========================================
  //                    Step1_CreateRetouchLayer.main
  //=========================================
  //
  
  Step1_CreateRetouchLayer.main = function () {
    Step1_CreateRetouchLayer();
  };
  
  Step1_CreateRetouchLayer.main();
}

//── remove-blemishes  ($._ext_REMOVEBLEMISHES)  [flatten->stamp: 0]
function Run_remove_blemishes() {
  //
  //
  
  //
  // Generated Mon Sep 26 2016 08:35:43 GMT+0500
  //
  
  //
  function RemoveBlemishes() {
    // Select
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Background");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(1);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Select
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Blemish Removal Layer");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(10);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Chnl'), sTID("selection"));
      desc1.putReference(cTID('null'), ref1);
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Trsp'));
      desc1.putReference(cTID('T   '), ref2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Hide
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var list1 = new ActionList();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      list1.putReference(ref1);
      desc1.putList(cTID('null'), list1);
      executeAction(cTID('Hd  '), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Background copy");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(12);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Fill
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putEnumerated(cTID('Usng'), cTID('FlCn'), sTID("contentAware"));
      desc1.putBoolean(sTID("contentAwareColorAdaptationFill"), true);
      desc1.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
      desc1.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
      executeAction(cTID('Fl  '), desc1, dialogMode);
    };
  
    // Set
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Chnl'), sTID("selection"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(cTID('T   '), cTID('Ordn'), cTID('None'));
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Blemish Removal Layer");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(12);
      list1.putInteger(10);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Blemish Removal");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Select
    step2();      // Layer Via Copy
    step3();      // Select
    step4();      // Set
    step5();      // Hide
    step6();      // Select
    step7();      // Fill
    step8();      // Set
    step9();      // Select
    step10();      // Merge Layers
    step11();      // Set
  };
  
  
  
  //=========================================
  //                    RemoveBlemishes.main
  //=========================================
  //
  
  RemoveBlemishes.main = function () {
    RemoveBlemishes();
  };
  
  RemoveBlemishes.main();
}

//── teeth-whitening  ($._ext_TEETHWHITENING)  [flatten->stamp: 1]
function Run_teeth_whitening() {
  //
  //==================== Teeth Whitening ==============
  //
  function TeethWhitening() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Set
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "1");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('LclR'), 1);
      desc3.putInteger(cTID('BgnR'), 315);
      desc3.putInteger(cTID('BgnS'), 345);
      desc3.putInteger(cTID('EndS'), 15);
      desc3.putInteger(cTID('EndR'), 45);
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -50);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      var desc4 = new ActionDescriptor();
      desc4.putInteger(cTID('LclR'), 2);
      desc4.putInteger(cTID('BgnR'), 15);
      desc4.putInteger(cTID('BgnS'), 45);
      desc4.putInteger(cTID('EndS'), 75);
      desc4.putInteger(cTID('EndR'), 105);
      desc4.putInteger(cTID('H   '), 0);
      desc4.putInteger(cTID('Strt'), -100);
      desc4.putInteger(cTID('Lght'), 100);
      list1.putObject(cTID('Hst2'), desc4);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(11);
      list1.putInteger(12);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Make
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "TeethWhitening");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Reset
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('Clrs'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('Rset'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Set
    step4();      // Make
    step5();      // Set
    step6();      // Select
    step7();      // Merge Layers
    step8();      // Make
    step9();      // Select
    step10();      // Set
    step11();      // Select
    step12();      // Select
    step13();      // Select
    step14();      // Reset
  };
  
  
  
  //=========================================
  //                    TeethWhitening.main
  //=========================================
  //
  
  TeethWhitening.main = function () {
    TeethWhitening();
  };
  
  TeethWhitening.main();
}

//── eyes-enhance  ($._ext_EYESENHANCEMENTLAYER)  [flatten->stamp: 1]
function Run_eyes_enhance() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 16:32:29 GMT-0700
  //
  
  
  //
  //==================== Step 1: Create Eye Enhancement Layer ==============
  //
  function Step1_CreateEyeEnhancementLayer() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Set
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Eye Enhancement Layer");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('RvlA'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Smart Sharpen
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putUnitDouble(cTID('Amnt'), cTID('#Prc'), 319);
      desc1.putUnitDouble(cTID('Rds '), cTID('#Pxl'), 1);
      desc1.putInteger(cTID('Thsh'), 0);
      desc1.putInteger(cTID('Angl'), 0);
      desc1.putBoolean(sTID("moreAccurate"), false);
      desc1.putEnumerated(cTID('blur'), sTID("blurType"), cTID('GsnB'));
      desc1.putString(sTID("preset"), "Default");
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('Amnt'), cTID('#Prc'), 0);
      desc2.putUnitDouble(cTID('Wdth'), cTID('#Prc'), 50);
      desc2.putInteger(cTID('Rds '), 1);
      desc1.putObject(cTID('sdwM'), sTID("adaptCorrectTones"), desc2);
      var desc3 = new ActionDescriptor();
      desc3.putUnitDouble(cTID('Amnt'), cTID('#Prc'), 0);
      desc3.putUnitDouble(cTID('Wdth'), cTID('#Prc'), 50);
      desc3.putInteger(cTID('Rds '), 1);
      desc1.putObject(cTID('hglM'), sTID("adaptCorrectTones"), desc3);
      executeAction(sTID('smartSharpen'), desc1, dialogMode);
    };
  
    // Make
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('Clrs'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Swatch 1");
      var desc3 = new ActionDescriptor();
      desc3.putDouble(cTID('Rd  '), 0);
      desc3.putDouble(cTID('Grn '), 0);
      desc3.putDouble(cTID('Bl  '), 0);
      desc2.putObject(cTID('Clr '), sTID("RGBColor"), desc3);
      desc1.putObject(cTID('Usng'), cTID('Clrs'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Invert
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(cTID('Invr'), undefined, dialogMode);
    };
  
    // Select
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 0);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Set
    step4();      // Make
    step5();      // Select
    step6();      // Smart Sharpen
    step7();      // Make
    step8();      // Select
    step9();      // Invert
    step10();      // Select
    step11();      // Select
    step12();      // Set
  };
  
  
  
  //=========================================
  //                    Step1_CreateEyeEnhancementLayer.main
  //=========================================
  //
  
  Step1_CreateEyeEnhancementLayer.main = function () {
    Step1_CreateEyeEnhancementLayer();
  };
  
  Step1_CreateEyeEnhancementLayer.main();
}

//── lip-gloss  ($._ext_LIPGLOSS)  [flatten->stamp: 1]
function Run_lip_gloss() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 18:29:20 GMT-0700
  //
  
  
  //
  //==================== Lip Gloss ==============
  //
  function LipGloss() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Make
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(sTID("contentLayer"));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Rd  '), 255);
      desc4.putDouble(cTID('Grn '), 255);
      desc4.putDouble(cTID('Bl  '), 255);
      desc3.putObject(cTID('Clr '), sTID("RGBColor"), desc4);
      desc2.putObject(cTID('Type'), sTID("solidColorLayer"), desc3);
      desc1.putObject(cTID('Usng'), sTID("contentLayer"), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(75);
      list1.putInteger(76);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 126);
      desc3.putInteger(cTID('Dstl'), 255);
      desc3.putInteger(cTID('DstW'), 255);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Lip Gloss");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 183.526611328125);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Make
    step4();      // Select
    step5();      // Merge Layers
    step6();      // Set
    step7();      // Make
    step8();      // Select
    step9();      // Set
    step10();      // Set
    step11();      // Select
    step12();      // Select
    step13();      // Select
  };
  
  
  
  //=========================================
  //                    LipGloss.main
  //=========================================
  //
  
  LipGloss.main = function () {
    LipGloss();
  };
  
  LipGloss.main();
}

//── lip-colorboost  ($._ext_LIPCOLORBOOST)  [flatten->stamp: 1]
function Run_lip_colorboost() {
  //
  //
  
  //
  // Generated Mon Jun 23 2014 18:24:38 GMT-0700
  //
  
  
  //
  //==================== Natural Lips Color Boost ==============
  //
  function NaturalLipsColorBoost() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Make
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putClass(cTID('Type'), sTID("vibrance"));
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(sTID("vibrance"), 100);
      desc1.putObject(cTID('T   '), sTID("vibrance"), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Background");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(1);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Layer Via Copy
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Select
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Vibrance 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(73);
      list1.putInteger(71);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Natural Lips Color Boost");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putClass(cTID('Nw  '), cTID('Chnl'));
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
      desc1.putReference(cTID('At  '), ref1);
      desc1.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('HdAl'));
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Select
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('PbTl'));
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Brsh'), "Soft Round");
      desc1.putReference(cTID('null'), ref1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putProperty(cTID('Clr '), cTID('FrgC'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(cTID('H   '), cTID('#Ang'), 0);
      desc2.putDouble(cTID('Strt'), 0);
      desc2.putDouble(cTID('Brgh'), 100);
      desc1.putObject(cTID('T   '), cTID('HSBC'), desc2);
      desc1.putString(cTID('Srce'), "photoshopPicker");
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Make
    step3();      // Select
    step4();      // Set
    step5();      // Select
    step6();      // Layer Via Copy
    step7();      // Select
    step8();      // Merge Layers
    step9();      // Set
    step10();      // Make
    step11();      // Select
    step12();      // Select
    step13();      // Set
  };
  
  
  
  //=========================================
  //                    NaturalLipsColorBoost.main
  //=========================================
  //
  
  NaturalLipsColorBoost.main = function () {
    NaturalLipsColorBoost();
  };
  
  NaturalLipsColorBoost.main();
}

//── post-process  ($._ext_POSTPROCESS)  [flatten->stamp: 1, acv->inline curve]
function Run_post_process() {
  //
  //==================== MRP Post Processing ==============
  //
  function MRPPostProcessing() {
    // Stamp Visible (non-destructive)
    function step1(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      StampVisible();
    };
  
    // Layer Via Copy
    function step2(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      executeAction(sTID('copyToLayer'), undefined, dialogMode);
    };
  
    // Levels
    function step3(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putBoolean(cTID('Auto'), true);
      executeAction(cTID('Lvls'), desc1, dialogMode);
    };
  
    // Make
    function step4(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Lvls'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step5(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putBoolean(cTID('AuCo'), true);
      list1.putObject(cTID('LvlA'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('Lvls'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step6(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putBoolean(sTID("useLegacy"), false);
      desc2.putObject(cTID('Type'), cTID('BrgC'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step7(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putBoolean(cTID('Auto'), true);
      desc2.putBoolean(sTID("useLegacy"), false);
      desc1.putObject(cTID('T   '), cTID('BrgC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step8(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putBoolean(sTID("useLegacy"), false);
      desc2.putObject(cTID('Type'), cTID('BrgC'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step9(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putInteger(cTID('Brgh'), 0);
      desc2.putInteger(cTID('Cntr'), 100);
      desc2.putBoolean(sTID("useLegacy"), false);
      desc1.putObject(cTID('T   '), cTID('BrgC'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step10(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step11(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 255);
      desc3.putInteger(cTID('DstW'), 0);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step12(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putInteger(cTID('Rd  '), 40);
      desc3.putInteger(cTID('Yllw'), 60);
      desc3.putInteger(cTID('Grn '), 40);
      desc3.putInteger(cTID('Cyn '), 60);
      desc3.putInteger(cTID('Bl  '), 20);
      desc3.putInteger(cTID('Mgnt'), 80);
      desc3.putBoolean(sTID("useTint"), false);
      var desc4 = new ActionDescriptor();
      desc4.putDouble(cTID('Rd  '), 225.000457763672);
      desc4.putDouble(cTID('Grn '), 211.000671386719);
      desc4.putDouble(cTID('Bl  '), 179.001159667969);
      desc3.putObject(sTID("tintColor"), sTID("RGBColor"), desc4);
      desc2.putObject(cTID('Type'), cTID('BanW'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step13(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      desc2.putInteger(cTID('Rd  '), 23);
      desc2.putInteger(cTID('Yllw'), 57);
      desc2.putInteger(cTID('Grn '), 23);
      desc2.putInteger(cTID('Cyn '), 55);
      desc2.putInteger(cTID('Mgnt'), 54);
      desc1.putObject(cTID('T   '), cTID('BanW'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step14(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Lmns'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step15(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step16(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putUnitDouble(sTID("fillOpacity"), cTID('#Prc'), 50);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Color Range
    function step17(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putInteger(cTID('Fzns'), 40);
      desc1.putEnumerated(cTID('Clrs'), cTID('Clrs'), sTID("skinTone"));
      desc1.putInteger(sTID("colorModel"), 0);
      executeAction(sTID('colorRange'), desc1, dialogMode);
    };
  
    // Make
    function step18(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step19(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -10);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step20(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc3.putBoolean(cTID('Clrz'), false);
      desc2.putObject(cTID('Type'), cTID('HStr'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step21(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      desc3.putInteger(cTID('LclR'), 1);
      desc3.putInteger(cTID('BgnR'), 315);
      desc3.putInteger(cTID('BgnS'), 345);
      desc3.putInteger(cTID('EndS'), 15);
      desc3.putInteger(cTID('EndR'), 45);
      desc3.putInteger(cTID('H   '), 0);
      desc3.putInteger(cTID('Strt'), -10);
      desc3.putInteger(cTID('Lght'), 0);
      list1.putObject(cTID('Hst2'), desc3);
      desc2.putList(cTID('Adjs'), list1);
      desc1.putObject(cTID('T   '), cTID('HStr'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Merge Visible
    function step22(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putBoolean(cTID('Dplc'), true);
      executeAction(sTID('mergeVisible'), desc1, dialogMode);
    };
  
    // Camera Raw Filter
    function step23(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      desc1.putString(cTID('CMod'), "Filter");
      desc1.putEnumerated(cTID('Sett'), cTID('Sett'), cTID('Cst '));
      desc1.putEnumerated(cTID('WBal'), cTID('WBal'), cTID('AsSh'));
      desc1.putInteger(cTID('Temp'), 0);
      desc1.putInteger(cTID('Tint'), 0);
      desc1.putInteger(cTID('AWBV'), 134348800);
      desc1.putBoolean(cTID('CtoG'), false);
      desc1.putInteger(cTID('Strt'), 0);
      desc1.putInteger(cTID('Shrp'), 0);
      desc1.putInteger(cTID('LNR '), 0);
      desc1.putInteger(cTID('CNR '), 0);
      desc1.putInteger(cTID('VigA'), 0);
      desc1.putInteger(cTID('BlkB'), 0);
      desc1.putInteger(cTID('RHue'), 0);
      desc1.putInteger(cTID('RSat'), 0);
      desc1.putInteger(cTID('GHue'), 0);
      desc1.putInteger(cTID('GSat'), 0);
      desc1.putInteger(cTID('BHue'), 0);
      desc1.putInteger(cTID('BSat'), 0);
      desc1.putInteger(cTID('Vibr'), 0);
      desc1.putInteger(cTID('HA_R'), 0);
      desc1.putInteger(cTID('HA_O'), 0);
      desc1.putInteger(cTID('HA_Y'), 0);
      desc1.putInteger(cTID('HA_G'), 0);
      desc1.putInteger(cTID('HA_A'), 0);
      desc1.putInteger(cTID('HA_B'), 0);
      desc1.putInteger(cTID('HA_P'), 0);
      desc1.putInteger(cTID('HA_M'), 0);
      desc1.putInteger(cTID('SA_R'), 0);
      desc1.putInteger(cTID('SA_O'), 0);
      desc1.putInteger(cTID('SA_Y'), 0);
      desc1.putInteger(cTID('SA_G'), 0);
      desc1.putInteger(cTID('SA_A'), 0);
      desc1.putInteger(cTID('SA_B'), 0);
      desc1.putInteger(cTID('SA_P'), 0);
      desc1.putInteger(cTID('SA_M'), 0);
      desc1.putInteger(cTID('LA_R'), 0);
      desc1.putInteger(cTID('LA_O'), 0);
      desc1.putInteger(cTID('LA_Y'), 0);
      desc1.putInteger(cTID('LA_G'), 0);
      desc1.putInteger(cTID('LA_A'), 0);
      desc1.putInteger(cTID('LA_B'), 0);
      desc1.putInteger(cTID('LA_P'), 0);
      desc1.putInteger(cTID('LA_M'), 0);
      desc1.putInteger(cTID('STSH'), 0);
      desc1.putInteger(cTID('STSS'), 0);
      desc1.putInteger(cTID('STHH'), 0);
      desc1.putInteger(cTID('STHS'), 0);
      desc1.putInteger(cTID('STB '), 0);
      desc1.putInteger(cTID('PC_S'), 0);
      desc1.putInteger(cTID('PC_D'), 0);
      desc1.putInteger(cTID('PC_L'), 0);
      desc1.putInteger(cTID('PC_H'), 0);
      desc1.putInteger(cTID('PC_1'), 25);
      desc1.putInteger(cTID('PC_2'), 50);
      desc1.putInteger(cTID('PC_3'), 75);
      desc1.putDouble(cTID('ShpR'), 1);
      desc1.putInteger(cTID('ShpD'), 25);
      desc1.putInteger(cTID('ShpM'), 0);
      desc1.putInteger(cTID('PCVA'), 0);
      desc1.putInteger(cTID('GRNA'), 0);
      desc1.putInteger(cTID('LPEn'), 0);
      desc1.putInteger(cTID('MDis'), 0);
      desc1.putInteger(cTID('PerV'), 0);
      desc1.putInteger(cTID('PerH'), 0);
      desc1.putDouble(cTID('PerR'), 0);
      desc1.putInteger(cTID('PerS'), 100);
      desc1.putInteger(cTID('PerA'), 0);
      desc1.putInteger(cTID('PerU'), 0);
      desc1.putInteger(cTID('AuCA'), 0);
      desc1.putDouble(cTID('Ex12'), 0);
      desc1.putInteger(cTID('Cr12'), 0);
      desc1.putInteger(cTID('Hi12'), 0);
      desc1.putInteger(cTID('Sh12'), 0);
      desc1.putInteger(cTID('Wh12'), 0);
      desc1.putInteger(cTID('Bk12'), 0);
      desc1.putInteger(cTID('Cl12'), 0);
      desc1.putInteger(cTID('DfPA'), 0);
      desc1.putInteger(cTID('DPHL'), 30);
      desc1.putInteger(cTID('DPHH'), 70);
      desc1.putInteger(cTID('DfGA'), 0);
      desc1.putInteger(cTID('DPGL'), 40);
      desc1.putInteger(cTID('DPGH'), 60);
      desc1.putInteger(cTID('Dhze'), 100);
      desc1.putInteger(cTID('TMMs'), 0);
      var list1 = new ActionList();
      list1.putInteger(0);
      list1.putInteger(0);
      list1.putInteger(255);
      list1.putInteger(255);
      desc1.putList(cTID('Crv '), list1);
      var list2 = new ActionList();
      list2.putInteger(0);
      list2.putInteger(0);
      list2.putInteger(255);
      list2.putInteger(255);
      desc1.putList(cTID('CrvR'), list2);
      var list3 = new ActionList();
      list3.putInteger(0);
      list3.putInteger(0);
      list3.putInteger(255);
      list3.putInteger(255);
      desc1.putList(cTID('CrvG'), list3);
      var list4 = new ActionList();
      list4.putInteger(0);
      list4.putInteger(0);
      list4.putInteger(255);
      list4.putInteger(255);
      desc1.putList(cTID('CrvB'), list4);
      desc1.putString(cTID('CamP'), "Embedded");
      desc1.putString(cTID('CP_D'), "54650A341B5B5CCAE8442D0B43A92BCE");
      desc1.putInteger(cTID('PrVe'), 101122048);
      desc1.putString(cTID('Rtch'), "");
      desc1.putString(cTID('REye'), "");
      desc1.putString(cTID('LCs '), "");
      desc1.putString(cTID('Upri'), "");
      executeAction(sTID('Adobe Camera Raw Filter'), desc1, dialogMode);
    };
  
    // Set
    function step24(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 255);
      desc3.putInteger(cTID('DstW'), 0);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step25(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Lmns'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step26(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Brightness/Contrast 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(17);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Select
    function step27(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step28(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 255);
      desc3.putInteger(cTID('DstW'), 0);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      var desc4 = new ActionDescriptor();
      desc4.putUnitDouble(cTID('Scl '), cTID('#Prc'), 100);
      desc2.putObject(cTID('Lefx'), cTID('Lefx'), desc4);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Make
    function step29(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putClass(cTID('AdjL'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var desc3 = new ActionDescriptor();
      desc3.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindDefault"));
      desc2.putObject(cTID('Type'), cTID('Crvs'), desc3);
      desc1.putObject(cTID('Usng'), cTID('AdjL'), desc2);
      executeAction(cTID('Mk  '), desc1, dialogMode);
    };
  
    // Set
    function step30(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(sTID("presetKind"), sTID("presetKindType"), sTID("presetKindCustom"));

      var ppCurveList = new ActionList();

      var ppCurveAdj = new ActionDescriptor();

      var ppCurveChanRef = new ActionReference();

      ppCurveChanRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));

      ppCurveAdj.putReference(cTID('Chnl'), ppCurveChanRef);

      var ppCurvePts = new ActionList();

      var ppPt1 = new ActionDescriptor(); ppPt1.putDouble(cTID('Hrzn'), 0);   ppPt1.putDouble(cTID('Vrtc'), 0);   ppCurvePts.putObject(cTID('Pnt '), ppPt1);

      var ppPt2 = new ActionDescriptor(); ppPt2.putDouble(cTID('Hrzn'), 128); ppPt2.putDouble(cTID('Vrtc'), 96);  ppCurvePts.putObject(cTID('Pnt '), ppPt2);

      var ppPt3 = new ActionDescriptor(); ppPt3.putDouble(cTID('Hrzn'), 255); ppPt3.putDouble(cTID('Vrtc'), 255); ppCurvePts.putObject(cTID('Pnt '), ppPt3);

      ppCurveAdj.putList(cTID('Crv '), ppCurvePts);

      ppCurveList.putObject(cTID('CrvA'), ppCurveAdj);

      desc2.putList(cTID('Adjs'), ppCurveList);
      desc1.putObject(cTID('T   '), cTID('Crvs'), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Select
    function step31(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Chnl'), cTID('Chnl'), sTID("RGB"));
      desc1.putReference(cTID('null'), ref1);
      desc1.putBoolean(cTID('MkVs'), false);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Set
    function step32(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      var list1 = new ActionList();
      var desc3 = new ActionDescriptor();
      var ref2 = new ActionReference();
      ref2.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Gry '));
      desc3.putReference(cTID('Chnl'), ref2);
      desc3.putInteger(cTID('SrcB'), 0);
      desc3.putInteger(cTID('Srcl'), 0);
      desc3.putInteger(cTID('SrcW'), 255);
      desc3.putInteger(cTID('Srcm'), 255);
      desc3.putInteger(cTID('DstB'), 0);
      desc3.putInteger(cTID('Dstl'), 255);
      desc3.putInteger(cTID('DstW'), 255);
      desc3.putInteger(cTID('Dstt'), 255);
      list1.putObject(cTID('Blnd'), desc3);
      desc2.putList(cTID('Blnd'), list1);
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Set
    function step33(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Lmns'));
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    // Move
    function step34(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var ref2 = new ActionReference();
      ref2.putIndex(cTID('Lyr '), 10);
      desc1.putReference(cTID('T   '), ref2);
      desc1.putBoolean(cTID('Adjs'), false);
      desc1.putInteger(cTID('Vrsn'), 5);
      var list1 = new ActionList();
      list1.putInteger(64);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('move'), desc1, dialogMode);
    };
  
    // Select
    function step35(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putName(cTID('Lyr '), "Layer 1");
      desc1.putReference(cTID('null'), ref1);
      desc1.putEnumerated(sTID("selectionModifier"), sTID("selectionModifierType"), sTID("addToSelectionContinuous"));
      desc1.putBoolean(cTID('MkVs'), false);
      var list1 = new ActionList();
      list1.putInteger(3);
      list1.putInteger(4);
      list1.putInteger(5);
      list1.putInteger(6);
      list1.putInteger(7);
      list1.putInteger(8);
      list1.putInteger(9);
      list1.putInteger(10);
      list1.putInteger(11);
      desc1.putList(cTID('LyrI'), list1);
      executeAction(cTID('slct'), desc1, dialogMode);
    };
  
    // Merge Layers
    function step36(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      executeAction(sTID('mergeLayersNew'), desc1, dialogMode);
    };
  
    // Set
    function step37(enabled, withDialog) {
      if (enabled != undefined && !enabled)
        return;
      var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
      var desc1 = new ActionDescriptor();
      var ref1 = new ActionReference();
      ref1.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc1.putReference(cTID('null'), ref1);
      var desc2 = new ActionDescriptor();
      desc2.putString(cTID('Nm  '), "Post-Processed");
      desc1.putObject(cTID('T   '), cTID('Lyr '), desc2);
      executeAction(cTID('setd'), desc1, dialogMode);
    };
  
    step1();      // Stamp Visible (non-destructive)
    step2();      // Layer Via Copy
    step3();      // Levels
    step4();      // Make
    step5();      // Set
    step6();      // Make
    step7();      // Set
    step8();      // Make
    step9();      // Set
    step10();      // Select
    step11();      // Set
    step12();      // Make
    step13();      // Set
    step14();      // Set
    step15();      // Select
    step16();      // Set
    step17();      // Color Range
    step18();      // Make
    step19();      // Set
    step20();      // Make
    step21();      // Set
    step22();      // Merge Visible
    step23();      // Camera Raw Filter
    step24();      // Set
    step25();      // Set
    step26();      // Select
    step27();      // Select
    step28();      // Set
    step29();      // Make
    step30();      // Set
    step31();      // Select
    step32();      // Set
    step33();      // Set
    step34();      // Move
    step35();      // Select
    step36();      // Merge Layers
    step37();      // Set
  };
  
  
  
  //=========================================
  //                    MRPPostProcessing.main
  //=========================================
  //
  
  MRPPostProcessing.main = function () {
    MRPPostProcessing();
  };
  
  MRPPostProcessing.main();
}

var PORTED_TOOLS = {
  'effect-autumn': Run_effect_autumn,
  'effect-bleached': Run_effect_bleached,
  'effect-camerafilm01': Run_effect_camerafilm01,
  'effect-camerafilm02': Run_effect_camerafilm02,
  'effect-camerafilm03': Run_effect_camerafilm03,
  'effect-camerafilm04': Run_effect_camerafilm04,
  'effect-camerafilm05': Run_effect_camerafilm05,
  'effect-chilling': Run_effect_chilling,
  'effect-cinematic': Run_effect_cinematic,
  'effect-duality': Run_effect_duality,
  'effect-hazynight': Run_effect_hazynight,
  'effect-noblue': Run_effect_noblue,
  'effect-sepia': Run_effect_sepia,
  'effect-sunset': Run_effect_sunset,
  'effect-triad': Run_effect_triad,
  'effect-warmlight': Run_effect_warmlight,
  'effect-warmth': Run_effect_warmth,
  'skinlook-candy': Run_skinlook_candy,
  'skinlook-gritty': Run_skinlook_gritty,
  'skinlook-highkey': Run_skinlook_highkey,
  'skinlook-tan': Run_skinlook_tan,
  'retouch-basic': Run_retouch_basic,
  'remove-blemishes': Run_remove_blemishes,
  'teeth-whitening': Run_teeth_whitening,
  'eyes-enhance': Run_eyes_enhance,
  'lip-gloss': Run_lip_gloss,
  'lip-colorboost': Run_lip_colorboost,
  'post-process': Run_post_process,
};

//──────────────────────────────────────────────────────────────────
// Dispatcher
var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("retouch: data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  var result = { ok: false };
  try {
    if (app.documents.length === 0) {
      result.error = "No document open in Photoshop";
    } else {
      var tool = String(data.tool || "");
      if      (tool === "dnb-auto")        AutomaticDodgeandBurn();
      else if (tool === "dnb-manual")      DodgeandBurnManual();
      else if (tool === "dnb-finish")      ManualDodgeandBurnBackButton();
      else if (tool === "dodge")           Dodge();
      else if (tool === "burn")            Burn();
      else if (tool === "dodge-intensity") SetLayerOpacity("Dodge", Number(data.opacity));
      else if (tool === "burn-intensity")  SetLayerOpacity("Burn", Number(data.opacity));
      else if (tool === "skin-smoothing")  SkinSmoothing(Number(data.radius));
      else if (tool === "skin-texture")    SkinTexture(Number(data.radius));
      else if (tool === "advanced-retouch") AdvancedRetouching();
      else if (tool === "blemish-layer")   CreateBlemishRemovalLayer();
      else if (tool === "blushon")         CreateBlushonLayer();
      else if (tool === "eye-color")       CreateEyeColorLayer();
      else if (tool === "eyeshade")        CreateEyeshadeLayer();
      else if (tool === "hair-color")      CreateHairColorLayer();
      else if (tool === "lipstick")        CreateLipstickLayer();
      // Shared leaf-page controls.
      else if (tool === "layer-opacity")   setActiveLayerOpacity(Number(data.opacity));
      else if (tool === "compare-before")  CompareImageBefore();
      else if (tool === "compare-after")   CompareImageAfter();
      else if (tool === "eraser")          SelectEraser();
      else if (tool === "color-changer")   SelectColorChanger();
      // Full CEP set — Effects, Skin Looks, Retouching extras, Makeup/Lips, Post.
      else if (PORTED_TOOLS.hasOwnProperty(tool)) PORTED_TOOLS[tool]();
      else { throw new Error("unknown retouch tool: " + tool); }
      if (!result.error) result.ok = true;
    }
  } catch (e) {
    result.error = (e && e.message) ? String(e.message) : String(e);
  }

  try {
    var outFile = new File(data.outputPath);
    outFile.encoding = "UTF-8";
    outFile.open("w");
    outFile.write(toJSON(result));
    outFile.close();
  } catch (eOut) {}
}
