#target photoshop
//
// SkinSmoothingVeryHigh.jsx
//

//
// Generated Mon Feb 06 2017 12:52:57 GMT+0500
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
//==================== Skin Smoothing Very High ==============
//
function SkinSmoothingVeryHigh() {
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
    desc3.putUnitDouble(cTID('Rds '), cTID('#Pxl'), 10);
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

//=========================================
//                    SkinSmoothingVeryHigh.main
//=========================================
//

SkinSmoothingVeryHigh.main = function () {
  SkinSmoothingVeryHigh();
};

SkinSmoothingVeryHigh.main();

// EOF

"SkinSmoothingVeryHigh.jsx"
// EOF
