#!/usr/bin/env node
// ffx.mjs: build, decode and inspect After Effects pseudo effect presets (.ffx).
// Zero dependencies. Node 18+.
//
//   node ffx.mjs build  spec.json out.ffx      JSON spec -> .ffx
//   node ffx.mjs decode in.ffx [out.json]      .ffx -> JSON spec (round-trips through build)
//                                              --all also decodes native effects found in the preset
//   node ffx.mjs dump   in.ffx                 print the RIFX chunk tree
//   node ffx.mjs diff   a.ffx b.ffx            byte diff of the RIFX payloads (ignores XMP tail)
//
// Format notes: references/ffx-format.md. Spec schema: references/spec.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants. Values match what After Effects 2026 writes when it saves a
// pseudo effect as an animation preset.
// ---------------------------------------------------------------------------

export const PARAM = {
  LAYER: 0,
  ANGLE: 3,
  CHECKBOX: 4,
  COLOR: 5,
  POINT: 6,
  POPUP: 7,
  NO_DATA: 9, // "ADBE Effect Built In Params"
  SLIDER: 10, // float slider
  GROUP_START: 13,
  GROUP_END: 14,
  POINT_3D: 18,
};

// pard bytes 4..7: PF_ParamUIFlags
const UI_NO_ECW_UI = 0x8; // group end
const UI_DISABLED = 0x20; // greyed out (Pseudo Effect Maker "dim" label)
const UI_INVISIBLE = 0x200;
// pard bytes 48..51: PF_ParamFlags
const FLAG_CANNOT_TIME_VARY = 0x2;

const HEAD = hex("00000003000000610000000700000000");
// beso: source comp/layer stamp. Bytes 24..31 hold the source layer size twice
// (u16 w, u16 h, u16 w, u16 h). On apply, AE multiplies stored Point and 3D Point
// values by this size, so it defines what the spec's fractional point defaults mean.
function beso([w, h]) {
  const b = hex(
    "00000001000000010000000000006400001900000000000007801388078013883ff0" +
      "0000000000003ff000000000000000000000ffffffff",
  );
  b.writeUInt16BE(w, 24);
  b.writeUInt16BE(h, 26);
  b.writeUInt16BE(w, 28);
  b.writeUInt16BE(h, 30);
  return b;
}
const TIMEBASE = hex("00006400"); // tdb4 bytes 12..15

// tdb4: 124-byte stream descriptor per control kind, copied from an AE 2026 save.
// "TTTTTTTT" (bytes 12..15) is the timebase. Bytes 2..3 are the value dimensions.
const TDB4_HEAD = {
  layer:    "db9900010001000000010000",
  group:    "db9900010001000000010000",
  angle:    "db99000100010000ffffffff",
  slider:   "db99000100010000ffffffff",
  checkbox: "db9900010001000000010004",
  popup:    "db9900010001000000010004",
  gpu:      "db9900010001000000020004",
  color:    "db990004000700010002ffff",
  point:    "db990002000f0003ffffffff",
  point3d:  "db990003000f0003ffffffff",
};
const TAIL_1D = "3f1a36e2eb1c432d3ff00000000000003ff00000000000003ff00000000000003ff0000000000000";
const TAIL_2D = "3d9b7cdfd9d7bdbc3fd89374bc6a7efa3ff00000000000003ff00000000000003ff0000000000000";
const zeros = (n) => "0".repeat(n);
const TDB4_TAIL = {
  layer:    TAIL_1D + "0000000404" + zeros(22) + "8" + zeros(103),
  group:    TAIL_1D + "0000000809" + zeros(22) + "8" + zeros(103),
  angle:    TAIL_1D + "0000000406" + zeros(126),
  slider:   TAIL_1D + "0000000809" + zeros(126),
  checkbox: TAIL_1D + "0000000404" + zeros(126),
  popup:    TAIL_1D + "0000000404" + zeros(126),
  gpu:      TAIL_1D + "0000000404" + zeros(126),
  color:    TAIL_1D + "0000000101" + zeros(37) + "1" + zeros(88),
  point:    TAIL_2D + "0000000406" + zeros(37) + "1" + zeros(88),
  point3d:  TAIL_2D + "0000000809" + zeros(37) + "1" + zeros(88),
};

