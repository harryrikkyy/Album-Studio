// run_action.jsx
//
// Runs a named Photoshop action via app.doAction(name, set). Reads the
// {setName, actionName, outputPath} payload from __DATA_PATH__ and writes
// {ok, error?} JSON back so the main process can surface a clean toast.
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_run_action.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("run_action: data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

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

  var result = { ok: false };
  try {
    if (!data.setName || !data.actionName) {
      result.error = "missing setName or actionName";
    } else {
      app.doAction(data.actionName, data.setName);
      result.ok = true;
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
