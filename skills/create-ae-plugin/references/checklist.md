# Test pass

Run in After Effects before calling an effect done. Build output alone proves nothing about rendering.

Set up one test project and keep it: a comp with a still, a moving layer, a shape layer, a text layer, and every parameter keyframed to non-default values.

## Resolution

For each of Full, Half, Third, Quarter, and Custom (for example 3 horizontal, 5 vertical):

- [ ] Same picture, only softer. Nothing moves, grows, shrinks or disappears.
- [ ] Point parameters stay under their crosshairs.
- [ ] Pixel-valued sliders keep their apparent size.
- [ ] Overlays stay on the picture.

Then:

- [ ] Viewer zoom 25%, 100%, 400%, with a region of interest.
- [ ] Comp with non-square pixels (Anamorphic 2:1): circles stay round, angles stay true.
- [ ] Layer bigger than the comp, layer partly off screen, layer scaled and rotated.
- [ ] Layer with a mask smaller than the layer.
- [ ] Very small layer (4 x 4) and very large (8000 x 8000 or more).
- [ ] Collapsed transformations / continuously rasterized shape or precomp.

## Buffer origin

- [ ] Put Gaussian Blur with a large radius (Repeat Edge Pixels off) before the effect and toggle it: the result does not shift.
- [ ] Put an effect that grows the layer after it: no garbage at the edges (checks `rowbytes` handling).

## Bit depth

- [ ] 8, 16 and 32 bpc projects: same look, no warning icon next to the effect.
- [ ] 32 bpc with values above 1.0 (Exposure +3 before the effect): overbrights survive unless the effect means to clamp.
- [ ] Transparent and semi-transparent input: no dark or bright fringes.

## Parameters

- [ ] Every parameter at minimum, maximum and zero. No crash, no NaN, no division by zero.
- [ ] Layer parameter set to None, to itself, to a smaller layer, to a layer with a different pixel aspect ratio.
- [ ] Path parameter set to None, to an open path, to a closed path.
- [ ] Undo and redo of every change, including overlay drags and button presses.
- [ ] Save, close, reopen: identical render.
- [ ] Open a project saved with the previous version of the plugin.
- [ ] Copy and paste the effect, duplicate the layer, precompose it.

## Rendering behavior

- [ ] Multi-Frame Rendering on: render the comp through the render queue twice and compare with a render made with it off.
- [ ] Scrub while a slow frame renders: After Effects stays responsive (abort works).
- [ ] RAM preview on a long comp until memory fills: no crash.
- [ ] Negative layer time, time-stretched layer, time-reversed layer, layer starting before the comp.
- [ ] Motion blur and frame blending on, if the effect depends on time.
- [ ] Effect applied twice on the same layer, and on an adjustment layer.
- [ ] Applied to an audio-only layer: no crash.

## Custom UI

- [ ] Overlay follows zoom, pan, layer transform, 3D layer, and the Layer panel.
- [ ] Hit targets are the same size at any zoom.
- [ ] Visible on dark, bright and busy footage, and at both UI brightness extremes.
- [ ] Clicks that miss the overlay still reach After Effects (point crosshairs, layer selection).
- [ ] HiDPI display.

## Build

- [ ] macOS: `lipo -archs` shows `x86_64 arm64`. `nm -gU` shows only the entry points. `codesign -dv` shows a signature.
- [ ] macOS, before sharing: downloaded on a second Mac (so it is quarantined), it loads without a Gatekeeper dialog.
- [ ] Windows: x64 build loads. ARM64 build exists if Windows on Arm is supported.
- [ ] No PiPL mismatch dialog at first apply.
- [ ] Effect version bumped if rendering changed.

## Performance

- [ ] Render time measured at 1080p and 4K, 8 and 32 bpc, written down.
- [ ] No-op parameter values take near-zero time.