const CDAT_SIZE = { color: 96, point: 48, point3d: 72 }; // everything else: 40

export const LIMITS = {
  matchNameBytes: 34, // tdmn is 40 bytes: matchname + "-NNNN" + NUL
  controlNameBytes: 31, // pard name field is 32 bytes incl. NUL
  maxControls: 254, // Pseudo Effect Maker refuses more
};

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function hex(s) {
  return Buffer.from(s, "hex");
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

function f64(v) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return b;
}

const toF32 = (v) => Math.fround(v);

function chunk(tag, body) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "latin1");
  head.writeUInt32BE(body.length, 4);
  const parts = [head, body];
  if (body.length & 1) parts.push(Buffer.alloc(1));
  return Buffer.concat(parts);
}

function list(kind, parts) {
  return chunk("LIST", Buffer.concat([Buffer.from(kind, "latin1"), ...parts]));
}

// AE string payload: "Utf8" + u32 length + bytes, padded to even INSIDE the chunk.
function utf8(s) {
  const raw = Buffer.from(s, "utf8");
  let body = Buffer.concat([Buffer.from("Utf8"), u32(raw.length), raw]);
  if (body.length & 1) body = Buffer.concat([body, Buffer.alloc(1)]);
  return body;
}

function tdmn(name) {
  const raw = Buffer.from(name, "utf8");
  if (raw.length > 39) throw new Error(`tdmn too long (max 39 bytes): ${name}`);
  const b = Buffer.alloc(40);
  raw.copy(b);
  return chunk("tdmn", b);
}

function tdb4(kind) {
  return Buffer.concat([hex(TDB4_HEAD[kind]), TIMEBASE, hex(TDB4_TAIL[kind])]);
}

function fixed16(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(v * 65536));
  return b;
}

function cdat(kind, values) {
  const b = Buffer.alloc(CDAT_SIZE[kind] ?? 40);
  values.forEach((v, i) => b.writeDoubleBE(v, i * 8));
  return chunk("cdat", b);
}

// ---------------------------------------------------------------------------
// Spec normalisation and validation
// ---------------------------------------------------------------------------

const byteLen = (s) => Buffer.byteLength(s, "utf8");
function fail(where, msg) {
  throw new Error(`${where}: ${msg}`);
}

// Read an optional numeric field. Rejects anything that is not a finite number.
function num(v, fallback, where, field) {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (typeof v === "boolean" || v === null || v === "" || !Number.isFinite(n)) fail(where, `${field} must be a number`);
  return n;
}

function numbers(arr, len, where, msg) {
  if (!Array.isArray(arr) || arr.length !== len || arr.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    fail(where, msg);
  }
  return arr;
}

// 16.16 fixed point holds -32768..32767.
const FIXED_MAX = 32767;

// Flatten the nested spec into AE's flat parameter list (groups become start/end pairs).
export function flatten(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec must be an object");
  const name = String(spec.name ?? "").trim();
  if (!name) fail("spec", "missing name");
  const matchName = String(spec.matchName ?? "");
  if (!matchName.startsWith("Pseudo/")) fail("spec", 'matchName must start with "Pseudo/"');
  if (!/^[\x20-\x7e]+$/.test(matchName)) fail("spec", "matchName must be printable ASCII");
  if (byteLen(matchName) > LIMITS.matchNameBytes) {
    fail("spec", `matchName is ${byteLen(matchName)} bytes, max ${LIMITS.matchNameBytes}`);
  }
  if (!Array.isArray(spec.controls)) fail("spec", "controls must be an array");
  const layerSize = spec.layerSize ?? [1920, 1080];
  if (!Array.isArray(layerSize) || layerSize.length !== 2 || layerSize.some((v) => !Number.isInteger(v) || v < 1 || v > 30000)) {
    fail("spec", "layerSize must be [width, height], integers 1..30000");
  }

  const out = [];
  const walk = (controls, trail) => {
    controls.forEach((c, i) => {
      const where = `${trail}[${i}]${c && c.name ? ` "${c.name}"` : ""}`;
      out.push(...normalise(c, where));
      if (c.type === "group") walk(c.controls ?? [], `${where}.controls`);
      if (c.type === "group") out.push({ type: "groupEnd", name: "" });
    });
  };
  walk(spec.controls, "controls");

  const real = out.filter((c) => c.type !== "groupEnd");
  if (out.length > LIMITS.maxControls) {
    fail("spec", `${out.length} parameters (group ends count), max ${LIMITS.maxControls}`);
  }
  if (real.length === 0) fail("spec", "no controls");
  return { name, matchName, layerSize, params: out };
}

