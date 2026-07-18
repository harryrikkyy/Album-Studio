#target photoshop
//
// AutumnPlayer.jsx
//

//
// Generated Sat Jul 01 2017 18:11:42 GMT+0500
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
// AutumnPlayer
//
//
//==================== AutumnPlayer ==============
//
function AutumnPlayer() {
  // Play
  function step1(enabled, withDialog) {
    if (enabled != undefined && !enabled)
      return;
    var dialogMode = (withDialog ? DialogModes.ALL : DialogModes.NO);
    var desc1 = new ActionDescriptor();
    var ref1 = new ActionReference();
    ref1.putName(cTID('Actn'), "Autumn");
    ref1.putName(cTID('ASet'), "Magic Retouch Pro Support Actions");
    desc1.putReference(cTID('null'), ref1);
    executeAction(cTID('Ply '), desc1, dialogMode);
  };

  step1();      // Play
};

// EOF

"AutumnPlayer.jsx"
// EOF
