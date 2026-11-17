// Offline tests for scripts/ffx.mjs. Run: node tests/run.mjs
// Optional: FFX_REFERENCE=/path/to/ae-saved.ffx also checks a byte-level rebuild of an
// AE-saved pseudo effect preset (only comp-specific stamps may differ).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFfx, decodeFfx, flatten, rifxPayload } from "../scripts/ffx.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examples = fs.readdirSync(path.join(root, "examples")).filter((f) => f.endsWith(".json"));
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

// Walk every chunk, check sizes and padding, collect tags.
function walk(buf, start, end, seen) {
  let off = start;
  while (off < end) {
    assert.ok(off + 8 <= end, `truncated chunk header at ${off}`);
    const tag = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    assert.ok(off + 8 + size <= end, `${tag} at ${off} overruns its parent`);
    seen.push({ tag, size, off });
    if (tag === "LIST") walk(buf, off + 12, off + 8 + size, seen);
    off += 8 + size + (size & 1);
  }
  assert.equal(off, end, "chunk list does not end on its parent boundary");
}

for (const file of examples) {
  const spec = JSON.parse(fs.readFileSync(path.join(root, "examples", file), "utf8"));

  test(`${file}: RIFX structure is consistent`, () => {
    const buf = buildFfx(spec);
    assert.equal(buf.toString("latin1", 0, 4), "RIFX");
    assert.equal(buf.toString("latin1", 8, 12), "FaFX");
    assert.equal(buf.readUInt32BE(4), buf.length - 8);
    const seen = [];
    walk(buf, 12, buf.length, seen);
    const sizes = (tag) => [...new Set(seen.filter((c) => c.tag === tag).map((c) => c.size))];
    assert.deepEqual(sizes("pard"), [148]);
    assert.deepEqual(sizes("tdb4"), [124]);
    assert.deepEqual(sizes("tdmn"), [40]);
    const { params } = flatten(spec);
    const parn = seen.find((c) => c.tag === "parn");
    assert.equal(buf.readUInt32BE(parn.off + 8), params.length + 2, "parn = params + root + built-in");
  });

  test(`${file}: decode(build(spec)) matches the normalised spec`, () => {
    const [effect] = decodeFfx(buildFfx(spec));
    assert.equal(effect.name, spec.name);
    assert.equal(effect.matchName, spec.matchName);
    // Rebuilding the decoded spec must give identical bytes.
    assert.deepEqual(buildFfx(effect), buildFfx(spec));
    assert.deepEqual(flatten(effect).params, flatten(spec).params);
  });
}

const base = { name: "T", matchName: "Pseudo/TEST_T_v1", controls: [{ type: "slider", name: "A" }] };
const bad = (patch, re) => () => assert.throws(() => buildFfx({ ...base, ...patch }), re);

test("rejects matchName without Pseudo/ prefix", bad({ matchName: "My Effect" }, /Pseudo\//));
test("rejects matchName over 34 bytes", bad({ matchName: "Pseudo/" + "x".repeat(28) }, /max 34/));
test("rejects non-ASCII matchName", bad({ matchName: "Pseudo/é" }, /ASCII/));
test("rejects control name over 31 bytes", bad({ controls: [{ type: "slider", name: "x".repeat(32) }] }, /max 31/));
test("rejects unknown control type", bad({ controls: [{ type: "text", name: "A" }] }, /unknown type/));
test("rejects popup default out of range", bad({ controls: [{ type: "popup", name: "P", options: ["a", "b"], default: 3 }] }, /1-based/));
test("rejects popup option containing |", bad({ controls: [{ type: "popup", name: "P", options: ["a|b"] }] }, /without/));
test("rejects slider range out of order", bad({ controls: [{ type: "slider", name: "S", validMin: 0, validMax: 10, sliderMin: 5, sliderMax: 20 }] }, /validMin/));
test("rejects non-numeric slider default", bad({ controls: [{ type: "slider", name: "S", default: "abc" }] }, /must be a number/));
test("rejects non-numeric angle default", bad({ controls: [{ type: "angle", name: "A", default: "x" }] }, /must be a number/));
test("rejects angle beyond 16.16 fixed range", bad({ controls: [{ type: "angle", name: "A", default: 40000 }] }, /degrees/));
test("rejects non-numeric point values", bad({ controls: [{ type: "point", name: "P", default: ["a", 1] }] }, /\[x, y\]/));
test("rejects non-numeric point3d values", bad({ controls: [{ type: "point3d", name: "P", default: [0, null, 1] }] }, /\[x, y, z\]/));
test("rejects more than 254 parameters", () => {
  const controls = Array.from({ length: 255 }, (_, i) => ({ type: "checkbox", name: `C${i}` }));
  assert.throws(() => buildFfx({ ...base, controls }), /max 254/);
});

test("point values are fractions of layerSize (written to beso bytes 28..31)", () => {
  const buf = buildFfx({ ...base, layerSize: [1000, 500], controls: [{ type: "point", name: "P", default: [0.25, 0.75] }] });
  const i = buf.indexOf("beso") + 8;
  assert.deepEqual([buf.readUInt16BE(i + 28), buf.readUInt16BE(i + 30)], [1000, 500]);
  const [effect] = decodeFfx(buf);
  assert.deepEqual(effect.layerSize, [1000, 500]);
  assert.deepEqual(effect.controls[0].default, [0.25, 0.75]);
});

test("labels become empty groups and decode back as labels", () => {
  const [effect] = decodeFfx(buildFfx({ ...base, controls: [{ type: "label", name: "L", dim: true }, ...base.controls] }));
  assert.deepEqual(effect.controls[0], { type: "label", name: "L", dim: true });
});

if (process.env.FFX_REFERENCE) {
  test(`rebuild of ${path.basename(process.env.FFX_REFERENCE)} differs only in comp stamps`, () => {
    const ref = rifxPayload(fs.readFileSync(process.env.FFX_REFERENCE));
    const [effect] = decodeFfx(ref).filter((e) => e.matchName.startsWith("Pseudo/"));
    const ours = rifxPayload(buildFfx(effect));
    assert.equal(ours.length, ref.length, "payload length");
    // Comp-specific stamps: beso body, tdb4 timebase (bytes 12..15), tdpi layer id.
    const seen = [];
    walk(ref, 12, ref.length, seen);
    const stamp = new Set();
    const mark = (from, len) => { for (let i = 0; i < len; i++) stamp.add(from + i); };
    for (const c of seen) {
      if (c.tag === "beso") mark(c.off + 8, c.size);
      if (c.tag === "tdb4") mark(c.off + 8 + 12, 4);
      if (c.tag === "tdpi") mark(c.off + 8, 4);
      // AE's own saves can hold a 3D Point value (cdat) that disagrees with its
      // definition default (pard). We decode the value, so the pard can differ.
      if (c.tag === "pard" && ref.readUInt32BE(c.off + 8 + 12) === 18) mark(c.off + 8, c.size);
    }
    const unexpected = [];
    for (let i = 0; i < ref.length; i++) if (ours[i] !== ref[i] && !stamp.has(i)) unexpected.push(i);
    assert.deepEqual(unexpected.slice(0, 10), [], `${unexpected.length} unexpected byte differences`);
  });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exitCode = failed ? 1 : 0;