function normalise(c, where) {
  if (!c || typeof c !== "object") fail(where, "control must be an object");
  const type = c.type;
  const name = String(c.name ?? "");
  if (byteLen(name) > LIMITS.controlNameBytes) {
    fail(where, `name is ${byteLen(name)} bytes, max ${LIMITS.controlNameBytes}`);
  }
  if (type !== "label" && !name) fail(where, "missing name");
  const base = {
    type,
    name,
    invisible: Boolean(c.invisible),
    noKeyframes: c.keyframes === false,
    disabled: Boolean(c.disabled),
  };

  switch (type) {
    case "slider": {
      const validMin = num(c.validMin, -1000000, where, "validMin");
      const validMax = num(c.validMax, 1000000, where, "validMax");
      const sliderMin = num(c.sliderMin, validMin, where, "sliderMin");
      const sliderMax = num(c.sliderMax, validMax, where, "sliderMax");
      const def = num(c.default, 0, where, "default");
      const precision = num(c.precision, 1, where, "precision");
      if (!(validMin <= sliderMin && sliderMin <= sliderMax && sliderMax <= validMax)) {
        fail(where, "need validMin <= sliderMin <= sliderMax <= validMax");
      }
      if (def < validMin || def > validMax) fail(where, "default outside validMin..validMax");
      if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
        fail(where, "precision must be an integer 0..6");
      }
      const display = c.display ?? "number";
      if (!["number", "percent", "pixel"].includes(display)) {
        fail(where, 'display must be "number", "percent" or "pixel"');
      }
      return [{ ...base, default: def, validMin, validMax, sliderMin, sliderMax, precision, display }];
    }
    case "angle": {
      const def = num(c.default, 0, where, "default");
      if (Math.abs(def) > FIXED_MAX) fail(where, `default must be within -${FIXED_MAX}..${FIXED_MAX} degrees`);
      return [{ ...base, default: def }];
    }
    case "checkbox":
      return [{ ...base, default: Boolean(c.default) }];
    case "color": {
      const rgb = c.default ?? [255, 255, 255];
      if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((v) => !(v >= 0 && v <= 255))) {
        fail(where, "default must be [r, g, b] with 0..255 values");
      }
      return [{ ...base, default: rgb.map((v) => Math.round(v)) }];
    }
    case "point": {
      const msg = "default must be [x, y] (fractions of the layer)";
      const xy = numbers(c.default ?? [0.5, 0.5], 2, where, msg);
      // pard stores x*100 and y*100 as 16.16 fixed.
      if (xy.some((v) => Math.abs(v * 100) > FIXED_MAX)) fail(where, `default fractions must be within -327..327`);
      return [{ ...base, default: xy }];
    }
    case "point3d": {
      const xyz = numbers(c.default ?? [0.5, 0.5, 0.5], 3, where, "default must be [x, y, z] (fractions of the layer)");
      return [{ ...base, default: xyz }];
    }
    case "popup": {
      const options = c.options;
      if (!Array.isArray(options) || options.length < 1) fail(where, "options must be a non-empty array");
      if (options.some((o) => typeof o !== "string" || o.includes("|"))) {
        fail(where, 'options must be strings without "|"');
      }
      const def = num(c.default, 1, where, "default");
      if (!Number.isInteger(def) || def < 1 || def > options.length) {
        fail(where, `default must be a 1-based index 1..${options.length}`);
      }
      return [{ ...base, options, default: def }];
    }
    case "layer":
      return [{ ...base, noKeyframes: true }];
    case "group":
      if (c.controls !== undefined && !Array.isArray(c.controls)) fail(where, "controls must be an array");
      return [{ ...base, noKeyframes: true }];
    case "label":
      // Pseudo Effect Maker's label: an empty group. "dim" greys it out.
      return [
        { ...base, type: "group", noKeyframes: true, disabled: Boolean(c.dim ?? c.disabled) },
        { type: "groupEnd", name: "" },
      ];
    default:
      fail(where, `unknown type "${type}"`);
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const KIND_TO_PARAM = {
  layer: PARAM.LAYER,
  angle: PARAM.ANGLE,
  checkbox: PARAM.CHECKBOX,
  color: PARAM.COLOR,
  point: PARAM.POINT,
  popup: PARAM.POPUP,
  slider: PARAM.SLIDER,
  group: PARAM.GROUP_START,
  groupEnd: PARAM.GROUP_END,
  point3d: PARAM.POINT_3D,
};

