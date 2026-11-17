# Parameters and custom controls

## Parameters

Add them in `PF_Cmd_PARAMS_SETUP`. Clear `def` with `AEFX_CLR_STRUCT` before each one, give each a disk ID, and set `out_data->num_params`.

| Type | Macro | Value |
|---|---|---|
| Float slider | `PF_ADD_FLOAT_SLIDERX` | `u.fs_d.value` (double) |
| Angle | `PF_ADD_ANGLE` | `u.ad.value` (fixed, degrees, can exceed 360) |
| Checkbox | `PF_ADD_CHECKBOXX` | `u.bd.value` |
| Popup | `PF_ADD_POPUP` | `u.pd.value`, 1-based. Choices `"A|B|(-|C"`, `(-` is a divider and takes an index. |
| Color | `PF_ADD_COLOR` | `u.cd.value` (8 bit). Use `PF_ColorParamSuite1` for float. |
| Point | `PF_ADD_POINT` | `u.td.x_value/y_value` (fixed). Defaults are percent of the layer. |
| 3D point | `PF_ADD_POINT_3D` | `u.point3d_d` |
| Layer | `PF_ADD_LAYER` | Check it out to get pixels. |
| Path (mask) | `PF_Param_PATH` | `u.path_d.path_id`, read through `PF_PathQuerySuite1` and `PF_PathDataSuite` |
| Button | `PF_ADD_BUTTON` | No value. Needs `PF_ParamFlag_SUPERVISE`. |
| Group | `PF_ADD_TOPIC` / `PF_END_TOPIC` | Both take a disk ID. |
| Arbitrary | `PF_ADD_ARBITRARY2` | A handle to your own data. |

Use float sliders, not `PF_ADD_SLIDER` or fixed sliders. Names are at most 31 bytes.

Useful flags, set on `def.flags` before adding:

- `PF_ParamFlag_SUPERVISE`: send `PF_Cmd_USER_CHANGED_PARAM` when the user changes it.
- `PF_ParamFlag_CANNOT_TIME_VARY`: no stopwatch.
- `PF_ParamFlag_START_COLLAPSED` on a group. Only honored with `PF_OutFlag2_PARAM_GROUP_START_COLLAPSED_FLAG`.
- `PF_ParamFlag_USE_VALUE_FOR_OLD_PROJECTS`: a parameter added in a later version loads with `value` in old projects and uses `dephault` for new ones. Use it so old projects render as before.

UI flags, on `def.ui_flags`: `PF_PUI_DISABLED`, `PF_PUI_INVISIBLE` (fixed at setup in After Effects), `PF_PUI_NO_ECW_UI` (no row in Effect Controls, still keyframable), `PF_PUI_STD_CONTROL_ONLY` (a control with no stream, needs `SUPERVISE`), `PF_PUI_CONTROL` and `PF_PUI_TOPIC` (custom drawn).

Changing a default changes old projects that kept the default. Give the parameter a new disk ID instead.

## Supervision

`PF_Cmd_USER_CHANGED_PARAM`: `extra` is a `PF_UserChangedParamExtra` with `param_index`. Here the effect may change parameter values: write the value into `params[i]` and set `params[i]->uu.change_flags = PF_ChangeFlag_CHANGED_VALUE`. The change is undoable.

`PF_Cmd_UPDATE_PARAMS_UI`: cosmetic only (enable, disable, rename, collapse). Sent when any parameter is supervised or `PF_OutFlag_SEND_UPDATE_PARAMS_UI` is set. Copy the `PF_ParamDef`, edit the copy, call `PF_ParamUtilsSuite3::PF_UpdateParamUI(effect_ref, index, &copy)`. Never modify the original, never pass `params[0]`, never change values, never check out parameters here.

Only call `PF_UpdateParamUI` when the state actually changes. Compare with the current `ui_flags` first.

Values can only be changed during `USER_CHANGED_PARAM` and during click, drag and keydown events.

`in_data->width/height` and point values are full resolution during these selectors.

## Comp and layer overlay (direct manipulation)

Setup:

1. `PF_OutFlag_CUSTOM_UI` in the PiPL and `GlobalSetup`.
2. At the end of `ParamsSetup`:

```cpp
PF_CustomUIInfo ci;
AEFX_CLR_STRUCT(ci);
ci.events = PF_CustomEFlag_COMP | PF_CustomEFlag_LAYER;
err = (*(in_data->inter.register_ui))(in_data->effect_ref, &ci);
```

3. Handle `PF_Cmd_EVENT`. `extra` is a `PF_EventExtra`: `e_type`, `contextH`, `u`, `cbs`, `evt_in_flags`, `evt_out_flags`.

Events: `PF_Event_DRAW`, `PF_Event_DO_CLICK`, `PF_Event_DRAG`, `PF_Event_ADJUST_CURSOR`, `PF_Event_KEYDOWN`, `PF_Event_MOUSE_EXITED`, plus context events. Set `evt_out_flags = PF_EO_HANDLED_EVENT` only for events the effect consumed. Leaving a click unhandled lets After Effects drag point parameters itself.

Coordinates:

```cpp
// layer -> window
if ((*extra->contextH)->w_type == PF_Window_COMP)
    extra->cbs.layer_to_comp(extra->cbs.refcon, extra->contextH, in_data->current_time, in_data->time_scale, &pt);
extra->cbs.source_to_frame(extra->cbs.refcon, extra->contextH, &pt);

// window -> layer
extra->cbs.frame_to_source(extra->cbs.refcon, extra->contextH, &pt);
if ((*extra->contextH)->w_type == PF_Window_COMP)
    extra->cbs.comp_to_layer(extra->cbs.refcon, extra->contextH, in_data->current_time, in_data->time_scale, &pt);
```

