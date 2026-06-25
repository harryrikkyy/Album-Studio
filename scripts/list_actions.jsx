// list_actions.jsx
//
// Enumerates every Photoshop action across every action set and writes the
// list as JSON to the path supplied via __DATA_PATH__'s `outputPath` field.
//
// Output:
//   { ok: true,  actions: [{ set, name }, ...] }
//   { ok: false, error: string }
//
// Walks via Action Manager (executeActionGet on numeric actionSet / action
// indices) instead of the pseudo-DOM `app.actionTree` because the tree
// property isn't reliably populated across PS versions and was removed in
// some recent builds.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_actions.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("list_actions: data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");
  // data = { outputPath }

  // ── manual JSON serializer (older PS versions ship without JSON) ──────
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
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return quoteStr(v);
    if (v instanceof Array) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
      return '[' + parts.join(',') + ']';
    }
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

  function listAllActions() {
    var out = [];
    var setIdx = 1;
    while (true) {
      var setName = null;
      var numActions = 0;
      try {
        var setRef = new ActionReference();
        setRef.putIndex(stringIDToTypeID("actionSet"), setIdx);
        var setDesc = executeActionGet(setRef);
        setName = setDesc.getString(stringIDToTypeID("name"));
        // Photoshop reports child count for action sets via numberOfChildren.
        try {
          numActions = setDesc.getInteger(stringIDToTypeID("numberOfChildren"));
        } catch (eN) {
          numActions = 0;
        }
      } catch (eSet) {
        // Out of bounds → we're done walking sets.
        break;
      }

      for (var actIdx = 1; actIdx <= numActions; actIdx++) {
        try {
          var aRef = new ActionReference();
          aRef.putIndex(stringIDToTypeID("action"), actIdx);
          aRef.putIndex(stringIDToTypeID("actionSet"), setIdx);
          var aDesc = executeActionGet(aRef);
          var actionName = aDesc.getString(stringIDToTypeID("name"));
          out.push({ set: setName, name: actionName });
        } catch (eAct) {
          // Skip individual broken actions; keep enumerating.
        }
      }
      setIdx++;
    }
    return out;
  }

  var result = { ok: false, actions: [] };
  try {
    result.actions = listAllActions();
    result.ok = true;
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