function pard(c) {
  const b = Buffer.alloc(148);
  let ui = 0;
  if (c.invisible) ui |= UI_INVISIBLE;
  if (c.disabled) ui |= UI_DISABLED;
  if (c.type === "groupEnd") ui |= UI_NO_ECW_UI;
  b.writeUInt32BE(ui, 4);
  b.writeUInt32BE(KIND_TO_PARAM[c.type], 12);
  Buffer.from(c.name, "utf8").copy(b, 16);
  const groupish = c.type === "group" || c.type === "groupEnd";
  if (c.noKeyframes || groupish || c.type === "layer") b.writeUInt32BE(FLAG_CANNOT_TIME_VARY, 48);

  switch (c.type) {
    case "layer":
      b.writeUInt32BE(0xffffffff, 128);
      break;
    case "angle":
      fixed16(c.default).copy(b, 56);
      fixed16(c.default).copy(b, 60);
      b.writeInt32BE(-30000, 64);
      b.writeInt32BE(30000, 68);
      break;
    case "color": {
      const argb = Buffer.from([255, ...c.default]);
      argb.copy(b, 56);
      argb.copy(b, 60);
      break;
    }
    case "point": {
      const [x, y] = c.default;
      fixed16(x).copy(b, 56);
      fixed16(y).copy(b, 60);
      fixed16(x * 100).copy(b, 68);
      fixed16(y * 100).copy(b, 72);
      break;
    }
    case "point3d":
      c.default.forEach((v, i) => {
        b.writeDoubleBE(v * 65536, 56 + 8 * i);
        b.writeDoubleBE(v * 100 * 65536, 80 + 8 * i);
      });
      break;
    case "checkbox":
      if (c.default) {
        b.writeUInt32BE(1, 56);
        b[60] = 1;
      }
      break;
    case "popup":
      b.writeUInt32BE(c.default, 56);
      b.writeUInt16BE(c.options.length, 60);
      b.writeUInt16BE(c.default, 62);
      break;
    case "slider":
      b.writeDoubleBE(c.default, 56);
      b.writeFloatBE(c.validMin, 104);
      b.writeFloatBE(c.validMax, 108);
      b.writeFloatBE(c.sliderMin, 112);
      b.writeFloatBE(c.sliderMax, 116);
      b.writeFloatBE(c.default, 120);
      b.writeUInt16BE(c.precision, 124);
      b.writeUInt16BE({ number: 0, percent: 1, pixel: 2 }[c.display], 126);
      break;
  }
  return chunk("pard", b);
}

function rootPard() {
  const b = Buffer.alloc(148);
  b.writeUInt32BE(FLAG_CANNOT_TIME_VARY, 48);
  b.writeUInt32BE(0xffffffff, 128);
  return chunk("pard", b);
}

function builtInPard() {
  const b = Buffer.alloc(148);
  b.writeUInt32BE(PARAM.NO_DATA, 12);
  return chunk("pard", b);
}

