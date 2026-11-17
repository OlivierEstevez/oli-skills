# Performance, threading and GPU

Measure first. Wrap the render function with `std::chrono::steady_clock`, log milliseconds for a known comp (for example 1920x1080 and 3840x2160, 8 and 32 bpc), and keep the numbers next to the change. Do not claim a speedup without them.

## Let After Effects skip work

In order of payoff:

1. **Fast paths.** When parameters make the effect a no-op, copy input to output (`PF_WorldTransformSuite1::copy_hq`) and return.
2. **Correct SmartFX rects.** Request only the input needed and return tight result rects. After Effects then renders upstream layers only for that area.
3. **Honest flags.** `PF_OutFlag_PIX_INDEPENDENT` when true. No `PF_OutFlag_NON_PARAM_VARY` unless output really changes with constant parameters. `PF_OutFlag_WIDE_TIME_INPUT` only with `PF_OutFlag2_AUTOMATIC_WIDE_TIME_INPUT`. Wrong flags either break caching or disable it.
4. **`PF_Cmd_QUERY_DYNAMIC_FLAGS`** (with `PF_OutFlag2_SUPPORTS_QUERY_DYNAMIC_FLAGS`) when a flag depends on parameter values.

## Use every core inside a frame

- Per-pixel work: `Iterate8Suite2`, `Iterate16Suite2`, `IterateFloatSuite2`. They split rows across all cores and handle progress and abort. The pixel function must be re-entrant and treat its refcon as read-only.
- Row or tile work that is not per-pixel (separable filters, rasterizing a mesh): `PF_Iterate8Suite2::iterate_generic(PF_Iterations_ONCE_PER_PROCESSOR, refcon, fn)` and split rows by thread index. Call abort and progress only from thread index 0.
- Do not start your own thread pool. It competes with After Effects' render threads.

Hand-written loops must call `PF_ABORT(in_data)` every few rows and return its result. Long algorithms (iterative solvers, seam carving) also call `PF_PROGRESS`.

## Inner loop habits

- Hoist everything per-frame out of the pixel function into the info struct.
- Avoid `double` division, `sqrt`, `sin` per pixel where a comparison of squares or a table does.
- Separable filters: two 1D passes. Box blurs with a running sum are O(1) per pixel for any radius. Three box passes approximate a Gaussian.
- Walk memory row by row. A column pass over a row-major buffer is slow: process several columns per pass or transpose.
- `float` buffers are enough for 8 and 16 bpc intermediates.
- Do not allocate per pixel or per row. Allocate once per frame, and prefer After Effects' allocators for anything frame-sized (`PF_WorldSuite2::PF_NewWorld`, `PF_HandleSuite1`), so the host can free cache when memory is low. Return `PF_Err_OUT_OF_MEMORY` when allocation fails.
- Size arithmetic for frame buffers in `size_t`. `width * height * 4` overflows 32-bit `int` above roughly 23000 x 23000.

## Multi-Frame Rendering

With `PF_OutFlag2_SUPPORTS_THREADED_RENDERING`, After Effects renders several frames at once: `SMART_PRE_RENDER`, `SMART_RENDER`, `RENDER` and the sequence selectors run concurrently, also with UI selectors. Without the flag the effect is serialized and shows a warning icon.

Thread-safe means:

- No mutable `static` or global variables. `static const` tables are fine. A table computed at runtime becomes a `static const` local initialized by a function (C++ guarantees that initialization is thread-safe) or `thread_local`.
- No writes to `global_data` outside `GLOBAL_SETUP` and `GLOBAL_SETDOWN`.
- No writes to `sequence_data` during render or `UPDATE_PARAMS_UI`. Read it with `PF_EffectSequenceDataSuite1::PF_GetConstSequenceData`.
- No mutex held while calling any suite or checkout: that deadlocks.
- Third-party libraries used during render are thread-safe too.

Sequence data with pointers also needs `PF_OutFlag2_SUPPORTS_GET_FLATTENED_SEQUENCE_DATA`. `PF_OutFlag2_MUTABLE_RENDER_SEQUENCE_DATA_SLOWER` gives each render thread its own writable copy, at a cost.

Adobe's static analyzer for leftover statics: https://github.com/adobe/ae-plugin-thread-safety

## Caching expensive intermediate results

For data that is costly to compute and shared between frames or threads (an analysis pass, a rasterized glyph atlas, a traced outline that only changes when another layer changes): `AEGP_ComputeCacheSuite1`.

- Register a class in `GLOBAL_SETUP` (`AEGP_ClassRegister`) with four callbacks: `generate_key`, `compute`, `approx_size_value`, `delete_compute_value`. Unregister in `GLOBAL_SETDOWN`.
- `generate_key` hashes every input that affects the result (`AEGP_HashSuite1`): parameter values, time, downsample factors, bit depth, and for layer inputs the state from `PF_ParamUtilsSuite3::PF_GetCurrentState`.
- `AEGP_ComputeIfNeededAndCheckout(class, options, wait, &receipt)`, `AEGP_GetReceiptComputeValue`, `AEGP_CheckinComputeReceipt`.
- Entries can be purged at any time and are not saved with the project.

Small constant data (glyph bitmaps for a fixed set of sizes, lookup tables) can simply be computed once in `GLOBAL_SETUP` into `global_data`.

## GPU

After Effects renders effects on the GPU only through its own frameworks, listed in `PF_GPU_Framework`:

| Framework | Platform |
|---|---|
| Metal | macOS |
| DirectX 12 | Windows (needs `PF_OutFlag2_SUPPORTS_DIRECTX_RENDERING`) |
| CUDA | Windows with NVIDIA |
| OpenCL | Legacy |

**There is no Vulkan framework.** After Effects hands the effect its input and output as GPU buffers on one of the frameworks above. A Vulkan renderer would have to create its own device, download the input to CPU memory, upload it, render, read back, and return a CPU buffer. That is slower than staying on the CPU for most effects, and it breaks After Effects' GPU pipeline between effects. Do not use Vulkan inside an effect.

What GPU support costs:

- One kernel per framework: Metal Shading Language for macOS, HLSL for DirectX, CUDA for NVIDIA. The SDK sample (`SDK_Invert_ProcAmp`) generates them from one source with a preprocessing step that needs Boost, plus the CUDA SDK and the DirectX shader compiler on Windows.
- `PF_OutFlag2_SUPPORTS_GPU_RENDER_F32`, `PF_Cmd_GPU_DEVICE_SETUP` / `SETDOWN`, `PF_RenderOutputFlag_GPU_RENDER_POSSIBLE` in PreRender, `PF_Cmd_SMART_RENDER_GPU`. GPU frames are always 32-bit float.
- A CPU path is still required, and both must match visually.

Add GPU only when all of these hold: the effect is per-pixel or a small fixed kernel, the CPU version is already measured and optimized, and it is still too slow at the target frame size. Effects built on data-dependent algorithms (flood fill, tracing, seam carving, scanline rasterizers with shared state) gain little or nothing.
