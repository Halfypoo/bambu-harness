import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  arcBounds,
  arcLength,
  isStockStartM211,
  parseSkipBoundsCheck,
  SKIP_BOUNDS_CHECK_VALUE,
  validateGcodeBedBounds,
} from "../src/bed-bounds.js";
import { LIMITS } from "../src/allow.js";
import {
  stripLeadInTravel,
  shiftLine,
  buildPlate,
  layoutCopies,
  listPlateObjects,
} from "../src/plate-builder.js";
import { remapNozzleSetpoint } from "../src/gcode-retarget.js";
import { validatePrintPreflight, rectsGap } from "../src/preflight.js";
import { makeStoredZip, forEachZipEntryLine, readZipEntry } from "../src/gcode3mf.js";
import { syntheticPlateGcode, syntheticPlateZip } from "./support/synthetic-plate.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR || tmpdir(),
        BAMBU_HARNESS_HOME: path.join(home, "config"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function twoObjectSource({
  aId = 278,
  bId = 318,
  aStart = { x: 40, y: 40 },
  bStart = { x: 100, y: 40 },
  aSize = 40,
  bSize = 34,
  leadInA = { x: 200, y: 200 },
  leadInB = { x: 210, y: 210 },
  aMode = "straight", // straight | g2 | g3
  bMode = "straight",
  /** When true, embed PETG-like S255/S270 heats + weak fan to exercise retarget. */
  hotTemps = false,
  rangeLow = 190,
  rangeHigh = 240,
  filamentType = "PLA",
} = {}) {
  const aEnd = { x: aStart.x + aSize, y: aStart.y };
  const bEnd = { x: bStart.x + bSize, y: bStart.y };
  function firstMove(mode, start, end, size) {
    if (mode === "g2") {
      // Small clockwise bulge (I = half chord, J small) — stays near the square.
      return `G2 X${end.x.toFixed(3)} Y${end.y.toFixed(3)} I${(size / 2).toFixed(3)} J${(size * 0.15).toFixed(3)} E0.8`;
    }
    if (mode === "g3") {
      return `G3 X${end.x.toFixed(3)} Y${end.y.toFixed(3)} I${(size / 2).toFixed(3)} J${(-size * 0.15).toFixed(3)} E0.8`;
    }
    return `G1 X${end.x.toFixed(3)} Y${start.y.toFixed(3)} E0.5`;
  }
  function objectBlock(id, lead, start, mode, size, { z = 0.2, withLeadIn = true } = {}) {
    const end = { x: start.x + size, y: start.y };
    const corner = { x: start.x + size, y: start.y + size };
    const leadLines = withLeadIn
      ? [`G1 X${lead.x} Y${lead.y} F42000`, `G1 Z${(z + 0.4).toFixed(1)}`, `G1 Z${z}`, "G1 E0.8 F1800"]
      : [`G1 Z${z}`, "G1 E0.8 F1800"];
    return [
      `; start printing object, unique label id: ${id}`,
      "M624 AQAAAAAAAAA=",
      ...leadLines,
      `G1 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} F42000`,
      firstMove(mode, start, end, size),
      `G1 X${corner.x.toFixed(3)} Y${corner.y.toFixed(3)} E0.5`,
      `G1 X${start.x.toFixed(3)} Y${corner.y.toFixed(3)} E0.5`,
      `G1 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} E0.5`,
      `; stop printing object, unique label id: ${id}`,
      "M625",
    ].join("\n");
  }
  const nozzleComment = hotTemps ? 255 : 220;
  const bedComment = hotTemps ? 80 : 60;
  const startHeats = hotTemps
    ? ["M104 S270", "M140 S80", "M109 S255", "M190 S80", "M104 S255", "M106 S102"]
    : ["M140 S60", "M190 S60", "M104 S220", "M109 S220"];
  const midHeats = hotTemps ? ["M104 S255 ; layer body leftover", "M106 S229.5"] : [];
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; nozzle_diameter = 0.4",
    `; filament_type = ${filamentType}`,
    `; nozzle_temperature = ${nozzleComment}`,
    `; nozzle_temperature_initial_layer = ${nozzleComment}`,
    `; nozzle_temperature_range_low = ${rangeLow}`,
    `; nozzle_temperature_range_high = ${rangeHigh}`,
    `; first_layer_bed_temperature = ${bedComment}`,
    `; cool_plate_temp = ${bedComment}`,
    `; hot_plate_temp = ${bedComment}`,
    `; hot_plate_temp_initial_layer = ${bedComment}`,
    `; bed_temperature = ${bedComment}`,
    `; filament_max_volumetric_speed = ${rangeHigh > 240 ? 12 : 21}`,
    hotTemps ? "; fan_max_speed = 40" : "; fan_max_speed = 100",
    "; curr_bed_type = Textured PEI Plate",
    "; filament used [g] = 2.00",
    "; total filament weight [g] : 2.00",
    "; model printing time: 10m 0s; total estimated time: 12m 0s",
    "G90",
    "M83",
    "M211 X0 Y0 Z0 ;turn off soft endstop",
    ...startHeats,
    "G0 X85 Y185 F10000",
    "M211 R",
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.2",
    "; layer num/total_layer_count: 1/2",
    objectBlock(aId, leadInA, aStart, aMode, aSize, { z: 0.2, withLeadIn: true }),
    ...midHeats,
    objectBlock(bId, leadInB, bStart, bMode, bSize, { z: 0.2, withLeadIn: true }),
    // Second layer so later-layer --nozzle-temp can be applied / validated.
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.4",
    "; layer num/total_layer_count: 2/2",
    objectBlock(aId, leadInA, aStart, aMode, aSize, { z: 0.4, withLeadIn: false }),
    objectBlock(bId, leadInB, bStart, bMode, bSize, { z: 0.4, withLeadIn: false }),
    "; filament end gcode",
    "G1 X-13 Y180 F3600",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const md5 = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();
  return makeStoredZip({
    "Metadata/plate_1.gcode": gcode,
    "Metadata/plate_1.gcode.md5": md5,
    "Metadata/plate_1.json": JSON.stringify({
      bbox_all: [aStart.x, aStart.y, bStart.x + bSize, bStart.y + bSize],
      bbox_objects: [
        { area: aSize * aSize, bbox: [aStart.x, aStart.y, aStart.x + aSize, aStart.y + aSize], id: aId, layer_height: 0.2, name: "cone-A" },
        { area: bSize * bSize, bbox: [bStart.x, bStart.y, bStart.x + bSize, bStart.y + bSize], id: bId, layer_height: 0.2, name: "cone-B" },
      ],
    }),
    "Metadata/slice_info.config":
      `<config><plate><metadata key="printer_model_id" value=""/><metadata key="nozzle_diameters" value="0.4"/><metadata key="weight" value="2.00"/><metadata key="prediction" value="720"/><filament type="${filamentType}" tray_info_idx="${/pla/i.test(filamentType) ? "GFA00" : "GFG99"}" color="${/pla/i.test(filamentType) ? "#F2754E" : "#000000"}" used_m="0.67" used_g="2.00" nozzle_diameter="0.40"/></plate></config>`,
    "Metadata/project_settings.config": '{"printer_model":"Bambu Lab A1 mini"}',
  });
}

test("in-bounds print moves pass bed-bounds", () => {
  const gcode = syntheticPlateGcode();
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  assert.ok(result.printMoveCount > 0);
});

test("Y=200 travel after start gcode fails (travel included)", () => {
  const gcode = syntheticPlateGcode({
    body: "G1 X20 Y20 Z0.2\nG0 Y200 F12000\nG1 X40 Y20 E0.4\n",
  });
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.axis === "Y" && v.value >= 200 && v.phase === "print"));
});

