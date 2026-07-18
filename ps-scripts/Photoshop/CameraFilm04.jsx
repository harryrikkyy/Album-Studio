#target photoshop
//
// CameraFilm04.jsx
//

//
// Generated Sun Jul 02 2017 21:54:45 GMT+0500
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
//==================== Camera Film 04 ==============
//
function CameraFilm04() {
  // Flatten Image
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(sTID('flattenImage'), undefined, dialogMode);
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

  step1();      // Flatten Image
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

// EOF

"CameraFilm04.jsx"
// EOF
