// batch_thumbnails.jsx
#target photoshop

var DATA_PATH = "__DATA_PATH__";
if (DATA_PATH.indexOf("__") === 0) DATA_PATH = "/tmp/albumstudio_thumbs_data.json";

var dataFile = new File(DATA_PATH);
if (!dataFile.exists) { alert("Data file not found: " + DATA_PATH); }
else {
  dataFile.encoding = "UTF-8";
  dataFile.open("r");
  var jsonStr = dataFile.read();
  dataFile.close();
  var data = (typeof JSON !== "undefined" && JSON.parse) ? JSON.parse(jsonStr) : eval("(" + jsonStr + ")");

  var folderPath = data.folderPath;
  var folder = new Folder(folderPath);
  var thumbFolder = new Folder(folderPath + "/_Thumbnails");
  if (!thumbFolder.exists) thumbFolder.create();

  var files = folder.getFiles(/\.(jpg|jpeg|png|tif|tiff|arw|dng|rw2|cr2|nef|raw)$/i);
  if (files.length === 0) { alert("No compatible images found in this folder!"); }
  else {
    var successCount = 0;
    app.preferences.rulerUnits = Units.PIXELS;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!(file instanceof File)) continue;
      try {
        var doc = app.open(file);

        // Flatten
        try { doc.flatten(); } catch(e) {}

        // Convert to 8-bit
        try { doc.bitsPerChannel = BitsPerChannelType.EIGHT; } catch(e) {}

        // Resize to 400px on longest side
        var w = doc.width.as("px");
        var h = doc.height.as("px");
        if (w > h) {
          doc.resizeImage(UnitValue(400, "px"), null, null, ResampleMethod.BICUBIC);
        } else {
          doc.resizeImage(null, UnitValue(400, "px"), null, ResampleMethod.BICUBIC);
        }

        // Save as JPEG
        var baseName = file.name.replace(/\.[^\.]+$/, "");
        var saveFile = new File(folderPath + "/_Thumbnails/" + baseName + ".jpg");
        var jpegOptions = new JPEGSaveOptions();
        jpegOptions.quality = 6;
        jpegOptions.matte = MatteType.NONE;
        doc.saveAs(saveFile, jpegOptions, true, Extension.LOWERCASE);
        doc.close(SaveOptions.DONOTSAVECHANGES);
        successCount++;
      } catch(e) {
        try { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch(ex) {}
      }
    }
    alert("Done! Created " + successCount + " thumbnails in the _Thumbnails folder.\n\nClick the Refresh button on your folder to load them!");
  }
}