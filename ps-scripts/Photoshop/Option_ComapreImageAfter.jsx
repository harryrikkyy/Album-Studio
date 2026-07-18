#target photoshop
//
// Option_ComapreImageAfter.jsx
//

//
// Generated Sun Jun 22 2014 13:06:50 GMT-0700
//

cTID = function(s) { return app.charIDToTypeID(s); };
sTID = function(s) { return app.stringIDToTypeID(s); };

//
//==================== Option - Comapre Image After ==============
//
function Option_ComapreImageAfter() {
  // Show
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
    executeAction(cTID('Shw '), desc1, dialogMode);
  };

  step1();      // Show
};

//=========================================
//                    Option_ComapreImageAfter.main
//=========================================
//

Option_ComapreImageAfter.main = function () {
  Option_ComapreImageAfter();
};

Option_ComapreImageAfter.main();

// EOF

"Option_ComapreImageAfter.jsx"
// EOF