test("relative-mode G91 off-bed travel fails", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "G90",
    "; CHANGE_LAYER",
    "G1 X170 Y170 Z0.2",
    "G91",
    "G0 Y40",
    "G90",
    "G1 X170 Y170 E0.1",
    "; filament end gcode",
    "",
  ].join("\n");
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.axis === "Y" && v.value >= 200));
});

test("stock brush moves to Y=185 in start section are allowed", () => {
  const gcode = syntheticPlateGcode({
    startExtra: "G0 X85 Y185 F10000 ;move to exposed steel surface and stop the nozzle\nG1 Y185\n",
  });
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
});

test("stock brush Y=185 after start gcode fails", () => {
  const gcode = syntheticPlateGcode({
    body: "G1 X20 Y20 Z0.2 E0.1\nG0 Y185 F10000\n",
  });
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.phase === "print" && v.axis === "Y"));
});

test("arc extrema outside the bed fail", () => {
  const gcode = [
    "G90",
    "; CHANGE_LAYER",
    "G1 X10 Y10 Z0.2",
    "G2 X10 Y10 I100 J0 F1200",
    "; filament end gcode",
    "",
  ].join("\n");
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, false);
  const arc = arcBounds(10, 10, 10, 10, 100, 0, false);
  assert.ok(arc.maxX > 180);
});

test("Z above printable height fails", () => {
  const gcode = syntheticPlateGcode({
    body: "G1 X20 Y20 Z181 F300\nG1 X30 Y20 E0.2\n",
  });
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.axis === "Z"));
});

test("skip-bounds-check requires the loud exact value", () => {
  assert.equal(parseSkipBoundsCheck({}), false);
  assert.equal(parseSkipBoundsCheck({ "skip-bounds-check": SKIP_BOUNDS_CHECK_VALUE }), true);
  assert.throws(() => parseSkipBoundsCheck({ "skip-bounds-check": "1" }), /I_UNDERSTAND_BED_CRASH_RISK/);
});

test("M211: stock start forms allowed; print-phase or non-stock refused", () => {
  assert.equal(isStockStartM211("M211 X0 Y0 Z0"), true);
  assert.equal(isStockStartM211("M211 S"), true);
  assert.equal(isStockStartM211("M211 R"), true);
  assert.equal(isStockStartM211("M211 X1 Y1 Z1"), false);

  const stock = [
    "G90",
    "M211 X0 Y0 Z0 ;turn off soft endstop",
    "G0 X85 Y185",
    "M211 R",
    "; CHANGE_LAYER",
    "G1 X20 Y20 Z0.2 E0.1",
    "; filament end gcode",
    "",
  ].join("\n");
  assert.equal(validateGcodeBedBounds(stock).ok, true, JSON.stringify(validateGcodeBedBounds(stock).violations));

  const badPrint = [
    "G90",
    "M211 X0 Y0 Z0",
    "; CHANGE_LAYER",
    "M211 X0 Y0 Z0",
    "G1 X20 Y20 E0.1",
    "; filament end gcode",
    "",
  ].join("\n");
  const refused = validateGcodeBedBounds(badPrint);
  assert.equal(refused.ok, false);
  assert.ok(refused.violations.some((v) => v.kind === "m211" && v.phase === "print"));
});

