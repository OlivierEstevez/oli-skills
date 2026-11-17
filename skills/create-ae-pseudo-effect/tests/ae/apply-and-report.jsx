// Apply a .ffx to a solid in a temporary comp, read every control back, delete the comp.
// Writes the report to REPORT_PATH (needs Preferences > Scripting & Expressions >
// "Allow Scripts to Write Files and Access Network").
//
// Run from macOS Terminal (After Effects must be open):
//   osascript -e 'tell application "Adobe After Effects 2026" to DoScript "var FFX_PATH=\"/abs/in.ffx\", REPORT_PATH=\"/abs/report.txt\"; $.evalFile(\"/abs/tests/ae/apply-and-report.jsx\")"'
// Report format: ExtendScript toSource() (an object literal, readable as JSON5).

(function () {
    var ffxPath = typeof FFX_PATH !== "undefined" ? FFX_PATH : "";
    var report = { file: ffxPath, ok: false, effects: [], error: null };
    var comp = null;

    function propInfo(p, depth) {
        var info = { name: p.name, matchName: p.matchName, depth: depth };
        if (p.propertyType === PropertyType.PROPERTY) {
            info.valueType = p.propertyValueType;
            try { info.value = p.value; } catch (e) { info.value = "?"; }
            info.canVaryOverTime = p.canVaryOverTime;
            info.canSetExpression = p.canSetExpression;
            if (p.hasMin) info.min = p.minValue;
            if (p.hasMax) info.max = p.maxValue;
            if (p.isDropdownEffect) info.items = p.propertyParameters;
        } else {
            info.children = [];
            for (var i = 1; i <= p.numProperties; i++) info.children.push(propInfo(p.property(i), depth + 1));
        }
        return info;
    }

    app.beginUndoGroup("FFX apply test");
    try {
        var f = new File(ffxPath);
        if (!f.exists) throw new Error("missing file " + ffxPath);
        comp = app.project.items.addComp("__ffx_test__", 1920, 1080, 1, 5, 25);
        var layer = comp.layers.addSolid([0.5, 0.5, 0.5], "ffx target", 1920, 1080, 1);
        layer.applyPreset(f);
        var parade = layer.property("ADBE Effect Parade");
        for (var i = 1; i <= parade.numProperties; i++) {
            var fx = parade.property(i);
            var e = { name: fx.name, matchName: fx.matchName, controls: [] };
            for (var j = 1; j <= fx.numProperties; j++) {
                var c = fx.property(j);
                if (c.matchName === "ADBE Effect Built In Params") continue;
                e.controls.push(propInfo(c, 0));
            }
            report.effects.push(e);
        }
        report.ok = report.effects.length > 0;
    } catch (err) {
        report.error = err.toString();
    }
    try { if (comp) comp.remove(); } catch (e3) {}
    app.endUndoGroup();
    var out = report.toSource();
    if (typeof REPORT_PATH !== "undefined") {
        var rf = new File(REPORT_PATH);
        rf.encoding = "UTF-8";
        rf.open("w");
        rf.write(out);
        rf.close();
    }
    return out;
})();
