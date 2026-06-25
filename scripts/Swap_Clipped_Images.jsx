// SwapLayers_Ultimate_Album.jsx
#target photoshop

// ---------------------------------------------------------
// YOUR WORKING SELECTION METHOD (Fixes Error 21)
// ---------------------------------------------------------
function getSelectedLayers() {
    var lyrs = [];
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var docDesc = executeActionGet(ref);

    if (docDesc.hasKey(stringIDToTypeID("targetLayers"))) {
        var targetLayers = docDesc.getList(stringIDToTypeID("targetLayers"));
        var bgRef = new ActionReference();
        bgRef.putProperty(stringIDToTypeID("property"), stringIDToTypeID("hasBackgroundLayer"));
        bgRef.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var hasBg = executeActionGet(bgRef).getBoolean(stringIDToTypeID("hasBackgroundLayer"));
        var offset = hasBg ? 0 : 1;

        var ids = [];
        for (var i = 0; i < targetLayers.count; i++) {
            var amIndex = targetLayers.getReference(i).getIndex();
            var ref2 = new ActionReference();
            ref2.putIndex(charIDToTypeID("Lyr "), amIndex + offset);
            var layerDesc = executeActionGet(ref2);
            ids.push(layerDesc.getInteger(stringIDToTypeID("layerID")));
        }

        for (var j = 0; j < ids.length; j++) {
            selectLayerById(ids[j], false);
            lyrs.push(app.activeDocument.activeLayer);
        }
    } else {
        lyrs.push(app.activeDocument.activeLayer);
    }
    return lyrs;
}

function selectLayerById(id, add) {
    if (add === undefined) add = false;
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), id);
    desc.putReference(charIDToTypeID("null"), ref);
    if (add) {
        desc.putEnumerated(stringIDToTypeID("selectionModifier"), stringIDToTypeID("selectionModifierType"), stringIDToTypeID("addToSelection"));
    }
    desc.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

// ---------------------------------------------------------
// DOM MASK FINDER (Fixes the un-clipping bug)
// ---------------------------------------------------------
function getLayerBelow(lyr) {
    var siblings = lyr.parent.layers;
    for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === lyr && i + 1 < siblings.length) {
            return siblings[i + 1]; // Returns the exact frame under the photo
        }
    }
    return null;
}

function getRawBounds(lyr) {
    var b = lyr.bounds;
    var x1 = Number(b[0].value), y1 = Number(b[1].value);
    var x2 = Number(b[2].value), y2 = Number(b[3].value);
    return {
        w: x2 - x1, h: y2 - y1,
        cx: x1 + (x2 - x1) / 2, cy: y1 + (y2 - y1) / 2
    };
}

// ---------------------------------------------------------
// MAIN SWAP LOGIC
// ---------------------------------------------------------
function swapAndReclip() {
    if (app.documents.length === 0) return;
    
    var doc = app.activeDocument;
    var sel = getSelectedLayers();

    if (sel.length !== 2) {
        alert("Please hold Cmd/Ctrl and select exactly TWO clipped layers.");
        return;
    }

    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;

    try {
        var A = sel[0];
        var B = sel[1];

        // 1. Get the actual frames they are clipped to
        var maskA = getLayerBelow(A);
        var maskB = getLayerBelow(B);

        if (!maskA || !maskB) {
            alert("Could not find the frames below the images.");
            return;
        }

        var bA = getRawBounds(A), bB = getRawBounds(B);
        var mA = getRawBounds(maskA), mB = getRawBounds(maskB);

        // 2. Proportional Scale (Fit to new frames)
        var s1 = Number(Math.max(mB.w / bA.w, mB.h / bA.h) * 100);
        var s2 = Number(Math.max(mA.w / bB.w, mA.h / bB.h) * 100);

        A.resize(s1, s1, AnchorPosition.MIDDLECENTER);
        B.resize(s2, s2, AnchorPosition.MIDDLECENTER);

        // 3. Move Centers to New Frames
        function forceMove(lyr, tCX, tCY) {
            var cur = getRawBounds(lyr);
            lyr.translate(Number(tCX - cur.cx), Number(tCY - cur.cy));
        }
        
        forceMove(A, mB.cx, mB.cy);
        forceMove(B, mA.cx, mA.cy);

        // 4. Temporarily unclip to avoid Photoshop stack confusion
        A.grouped = false;
        B.grouped = false;

        // 5. Swap Places in the layers panel
        A.move(maskB, ElementPlacement.PLACEBEFORE);
        B.move(maskA, ElementPlacement.PLACEBEFORE);

        // 6. Force Re-Clip
        A.grouped = true;
        B.grouped = true;

        // 7. Re-highlight both layers in case you want to swap back
        selectLayerById(A.id, false);
        selectLayerById(B.id, true);

    } catch (e) {
        alert("Error: " + e.message);
    } finally {
        app.preferences.rulerUnits = oldUnits;
    }
}

// Wrapper for a single Undo
app.activeDocument.suspendHistory("Ultimate Swap & Reclip", "swapAndReclip()");