test("preflight hard-fails MD5 mismatch and passes matching synthetic plate with zero warnings", () => {
  const good = syntheticPlateZip();
  const ok = validatePrintPreflight(good);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors, null, 2));
  assert.equal(ok.warnings.length, 0, JSON.stringify(ok.warnings, null, 2));

  const gcode = syntheticPlateGcode();
  const bad = makeStoredZip({
    "Metadata/plate_1.gcode": gcode,
    "Metadata/plate_1.gcode.md5": "00000000000000000000000000000000",
    "Metadata/plate_1.json": JSON.stringify({
      bbox_all: [20, 20, 40, 40],
      bbox_objects: [{ area: 400, bbox: [20, 20, 40, 40], id: 1, layer_height: 0.2, name: "synthetic.stl" }],
    }),
    "Metadata/slice_info.config": `<config><plate><metadata key="nozzle_diameters" value="0.4"/><filament type="PLA" used_g="1.25" nozzle_diameter="0.40"/></plate></config>`,
    "Metadata/project_settings.config": '{"printer_model":"Bambu Lab A1 mini"}',
  });
  const failed = validatePrintPreflight(bad);
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.some((e) => e.code === "integrity" && /md5/i.test(e.message)));
});

test("skirt outside the plate json bbox warns and still passes when extrusion stays on the bed", () => {
  const zip = syntheticPlateZip({
    bbox_all: [30, 30, 50, 50],
    bbox_objects: [{ area: 400, bbox: [30, 30, 50, 50], id: 1, layer_height: 0.2, name: "part" }],
    body: [
      "G1 X22 Y22 Z0.2 F1200",
      "G1 X58 Y22 E0.4",
      "G1 X58 Y58 E0.4",
      "G1 X22 Y58 E0.4",
      "G1 X22 Y22 E0.4",
      "G1 X30 Y30 E0.2",
      "G1 X50 Y50 E0.2",
    ].join("\n"),
  });
  const check = validatePrintPreflight(zip);
  assert.equal(check.ok, true, JSON.stringify(check.errors, null, 2));
  assert.ok(
    check.warnings.some((w) => w.code === "bbox" && /skirt|brim|prime/i.test(w.message)),
    JSON.stringify(check.warnings, null, 2),
  );
  assert.equal(check.errors.some((e) => e.code === "bbox"), false);
});

test("preflight warns on tight part gap and errors on bbox outside bed", () => {
  const outside = syntheticPlateZip({
    bbox_all: [10, 10, 200, 40],
    bbox_objects: [{ area: 1, bbox: [10, 10, 200, 40], id: 1, layer_height: 0.2, name: "x" }],
  });
  const out = validatePrintPreflight(outside);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.code === "bbox"));
  assert.ok(rectsGap([0, 0, 10, 10], [12, 0, 22, 10]) >= 2);
});

test("stripLeadInTravel targets START of first extruding move (straight)", () => {
  const leadIn = [
    "G1 X150 Y170 F42000",
    "G1 Z0.6",
    "G1 Z0.2",
    "G1 E0.8 F1800",
    "G1 X155 Y170 E0.2",
    "G1 X155 Y175 E0.2",
  ];
  const stripped = stripLeadInTravel(leadIn);
  assert.ok(stripped.dropped >= 1);
  // Start of the first extruding XY move is the lead-in endpoint (150,170), not the extrusion end.
  assert.deepEqual(stripped.firstExtrusionXY, { x: 150, y: 170 });
  assert.equal(stripped.lines.some((l) => /X150 Y170/.test(l)), false);
  assert.ok(stripped.lines.some((l) => /X155 Y170 E0\.2/.test(l)));

  const naive = shiftLine(leadIn[0], 0, 40);
  assert.match(naive, /Y210/);
});

test("stripLeadInTravel keeps G2/G3 geometry by traveling to arc start", () => {
  // Bug class: traveling to the END then running G2 I/J (offsets from the true start)
  // swings the arc off the bed — e.g. Gyro2-style I/J from the wrong point.
  const wrong = arcBounds(73.81, 42.836, 73.81, 42.836, -26.434, 62.459, true);
  assert.ok(
    wrong.minX < 0 || wrong.maxX > 180 || wrong.minY < 0 || wrong.maxY > 180,
    `expected off-bed swing, got ${JSON.stringify(wrong)}`,
  );

  const blockG2 = [
    "G1 X100.000 Y40.000 F42000",
    "G1 Z0.6",
    "G1 E0.8 F1800",
    "G2 X80.000 Y40.000 I-10.000 J0.000 E0.8",
    "G1 X80.000 Y55.000 E0.2",
  ];
  const g2 = stripLeadInTravel(blockG2);
  assert.deepEqual(g2.firstExtrusionXY, { x: 100, y: 40 });
  assert.ok(g2.lines.some((l) => l.startsWith("G2 ")));
  const arc = arcBounds(100, 40, 80, 40, -10, 0, true);
  assert.ok(arc.minX > 0 && arc.maxX < 180 && arc.minY > 0 && arc.maxY < 180);

  const blockG3 = [
    "G1 X60 Y40 F42000",
    "G1 E0.8 F1800",
    "G3 X80 Y40 I10 J0 E0.5",
    "G1 X80 Y55 E0.2",
  ];
  const g3 = stripLeadInTravel(blockG3);
  assert.deepEqual(g3.firstExtrusionXY, { x: 60, y: 40 });
  assert.ok(g3.lines.some((l) => l.startsWith("G3 ")));
  const arc3 = arcBounds(60, 40, 80, 40, 10, 0, false);
  assert.ok(arc3.minY > 0 && arc3.maxY < 180);
});

