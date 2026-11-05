/*  Trim Logos for Photoshop
    Version 1.0.0
    ------------------------------------------------------------
    Asks for a folder of logos, trims transparent and white borders from
    each one, and saves trimmed PNG copies into a "trimmed" subfolder.
    Originals are never changed.

    Processed:  png, jpg, jpeg, psd, tif, tiff, gif, bmp, webp
    Skipped:    ai, eps, svg, pdf (vector files: mask these in AE instead)
*/
#target photoshop

(function () {

    var WHITE_LEVEL = 245;   // corner brighter than this (0-255) counts as a white background
    var TOLERANCE   = 12;    // how close to the corner colour counts as background (handles JPG noise)

    var RASTER = /\.(png|jpe?g|psd|tiff?|gif|bmp|webp)$/i;
    var VECTOR = /\.(ai|eps|svg|pdf)$/i;

    var inFolder = Folder.selectDialog("Choose the folder of logos to trim");
    if (!inFolder) return;

    var outFolder = new Folder(inFolder.fsName + "/trimmed");
    if (!outFolder.exists) outFolder.create();

    var files = inFolder.getFiles(function (f) { return f instanceof File && !/^\./.test(f.name); });
    var done = [], skippedVector = [], untrimmed = [], failed = [];

    var oldUnits = app.preferences.rulerUnits;
    var oldDialogs = app.displayDialogs;
    app.preferences.rulerUnits = Units.PIXELS;
    app.displayDialogs = DialogModes.NO;

    try {
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var name = decodeURI(f.name);
            if (VECTOR.test(name)) { skippedVector.push(name); continue; }
            if (!RASTER.test(name)) continue;

            var doc = null;
            try {
                doc = app.open(f);
                if (doc.mode === DocumentMode.INDEXEDCOLOR || doc.mode === DocumentMode.BITMAP ||
                    doc.mode === DocumentMode.GRAYSCALE) {
                    doc.changeMode(ChangeMode.RGB);
                }

                var w0 = doc.width.as("px"), h0 = doc.height.as("px");

                // 1) Transparent borders
                if (!(doc.layers.length === 1 && doc.activeLayer.isBackgroundLayer)) {
                    doc.trim(TrimType.TRANSPARENT, true, true, true, true);
                }

                // 2) White borders: select white from each white corner, crop to the rest
                trimWhite(doc);

                if (doc.width.as("px") === w0 && doc.height.as("px") === h0) untrimmed.push(name);

                var base = name.replace(/\.[^.]+$/, "");
                var out = new File(outFolder.fsName + "/" + base + ".png");
                var n = 2;
                while (out.exists && isInThisRun(out, done)) {
                    out = new File(outFolder.fsName + "/" + base + "-" + n + ".png");
                    n++;
                }
                var opts = new PNGSaveOptions();
                opts.compression = 6;
                doc.saveAs(out, opts, true, Extension.LOWERCASE);
                done.push(out.fsName);
            } catch (e) {
                failed.push(name + " (" + e.message + ")");
            } finally {
                if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
            }
        }
    } finally {
        app.preferences.rulerUnits = oldUnits;
        app.displayDialogs = oldDialogs;
    }

    var msg = "Trimmed and saved " + done.length + " logo" + (done.length === 1 ? "" : "s") +
              " to:\n" + outFolder.fsName;
    if (untrimmed.length) msg += "\n\nNo border found (saved unchanged):\n  " + untrimmed.join("\n  ");
    if (skippedVector.length) msg += "\n\nSkipped vector files (mask these in AE):\n  " + skippedVector.join("\n  ");
    if (failed.length) msg += "\n\nCouldn't process:\n  " + failed.join("\n  ");
    alert(msg);

    // ---------------- helpers ----------------

    function isInThisRun(file, list) {
        for (var k = 0; k < list.length; k++) if (list[k] === file.fsName) return true;
        return false;
    }

    function cornerIsWhite(doc, x, y) {
        var s = null;
        try {
            s = doc.colorSamplers.add([UnitValue(x + 0.5, "px"), UnitValue(y + 0.5, "px")]);
            var c = s.color.rgb;
            return c.red > WHITE_LEVEL && c.green > WHITE_LEVEL && c.blue > WHITE_LEVEL;
        } catch (e) {
            return false;
        } finally {
            if (s) s.remove();
        }
    }

    function wand(x, y, add) {
        var d = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
        d.putReference(charIDToTypeID("null"), ref);
        var pt = new ActionDescriptor();
        pt.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), x);
        pt.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), y);
        d.putObject(charIDToTypeID("T   "), charIDToTypeID("Pnt "), pt);
        d.putInteger(charIDToTypeID("Tlrn"), TOLERANCE);
        d.putBoolean(charIDToTypeID("AntA"), false);
        d.putBoolean(charIDToTypeID("Cntg"), true);
        d.putBoolean(charIDToTypeID("Mrgd"), true);
        executeAction(charIDToTypeID(add ? "AddT" : "setd"), d, DialogModes.NO);
    }

    function trimWhite(doc) {
        var W = doc.width.as("px"), H = doc.height.as("px");
        var corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
        var any = false;
        for (var c = 0; c < corners.length; c++) {
            if (cornerIsWhite(doc, corners[c][0], corners[c][1])) {
                wand(corners[c][0] + 0.5, corners[c][1] + 0.5, any);
                any = true;
            }
        }
        if (!any) return;

        try {
            doc.selection.invert();
            var b = doc.selection.bounds;   // throws if nothing is left (all white)
            doc.selection.deselect();
            var l = b[0].as("px"), t = b[1].as("px"), r = b[2].as("px"), bt = b[3].as("px");
            if (r > l && bt > t && (l > 0 || t > 0 || r < W || bt < H)) doc.crop([l, t, r, bt]);
        } catch (e) {
            try { doc.selection.deselect(); } catch (e2) {}
        }
    }

})();
