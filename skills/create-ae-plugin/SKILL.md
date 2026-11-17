---
name: create-ae-plugin
description: Build After Effects effect plugins in C++ with the After Effects SDK, for macOS and Windows. Use when creating a new AE effect plugin, adding parameters or custom controls (comp overlays, custom Effect Controls UI, arbitrary data), implementing SmartFX or 32-bit float support, fixing an effect that renders wrong at Half/Third/Quarter resolution or with non-square pixels, making an effect thread-safe for Multi-Frame Rendering, or setting up the CMake build and PiPL resource. Triggers on After Effects plugin, AE SDK, .aex, .plugin, PiPL, PF_Cmd, SmartFX, PF_InData, downsample, Drawbot, effect plugin, distribute, notarize, Gatekeeper, plugin won't open on another Mac.
---

# After Effects effect plugins

An effect is a C++ shared library with one entry point. After Effects calls it with a command selector (`PF_Cmd_*`), the plugin answers and returns a `PF_Err`. Everything else is detail, and the details below are the ones that break plugins.

## Start here

1. Ask for the After Effects SDK location if it is not known. The SDK is not redistributable: never commit it, never download it without being asked.
2. Copy `template/` to the new project. It is a working SmartFX effect (8, 16 and 32 bpc, universal macOS binary, Windows x64 and ARM64).
3. Rename: `project(...)` in `CMakeLists.txt`, then every value in `src/Plugin_Config.h`.
4. Build: `cmake --preset debug -DAE_SDK_ROOT=<SDK>/Examples && cmake --build --preset debug`.
5. Replace the parameters, `SpotInfo` and `ShadePixel` with the new effect.
6. Run `references/checklist.md` in After Effects before calling it done.

Build details and the PiPL: `references/build-and-pipl.md`.

## Rules that are never optional

**Resolution and coordinates.** Read `references/coordinates-and-resolution.md` before writing any geometry.

- Buffers are downsampled at Half, Third, Quarter and Custom. `in_data->width` and `in_data->height` are not: they stay at full resolution. Never mix them with buffer sizes or point values during render.
- Point parameters arrive in downsampled buffer coordinates. Sliders that mean "pixels" arrive in full-resolution pixels and must be scaled by `downsample_x` and `downsample_y`.
- Downsampling can differ per axis, and pixels can be non-square. Do geometry in full-resolution square pixels, convert at the edges.
- In SmartFX, buffer pixel (0,0) is not the layer's (0,0).

**Bit depth.** Use SmartFX and support 8, 16 and 32 bpc from the start. Legacy `PF_Cmd_RENDER` cannot do 32 bpc, so a legacy effect shows a warning and loses overbrights in a 32 bpc project. Write pixel code once as a template over the pixel type. 16 bpc white is 32768, not 65535.

**Memory and errors.**

- Wrap `EffectMain` in `try`/`catch (...)`. An exception that reaches After Effects crashes it.
- Return every error from a suite or callback. Never swallow `PF_Interrupt_CANCEL`.
- Check in everything checked out (params, layers, paths), on the error path too.
- Catch `std::bad_alloc` and return `PF_Err_OUT_OF_MEMORY`. Large buffers should come from After Effects (`PF_NewWorld`, `PF_HandleSuite1`), not `new`.
- Walk buffers with `rowbytes`. Input and output can have different `rowbytes`.
- Never write outside the output world.

**Threading.** Set `PF_OutFlag2_SUPPORTS_THREADED_RENDERING` only when render has no mutable static or global state and does not write sequence data. Render runs on several threads at once. Details: `references/performance-and-gpu.md`.

**Identity.**

- `PLUGIN_MATCH_NAME` never changes after release, and never starts with `ADBE `.
- Parameter disk IDs start at 1, are append-only, and are never reused.
- PiPL flags must equal the flags set in `GlobalSetup`. The template enforces this with a `static_assert`: change `Plugin_Config.h` and the assert together.
- Changing how the effect renders requires a version bump, or users keep stale frames from the disk cache.

**Distribution.** The template's ad-hoc signature only works on the machine that built the plugin. On any other Mac, a downloaded plugin is quarantined and Gatekeeper blocks it. To share a plugin, sign it with a Developer ID and notarize it: `references/build-and-pipl.md`, "Signing for distribution".

**Responsiveness.** Use the iterate suites for per-pixel work: they use all cores and handle aborts. In hand-written loops, call `PF_ABORT` every few rows and return its result.

## What to read for which task

| Task | Reference |
|---|---|
| Anything measured in pixels, points, paths, layer parameters | `references/coordinates-and-resolution.md` |
| Effect reads neighbours, grows the layer, uses another layer | `references/smartfx.md` |
| Parameters, supervision, comp overlay, custom ECW control, arbitrary data | `references/custom-ui.md` |
| CMake, PiPL, signing, install paths, Windows | `references/build-and-pipl.md` |
| Speed, caching, Multi-Frame Rendering, GPU | `references/performance-and-gpu.md` |
| Test pass before release | `references/checklist.md` |

## Where the truth lives

- SDK headers, especially `AE_Effect.h`, `AE_EffectCB.h`, `AE_EffectUI.h`, `AE_EffectCBSuites.h`. When this skill and a header disagree, the header wins.
- SDK samples, by task: `Skeleton` (minimal), `SmartyPants` (SmartFX), `Resizer` (buffer expansion), `Checkout` (other layers and times), `Supervisor` (parameter supervision), `CCU` (comp overlay), `Custom_ECW_UI` and `ColorGrid` (custom ECW control and arbitrary data), `PathMaster` (masks), `SDK_Invert_ProcAmp` (GPU).
- Docs: https://ae-plugins.docsforadobe.dev/

Measure before optimizing. Do not guess render times: time the render function and report numbers.