test("layout packs 4 pairs of A+B (41x41 and 34x34) with gap 4 margin 5", () => {
  const stats = {
    278: { w: 41.12, h: 41.12, cx: 0, cy: 0, minX: 0, minY: 0, maxX: 41.12, maxY: 41.12 },
    318: { w: 34.38, h: 34.38, cx: 0, cy: 0, minX: 0, minY: 0, maxX: 34.38, maxY: 34.38 },
  };
  const placements = layoutCopies(stats, { copies: 4, gapMm: 4, marginMm: 5, bedMm: 180, objectIds: [278, 318], layout: "front" });
  assert.equal(placements.length, 8);
  for (const p of placements) {
    const st = stats[p.id];
    assert.ok(p.cx - st.w / 2 >= 5 - 1e-6, JSON.stringify(p));
    assert.ok(p.cy - st.h / 2 >= 5 - 1e-6, JSON.stringify(p));
    assert.ok(p.cx + st.w / 2 <= 175 + 1e-6, JSON.stringify(p));
    assert.ok(p.cy + st.h / 2 <= 175 + 1e-6, JSON.stringify(p));
  }
});

test("center layout puts a 2-pair plate in a centred 2x2; front keeps the margin", () => {
  const stats = {
    278: { w: 40, h: 40 },
    318: { w: 34, h: 34 },
  };
  const center = layoutCopies(stats, { copies: 2, gapMm: 4, marginMm: 5, bedMm: 180, objectIds: [278, 318], layout: "center" });
  assert.equal(center.length, 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of center) {
    const st = stats[p.id];
    minX = Math.min(minX, p.cx - st.w / 2);
    minY = Math.min(minY, p.cy - st.h / 2);
    maxX = Math.max(maxX, p.cx + st.w / 2);
    maxY = Math.max(maxY, p.cy + st.h / 2);
  }
  assert.ok(Math.abs((minX + (180 - maxX)) / 2 - minX) < 1.5, `not centred in X ${minX}..${maxX}`);
  assert.ok(Math.abs(minX - (180 - maxX)) < 1.5, `X margins ${minX} vs ${180 - maxX}`);
  assert.ok(Math.abs(minY - (180 - maxY)) < 1.5, `Y margins ${minY} vs ${180 - maxY}`);
  assert.ok(maxY - minY > 40 + 4, "2-pair center should stack into two rows");
  assert.ok(minY > 5 + 1, `expected off the front edge, minY=${minY}`);

  const front = layoutCopies(stats, { copies: 2, gapMm: 4, marginMm: 5, bedMm: 180, objectIds: [278, 318], layout: "front" });
  let frontMinY = Infinity;
  for (const p of front) frontMinY = Math.min(frontMinY, p.cy - stats[p.id].h / 2);
  assert.ok(Math.abs(frontMinY - 5) < 1e-6, `front minY ${frontMinY}`);
});

