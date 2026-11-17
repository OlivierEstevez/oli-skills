# Spec format

One JSON object per effect. `decode` produces the same format, so any .ffx can be turned into a spec, edited and rebuilt.

```json
{
  "name": "Box Rig",
  "matchName": "Pseudo/ACME_BoxRig_v1",
  "layerSize": [1920, 1080],
  "controls": [
    { "type": "slider", "name": "Width", "default": 200, "validMin": 0, "validMax": 30000, "sliderMin": 0, "sliderMax": 1000, "precision": 0, "display": "pixel" },
    { "type": "group", "name": "Corners", "controls": [
      { "type": "slider", "name": "Radius", "default": 0, "validMin": 0, "validMax": 15000, "sliderMin": 0, "sliderMax": 100 }
    ] },
    { "type": "label", "name": "v1.0", "dim": true }
  ]
}
```

## Effect fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Name shown in the Effect Controls panel and used by `effect("...")` in expressions. |
| `matchName` | yes | Internal id. `Pseudo/` prefix, printable ASCII, max 34 bytes. Change it whenever the layout changes. See [Choosing a matchName](#choosing-a-matchname). |
| `layerSize` | no | `[width, height]` of the layer the point defaults refer to. Default `[1920, 1080]`. |
| `controls` | yes | Ordered list of controls. Groups nest. |

## Choosing a matchName

Pattern: `Pseudo/<PREFIX>_<Name>_v<N>`, for example `Pseudo/ACME_BoxRig_v1`.

| Part | Why |
|---|---|
| `Pseudo/` | The convention for pseudo effects. The builder requires it. |
| `<PREFIX>` | 2 to 6 letters for the author or studio. Two different effects with the same matchName cannot coexist in one AE session, so a prefix keeps yours from colliding with other tools. |
| `<Name>` | Short. The whole matchName has 34 bytes. |
| `_v<N>` | Bump it on every layout change. After Effects keeps the first definition it loaded for a matchName (see `ffx-format.md#session-registry`). |

Spaces work: After Effects' own matchNames use them (`ADBE Slider Control`). Avoid them anyway:

- A double or trailing space is invisible in code and in the Effect Controls panel, yet makes a different matchName.
- Underscores keep the name one token, so it is easy to search for in code and in shell commands.
- Scripts reference matchNames as strings (`property("Pseudo/ACME_BoxRig_v1-0003")`); without spaces, typos are easier to spot.

Avoid `-` followed by 4 digits at the end: each control's matchName is the effect's matchName plus `-NNNN`.

Users never see the matchName. The panel shows `name`, and expressions use `name` too.

## Fields every control accepts

| Field | Default | Meaning |
|---|---|---|
| `type` | | One of the types below. |
| `name` | | Max 31 UTF-8 bytes. Required except for labels. Duplicate names are allowed but make `effect("FX")("Name")` ambiguous. |
| `invisible` | `false` | Hidden from the panel. Still readable by expressions and scripts. After Effects refuses expressions on the hidden control itself. |
| `keyframes` | `true` | `false` sets CANNOT_TIME_VARY: no stopwatch, no expressions on that control. |

## Control types

### slider

| Field | Default | Notes |
|---|---|---|
| `default` | `0` | Must be within `validMin..validMax`. |
| `validMin`, `validMax` | `-1000000`, `1000000` | Hard range. Typed values are clamped to it. |
| `sliderMin`, `sliderMax` | `validMin`, `validMax` | Range of the drag slider. Must sit inside the valid range. |
| `precision` | `1` | Decimal places shown, 0..6. |
| `display` | `"number"` | `"percent"` adds a % sign, `"pixel"` marks it as pixels. Display only. |

Ranges are stored as 32-bit floats: values beyond about 7 significant digits are rounded.

### angle

`default` in degrees. Default `0`.

### checkbox

`default`: `true` or `false`. Expressions read it as 1 or 0.

### color

`default`: `[r, g, b]`, each 0..255. Default white. Expressions read `[r, g, b, a]` in 0..1.

### point

`default`: `[x, y]` as fractions of `layerSize`. Default `[0.5, 0.5]`. The applied value is `x * width, y * height` in layer pixels.

### point3d

`default`: `[x, y, z]` as fractions. Default `[0.5, 0.5, 0.5]`. Applied value: `x * width, y * height, z * height`.

### popup (dropdown)

| Field | Notes |
|---|---|
| `options` | Array of strings, no `|` characters. `"(-"` draws a separator line (it still counts as an item). |
| `default` | 1-based index. Default `1`. |

Expressions read the 1-based index.

### layer

No fields. Starts at None. It cannot be keyframed.

### group

| Field | Notes |
|---|---|
| `controls` | Nested controls. Groups can nest. An empty group is a label. |

Groups are a panel feature only. Scripts and expressions see a flat list (`references/scripting.md`).

### label

A text line with no control: an empty group, same as Pseudo Effect Maker's label. `name` is the text, max 31 bytes. `dim: true` greys it out.

## Parameter count

Every control is one parameter. Every group and every label is two (start and end). Max 254 in total. The root and the built-in Compositing Options are added automatically and do not count.

## Choosing types for common needs

| Need | Use |
|---|---|
| Number, size, amount | slider with `display` and a tight `sliderMin..sliderMax` |
| On/off | checkbox |
| Choice between modes | popup, read the index in expressions |
| Position on the layer | point (2D) or point3d |
| Seed, count, anything that must not animate | slider with `keyframes: false` and `precision: 0` |
| Internal value driven by expressions, not by the user | slider with `invisible: true` |
| Credit line, version, section title | label |