`pt` is a `PF_FixedPoint`. Always go through these callbacks, or the overlay breaks on zoom, pan, rotation and 3D. Measure hit distances in window pixels so they do not change with zoom.

Drawing (only inside `PF_Event_DRAW`):

- Return early if `extra->evt_in_flags & PF_EI_DONT_DRAW`.
- `PF_EffectCustomUISuite1::PF_GetDrawingReference(contextH, &drawRef)`, then `DRAWBOT_DrawbotSuite::GetSurface` and `GetSupplier`.
- Supplier makes pens, brushes, paths, fonts, images (`NewPen`, `NewBrush`, `NewPath`). Each must be released. The RAII wrappers in `DrawbotSuite.h` (`DRAWBOT_PathP`, `DRAWBOT_PenP`, `DRAWBOT_BrushP`) do this and throw on failure, so wrap drawing in `try`/`catch`.
- Path: `MoveTo`, `LineTo`, `BezierTo`, `AddRect`, `AddArc`, `Close`. Surface: `StrokePath`, `FillPath`, `PaintRect`, `DrawString`, `DrawImage`, `PushStateStack`/`PopStateStack`.
- Use `PF_EffectCustomUIOverlayThemeSuite1` for colors, stroke width and vertex size (`PF_GetPreferredForegroundColor`, `PF_StrokePath`, `PF_FillVertex`, ...). Hard-coded colors disappear against some footage and ignore the user's brightness setting.
- `AEFX_AcquireDrawbotSuites` / `AEFX_ReleaseDrawbotSuites` (in `AEFX_SuiteHelper.c`, add it to the build). Release on every path.

Click and drag:

- On `DO_CLICK`: hit-test, set `u.do_click.send_drag = TRUE`, store what was grabbed in `u.do_click.continue_refcon[0..3]`. Do not block waiting for mouse-up.
- Later events arrive as clicks with `send_drag` set. Treat them as drags: compute the new value, write it into `params[i]`, set `change_flags = PF_ChangeFlag_CHANGED_VALUE`. End when `u.do_click.last_time` is set.
- `PF_EO_ALWAYS_UPDATE` re-renders on every drag step, `PF_EO_NEVER_UPDATE` waits for release. Pick per effect cost.
- To redraw without a value change: `PF_AppSuite::PF_InvalidateRect(contextH, NULL)` and `PF_EO_UPDATE_NOW`.

Do not check out layer parameters during events.

A point parameter already gives a draggable crosshair for free. Draw an overlay only for what a point cannot express (handles relative to another point, radii, curves, meshes).

## Custom control in the Effect Controls panel

1. `PF_OutFlag_CUSTOM_UI`.
2. On the parameter: `def.ui_flags = PF_PUI_CONTROL`, `def.ui_width`, `def.ui_height`. Works on standard types and on arbitrary data. Add `PF_CustomEFlag_EFFECT` to `ci.events`.
3. In events, `(*contextH)->w_type == PF_Window_EFFECT`, `extra->effect_win.index` is the parameter and `extra->effect_win.current_frame` is its rectangle. Draw with Drawbot inside that rectangle. Use `PF_AppSuite::PF_AppGetBgColor` and `PF_AppGetColor` to match the panel.
4. To resize at runtime, change `ui_height` on a copy and call `PF_UpdateParamUI`.

On HiDPI displays draw images at 2x and scale with the surface `Transform`.

Samples: `Custom_ECW_UI`, `ColorGrid`, `HistoGrid`.

## Arbitrary data

Use it when the control's state is not expressible with standard parameters (a curve, a grid of colors). It is keyframable and saved with the project, but the effect must implement the whole type.

- Add with `PF_ADD_ARBITRARY2`, with `dephault` pointing at a handle allocated through `PF_HandleSuite1`. In After Effects it must have `PF_PUI_TOPIC`, `PF_PUI_CONTROL` or `PF_PUI_NO_ECW_UI`.
- Handle `PF_Cmd_ARBITRARY_CALLBACK`: `extra` is `PF_ArbParamsExtra`, switch on `which_function`: `NEW`, `DISPOSE`, `COPY`, `FLAT_SIZE`, `FLATTEN`, `UNFLATTEN`, `INTERP`, `COMPARE`, `PRINT_SIZE`, `PRINT`, `SCAN`. All of them, every time.
- The flattened form is a file format. Keep it free of pointers, give it a version field, fix the byte order.
- `COPY` with a `NULL` source means "make a default".
- These callbacks can be re-entered and can run with `in_data->effect_ref == NULL`. Do not check out parameters then, and keep no static state.

Before reaching for arbitrary data, check whether many standard parameters plus `PF_PUI_NO_ECW_UI` and an overlay would do: After Effects then handles interpolation, expressions, copy and paste.

## Sequence data

Per-instance state that is not a parameter. Allocate in `PF_Cmd_SEQUENCE_SETUP`, free in `SEQUENCE_SETDOWN`, handle `SEQUENCE_RESETUP` (load, duplicate) and `SEQUENCE_FLATTEN` (save) if it holds pointers. With Multi-Frame Rendering it is read-only during render and read through `PF_EffectSequenceDataSuite1::PF_GetConstSequenceData`. Do not cache render results in it: use the Compute Cache (`performance-and-gpu.md`).