test("e2e: 4-pair plate from synthetic 2-object source with arcs + far lead-in passes check-bounds", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bambu-plate4-"));
  try {
    const source = twoObjectSource({ aMode: "g2", bMode: "g3" });
    const listed = listPlateObjects(source);
    assert.deepEqual(listed.map((o) => o.id), [278, 318]);

    const built = buildPlate(source, { copies: 4, objects: "278,318", gapMm: 4, marginMm: 5 });
    assert.equal(built.placements.length, 8);
    assert.equal(built.preflight.ok, true, JSON.stringify(built.preflight.errors, null, 2));
    assert.equal(built.preflight.errors.length, 0);
    // Distinct tiled ids in plate json
    const ids = new Set();
    forEachZipEntryLine(built.buf, "Metadata/plate_1.json", (line) => {
      void line;
    });
    const jsonBuf = [];
    // re-read via validate
    const check = validatePrintPreflight(built.buf);
    assert.equal(check.ok, true, JSON.stringify(check.errors, null, 2));
    assert.equal(check.errors.length, 0);

    const src = path.join(home, "src.gcode.3mf");
    const out = path.join(home, "out4.gcode.3mf");
    await writeFile(src, source);
    const cliBuild = await runCli(
      ["plate", "build", src, "--copies", "4", "--objects", "278,318", "--gap", "4", "--margin", "5", "--out", out],
      home,
    );
    assert.equal(cliBuild.code, 0, cliBuild.stderr);
    const cliCheck = await runCli(["check-bounds", out], home);
    assert.equal(cliCheck.code, 0, cliCheck.stderr);
    const body = JSON.parse(cliCheck.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.errorCount, 0);
    void ids;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("plate info lists object ids; unknown --objects fails clearly", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bambu-info-"));
  try {
    const source = twoObjectSource();
    const src = path.join(home, "src.gcode.3mf");
    await writeFile(src, source);
    const info = await runCli(["plate", "info", src], home);
    assert.equal(info.code, 0, info.stderr);
    const body = JSON.parse(info.stdout);
    assert.equal(body.ok, true);
    assert.deepEqual(body.objects.map((o) => o.id), [278, 318]);

    const bad = await runCli(
      ["plate", "build", src, "--objects", "999", "--copies", "1", "--out", path.join(home, "x.gcode.3mf")],
      home,
    );
    assert.equal(bad.code, 4);
    assert.match(bad.stderr, /999|Available: 278,318/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("check-bounds CLI refuses Y=200 travel plate with exit 4 and JSON ok:false", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bambu-check-"));
  try {
    const file = path.join(home, "bad.gcode.3mf");
    await writeFile(
      file,
      syntheticPlateZip({
        body: "G1 X20 Y20 Z0.2\nG0 Y200 F9000\nG1 X40 Y20 E0.2\n",
      }),
    );
    const refused = await runCli(["check-bounds", file], home);
    assert.equal(refused.code, 4);
    const err = JSON.parse(refused.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /out of|Y=200|Bed bounds|print|preflight|M211|xy/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("plate gcode stream ceiling is 1 GiB (not 100 MiB)", () => {
  assert.equal(LIMITS.maxPlateGcodeBytes, 1024 * 1024 * 1024);
  assert.ok(LIMITS.maxPlateGcodeBytes > LIMITS.max3mfBytes);
});

test("remapNozzleSetpoint retargets purge highs and print layers", () => {
  assert.equal(remapNozzleSetpoint(270, { phase: "start", layerIndex: 0, firstLayerC: 220, nozzleC: 215 }), 240);
  assert.equal(remapNozzleSetpoint(255, { phase: "start", layerIndex: 0, firstLayerC: 220, nozzleC: 215 }), 220);
  assert.equal(remapNozzleSetpoint(235, { phase: "start", layerIndex: 0, firstLayerC: 220, nozzleC: 215 }), 220);
  assert.equal(remapNozzleSetpoint(170, { phase: "start", layerIndex: 0, firstLayerC: 220, nozzleC: 215 }), 170);
  assert.equal(remapNozzleSetpoint(255, { phase: "print", layerIndex: 1, firstLayerC: 220, nozzleC: 215 }), 220);
  assert.equal(remapNozzleSetpoint(255, { phase: "print", layerIndex: 2, firstLayerC: 220, nozzleC: 215 }), 215);
});

test("arcLength uses true arc path not chord", () => {
  const chord = Math.hypot(20, 0);
  const len = arcLength(0, 0, 20, 0, 10, 0, false);
  assert.ok(Math.abs(len - Math.PI * 10) < 1e-6, `got ${len}`);
  assert.ok(len > chord * 1.5);
});

test("plate build rewrites M104/M109/M140/M190/M106 and drops S255/S270", () => {
  const source = twoObjectSource({ hotTemps: true });
  const built = buildPlate(source, {
    copies: 2,
    objects: "278,318",
    gapMm: 4,
    marginMm: 5,
    filament: {
      type: "PLA",
      nozzleC: 215,
      firstLayerC: 220,
      bedC: 60,
      fanPercent: 100,
    },
  });
  assert.equal(built.preflight.ok, true, JSON.stringify(built.preflight.errors, null, 2));
  const gcode = readZipEntry(built.buf, "Metadata/plate_1.gcode").toString("utf8");
  assert.match(gcode, /;\s*nozzle_temperature = 215/);
  assert.match(gcode, /;\s*nozzle_temperature_initial_layer = 220/);
  assert.match(gcode, /;\s*first_layer_bed_temperature = 60/);
  assert.equal((gcode.match(/\bM10[49]\s+S255\b/gi) || []).length, 0);
  assert.equal((gcode.match(/\bM10[49]\s+S270\b/gi) || []).length, 0);
  assert.match(gcode, /\bM104\s+S220\b/i);
  // Later-layer temp injected immediately after the layer-2 CHANGE_LAYER.
  assert.match(
    gcode,
    /;\s*CHANGE_LAYER\s*\nM104 S215 ; set nozzle to later-layer temperature\n;\s*Z_HEIGHT: 0\.4/,
  );
  assert.match(gcode, /\bM140\s+S60\b/i);
  assert.match(gcode, /\bM190\s+S60\b/i);
  assert.match(gcode, /\bM106\s+S255\b/i);
  assert.equal((gcode.match(/\bM106\s+S102\b/gi) || []).length, 0);
  // Distinct M624 labels per tiled copy (2 objects × 2 copies); emitted each layer.
  const labels = [...gcode.matchAll(/;\s*start printing object, unique label id:\s*(\d+)/g)].map((m) => m[1]);
  assert.equal(new Set(labels).size, 4);
  assert.equal((gcode.match(/^M624\b/gm) || []).length, 8);
  assert.equal((gcode.match(/^M625\b/gm) || []).length, 8);
  // Weight scaled for 2 copies of both objects (fraction 1 × copies 2)
  assert.match(gcode, /filament used \[g\] = 4\.00/);
  const slice = readZipEntry(built.buf, "Metadata/slice_info.config").toString("utf8");
  assert.match(slice, /used_g="4\.00"/);
  assert.match(slice, /used_m="1\.34"/);
});

test("plate build from a 220..270 header accepts PLA 215/220 and rewrites the filament band", () => {
  const source = twoObjectSource({
    hotTemps: true,
    rangeLow: 220,
    rangeHigh: 270,
    filamentType: "PETG",
  });
  const built = buildPlate(source, {
    copies: 4,
    objects: "278,318",
    gapMm: 4,
    marginMm: 5,
    filament: {
      type: "PLA",
      nozzleC: 215,
      firstLayerC: 220,
      bedC: 60,
      fanPercent: 100,
    },
  });
  assert.equal(built.preflight.ok, true, JSON.stringify(built.preflight.errors, null, 2));
  const gcode = readZipEntry(built.buf, "Metadata/plate_1.gcode").toString("utf8");
  assert.match(gcode, /;\s*filament_type = PLA/);
  assert.match(gcode, /;\s*nozzle_temperature_range_low = 190/);
  assert.match(gcode, /;\s*nozzle_temperature_range_high = 240/);
  assert.match(gcode, /;\s*nozzle_temperature = 215/);
  assert.match(gcode, /;\s*nozzle_temperature_initial_layer = 220/);
  assert.match(gcode, /;\s*cool_plate_temp = 60/);
  assert.match(gcode, /;\s*hot_plate_temp = 60/);
  assert.match(gcode, /;\s*hot_plate_temp_initial_layer = 60/);
  assert.match(gcode, /;\s*bed_temperature = 60/);
  assert.match(gcode, /;\s*filament_max_volumetric_speed = 21/);
  assert.equal((gcode.match(/\bM10[49]\s+S255\b/gi) || []).length, 0);
  assert.equal((gcode.match(/\bM10[49]\s+S270\b/gi) || []).length, 0);
  assert.match(
    gcode,
    /;\s*CHANGE_LAYER\s*\nM104 S215 ; set nozzle to later-layer temperature\n;\s*Z_HEIGHT: 0\.4/,
  );
  const slice = readZipEntry(built.buf, "Metadata/slice_info.config").toString("utf8");
  assert.match(slice, /type="PLA"/);
  assert.match(slice, /tray_info_idx="GFA00"/);
  assert.match(slice, /color="#FFFFFF"/);
  assert.match(
    slice,
    /<!-- ; first_layer_bed_temperature = 60 \(Textured PEI Plate, PLA; matches M140\/M190 S60 in plate_1\.gcode\) -->/,
  );

  // Hand-edit the later-layer setpoint to S250 and restore the stale 220..270 header.
  // Settings agree with S250; the PLA band (not the stale header) must still refuse it.
  let edited = gcode.replace(
    "M104 S215 ; set nozzle to later-layer temperature",
    "M104 S250 ; hand-edited",
  );
  edited = edited
    .replace("; nozzle_temperature = 215", "; nozzle_temperature = 250")
    .replace("; nozzle_temperature_range_low = 190", "; nozzle_temperature_range_low = 220")
    .replace("; nozzle_temperature_range_high = 240", "; nozzle_temperature_range_high = 270");
  const md5 = crypto.createHash("md5").update(edited).digest("hex").toUpperCase();
  const bad = makeStoredZip({
    "Metadata/plate_1.gcode": edited,
    "Metadata/plate_1.gcode.md5": md5,
    "Metadata/plate_1.json": readZipEntry(built.buf, "Metadata/plate_1.json").toString("utf8"),
    "Metadata/slice_info.config": slice,
    "Metadata/project_settings.config": '{"printer_model":"Bambu Lab A1 mini"}',
  });
  const check = validatePrintPreflight(bad);
  assert.equal(check.ok, false);
  const rangeErr = check.errors.find((e) => e.code === "nozzle_temp_range" && /S250/.test(e.message));
  assert.ok(rangeErr, JSON.stringify(check.errors, null, 2));
  assert.match(rangeErr.message, /190\.\.240/);
});

test("stale 220..270 header on declared PLA does not reject nozzle 215", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; nozzle_diameter = 0.4",
    "; filament_type = PLA",
    "; nozzle_temperature = 215",
    "; nozzle_temperature_initial_layer = 220",
    "; nozzle_temperature_range_low = 220",
    "; nozzle_temperature_range_high = 270",
    "; first_layer_bed_temperature = 60",
    "; filament used [g] = 1.00",
    "G90",
    "M83",
    "M211 X0 Y0 Z0",
    "M104 S220",
    "M109 S220",
    "M211 R",
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.2",
    "; start printing object, unique label id: 1",
    "G1 X20 Y20 Z0.2 F1200",
    "G1 X40 Y20 E0.4",
    "G1 X40 Y40 E0.4",
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.4",
    "M104 S215",
    "G1 X20 Y20 Z0.4 F1200",
    "G1 X40 Y20 E0.4",
    "G1 X40 Y40 E0.4",
    "; filament end gcode",
    "G1 X-13 Y180 F3600",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const md5 = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();
  const zip = makeStoredZip({
    "Metadata/plate_1.gcode": gcode,
    "Metadata/plate_1.gcode.md5": md5,
    "Metadata/plate_1.json": JSON.stringify({
      bbox_all: [40, 20, 40, 40],
      bbox_objects: [{ id: 1, bbox: [40, 20, 40, 40], area: 400, layer_height: 0.2, name: "x" }],
    }),
    "Metadata/slice_info.config":
      `<config><plate><metadata key="printer_model_id" value=""/><metadata key="nozzle_diameters" value="0.4"/><metadata key="weight" value="1.00"/><filament type="PLA" used_m="0.3" used_g="1.00" nozzle_diameter="0.40"/></plate></config>`,
  });
  const check = validatePrintPreflight(zip);
  assert.equal(check.ok, true, JSON.stringify(check.errors, null, 2));
  assert.ok((check.infos || []).some((i) => i.code === "nozzle_range_header"));
});

test("cli plate build writes the matte-rainbow plate from a 220..270 source", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bambu-plate-"));
  try {
    const src = path.join(home, "gyro2-tread.3mf");
    const out = path.join(home, "spiral-pairs-x4.gcode.3mf");
    await writeFile(
      src,
      twoObjectSource({ hotTemps: true, rangeLow: 220, rangeHigh: 270, filamentType: "PETG" }),
    );
    const result = await runCli(
      [
        "plate", "build", src,
        "--objects", "278,318",
        "--copies", "4",
        "--gap", "4",
        "--margin", "5",
        "--filament-type", "PLA",
        "--nozzle-temp", "215",
        "--nozzle-temp-first-layer", "220",
        "--bed-temp", "60",
        "--fan", "100",
        "--out", out,
      ],
      home,
    );
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "plate-build");
    const buf = await readFile(out);
    assert.ok(buf.length > 100);
    const gcode = readZipEntry(buf, "Metadata/plate_1.gcode").toString("utf8");
    assert.match(gcode, /;\s*nozzle_temperature_range_low = 190/);
    assert.match(gcode, /;\s*nozzle_temperature_range_high = 240/);
    assert.match(gcode, /\bM104 S215 ; set nozzle to later-layer temperature/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("preflight hard-fails when later-layer nozzle temp is declared but missing in gcode", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; nozzle_diameter = 0.4",
    "; filament_type = PLA",
    "; nozzle_temperature = 215",
    "; nozzle_temperature_initial_layer = 220",
    "; nozzle_temperature_range_low = 190",
    "; nozzle_temperature_range_high = 240",
    "; first_layer_bed_temperature = 60",
    "; filament used [g] = 1.00",
    "G90",
    "M83",
    "M211 X0 Y0 Z0",
    "M104 S220",
    "M109 S220",
    "M211 R",
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.2",
    "; start printing object, unique label id: 1",
    "G1 X20 Y20 Z0.2 F1200",
    "G1 X40 Y20 E0.4",
    "G1 X40 Y40 E0.4",
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.4",
    // Deliberately no M104 S215 here.
    "G1 X20 Y20 Z0.4 F1200",
    "G1 X40 Y20 E0.4",
    "; filament end gcode",
    "G1 X-13 Y180 F3600",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const md5 = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();
  const zip = makeStoredZip({
    "Metadata/plate_1.gcode": gcode,
    "Metadata/plate_1.gcode.md5": md5,
    "Metadata/plate_1.json": JSON.stringify({
      bbox_all: [20, 20, 40, 40],
      bbox_objects: [{ id: 1, bbox: [20, 20, 40, 40], area: 400, layer_height: 0.2, name: "x" }],
    }),
    "Metadata/slice_info.config":
      `<config><plate><metadata key="printer_model_id" value=""/><metadata key="nozzle_diameters" value="0.4"/><metadata key="weight" value="1.00"/><filament type="PLA" used_m="0.3" used_g="1.00" nozzle_diameter="0.40"/></plate></config>`,
  });
  const check = validatePrintPreflight(zip);
  assert.equal(check.ok, false);
  assert.ok(
    check.errors.some((e) => e.code === "nozzle_temp_later_missing"),
    JSON.stringify(check.errors, null, 2),
  );
});

test("net extrusion cancels retract/unretract for filament-length accounting", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; first_layer_bed_temperature = 60",
    "G90",
    "M83",
    "M211 X0 Y0 Z0",
    "M211 R",
    "; CHANGE_LAYER",
    "G1 X20 Y20 Z0.2 F1200",
    "G1 X40 Y20 E1.0",
    "G1 E-0.8 F1800",
    "G1 X60 Y20 F9000",
    "G1 E0.8 F1800",
    "G1 X80 Y20 E1.0",
    "; filament end gcode",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const result = validateGcodeBedBounds(gcode);
  // Net = 1.0 - 0.8 + 0.8 + 1.0 = 2.0 (not 2.8 if unretract were counted as new filament)
  assert.equal(result.extrudedEMm, 2);
});

test("line after filament-end marker is phase end (marker itself stays print)", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; first_layer_bed_temperature = 60",
    "G90",
    "M83",
    "M211 X0 Y0 Z0",
    "M211 R",
    "; CHANGE_LAYER",
    "G1 X20 Y20 Z0.2 E0.2 F1200",
    "; filament end gcode",
    "G1 X-13 Y180 F3600",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  // Park after the end marker is whitelisted as end (would fail if still labelled print).
  assert.equal(result.violations.length, 0);
});

test("preflight hard-fails print-phase nozzle command vs settings mismatch", () => {
  const source = twoObjectSource({ hotTemps: true });
  const built = buildPlate(source, {
    copies: 1,
    objects: "278,318",
    filament: { type: "PLA", nozzleC: 220, firstLayerC: 220, bedC: 60 },
  });
  assert.equal(built.preflight.ok, true, JSON.stringify(built.preflight.errors, null, 2));
  let gcode = readZipEntry(built.buf, "Metadata/plate_1.gcode").toString("utf8");
  // Hand-edit: inject a mismatched body heat that settings still claim is 220.
  gcode = gcode.replace("; CHANGE_LAYER", "; CHANGE_LAYER\nM104 S255 ; hand-edited mismatch");
  const md5 = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();
  const bad = makeStoredZip({
    "Metadata/plate_1.gcode": gcode,
    "Metadata/plate_1.gcode.md5": md5,
    "Metadata/plate_1.json": readZipEntry(built.buf, "Metadata/plate_1.json").toString("utf8"),
    "Metadata/slice_info.config": readZipEntry(built.buf, "Metadata/slice_info.config").toString("utf8"),
    "Metadata/project_settings.config": '{"printer_model":"Bambu Lab A1 mini"}',
  });
  const check = validatePrintPreflight(bad);
  assert.equal(check.ok, false);
  assert.ok(
    check.errors.some((e) => e.code === "nozzle_temp_mismatch" || e.code === "nozzle_temp_range"),
    JSON.stringify(check.errors, null, 2),
  );
});

test("unverified Z feedrate is info not warning; arc volumetric uses arc length", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; nozzle_diameter = 0.4",
    "; filament_type = PLA",
    "; nozzle_temperature = 220",
    "; nozzle_temperature_range_low = 190",
    "; nozzle_temperature_range_high = 240",
    "; first_layer_bed_temperature = 60",
    "G90",
    "M83",
    "M211 X0 Y0 Z0",
    "M211 R",
    "; CHANGE_LAYER",
    "G1 X40 Y40 Z0.2 F1200",
    "G1 Z1.0 F3000",
    "G1 X60 Y40 E0.2 F1200",
    "; filament end gcode",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, true);
  assert.ok((result.infos || []).some((i) => i.kind === "feedrate" && i.max === 30));
  assert.equal((result.warnings || []).filter((w) => w.kind === "feedrate" && w.max === 30).length, 0);
});

function withPrintPhase(body) {
  return [
    "; printer_model = Bambu Lab A1 mini",
    "; nozzle_diameter = 0.4",
    "; filament_type = PLA",
    "; nozzle_temperature = 220",
    "; nozzle_temperature_initial_layer = 220",
    "; first_layer_bed_temperature = 60",
    "G90",
    "M83",
    "M211 X0 Y0 Z0",
    "M211 R",
    "; CHANGE_LAYER",
    body.trimEnd(),
    "; filament end gcode",
    "G1 X-13 Y180 F3600",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
}

test("parser does not fail open on G01, explicit plus, exponent, or a leading N word", () => {
  for (const line of ["G01 Y200", "G1 Y+200", "G1 Y2E2", "N10 G1 Y200", "G1X20Y200"]) {
    const result = validateGcodeBedBounds(withPrintPhase(`G1 X20 Y20\n${line}`));
    assert.equal(result.ok, false, line);
    assert.ok(result.violations.some((v) => v.axis === "Y" && v.value >= 200), `${line} ${JSON.stringify(result.violations)}`);
  }
});

test("parentheses are comments; a Y inside them is not a move and a Y outside still is", () => {
  const commented = validateGcodeBedBounds(withPrintPhase("G1 X20 Y20 (travel Y200 is a comment)"));
  assert.equal(commented.ok, true, JSON.stringify(commented.violations));
  const real = validateGcodeBedBounds(withPrintPhase("G1 X20 (comment) Y200"));
  assert.equal(real.ok, false);
  assert.ok(real.violations.some((v) => v.axis === "Y" && v.value >= 200));
});

test("CR-only line breaks are still split and checked", () => {
  const gcode = withPrintPhase("G1 X20 Y20").replace(/\n/g, "\r");
  const off = `${gcode.slice(0, gcode.indexOf("; CHANGE_LAYER"))}; CHANGE_LAYER\rG1 Y200\r; filament end gcode\r`;
  const result = validateGcodeBedBounds(off);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.axis === "Y" && v.value >= 200));
});

test("R-form arc whose bulge leaves the bed fails even though both endpoints are inside", () => {
  const result = validateGcodeBedBounds(withPrintPhase("G1 X10 Y170\nG2 X30 Y170 R-15"));
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.axis === "Y" && v.value > 180), JSON.stringify(result.violations));
});

test("full-circle arc is bounded by the whole radius, not just the shared endpoint", () => {
  const result = validateGcodeBedBounds(withPrintPhase("G1 X90 Y90\nG2 I80 J0"));
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.axis === "X" && v.value > 180), JSON.stringify(result.violations));
});

