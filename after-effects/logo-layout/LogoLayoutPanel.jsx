/*  Logo Layout Panel for After Effects
    Version 4.0.0 (previously LogoLayoutPanel_v4.jsx)
    ------------------------------------------------------------
    Install as a dockable panel:
      Mac:     /Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/
      Windows: C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\
    Restart After Effects, then open it from the Window menu.

    Mask each logo tightly to its edges. The panel uses each layer's mask
    bounds as the logo's size (layers without a mask use their full frame).

    Apply: lays out the selected layers. With nothing selected, it re-applies
    to the last logos you laid out in this comp.
    Live update: after the first Apply, any setting change re-lays out those logos.
*/
(function (thisObj) {

    var SECTION = "LogoLayoutPanel";
    var DEFAULTS = {
        arrange: 0,          // 0 = number of rows, 1 = logos per row
        count: 1,
        spacing: 1,          // 0 = equal centres, 1 = equal gaps
        gap: 60,
        safeZone: 0,         // 0 = title safe, 1 = action safe, 2 = full frame
        titlePct: 20,
        actionPct: 10,
        padX: 0,
        padY: 0,
        sizeMode: 0,         // 0 = balanced (area), 1 = fit cell, 2 = same height
        areaFill: 0.45,
        maxHeightRatio: 0.6,
        liveUpdate: false
    };

    var lastCompId = null;
    var lastLayers = [];
    var OLD_TAG = /\s*\[LogoLayout:[^\]]*\]/;   // left in layer comments by the previous version

    // ---------------- settings persistence ----------------
    function loadSettings() {
        var s = {};
        for (var k in DEFAULTS) {
            if (!DEFAULTS.hasOwnProperty(k)) continue;
            var d = DEFAULTS[k], v = d;
            try {
                if (app.settings.haveSetting(SECTION, k)) {
                    var raw = app.settings.getSetting(SECTION, k);
                    if (typeof d === "boolean") v = (raw === "1");
                    else { var n = parseFloat(raw); if (!isNaN(n)) v = n; }
                }
            } catch (e) {}
            s[k] = v;
        }
        return s;
    }

    function saveSettings(s) {
        for (var k in s) {
            if (!s.hasOwnProperty(k)) continue;
            try {
                app.settings.saveSetting(SECTION, k,
                    typeof s[k] === "boolean" ? (s[k] ? "1" : "0") : String(s[k]));
            } catch (e) {}
        }
    }

    // ---------------- bounds ----------------
    function getMaskBounds(layer) {
        var masks = layer.property("ADBE Mask Parade");
        if (!masks || masks.numProperties === 0) return null;
        var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, found = false;
        for (var i = 1; i <= masks.numProperties; i++) {
            var m = masks.property(i);
            if (m.maskMode === MaskMode.NONE || m.maskMode === MaskMode.SUBTRACT || m.inverted) continue;
            var sh = m.property("ADBE Mask Shape").value;
            for (var v = 0; v < sh.vertices.length; v++) {
                var vx = sh.vertices[v][0], vy = sh.vertices[v][1];
                var pts = [[vx, vy],
                           [vx + sh.inTangents[v][0],  vy + sh.inTangents[v][1]],
                           [vx + sh.outTangents[v][0], vy + sh.outTangents[v][1]]];
                for (var p = 0; p < pts.length; p++) {
                    l = Math.min(l, pts[p][0]); r = Math.max(r, pts[p][0]);
                    t = Math.min(t, pts[p][1]); b = Math.max(b, pts[p][1]);
                    found = true;
                }
            }
        }
        return (found && r > l && b > t) ? { l: l, t: t, r: r, b: b } : null;
    }

    function getBounds(layer) {
        var mb = getMaskBounds(layer);
        if (mb) return { b: mb, masked: true };
        if (!layer.source) {   // text and shape layers
            var sr = layer.sourceRectAtTime(layer.inPoint, false);
            return { b: { l: sr.left, t: sr.top, r: sr.left + sr.width, b: sr.top + sr.height }, masked: true };
        }
        return { b: { l: 0, t: 0, r: layer.width, b: layer.height }, masked: false };
    }

    // ---------------- layout ----------------
    function hasKeys(tr) {
        var names = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale"];
        for (var i = 0; i < names.length; i++) {
            if (tr.property(names[i]).numKeys > 0) return true;
        }
        if (tr.property("ADBE Position").dimensionsSeparated) {
            if (tr.property("ADBE Position_0").numKeys > 0 || tr.property("ADBE Position_1").numKeys > 0) return true;
        }
        return false;
    }

    function set2D(prop, x, y) {
        var v = prop.value;
        prop.setValue(v.length === 3 ? [x, y, v[2]] : [x, y]);
    }

    function layout(comp, items, s) {
        var n = items.length;
        if (n === 0) return;

        var count = Math.min(Math.max(1, Math.round(s.count)), n);
        var cols = (s.arrange === 1) ? count : Math.ceil(n / count);
        var rows = Math.ceil(n / cols);

        var pct = (s.safeZone === 0) ? s.titlePct : (s.safeZone === 1) ? s.actionPct : 0;
        var left = comp.width  * pct / 200 + s.padX;
        var top  = comp.height * pct / 200 + s.padY;
        var availW = comp.width  - 2 * left;
        var availH = comp.height - 2 * top;

        var cellW = (availW - (cols - 1) * s.gap) / cols;
        var cellH = (availH - (rows - 1) * s.gap) / rows;
        var boxW = cellW;
        var boxH = Math.min(cellH, cellW * s.maxHeightRatio);
        if (boxW <= 0 || boxH <= 0) throw new Error("Not enough room. Reduce the gap, padding or rows/columns.");

        var blockH = rows * boxH + (rows - 1) * s.gap;
        var startY = top + (availH - blockH) / 2;

        // 1) Scale each logo
        for (var k = 0; k < n; k++) {
            var b = items[k].b;
            var cw = b.r - b.l, ch = b.b - b.t;
            var fitScale = Math.min(boxW / cw, boxH / ch);
            var sc;
            if (s.sizeMode === 2)      sc = Math.min(boxH / ch, fitScale);
            else if (s.sizeMode === 0) sc = Math.min(Math.sqrt(boxW * boxH * s.areaFill / (cw * ch)), fitScale);
            else                       sc = fitScale;
            items[k].sc = sc;
            items[k].w = cw * sc;
        }

        // 2) Equal gaps: justify the fullest row, use that gap for every row
        var edgeGap = 0;
        if (s.spacing === 1) {
            edgeGap = Infinity;
            for (var r = 0; r < rows; r++) {
                var first = r * cols, last = Math.min(n, first + cols);
                if (last - first < 2) continue;
                var sumW = 0;
                for (var q = first; q < last; q++) sumW += items[q].w;
                edgeGap = Math.min(edgeGap, (availW - sumW) / (last - first - 1));
            }
            if (edgeGap === Infinity) edgeGap = 0;
        }

        // 3) Position
        for (var r2 = 0; r2 < rows; r2++) {
            var f = r2 * cols, e = Math.min(n, f + cols), inRow = e - f;
            var cy = startY + r2 * (boxH + s.gap) + boxH / 2;
            var x;
            if (s.spacing === 1) {
                var rowW = (inRow - 1) * edgeGap;
                for (var q2 = f; q2 < e; q2++) rowW += items[q2].w;
                x = left + (availW - rowW) / 2;
            } else {
                x = left + (availW - (inRow * cellW + (inRow - 1) * s.gap)) / 2;
            }

            for (var i2 = f; i2 < e; i2++) {
                var it = items[i2], bb = it.b, cx;
                if (s.spacing === 1) { cx = x + it.w / 2; x += it.w + edgeGap; }
                else                 { cx = x + cellW / 2; x += cellW + s.gap; }

                var tr = it.layer.property("ADBE Transform Group");
                set2D(tr.property("ADBE Anchor Point"), (bb.l + bb.r) / 2, (bb.t + bb.b) / 2);
                set2D(tr.property("ADBE Scale"), it.sc * 100, it.sc * 100);
                var pos = tr.property("ADBE Position");
                if (pos.dimensionsSeparated) {
                    tr.property("ADBE Position_0").setValue(cx);
                    tr.property("ADBE Position_1").setValue(cy);
                } else {
                    set2D(pos, cx, cy);
                }
            }
        }
    }

    function run(s) {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return "Open a composition first.";

        var layers = [], i;
        if (comp.selectedLayers.length > 0) {
            for (i = 0; i < comp.selectedLayers.length; i++) layers.push(comp.selectedLayers[i]);
        } else if (lastCompId === comp.id) {
            for (i = 0; i < lastLayers.length; i++) {
                try { lastLayers[i].name; layers.push(lastLayers[i]); } catch (e) {} // skip deleted layers
            }
        }
        if (layers.length === 0) return "Select the logo layers first.";
        lastCompId = comp.id;
        lastLayers = layers;

        var items = [], skipped = [], unmasked = [];
        app.beginUndoGroup("Logo Layout");
        try {
            for (i = 0; i < layers.length; i++) {
                var L = layers[i];
                if (!(L instanceof AVLayer)) { skipped.push(L.name + " (not a visual layer)"); continue; }
                if (L.parent) { skipped.push(L.name + " (parented)"); continue; }
                if (hasKeys(L.property("ADBE Transform Group"))) { skipped.push(L.name + " (keyframed transform)"); continue; }

                if (OLD_TAG.test(L.comment)) L.comment = L.comment.replace(OLD_TAG, "");

                var g = getBounds(L);
                if (g.b.r - g.b.l <= 0 || g.b.b - g.b.t <= 0) { skipped.push(L.name + " (no visible content)"); continue; }
                if (!g.masked) unmasked.push(L.name);
                items.push({ layer: L, b: g.b });
            }
            layout(comp, items, s);
        } catch (err) {
            return "Error: " + err.toString();
        } finally {
            app.endUndoGroup();
        }

        clearOutput();
        var msg = "Laid out " + items.length + " logo" + (items.length === 1 ? "" : "s") + ".";
        if (unmasked.length) {
            writeLn("No mask (using full frame):");
            for (var j = 0; j < unmasked.length; j++) writeLn("  " + unmasked[j]);
            msg += " " + unmasked.length + " without a mask.";
        }
        if (skipped.length) {
            writeLn("Skipped:");
            for (var j2 = 0; j2 < skipped.length; j2++) writeLn("  " + skipped[j2]);
            msg += " Skipped " + skipped.length + ".";
        }
        if (unmasked.length || skipped.length) msg += " See Info panel.";
        return msg;
    }

    // ---------------- UI ----------------
    function buildUI(thisObj) {
        var s = loadSettings();
        var w = (thisObj instanceof Panel) ? thisObj
              : new Window("palette", "Logo Layout", undefined, { resizeable: true });
        w.orientation = "column";
        w.alignChildren = ["fill", "top"];
        w.spacing = 6;
        w.margins = 10;

        function section(title) {
            var p = w.add("panel", undefined, title);
            p.orientation = "column";
            p.alignChildren = ["fill", "top"];
            p.spacing = 4;
            p.margins = [10, 15, 10, 8];
            return p;
        }
        function labelled(parent, label) {
            var g = parent.add("group");
            g.alignChildren = ["left", "center"];
            g.spacing = 4;
            var st = g.add("statictext", undefined, label);
            st.preferredSize.width = 95;
            return g;
        }
        function field(g, value, chars) {
            var et = g.add("edittext", undefined, String(value));
            et.characters = chars || 5;
            return et;
        }

        // Layout
        var pL = section("Layout");
        var gA = labelled(pL, "Arrange by:");
        var ddArrange = gA.add("dropdownlist", undefined, ["Number of rows", "Logos per row"]);
        ddArrange.selection = s.arrange;
        var etCount = field(gA, s.count, 3);
        var ddSpacing = labelled(pL, "Spacing:").add("dropdownlist", undefined, ["Equal centres", "Equal gaps"]);
        ddSpacing.selection = s.spacing;
        var etGap = field(labelled(pL, "Min gap (px):"), s.gap);

        // Safe zone
        var pS = section("Safe zone");
        var ddSafe = labelled(pS, "Keep inside:").add("dropdownlist", undefined, ["Title safe", "Action safe", "Full frame"]);
        ddSafe.selection = s.safeZone;
        var gPct = labelled(pS, "Title / Action %:");
        var etTitle = field(gPct, s.titlePct, 4);
        var etAction = field(gPct, s.actionPct, 4);
        var gPad = labelled(pS, "Padding X / Y:");
        var etPadX = field(gPad, s.padX, 4);
        var etPadY = field(gPad, s.padY, 4);

        // Size
        var pZ = section("Logo size");
        var ddSize = labelled(pZ, "Mode:").add("dropdownlist", undefined, ["Balanced (area)", "Fit cell", "Same height"]);
        ddSize.selection = s.sizeMode;
        var gF = labelled(pZ, "Weight:");
        var slFill = gF.add("slider", undefined, Math.round(s.areaFill * 100), 10, 100);
        slFill.preferredSize.width = 110;
        var stFill = gF.add("statictext", undefined, Math.round(s.areaFill * 100) + "%");
        stFill.characters = 5;
        var gH = labelled(pZ, "Max height:");
        var etMaxH = field(gH, s.maxHeightRatio, 4);
        gH.add("statictext", undefined, "x cell width");

        // Actions
        var cbLive = w.add("checkbox", undefined, "Live update when settings change");
        cbLive.value = s.liveUpdate;
        var btnApply = w.add("button", undefined, "Apply");
        var stStatus = w.add("statictext", undefined, "Select logo layers, then Apply.", { truncate: "end" });
        stStatus.alignment = ["fill", "top"];

        function num(et, d) { var v = parseFloat(et.text); return isNaN(v) ? d : v; }

        function refreshEnabled() {
            var area = ddSize.selection && ddSize.selection.index === 0;
            slFill.enabled = area;
            stFill.enabled = area;
            stFill.text = Math.round(slFill.value) + "%";
        }

        function readUI() {
            s = {
                arrange: ddArrange.selection ? ddArrange.selection.index : 0,
                count: Math.max(1, Math.round(num(etCount, 1))),
                spacing: ddSpacing.selection ? ddSpacing.selection.index : 1,
                gap: Math.max(0, num(etGap, 60)),
                safeZone: ddSafe.selection ? ddSafe.selection.index : 0,
                titlePct: Math.max(0, num(etTitle, 20)),
                actionPct: Math.max(0, num(etAction, 10)),
                padX: num(etPadX, 0),
                padY: num(etPadY, 0),
                sizeMode: ddSize.selection ? ddSize.selection.index : 0,
                areaFill: Math.round(slFill.value) / 100,
                maxHeightRatio: Math.max(0.05, num(etMaxH, 0.6)),
                liveUpdate: cbLive.value
            };
            saveSettings(s);
            return s;
        }

        function go() { stStatus.text = run(readUI()); }

        function changed() {
            refreshEnabled();
            var cur = readUI();
            if (cur.liveUpdate && lastLayers.length) go();
        }

        var controls = [ddArrange, etCount, ddSpacing, etGap, ddSafe, etTitle, etAction,
                        etPadX, etPadY, ddSize, slFill, etMaxH];
        for (var c = 0; c < controls.length; c++) controls[c].onChange = changed;
        slFill.onChanging = function () {
            stFill.text = Math.round(slFill.value) + "%";
        };
        cbLive.onClick = function () { readUI(); };
        btnApply.onClick = go;

        refreshEnabled();
        w.onResizing = w.onResize = function () { this.layout.resize(); };
        w.layout.layout(true);
        if (w instanceof Window) { w.center(); w.show(); }
        return w;
    }

    buildUI(thisObj);

})(this);