function tdbs(c) {
  const parts = [
    chunk("tdsb", u32(c.invisible ? 3 : 1)),
    chunk("tdsn", utf8(c.name)),
  ];
  switch (c.type) {
    case "slider":
      parts.push(
        chunk("tdb4", tdb4("slider")),
        cdat("slider", [c.default]),
        chunk("tdum", f64(toF32(c.sliderMin))),
        chunk("tduM", f64(toF32(c.sliderMax))),
      );
      break;
    case "angle":
      parts.push(chunk("tdb4", tdb4("angle")), cdat("angle", [c.default]));
      break;
    case "checkbox":
      parts.push(chunk("tdb4", tdb4("checkbox")), cdat("checkbox", [c.default ? 1 : 0]));
      break;
    case "popup":
      parts.push(chunk("tdb4", tdb4("popup")), cdat("popup", [c.default]));
      break;
    case "color":
      parts.push(chunk("tdb4", tdb4("color")), cdat("color", [255, ...c.default]));
      break;
    case "point":
      parts.push(chunk("tdb4", tdb4("point")), cdat("point", c.default));
      break;
    case "point3d":
      parts.push(chunk("tdb4", tdb4("point3d")), cdat("point3d", c.default));
      break;
    case "layer":
      // tdpi = id of the layer the control points to. 0 = None.
      parts.push(chunk("tdb4", tdb4("layer")), cdat("layer", []), chunk("tdpi", u32(0)), chunk("tdps", u32(0)));
      break;
    default: // group, groupEnd
      parts.push(chunk("tdb4", tdb4("group")), cdat("group", []));
  }
  return list("tdbs", parts);
}

function rootTdbs() {
  return list("tdbs", [
    chunk("tdsb", u32(3)),
    chunk("tdsn", utf8("")),
    chunk("tdb4", tdb4("layer")),
    cdat("layer", []),
    chunk("tdpi", u32(0)),
    chunk("tdps", u32(0)),
  ]);
}

// "ADBE Effect Built In Params": the Compositing Options group every effect carries.
function builtInTdgp() {
  const unnamed = "-_0_/-";
  return list("tdgp", [
    chunk("tdsb", u32(1)),
    chunk("tdsn", utf8("Compositing Options")),
    tdmn("ADBE Effect Mask Parade"),
    list("tdgp", [chunk("tdsb", u32(1)), chunk("tdsn", utf8(unnamed)), tdmn("ADBE Group End")]),
    tdmn("ADBE Effect Mask Opacity"),
    list("tdbs", [
      chunk("tdsb", u32(1)),
      chunk("tdsn", utf8(unnamed)),
      chunk("tdb4", tdb4("slider")),
      cdat("slider", [100]),
      chunk("tdum", f64(0)),
      chunk("tduM", f64(100)),
    ]),
    tdmn("ADBE Force CPU GPU"),
    list("tdbs", [
      chunk("tdsb", u32(1)),
      chunk("tdsn", utf8(unnamed)),
      chunk("tdb4", tdb4("gpu")),
      cdat("checkbox", [1]),
    ]),
    tdmn("ADBE Group End"),
  ]);
}

