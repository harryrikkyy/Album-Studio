#target photoshop
//
// Flaten Image.jsx
//

//
// Generated Sun Jun 22 2014 09:18:31 GMT-0700
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
//==================== Option - Finalize Image ==============
//
function Option_FinalizeImage() {
  // Flatten Image
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    executeAction(sTID('flattenImage'), undefined, dialogMode);
  };

  step1();      // Flatten Image
};

//=========================================
//                    Option_FinalizeImage.main
//=========================================
//

Option_FinalizeImage.main = function () {
  Option_FinalizeImage();
};

Option_FinalizeImage.main();

// EOF

"Flaten Image.jsx"
// EOF
