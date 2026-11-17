---
name: create-ae-pseudo-effect
description: Create After Effects pseudo effects (custom Effect Controls panels for scripts and rigs) as .ffx animation presets, without Pseudo Effect Maker or PresetEffects.xml. Use when a script, rig or template needs its own effect with sliders, angles, checkboxes, colors, points, 3D points, dropdowns, layer pickers, groups or labels; when converting a PresetEffects.xml definition or an existing .ffx into editable form; or when debugging why a pseudo effect .ffx applies wrong values or the wrong layout. Triggers on pseudo effect, .ffx, animation preset, Effect Controls, PresetEffects.xml, Pseudo Effect Maker, expression controls panel, applyPreset.
---

# After Effects pseudo effects as .ffx

A pseudo effect is an effect with no code: a named list of controls. After Effects stores the full definition inside any animation preset (.ffx) that uses it, so applying the .ffx registers the effect on any machine. `scripts/ffx.mjs` builds that .ffx from a JSON spec. It has no dependencies and needs Node 18+.

## Start here

1. Write a spec. Schema and every option: `references/spec.md`. Starting point: `examples/kitchen-sink.json`.
2. Build: `node <skill>/scripts/ffx.mjs build spec.json out.ffx`
3. Check: `node <skill>/scripts/ffx.mjs decode out.ffx` prints the spec back from the bytes.
4. Apply in After Effects: `layer.applyPreset(new File(path))`. Script usage, expressions and indexing: `references/scripting.md`.
5. Verify in After Effects before calling it done: `references/scripting.md#verify-in-after-effects`.

To edit an existing .ffx (from Pseudo Effect Maker or saved by AE): `decode` it to JSON, edit, `build` with a new matchName.

## Rules that are never optional

**Change the matchName whenever the layout changes.** After Effects keeps the first definition it loads for a matchName for the whole session. A changed .ffx with the same matchName applies silently with the old controls (verified in AE 2026). Use a version suffix: `Pseudo/ACME_BoxRig_v2`.

**matchName format.** Starts with `Pseudo/`, printable ASCII, max 34 bytes. Each control gets `<matchName>-NNNN` in a 40-byte field, so 34 is the hard limit. Use `Pseudo/<PREFIX>_<Name>_v<N>`: a short author or studio prefix so it never collides with someone else's effect, no spaces, a version. Details: `references/spec.md#choosing-a-matchname`.

**Names.** Control names max 31 UTF-8 bytes. Max 254 parameters, counting each group as 2 (start and end) and each label as 2.

**Point defaults are fractions of `layerSize`.** On apply, After Effects multiplies stored point values by the source layer size written in the file (default 1920×1080). `[0.5, 0.5]` gives `[960, 540]` on any layer. 3D Point uses width for X and height for Y and Z. If the target layer size differs, set the value from the script after applying.

**Layer controls start at None.** A preset cannot point at a layer in an unknown comp. Set it from the script.

**No hold keyframes, no collapsed groups, no custom units.** After Effects does not store `hold`, `default_self` or twirl state in an .ffx.

**Do not patch bytes by hand.** Every LIST size depends on its children. Change the spec and rebuild.

## What to read for which task

| Task | Reference |
|---|---|
| Write or edit a spec, choose control types and options | `references/spec.md` |
| Apply in a script, read values, write expressions, verify in AE | `references/scripting.md` |
| Byte layout of the .ffx (RIFX chunks, pard, tdb4, cdat) | `references/ffx-format.md` |

## Commands

```bash
node scripts/ffx.mjs build  spec.json out.ffx     # JSON spec -> .ffx
node scripts/ffx.mjs decode in.ffx [out.json]     # .ffx -> JSON spec (--all includes native effects)
node scripts/ffx.mjs dump   in.ffx                # chunk tree, for debugging
node scripts/ffx.mjs diff   a.ffx b.ffx           # byte diff of the RIFX payloads
node tests/run.mjs                                # offline tests
```

## How this was verified

- Rebuilding two presets saved by After Effects 2026 gives identical bytes, except the comp-specific stamps (source comp size, timebase, layer id).
- `examples/kitchen-sink.json` (every control type and flag) applied in After Effects 2026 with a never-registered matchname. All 23 parameters read back with the specified names, values, ranges, keyframe and expression state.
- Decoding 38 real-world .ffx files (Pseudo Effect Maker output, AE-saved presets from commercial tools) gives no errors.
- Not yet tested: After Effects versions before 2026. The header is the one AE 2026 writes. If an older version rejects a file, report it with the AE version.