export function buildFfx(spec) {
  const { name, matchName, layerSize, params } = flatten(spec);
  const paramMatch = (i) => `${matchName}-${String(i).padStart(4, "0")}`;

  const parT = [chunk("parn", u32(params.length + 2)), tdmn(paramMatch(0)), rootPard()];
  params.forEach((c, i) => {
    parT.push(tdmn(paramMatch(i + 1)), pard(c));
    if (c.type === "popup") parT.push(chunk("pdnm", utf8(c.options.join("|"))));
    if (c.type === "checkbox") parT.push(chunk("pdnm", utf8("")));
  });
  parT.push(tdmn("ADBE Effect Built In Params"), builtInPard());

  const tdgp = [chunk("tdsb", u32(1)), chunk("tdsn", utf8(name)), tdmn(paramMatch(0)), rootTdbs()];
  params.forEach((c, i) => tdgp.push(tdmn(paramMatch(i + 1)), tdbs(c)));
  tdgp.push(tdmn("ADBE Effect Built In Params"), builtInTdgp(), tdmn("ADBE Group End"));

  const tdsi = (index, mn) => list("tdsi", [chunk("tdix", index), tdmn(mn)]);
  const besc = list("besc", [
    chunk("beso", beso(layerSize)),
    list("tdsp", [
      chunk("tdot", u32(0xffffffff)),
      chunk("tdpl", u32(2)),
      tdsi(u32(0xffffffff), "ADBE Effect Parade"),
      tdsi(u32(0), matchName),
    ]),
    chunk("tdsn", utf8(name)),
    list("tdsp", [
      chunk("tdot", u32(0xffffffff)),
      chunk("tdpl", u32(1)),
      tdsi(u32(0xffffffff), "ADBE End of path sentinel"),
    ]),
    list("sspc", [
      chunk("fnam", utf8(name)),
      list("parT", parT),
      list("tdgp", tdgp),
      chunk("pgui", Buffer.alloc(16)),
      chunk("elab", Buffer.from([0xff])),
    ]),
  ]);

  const payload = Buffer.concat([Buffer.from("FaFX"), chunk("head", HEAD), besc]);
  return Buffer.concat([Buffer.from("RIFX"), u32(payload.length), payload]);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export function rifxPayload(buf) {
  if (buf.toString("latin1", 0, 4) !== "RIFX" || buf.toString("latin1", 8, 12) !== "FaFX") {
    throw new Error("not an .ffx file (expected RIFX/FaFX)");
  }
  return buf.subarray(0, 8 + buf.readUInt32BE(4));
}

function* chunks(buf, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const tag = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    yield tag === "LIST"
      ? { tag, kind: body.toString("latin1", 0, 4), body: body.subarray(4) }
      : { tag, body };
    off += 8 + size + (size & 1);
  }
}

const children = (body) => [...chunks(body, 0, body.length)];

// Strings are either "Utf8"+len+bytes (AE) or raw NUL-terminated (Pseudo Effect Maker).
function readString(body) {
  if (body.length >= 8 && body.toString("latin1", 0, 4) === "Utf8") {
    return body.toString("utf8", 8, 8 + body.readUInt32BE(4));
  }
  const nul = body.indexOf(0);
  return body.toString("utf8", 0, nul < 0 ? body.length : nul);
}

const readFixed = (b, o) => b.readInt32BE(o) / 65536;
const round = (v, d = 6) => Number(v.toFixed(d));

function findList(items, kind) {
  for (const it of items) {
    if (it.tag !== "LIST") continue;
    if (it.kind === kind) return it;
    const inner = findList(children(it.body), kind);
    if (inner) return inner;
  }
  return null;
}

// Returns one entry per pseudo effect found in the file.
export function decodeFfx(buf) {
  const payload = rifxPayload(buf);
  const top = children(payload.subarray(12));
  const effects = [];
  let layerSize = [1920, 1080];
  const visit = (items) => {
    for (const it of items) {
      if (it.tag === "beso" && it.body.length >= 32) layerSize = [it.body.readUInt16BE(28), it.body.readUInt16BE(30)];
      if (it.tag !== "LIST") continue;
      if (it.kind === "sspc") effects.push(decodeEffect(children(it.body), layerSize));
      else visit(children(it.body));
    }
  };
  visit(top);
  return effects;
}

