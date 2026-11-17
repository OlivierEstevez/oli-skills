# SmartFX

SmartFX is the render path to use. It is the only way to get 32 bpc, and it lets After Effects render only the pixels that are needed.

Flags (PiPL and `GlobalSetup`): `PF_OutFlag2_SUPPORTS_SMART_RENDER`, plus `PF_OutFlag2_FLOAT_COLOR_AWARE` and `PF_OutFlag_DEEP_COLOR_AWARE` for 32 and 16 bpc.

With the flag set, After Effects sends `PF_Cmd_SMART_PRE_RENDER` then `PF_Cmd_SMART_RENDER` instead of `FRAME_SETUP` / `RENDER` / `FRAME_SETDOWN`. Premiere Pro does not support SmartFX: an effect that must run there also needs a legacy `PF_Cmd_RENDER`.

Neither selector receives a usable `params[]`. Check out every value with `PF_CHECKOUT_PARAM` and check it back in.

## PreRender

Input: `extra->input->output_request.rect`, the area After Effects wants, in downsampled layer coordinates. It can be empty (After Effects only wants the bounds).

Do three things:

1. **Check out every layer input the render might need**, with `extra->cb->checkout_layer(effect_ref, param_index, checkout_id, &request, time, time_step, time_scale, &result)`. Layers cannot be checked out later. `checkout_id` is any unique non-negative number chosen by the effect.
2. **Set `result_rect`**: what this render will produce. Not bigger than the request (unless `PF_RenderOutputFlag_RETURNS_EXTRA_PIXELS` is set), can be smaller, can be empty.
3. **Set `max_result_rect`**: the bounds if After Effects asked for everything. It must not depend on the request. Compute it tightly: too small clips the picture, too big wastes memory and render time.

Sizing the input request by effect type:

| Effect | Input request | Output rects |
|---|---|---|
| Per-pixel (color) | Same as output request | Same as input result |
| Reads neighbours within radius r (blur, shadow, glow) | Output request grown by r, in downsampled pixels | Input result grown by r if the effect spreads pixels outward, else input result |
| Arbitrary warp | Whole input: request `max_result_rect` after a first empty checkout, or a large rect | Bounds of the warped shape, intersected with the request for `result_rect` |
| Generator (ignores input) | Still check out the input once | Layer bounds or the generated shape's bounds |

To learn a layer's size before deciding, call `checkout_layer` with an empty request: `ref_width`/`ref_height` (full resolution) and `max_result_rect` come back without rendering.

`r` in downsampled pixels is `ceil(r_fullres * downsample.num / den)`, per axis.

Pass data to render through `extra->output->pre_render_data`, with `delete_pre_render_data_func` set. After Effects owns it after PreRender returns and frees it, even when SmartRender never runs. Allocate with `malloc` and free with `free` in the delete function (see the template). Do not store pointers into checked-out params.

PreRender can run without a following SmartRender, and several times. It must leave nothing behind.

`UnionLRect` and friends are in the SDK's `Smart_Utils.h`.

## SmartRender

```cpp
extra->cb->checkout_layer_pixels(effect_ref, checkout_id, &input);   // once per checkout id
extra->cb->checkout_output(effect_ref, &output);                     // after at least one input
```

- One `checkout_layer_pixels` per `checkout_id`. To read the same layer twice, check it out twice in PreRender with two ids.
- Check for `NULL` worlds and `NULL` data, and return without error.
- Bit depth: `extra->input->bitdepth` is 8, 16 or 32. Dispatch to `Iterate8Suite2`, `Iterate16Suite2`, `IterateFloatSuite2`, or to a template instantiated on `PF_Pixel8`, `PF_Pixel16`, `PF_PixelFloat`.
- Buffer origins: see "Buffer origin" in `coordinates-and-resolution.md`.
- A checked-out input is read-only. Request the output late and inputs few at a time to save memory.
- `checkin_layer_pixels` is optional, but frees memory early.

## Pixel formats

| Depth | Type | Range | Notes |
|---|---|---|---|
| 8 | `PF_Pixel8` | 0..255 | |
| 16 | `PF_Pixel16` | 0..32768 | `PF_MAX_CHAN16` is 32768 |
| 32 | `PF_PixelFloat` | 0.0..1.0 nominal | Values above 1 and below 0 are legal. Do not clamp color. Clamp alpha to 0..1. |

All are ARGB, premultiplied. To apply anything non-linear to color (blend modes, curves), unpremultiply, operate, premultiply again, and guard the division when alpha is 0.

Color parameters are 8 bit in `u.cd.value`. For 16 and 32 bpc use `PF_ColorParamSuite1::PF_GetFloatingPointColorFromColorDef`.

Write the maths once:

```cpp
template <typename Pix, typename Chan = decltype(Pix::red)>
static void Process(const PF_EffectWorld *in, PF_EffectWorld *out, double maxChan);
```

Work in `double` or `float` normalized to 0..1, then scale back. Round integers with `+ 0.5` and clamp them. Do not clamp float color.

## Flags that pair with SmartFX

- `PF_OutFlag_PIX_INDEPENDENT`: each output pixel depends only on the same input pixel. Set it when true, it speeds up rendering.
- `PF_OutFlag2_REVEALS_ZERO_ALPHA`: the effect can make fully transparent pixels visible. Without it After Effects trims those pixels from the input.
- `PF_OutFlag_WIDE_TIME_INPUT` with `PF_OutFlag2_AUTOMATIC_WIDE_TIME_INPUT`: the effect checks out anything at a time other than the current time.
- `PF_OutFlag_NON_PARAM_VARY`: output changes over time with constant parameters (noise, particles). Leave it off otherwise: it disables caching on stills.
- `PF_OutFlag_I_EXPAND_BUFFER`, `PF_OutFlag_I_SHRINK_BUFFER`, `PF_OutFlag_USE_OUTPUT_EXTENT`: legacy only, obsolete for SmartFX. Growing the layer is done with the result rects.

## Legacy path, when it is needed

Only for Premiere Pro, or hosts without SmartFX. `PF_Cmd_RENDER` gets `params[]` filled in and full-layer buffers, 8 and 16 bpc only. To grow the buffer, set `PF_OutFlag_I_EXPAND_BUFFER` and answer `PF_Cmd_FRAME_SETUP` with `out_data->width`, `height`, `origin`. `FRAME_SETUP` is sent twice with that flag. Do not clear the output assuming it is empty: fill it first if the effect does not write every pixel.