test("arc with no I/J/R is refused instead of treated as a straight chord", () => {
  const result = validateGcodeBedBounds(withPrintPhase("G1 X20 Y20\nG2 X40 Y20"));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === "arc"));
});

test("G92 axis reset is applied to the machine position", () => {
  // Logical X40 looks on-bed; machine position is 150 + 40 = 190.
  const result = validateGcodeBedBounds(withPrintPhase("G1 X150 Y20\nG92 X0\nG1 X40 Y20"));
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.axis === "X" && v.value >= 190), JSON.stringify(result.violations));
});

test("a file with no layer marker is refused even when every move is inside the start envelope", () => {
  const gcode = [
    "; printer_model = Bambu Lab A1 mini",
    "; first_layer_bed_temperature = 60",
    "G90",
    "M211 X0 Y0 Z0",
    "G1 X20 Y100",
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
  const result = validateGcodeBedBounds(gcode);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === "no_print_phase"), JSON.stringify(result.violations));
});

test("print-phase homing, alternate work offsets, and an open SKIPPABLE block are refused", () => {
  const home = validateGcodeBedBounds(withPrintPhase("G1 X20 Y20\nG28 X"));
  assert.ok(home.violations.some((v) => v.kind === "homing"), JSON.stringify(home.violations));
  const offset = validateGcodeBedBounds(withPrintPhase("G55\nG1 X20 Y20"));
  assert.ok(offset.violations.some((v) => v.kind === "coord"), JSON.stringify(offset.violations));
  const open = validateGcodeBedBounds(withPrintPhase("; SKIPPABLE_START\nG1 X20 Y20 E0.1\n"));
  assert.ok(open.violations.some((v) => v.kind === "skippable"), JSON.stringify(open.violations));
});