function decodeEffect(sspc, layerSize) {
  const parT = children(findList(sspc, "parT").body);
  const tdgp = children(findList(sspc, "tdgp").body);
  const fnam = sspc.find((c) => c.tag === "fnam");

  // Display name and current values, keyed by parameter matchname.
  const values = new Map();
  let effectName = fnam ? readString(fnam.body) : "";
  let lastMn = null;
  for (const it of tdgp) {
    if (it.tag === "tdsn" && !lastMn && !effectName) effectName = readString(it.body);
    if (it.tag === "tdmn") lastMn = readString(it.body);
    if (it.tag === "LIST" && it.kind === "tdbs" && lastMn) values.set(lastMn, children(it.body));
  }

  const flat = [];
  let mn = null;
  for (const it of parT) {
    if (it.tag === "tdmn") mn = readString(it.body);
    else if (it.tag === "pard") flat.push({ mn, pard: it.body, pdnm: null });
    else if (it.tag === "pdnm" && flat.length) flat[flat.length - 1].pdnm = readString(it.body);
  }

  const first = flat[0]?.mn ?? "";
  const matchName = first.replace(/-0000$/, "");
  const effect = { name: effectName, matchName, layerSize, controls: [] };
  const stack = [effect.controls];
  const warnings = [];

  for (const p of flat.slice(1)) {
    if (!p.mn.startsWith(matchName + "-")) continue; // built-in params
    const b = p.pard;
    const type = b.readUInt32BE(12);
    const ui = b.readUInt32BE(4);
    const flags = b.readUInt32BE(48);
    const name = readString(b.subarray(16, 48));
    const c = { type: "", name };
    const vals = values.get(p.mn) ?? [];
    const cd = vals.find((v) => v.tag === "cdat")?.body;
    if (ui & UI_INVISIBLE) c.invisible = true;
    const animatable = ![PARAM.LAYER, PARAM.GROUP_START, PARAM.GROUP_END].includes(type);
    if (animatable && flags & FLAG_CANNOT_TIME_VARY) c.keyframes = false;

    switch (type) {
      case PARAM.SLIDER: {
        const disp = b.readUInt16BE(126);
        Object.assign(c, {
          type: "slider",
          default: round(cd ? cd.readDoubleBE(0) : b.readFloatBE(120)),
          validMin: round(b.readFloatBE(104)),
          validMax: round(b.readFloatBE(108)),
          sliderMin: round(b.readFloatBE(112)),
          sliderMax: round(b.readFloatBE(116)),
          precision: b.readUInt16BE(124),
        });
        if (disp === 1) c.display = "percent";
        if (disp === 2) c.display = "pixel";
        break;
      }
      case PARAM.ANGLE:
        Object.assign(c, { type: "angle", default: round(cd ? cd.readDoubleBE(0) : readFixed(b, 60)) });
        break;
      case PARAM.CHECKBOX:
        Object.assign(c, { type: "checkbox", default: cd ? cd.readDoubleBE(0) !== 0 : b[60] === 1 });
        break;
      case PARAM.COLOR: {
        const rgb = cd ? [1, 2, 3].map((i) => Math.round(cd.readDoubleBE(i * 8))) : [...b.subarray(61, 64)];
        Object.assign(c, { type: "color", default: rgb });
        break;
      }
      case PARAM.POINT: {
        const xy = cd ? [cd.readDoubleBE(0), cd.readDoubleBE(8)] : [readFixed(b, 56), readFixed(b, 60)];
        Object.assign(c, { type: "point", default: xy.map((v) => round(v)) });
        break;
      }
      case PARAM.POINT_3D: {
        const xyz = [0, 1, 2].map((i) => round(cd ? cd.readDoubleBE(i * 8) : b.readDoubleBE(56 + i * 8) / 65536));
        Object.assign(c, { type: "point3d", default: xyz });
        break;
      }
      case PARAM.POPUP: {
        const options = (p.pdnm ?? "").split("|");
        const def = cd ? Math.round(cd.readDoubleBE(0)) : b.readUInt16BE(62);
        Object.assign(c, { type: "popup", options, default: def });
        break;
      }
      case PARAM.LAYER:
        c.type = "layer";
        break;
      case PARAM.GROUP_START: {
        c.type = "group";
        if (ui & UI_DISABLED) c.disabled = true;
        c.controls = [];
        stack[stack.length - 1].push(c);
        stack.push(c.controls);
        continue;
      }
      case PARAM.GROUP_END:
        if (stack.length > 1) stack.pop();
        else warnings.push(`unbalanced group end at ${p.mn}`);
        continue;
      default:
        warnings.push(`${p.mn}: unsupported param type ${type}, skipped`);
        continue;
    }
    stack[stack.length - 1].push(c);
  }

  // Empty groups are Pseudo Effect Maker labels.
  const toLabels = (controls) =>
    controls.map((c) => {
      if (c.type !== "group") return c;
      if (c.controls.length === 0) {
        const label = { type: "label", name: c.name };
        if (c.disabled) label.dim = true;
        if (c.invisible) label.invisible = true;
        return label;
      }
      return { ...c, controls: toLabels(c.controls) };
    });
  effect.controls = toLabels(effect.controls);
  if (warnings.length) effect.warnings = warnings;
  return effect;
}

// ---------------------------------------------------------------------------
// Debug output
// ---------------------------------------------------------------------------

