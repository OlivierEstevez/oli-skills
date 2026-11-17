# .ffx format (pseudo effect presets)

Reverse-engineered from presets saved by After Effects 2026, presets written by Pseudo Effect Maker 3, and 38 real-world files. Nothing here is documented by Adobe. Offsets are byte offsets inside the chunk body. All integers are big-endian.

## Container

RIFX: RIFF with big-endian sizes. A chunk is `tag (4 bytes) + u32 size + body`, followed by one zero pad byte when `size` is odd. The pad is not counted in `size`. `LIST` bodies start with a 4-byte list type and then hold child chunks.

The RIFX size covers the whole payload. After Effects appends an XMP packet after it. Pseudo Effect Maker appends a JSON object instead (`controlName`, `matchname`, `version`, `controlArray`), which only its own panel reads. Readers must stop at `8 + size`. Neither trailer is needed on load, and `ffx.mjs` writes none.

```
RIFX  FaFX
  head (16)                       version stamp
  LIST besc
    beso (56)                     source comp/layer stamp
    LIST tdsp                     property path: ADBE Effect Parade > <matchName>
      tdot  ffffffff
      tdpl  u32 2                 path length
      LIST tdsi  { tdix ffffffff, tdmn "ADBE Effect Parade" }
      LIST tdsi  { tdix 00000000, tdmn "<matchName>" }
    tdsn                          effect display name
    LIST tdsp                     path terminator
      tdot ffffffff, tdpl u32 1, LIST tdsi { tdix ffffffff, tdmn "ADBE End of path sentinel" }
    LIST sspc                     the effect definition and its values
      fnam                        effect display name
      LIST parT                   definitions: one pard per parameter
      LIST tdgp                   values: one tdbs per parameter
      pgui (16)  zeros
      elab (1)   ff
```

A preset with several effects has several `sspc` lists. Presets saved from native effects carry `sspc` for those too (for example `ADBE Geometry2`). Presets of plain layer properties have no `sspc`.

## Strings

| Chunk | Format |
|---|---|
| `tdmn` | 40 bytes, ASCII, NUL padded. Max 39 characters. |
| `tdsn`, `fnam`, `pdnm` (AE) | `"Utf8"` + u32 byte length + UTF-8 bytes, padded to even length inside the body (pad counted in `size`). |
| `tdsn`, `fnam` (Pseudo Effect Maker) | Raw NUL-terminated string. After Effects reads both. |

## head and beso

`head` from AE 2026: `00000003 00000061 00000007 00000000`. Pseudo Effect Maker writes `00000003 00000044 00000001 01000000`. Older AE saves show `0000005c 0000000e`. The second and third words track the AE version.

`beso` (56 bytes):

| Offset | Meaning |
|---|---|
| 12..15 | Timebase stamp (same value as tdb4 12..15). |
| 16..19 | Frame rate of the source comp, 16.16 fixed (`00190000` = 25, `001df852` = 29.97). |
| 24..27 | u16 w, u16 h. AE 2026 repeats the layer size. Older saves write `0001 0001`. |
| 28..31 | u16 width, u16 height of the source layer. **Used on apply**: stored Point and 3D Point values are multiplied by this size (3D Z uses height). Verified in AE 2026 by changing only these bytes. |
| 32..47 | Two doubles `1.0`. |
| 52..55 | `ffffffff` |

## parT: definitions

```
parn  u32 count             parameters + 2 (root and built-in params)
tdmn  "<matchName>-0000"    root: the effect's input layer
pard                         type 0, flags 2, bytes 128..131 = ffffffff
tdmn  "<matchName>-0001"
pard
[pdnm]                       popups: "A|B|C". checkboxes: empty string.
...
tdmn  "ADBE Effect Built In Params"
pard                         type 9, all else zero
```

### pard (148 bytes)

| Offset | Meaning |
|---|---|
| 4..7 | u32 UI flags (PF_ParamUIFlags): `0x8` no ECW UI (every group end), `0x20` disabled/greyed (dim label), `0x200` invisible. |
| 12..15 | u32 parameter type, see below. |
| 16..47 | Name, UTF-8, NUL-terminated. Max 31 bytes. Empty for group ends. |
| 48..51 | u32 flags (PF_ParamFlags): `0x2` CANNOT_TIME_VARY. Always set on layer, group start, group end and root. |
| 52..147 | Type payload. |

