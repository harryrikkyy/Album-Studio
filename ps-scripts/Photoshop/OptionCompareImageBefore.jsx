#target photoshop
//
// OptionCompareImageBefore.jsx
//

//
// Generated Sun Jun 22 2014 13:06:34 GMT-0700
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
//==================== Option Compare Image Before ==============
//
function OptionCompareImageBefore() {
  // Hide
  function step1(enabled, withDialog) {
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

  step1();      // Hide
};

//=========================================
//                    OptionCompareImageBefore.main
//=========================================
//

OptionCompareImageBefore.main = function () {
  OptionCompareImageBefore();
};

OptionCompareImageBefore.main();

// EOF

"OptionCompareImageBefore.jsx"
// EOF