export function dumpFfx(buf) {
  const payload = rifxPayload(buf);
  const lines = [`RIFX FaFX payload=${payload.length} bytes file=${buf.length} bytes`];
  if (buf.length > payload.length) {
    const tail = buf.subarray(payload.length);
    const kind = tail.subarray(0, 9).toString("latin1") === "<?xpacket" ? "XMP packet" : "trailer";
    lines.push(`(${tail.length} byte ${kind} after the RIFX payload)`);
  }
  const textTags = new Set(["tdmn", "tdsn", "fnam", "pdnm"]);
  const walk = (body, depth) => {
    for (const it of chunks(body, 0, body.length)) {
      const pad = "  ".repeat(depth);
      if (it.tag === "LIST") {
        lines.push(`${pad}LIST ${it.kind}`);
        walk(it.body, depth + 1);
      } else if (textTags.has(it.tag)) {
        lines.push(`${pad}${it.tag} ${JSON.stringify(readString(it.body))}`);
      } else if (it.tag === "pard") {
        const t = it.body.readUInt32BE(12);
        const n = readString(it.body.subarray(16, 48));
        lines.push(`${pad}pard type=${t} ui=0x${it.body.readUInt32BE(4).toString(16)} flags=0x${it.body.readUInt32BE(48).toString(16)} name=${JSON.stringify(n)}`);
      } else {
        const h = it.body.toString("hex");
        lines.push(`${pad}${it.tag} (${it.body.length}) ${h.length > 64 ? h.slice(0, 64) + "..." : h}`);
      }
    }
  };
  walk(payload.subarray(12), 1);
  return lines.join("\n");
}

export function diffFfx(a, b, max = 20) {
  const pa = rifxPayload(a);
  const pb = rifxPayload(b);
  const out = [];
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n && out.length < max; i++) {
    if (pa[i] !== pb[i]) {
      const from = Math.max(0, i - 8);
      out.push(`0x${i.toString(16).padStart(6, "0")}: ${pa.subarray(from, i + 8).toString("hex")} | ${pb.subarray(from, i + 8).toString("hex")}`);
    }
  }
  if (pa.length !== pb.length) out.push(`length ${pa.length} vs ${pb.length}`);
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const [cmd, a, b] = argv.filter((x) => !x.startsWith("--"));
  const read = (p) => fs.readFileSync(p);
  switch (cmd) {
    case "build": {
      if (!a || !b) return usage();
      const spec = JSON.parse(fs.readFileSync(a, "utf8"));
      const data = buildFfx(spec);
      fs.mkdirSync(path.dirname(path.resolve(b)), { recursive: true });
      fs.writeFileSync(b, data);
      const { params } = flatten(spec);
      console.log(`wrote ${b}: "${spec.name}" (${spec.matchName}), ${params.length} params, ${data.length} bytes`);
      return 0;
    }
    case "decode": {
      if (!a) return usage();
      const all = decodeFfx(read(a));
      const effects = argv.includes("--all") ? all : all.filter((e) => e.matchName.startsWith("Pseudo/"));
      if (all.length === 0) throw new Error("this preset embeds no effect definitions (no sspc chunk)");
      if (effects.length === 0) {
        throw new Error(`no Pseudo/ effect found; embedded effects: ${all.map((e) => e.matchName).join(", ")} (use --all)`);
      }
      const json = JSON.stringify(effects.length === 1 ? effects[0] : effects, null, 2) + "\n";
      if (b) fs.writeFileSync(b, json);
      else process.stdout.write(json);
      return 0;
    }
    case "dump":
      if (!a) return usage();
      console.log(dumpFfx(read(a)));
      return 0;
    case "diff": {
      if (!a || !b) return usage();
      const d = diffFfx(read(a), read(b));
      console.log(d.length ? d.join("\n") : "identical RIFX payloads");
      return d.length ? 2 : 0;
    }
    default:
      return usage();
  }
}

function usage() {
  console.error("usage: ffx.mjs build <spec.json> <out.ffx> | decode <in.ffx> [out.json] [--all] | dump <in.ffx> | diff <a.ffx> <b.ffx>");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
