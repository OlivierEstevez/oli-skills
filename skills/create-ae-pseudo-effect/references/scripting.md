# Using a pseudo effect from scripts and expressions

## Apply

```javascript
// ExtendScript
var fx = null;
var parade = layer.property("ADBE Effect Parade");
var before = parade.numProperties;
layer.applyPreset(new File(ffxPath));
if (parade.numProperties > before) fx = parade.property(parade.numProperties);
```

- `applyPreset` adds the effect at the bottom of the stack and registers the matchName for the session.
- Wrap the apply and any value fixes in `app.beginUndoGroup("Apply <Effect>")` / `app.endUndoGroup()` so one undo removes it all.
- After the first apply, `parade.canAddProperty(matchName)` is true and `parade.addProperty(matchName)` works without the file. Use it for the second and later layers: it is faster and does not touch the disk.
- The file must exist on disk. Scripts that ship as one file embed the .ffx bytes as a string and write them to `Folder.temp` first (`file.encoding = "BINARY"`). A build step can do this automatically for every .ffx a script uses.
- The effect's `numProperties` is the parameter count plus 1 (the built-in Compositing Options group).

## Address controls

Scripts and expressions both see one flat list: group starts, group ends and label ends are properties too. The 1-based property index equals the `-NNNN` suffix of the control's matchName.

```javascript
// ExtendScript: by display name (first match), by matchName, or by index
fx.property("Width").setValue(400);
fx.property("Pseudo/ACME_BoxRig_v1-0001").setValue(400);
fx.property(1).setValue(400);
```

```javascript
// Expression: groups do not change the path
effect("Box Rig")("Width")
effect("Box Rig")(1)                  // same control, by index
```

Use matchNames in scripts. Names can repeat and users can rename the effect instance, but matchNames cannot change. To find a control's index, count every entry of the flattened spec, groups twice, starting at 1.

## Values that need fixing after apply

| Control | Why | Fix |
|---|---|---|
| point, point3d | Default is `fraction × layerSize`, not the target layer's size. | `fx.property(i).setValue([layer.width * 0.5, layer.height * 0.5])` |
| layer | Always None after apply. | `fx.property(i).setValue(otherLayer.index)` |

## Expressions on controls

- `keyframes: false` controls cannot hold expressions (`canSetExpression` is false).
- Invisible controls cannot hold expressions either. To hide a driven control, put it inside an invisible group instead.
- Checkboxes read 0/1, popups read the 1-based index, colors read `[r, g, b, a]` in 0..1.

## Verify in After Effects

`tests/ae/apply-and-report.jsx` creates a temp comp, applies one .ffx to a solid, writes every control's name, matchName, value, range, `canVaryOverTime` and `canSetExpression` to a report, then deletes the comp.

```bash
osascript -e 'tell application "Adobe After Effects 2026" to DoScript "var FFX_PATH=\"/abs/out.ffx\", REPORT_PATH=\"/abs/report.txt\"; $.evalFile(\"/abs/<skill>/tests/ae/apply-and-report.jsx\")"'
```

- Needs Preferences > Scripting & Expressions > "Allow Scripts to Write Files and Access Network".
- It runs in the user's open project. Ask before running it.
- Use a fresh matchName for each test build, or After Effects reuses the definition it already loaded.
- Check: every control present in order, defaults match the spec, `canVaryOverTime` false where `keyframes: false`, `canSetExpression` false on invisible controls.