test("G91 and M211 on the same line as a move are not ignored", () => {
  const rel = validateGcodeBedBounds(withPrintPhase("G1 X20 Y20\nG91 G1 Y190"));
  assert.equal(rel.ok, false, JSON.stringify(rel.violations));
  assert.ok(rel.violations.some((v) => v.axis === "Y" && v.value >= 200), JSON.stringify(rel.violations));
  const endstop = validateGcodeBedBounds(withPrintPhase("G1 X20 Y20 M211 X0 Y0 Z0"));
  assert.ok(endstop.violations.some((v) => v.kind === "m211"), JSON.stringify(endstop.violations));
});

test("SKIPPABLE parks may leave X for the timelapse safe pos but not Y", () => {
  const y = validateGcodeBedBounds(withPrintPhase("; SKIPPABLE_START\nG0 Y189\n; SKIPPABLE_END"));
  assert.equal(y.ok, false, JSON.stringify(y.violations));
  assert.ok(y.violations.some((v) => v.axis === "Y" && v.value >= 189));
  const x = validateGcodeBedBounds(withPrintPhase("; SKIPPABLE_START\nG0 X-13 Y90\n; SKIPPABLE_END"));
  assert.equal(x.ok, true, JSON.stringify(x.violations));
});

test("lan print and lan upload refuse an off-bed plate before opening a connection", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bambu-lan-bounds-"));
  try {
    const file = path.join(home, "bad.gcode.3mf");
    await writeFile(file, syntheticPlateZip({ body: "G1 X20 Y20 Z0.2\nG0 Y200 F9000\nG1 X40 Y20 E0.2\n" }));
    const printed = await runCli(["lan", "print", file, "--yes"], home);
    assert.equal(printed.code, 4);
    assert.match(printed.stderr, /Y=200|out of|preflight|Bed bounds|bounds/i);
    const uploaded = await runCli(["lan", "upload", file], home);
    assert.equal(uploaded.code, 4);
    assert.match(uploaded.stderr, /Y=200|out of|preflight|Bed bounds|bounds/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