Parameter types (PF_Param_* values from the AE SDK):

| Type | Control | Payload |
|---|---|---|
| 0 | Layer | 128..131 = `ffffffff` |
| 3 | Angle | 56 default, 60 default (16.16 fixed degrees). 64 i32 -30000, 68 i32 30000. |
| 4 | Checkbox | 56 u32 1 if on. 60 u8 1 if on. |
| 5 | Color | 56 ARGB bytes, 60 ARGB bytes. Alpha `ff`. |
| 6 | Point | 56 x, 60 y (16.16 fixed fractions). 68 x·100, 72 y·100 (16.16 fixed). |
| 7 | Popup | 56 u32 default. 60 u16 item count. 62 u16 default (1-based). |
| 9 | No data | Built-in params placeholder. |
| 10 | Float slider | 56 f64 default. 104 f32 valid min, 108 valid max, 112 slider min, 116 slider max, 120 default. 124 u16 precision. 126 u16 display: 0 none, 1 percent, 2 pixel. |
| 13 | Group start | none |
| 14 | Group end | none |
| 18 | 3D Point | 56, 64, 72 f64 fraction·65536. 80, 88, 96 f64 fraction·100·65536. |

Types 1 (int slider), 2 (fixed slider), 11 (arbitrary data) and 15 (button) appear in presets of native effects. A pseudo effect never uses them.

Bytes not listed are zero in clean files. AE-saved files often hold leftover memory in unused payload bytes. Ignore it when reading.

`hold` and `default_self` from PresetEffects.xml leave no trace in the file. Verified with an AE 2026 save of one control per attribute.

## tdgp: values

```
tdsb  u32 1
tdsn  effect name
tdmn  "<matchName>-0000"   LIST tdbs (root: tdsb 3, layer tdb4, cdat, tdpi, tdps)
tdmn  "<matchName>-0001"   LIST tdbs
...
tdmn  "ADBE Effect Built In Params"   LIST tdgp (Compositing Options: mask parade, mask opacity, GPU switch)
tdmn  "ADBE Group End"
```

Pseudo Effect Maker leaves out the built-in params block. After Effects loads files with or without it.

### tdbs (one per parameter)

| Chunk | Meaning |
|---|---|
| `tdsb` | u32: `1` visible, `3` hidden (bit 1). Some AE saves show `0x00040001`; meaning unknown. |
| `tdsn` | Display name. |
| `tdb4` | 124-byte stream descriptor. Constant per control type except bytes 12..15. |
| `cdat` | Current value as doubles. 40 bytes; color 96, point 48, 3D point 72. |
| `tdum`, `tduM` | Slider only: f64 slider min and max (rounded through f32). |
| `tdpi`, `tdps` | Layer only: u32 layer id the control points to (0 = None), u32 0. In the root, tdpi is the id of the source layer. |

`cdat` holds the value After Effects applies:

| Control | cdat doubles |
|---|---|
| Slider, angle | value |
| Checkbox | 0 or 1 |
| Popup | 1-based index |
| Color | 255, r, g, b (0..255) |
| Point | x, y as fractions of the beso layer size |
| 3D Point | x, y, z as fractions (x·width, y·height, z·height) |
| Layer, group | zeros |

### tdb4 (124 bytes)

| Offset | Meaning |
|---|---|
| 0..1 | `db99` in AE saves. Pseudo Effect Maker writes `bd99` for angle, color, slider. AE reads both. |
| 2..3 | Value dimensions: 1, 2 (point), 3 (3D point), 4 (color). |
| 4..11 | Type-dependent constants. |
| 12..15 | Timebase stamp of the source comp. Not needed on load. |
| 16..123 | Type-dependent constants (defaults to 1.0, interpolation hints). |

The exact per-type templates are in `scripts/ffx.mjs` (`TDB4_HEAD`, `TDB4_TAIL`). Copy them, do not derive them.

## Session registry

The first time After Effects loads a matchName (from PresetEffects.xml, a project or an .ffx), it registers that definition for the session. Applying another .ffx with the same matchName and a different layout adds the registered layout, not the file's (verified in AE 2026).
