# Coordinates and resolution

An effect must give the same picture at Full, Half, Third, Quarter and Custom resolution, on square and non-square pixels. Almost every "it breaks at Half" bug is a value from one coordinate space used in another.

## The three spaces

| Space | What it is | What arrives in it |
|---|---|---|
| buffer | Pixels of the `PF_EffectWorld` in hand. (0,0) is the buffer's top left. | `world->width`, `world->height`, pixel loops |
| layer | Downsampled layer pixels. (0,0) is the layer's top left. | Point parameters, SmartFX rects, layer parameter sizes |
| square | Full-resolution square pixels. | Sliders that mean "pixels", `in_data->width/height` (full-res, not squared) |

Conversions:

```cpp
dsX = downsample_x.den / (double)downsample_x.num;   // 2.0 at Half
dsY = downsample_y.den / (double)downsample_y.num;
par = pixel_aspect_ratio.num / (double)pixel_aspect_ratio.den;

layer  = buffer + bufferOriginInLayer;
square.x = layer.x * dsX * par;
square.y = layer.y * dsY;
```

Check every `num` and `den` for zero before dividing. Some hosts send zeros.

`downsample_x` and `downsample_y` can differ (Custom resolution). Never use one for both axes.

## What After Effects scales for you, and what it does not

| Value | At Half resolution |
|---|---|
| Input, output, checked-out layer buffers | Half size |
| Point parameters (`u.td.x_value`, fixed point) | Halved, and shifted by the upstream origin |
| `in_data->width`, `in_data->height` | Unchanged (full resolution). Confirmed in After Effects 2026. |
| Float sliders, angles, percentages | Unchanged |
| Mask path vertices (`PF_PathVertexInfo`, `PF_PathEvalSegLength`) | The docs only say "layer coordinate space". Verify in After Effects at Half before relying on either reading, then scale explicitly. |
| SmartFX `ref_width`, `ref_height` | Unchanged (full resolution) |
| SmartFX request and result rects | Downsampled layer pixels |

Consequences:

- A "10 px blur" slider is `10 * downsample_x.num / den` buffer pixels wide, and `10 * num / den` on Y with the Y factor.
- "Center of the layer" during render is `input->width / 2` in a legacy effect (minus any upstream origin shift), or `ref_width * num / den / 2` in SmartFX. These are in the same space as point values.
- A percentage of the layer is `pct / 100 * input->width` in buffer pixels.
- Code shared between render and UI events (a mesh builder used by both the renderer and the overlay) must take the layer size as an argument. Render passes the downsampled size, UI events pass `in_data->width/height`. Reading `in_data->width/height` inside the shared code is the classic "shrinks at Half" bug. `downsample_x/y` is not valid during UI events.
- During UI events (draw, click, drag) nothing is downsampled: use `in_data->width/height` and point values as they are.

## Recommended pattern

1. Read parameters.
2. Convert points to square space immediately. Leave pixel sliders as they are (already square).
3. Do all geometry in square space: distances, angles, radii, curves.
4. In the pixel loop, convert each buffer pixel centre `(x + 0.5, y + 0.5)` to square space, or convert the finished geometry back to buffer space once.

The template does exactly this in `MakeSpace` and `ShadePixel`.

For effects that rasterize shapes (strokes, meshes), it is usually cheaper to convert the shape to buffer space once: `buffer = square / (ds * par) - origin`.

## Pixel centres

Pixel `(x, y)` covers `[x, x+1) x [y, y+1)`. Its centre is `(x + 0.5, y + 0.5)`. When sampling bilinearly at a continuous position `p`, the four taps are around `p - 0.5`. The SDK's `subpixel_sample` treats `(0, 0)` as the centre of the first pixel, so subtract 0.5 before calling it.

## Sizes that must be integers

Kernel radii, cell sizes and dilation radii get rounded after scaling, and the rounding differs per resolution (`16 / 3 = 5.33`). Options, best first:

- Keep the value fractional and weight the edge taps (fractional box blur).
- Define the grid in square space and map each buffer pixel into it, instead of stepping an integer cell size in buffer pixels.
- Accept a small mismatch, but clamp to a minimum of 1 so the effect does not vanish at Quarter.

Thresholds that count pixels ("ignore blobs under 16 px") scale by `num_x/den_x * num_y/den_y`.

## Analysis effects

Edge detection, seam carving, tracing an outline from alpha: the input itself has less detail at lower resolution, so the result cannot match exactly. Make the parameters resolution-independent (thresholds, sizes), anchor grids to the layer origin, and say in the docs that the preview is approximate. Do not chase pixel-exact parity.

## Buffer origin

Legacy effects (`PF_Cmd_RENDER`):

- Normally buffer (0,0) is the layer's (0,0).
- If an earlier effect grew the buffer, the layer's corner sits at `in_data->pre_effect_source_origin_x/y` inside the input. Point parameters are already shifted to match. Anything derived from "the layer rectangle" (centre, percentages, a uniform grid) must add that offset.
- If this effect grows the buffer in `PF_Cmd_FRAME_SETUP`, the input's corner lands at `in_data->output_origin_x/y` in the output. Size the new buffer from downsampled sizes (`in_data->width * downsample_x.num / den`), never from `in_data->width/height` alone. Scale the growth by the downsample factors and clamp the buffer to 30000 x 30000.

SmartFX:

- The output buffer covers the `result_rect` returned from PreRender. Its (0,0) is `result_rect.left/top` in layer coordinates.
- Each input buffer covers that checkout's `result_rect`. Input and output can have different origins and sizes when the effect reads neighbours. Convert through layer coordinates: `inputBuffer = outputBuffer + (outRect.left - inRect.left)`.
- Pass the rects from PreRender to SmartRender in `pre_render_data`.

Test for origin bugs: put Gaussian Blur (large radius, "Repeat Edge Pixels" off) or the SDK's Resizer before the effect and toggle it. The output must not shift.

## Other layers

A layer parameter arrives without its transform, at its own size, downsampled by the same factors, with its own pixel aspect ratio (`world->pix_aspect_ratio` for checked-out layers, `in_data->pixel_aspect_ratio` for the effect's own layer). A layer set to None comes back empty: handle `data == NULL` or zero size.

Decide and document how the other layer maps onto this one (stretch to fit, or 1:1 centred), and compute the mapping from buffer sizes of both, which are downsampled alike.

## Time

`current_time / time_scale` is seconds. `time_step` can be zero or negative: check before dividing. Renders can be asked at non-frame times and at negative times.
