#target photoshop
//
// CameraFilm05.jsx
//

//
// Generated Sun Jul 02 2017 21:54:45 GMT+0500
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
//==================== Camera Film 05 ==============
//
function CameraFilm05() {
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

  step1();      // Flatten Image
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

// EOF

"CameraFilm05.jsx"
// EOF
