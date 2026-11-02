import crypto from "node:crypto";
import { A1_MINI_BOUNDS, SKIP_BOUNDS_CHECK_VALUE, validateGcode3mfBedBounds, validateGcodeBedBounds } from "./bed-bounds.js";
import { fail } from "./errors.js";
import { extractBedTarget, findZipEntry, forEachZipEntryLine, plateGcodePath, readZipEntry, zipEntryCompressedBytes } from "./gcode3mf.js";
import { effectiveNozzleRange } from "./filament-defaults.js";
import { A1_MINI_LIMITS, resolvePrinterLimits } from "./printer-limits.js";
import zlib from "node:zlib";
import { LIMITS } from "./allow.js";

function issue(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

function parseHeaderMeta(gcodeText) {
  const head = String(gcodeText || "").slice(0, 200_000);
  const get = (key) => {
    const re = new RegExp(`^;\\s*${key}\\s*=\\s*(.+)$`, "im");
    const match = re.exec(head);
    return match ? match[1].trim() : null;
  };
  const getNum = (key) => {
    const value = get(key);
    if (value == null || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  return {
    printerModel: get("printer_model"),
    nozzleDiameter: getNum("nozzle_diameter"),
    filamentType: get("filament_type"),
    nozzleTemp: getNum("nozzle_temperature"),
    nozzleTempInitial: getNum("nozzle_temperature_initial_layer") ?? getNum("first_layer_temperature"),
    nozzleRangeLow: getNum("nozzle_temperature_range_low"),
    nozzleRangeHigh: getNum("nozzle_temperature_range_high"),
    firstLayerBed: getNum("first_layer_bed_temperature"),
    maxVolumetric: getNum("filament_max_volumetric_speed"),
    filamentWeightG: (() => {
      const total = /;\s*total filament weight \[g\]\s*:\s*([0-9.]+)/i.exec(head);
      if (total) return Number(total[1]);
      const used = /;\s*filament used \[g\]\s*=\s*([0-9.]+)/i.exec(head);
      return used ? Number(used[1]) : null;
    })(),
  };
}

function parseSliceInfo(text) {
  const source = String(text || "");
  const meta = (key) => {
    const match = new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"`, "i").exec(source);
    return match ? match[1] : null;
  };
  const filament = /<filament\b[^>]*\btype="([^"]+)"[^>]*\bused_g="([^"]+)"[^>]*\bnozzle_diameter="([^"]+)"/i.exec(source)
    || /<filament\b[^>]*\bnozzle_diameter="([^"]+)"[^>]*\btype="([^"]+)"[^>]*\bused_g="([^"]+)"/i.exec(source);
  let filamentType = null;
  let usedG = null;
  let nozzle = null;
  if (filament) {
    if (/type="/i.test(filament[0]) && filament[1] && /[A-Za-z]/.test(filament[1])) {
      filamentType = filament[1];
      usedG = filament[2];
      nozzle = filament[3];
    } else {
      nozzle = filament[1];
      filamentType = filament[2];
      usedG = filament[3];
    }
  }
  const filamentAlt = /<filament\b([^>]*)\/?>/i.exec(source);
  if (filamentAlt) {
    const attrs = filamentAlt[1];
    const type = /\btype="([^"]+)"/i.exec(attrs);
    const used = /\bused_g="([^"]+)"/i.exec(attrs);
    const noz = /\bnozzle_diameter="([^"]+)"/i.exec(attrs);
    if (type) filamentType = type[1];
    if (used) usedG = used[1];
    if (noz) nozzle = noz[1];
  }
  return {
    printerModelId: meta("printer_model_id"),
    nozzleDiameters: meta("nozzle_diameters"),
    weight: meta("weight"),
    filamentType,
    filamentUsedG: usedG != null ? Number(usedG) : null,
    filamentNozzle: nozzle != null ? Number(nozzle) : null,
  };
}

/** Signed gap between AABBs [x0,y0,x1,y1]: negative means overlap depth. */
export function rectsGap(a, b) {
  const ax0 = Number(a[0]);
  const ay0 = Number(a[1]);
  const ax1 = Number(a[2]);
  const ay1 = Number(a[3]);
  const bx0 = Number(b[0]);
  const by0 = Number(b[1]);
  const bx1 = Number(b[2]);
  const by1 = Number(b[3]);
  const overlapX = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  const overlapY = Math.min(ay1, by1) - Math.max(ay0, by0);
  if (overlapX > 0 && overlapY > 0) return -Math.min(overlapX, overlapY);
  const gapX = overlapX < 0 ? -overlapX : 0;
  const gapY = overlapY < 0 ? -overlapY : 0;
  if (gapX === 0) return gapY;
  if (gapY === 0) return gapX;
  return Math.hypot(gapX, gapY);
}

function bboxInsideBed(bbox, limits) {
  if (!Array.isArray(bbox) || bbox.length < 4) return false;
  const [x0, y0, x1, y1] = bbox.map(Number);
  return (
    x0 >= limits.xMin - 1e-4
    && y0 >= limits.yMin - 1e-4
    && x1 <= limits.xMax + 1e-4
    && y1 <= limits.yMax + 1e-4
    && x0 <= x1
    && y0 <= y1
  );
}

function readEntryText(buf, name, maxBytes = LIMITS.maxZipEntryBytes) {
  const data = readZipEntry(buf, name, maxBytes);
  return data ? data.toString("utf8") : null;
}

function readPlateGcodeMd5(buf, plate = 1) {
  const path = `${plateGcodePath(plate)}.md5`;
  const data = readZipEntry(buf, path, 4096);
  return data ? data.toString("utf8").trim().toUpperCase() : null;
}

function md5OfZipEntry(buf, name, maxBytes = LIMITS.maxPlateGcodeBytes) {
  const entry = findZipEntry(buf, name);
  if (!entry) return null;
  if (entry.uncompSize > maxBytes) {
    fail(`zip entry too large to hash: ${name}`, { exitCode: 4, code: "bad_3mf" });
  }
  const compressed = zipEntryCompressedBytes(buf, entry);
  let data;
  if (entry.method === 0) data = compressed;
  else if (entry.method === 8) data = zlib.inflateRawSync(compressed);
  else fail(`unsupported zip compression method ${entry.method} in ${name}`, { exitCode: 4, code: "bad_3mf" });
  return crypto.createHash("md5").update(data).digest("hex").toUpperCase();
}

function collectGcodeHeaderAndTemps(buf, platePath) {
  let header = "";
  let collectingHeader = true;
  let phase = "start";
  let layerIndex = 0;
  let enterEndAfterThisLine = false;
  const temps = [];
  forEachZipEntryLine(buf, platePath, (line, lineNo) => {
    // End-marker comment stays in the prior phase; the following line is the first "end" line.
    if (enterEndAfterThisLine) {
      phase = "end";
      enterEndAfterThisLine = false;
    }
    if (phase === "start" && (/^;\s*CHANGE_LAYER\s*$/.test(line) || /^;\s*layer num\/total_layer_count:/.test(line))) {
      phase = "print";
      layerIndex = 1;
    } else if (phase === "print" && /^;\s*CHANGE_LAYER\s*$/.test(line)) {
      // Only CHANGE_LAYER advances the layer index (not layer-num comments).
      layerIndex += 1;
    }
    if ((phase === "start" || phase === "print") && /^;\s*(filament end gcode|MACHINE_END_GCODE_START|EXECUTABLE_BLOCK_END)\b/i.test(line)) {
      enterEndAfterThisLine = true;
    }
    if (collectingHeader) {
      header += `${line}\n`;
      if (header.length > 200_000 || phase !== "start") collectingHeader = false;
    }
    const code = line.split(";", 1)[0].trim();
    if (!code) return;
    const head = code.split(/\s+/, 1)[0].toUpperCase();
    if (head === "M104" || head === "M109" || head === "M140" || head === "M190") {
      const match = /\bS([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i.exec(code);
      if (match) {
        temps.push({
          cmd: head,
          celsius: Number(match[1]),
          lineNo,
          line: line.slice(0, 120),
          phase,
          layerIndex,
        });
      }
    }
  });
  return { header, temps };
}

/**
 * Full pre-print validation for a .gcode.3mf buffer.
 * Hard-fail categories: xy_all, z, extrusion_xy, bbox, integrity (md5/model/nozzle/filament).
 * Warnings: gap, temperatures (range), feedrate/accel/volumetric.
 */
export function validatePrintPreflight(buf, { plate = 1, model = "a1-mini" } = {}) {
  const limits = resolvePrinterLimits(model) || A1_MINI_LIMITS;
  const errors = [];
  const warnings = [];
  const platePath = plateGcodePath(plate);

  // (1)(2)(3) move analysis — all travels after start, Z, extrusion
  const moves = validateGcode3mfBedBounds(buf, { plate, bounds: limits });
  for (const v of moves.violations) {
    const message =
      v.message
      || (v.kind === "m211"
        ? `M211 refused at line ${v.lineNo} (${v.phase})`
        : `${v.axis}=${v.value} out of ${v.min}..${v.max} at line ${v.lineNo} (${v.phase})`);
    errors.push(issue("error", v.kind || "bed_bounds", message, { ...v }));
  }
  for (const w of moves.warnings) {
    warnings.push(issue("warning", w.kind || "motion", w.note || "motion warning", w));
  }
  const infos = [];
  for (const info of moves.infos || []) {
    infos.push(issue("info", info.kind || "motion", info.note || "motion info", info));
  }

  // Header / temps from streamed gcode
  const { header, temps } = collectGcodeHeaderAndTemps(buf, platePath);
  const meta = parseHeaderMeta(header);
  const bedTarget = extractBedTarget(header);

  // (6) temperatures — bed presence is hard (matches lan print).
  // Print-phase M104/M109 must match settings comments and stay in filament range (HARD FAIL).
  if (bedTarget.celsius == null || Number.isNaN(bedTarget.celsius)) {
    errors.push(
      issue("error", "bed_target_unknown", "Sliced first-layer bed target is missing or unknown in plate gcode header"),
    );
  }
  const nozzleRange = effectiveNozzleRange(meta, limits.plaNozzleRangeC);
  const rangeLow = nozzleRange.low;
  const rangeHigh = nozzleRange.high;
  if (nozzleRange.ignoredHeader) {
    infos.push(
      issue(
        "info",
        "nozzle_range_header",
        `Header nozzle range ${meta.nozzleRangeLow}..${meta.nozzleRangeHigh} C disagrees with ${meta.filamentType}; using ${rangeLow}..${rangeHigh} C`,
      ),
    );
  }
  const declaredNozzle = meta.nozzleTemp;
  const declaredFirst = meta.nozzleTempInitial ?? meta.nozzleTemp;
  for (const t of temps) {
    if (t.phase !== "print") continue;
    if (t.cmd !== "M104" && t.cmd !== "M109") continue;
    if (!(t.celsius > 0)) continue;
    if (t.celsius < rangeLow || t.celsius > rangeHigh) {
      errors.push(
        issue(
          "error",
          "nozzle_temp_range",
          `Nozzle ${t.cmd} S${t.celsius} outside filament range ${rangeLow}..${rangeHigh} C at line ${t.lineNo}`,
          t,
        ),
      );
    }
    if (declaredNozzle != null || declaredFirst != null) {
      const expected = t.layerIndex <= 1 ? (declaredFirst ?? declaredNozzle) : (declaredNozzle ?? declaredFirst);
      if (expected != null && Math.abs(t.celsius - expected) > 0.51) {
        errors.push(
          issue(
            "error",
            "nozzle_temp_mismatch",
            `Nozzle ${t.cmd} S${t.celsius} at line ${t.lineNo} (layer ${t.layerIndex}) disagrees with settings comment ${expected} C`,
            { ...t, expected },
          ),
        );
      }
    }
    if (t.celsius > limits.nozzleMaxC) {
      infos.push(
        issue(
          "info",
          "nozzle_temp_machine",
          `Nozzle ${t.cmd} S${t.celsius} above machine max ${limits.nozzleMaxC} C (unverified) at line ${t.lineNo}`,
          t,
        ),
      );
    }
  }
  // Start-phase leftovers above the resolved filament range — hard fail.
  // Floor the cap at 254 so a stock PLA flush (~250) stays legal when the PLA band tops out at 240.
  // A hotter declared filament (PETG/ABS) may keep a start setpoint up to its own range high.
  const startCap = Math.max(rangeHigh, 254);
  for (const t of temps) {
    if (t.phase !== "start") continue;
    if (t.cmd !== "M104" && t.cmd !== "M109") continue;
    if (t.celsius > startCap) {
      errors.push(
        issue(
          "error",
          "nozzle_temp_start",
          `Start ${t.cmd} S${t.celsius} at line ${t.lineNo} is above the start-phase cap ${startCap} C`,
          t,
        ),
      );
    }
  }
  // When settings declare a later-layer nozzle temp distinct from first-layer, require a
  // print-phase M104/M109 at layer ≥2 matching it (otherwise the nozzle stays at first-layer).
  if (
    declaredNozzle != null
    && declaredFirst != null
    && Math.abs(declaredNozzle - declaredFirst) > 0.51
  ) {
    const laterOk = temps.some(
      (t) =>
        t.phase === "print"
        && t.layerIndex >= 2
        && (t.cmd === "M104" || t.cmd === "M109")
        && t.celsius > 0
        && Math.abs(t.celsius - declaredNozzle) <= 0.51,
    );
    if (!laterOk) {
      errors.push(
        issue(
          "error",
          "nozzle_temp_later_missing",
          `Settings declare later-layer nozzle ${declaredNozzle} C (first-layer ${declaredFirst} C) but no print-phase M104/M109 at layer ≥2 sets ${declaredNozzle} C`,
          { declaredNozzle, declaredFirst },
        ),
      );
    }
  }

  // (4) plate_N.json bboxes
  const plateJsonText = readEntryText(buf, `Metadata/plate_${plate}.json`);
  let plateJson = null;
  if (plateJsonText) {
    try {
      plateJson = JSON.parse(plateJsonText);
    } catch {
      errors.push(issue("error", "bbox", `Metadata/plate_${plate}.json is not valid JSON`));
    }
  } else {
    warnings.push(issue("warning", "bbox", `Metadata/plate_${plate}.json missing; skipped footprint checks`));
  }
  if (plateJson) {
    const bboxAll = plateJson.bbox_all;
    const objects = Array.isArray(plateJson.bbox_objects) ? plateJson.bbox_objects : [];
    if (bboxAll && !bboxInsideBed(bboxAll, limits)) {
      errors.push(issue("error", "bbox", `bbox_all ${JSON.stringify(bboxAll)} is outside the ${limits.bedMm} mm bed`));
    }
    for (const obj of objects) {
      if (!bboxInsideBed(obj.bbox, limits)) {
        errors.push(
          issue("error", "bbox", `bbox_objects id=${obj.id} bbox ${JSON.stringify(obj.bbox)} is outside the ${limits.bedMm} mm bed`),
        );
      }
    }
    // Skirt, brim, and prime lines routinely extend past bbox_all / bbox_objects.
    // A mismatch is a warning. Extrusion that leaves the bed is already a hard error.
    if (moves.extrusion.moves && bboxAll) {
      const [jx0, jy0, jx1, jy1] = bboxAll.map(Number);
      const [gx0, gy0] = moves.extrusion.min;
      const [gx1, gy1] = moves.extrusion.max;
      const tol = limits.bboxMatchTolMm ?? 1;
      if (
        Math.abs(jx0 - gx0) > tol + 1e-6
        || Math.abs(jy0 - gy0) > tol + 1e-6
        || Math.abs(jx1 - gx1) > tol + 1e-6
        || Math.abs(jy1 - gy1) > tol + 1e-6
      ) {
        warnings.push(
          issue(
            "warning",
            "bbox",
            `plate json bbox_all [${jx0}, ${jy0}, ${jx1}, ${jy1}] differs from gcode extrusion [${gx0}, ${gy0}, ${gx1}, ${gy1}] by more than ${tol} mm (skirt, brim, or prime line). Extrusion outside the bed is still a hard error.`,
            { json: bboxAll, gcode: { min: moves.extrusion.min, max: moves.extrusion.max } },
          ),
        );
      }
    }

    // (5) min gap between parts — warning
    for (let i = 0; i < objects.length; i++) {
      for (let j = i + 1; j < objects.length; j++) {
        const gap = rectsGap(objects[i].bbox, objects[j].bbox);
        if (gap < (limits.minGapMm ?? 4) - 1e-6) {
          warnings.push(
            issue(
              "warning",
              "part_gap",
              `Objects ${objects[i].id} and ${objects[j].id} gap ${gap.toFixed(2)} mm < ${limits.minGapMm} mm`,
              { a: objects[i].id, b: objects[j].id, gap },
            ),
          );
        }
      }
    }
  }

  // (7) 3mf integrity
  const declaredMd5 = readPlateGcodeMd5(buf, plate);
  const actualMd5 = md5OfZipEntry(buf, platePath);
  if (!declaredMd5) {
    errors.push(issue("error", "integrity", `missing ${platePath}.md5`));
  } else if (actualMd5 && declaredMd5 !== actualMd5) {
    errors.push(
      issue("error", "integrity", `${platePath}.md5 mismatch: declared ${declaredMd5}, actual ${actualMd5}`),
    );
  }

  const sliceText = readEntryText(buf, "Metadata/slice_info.config");
  const slice = sliceText ? parseSliceInfo(sliceText) : null;
  if (!meta.printerModel || !/a1\s*mini/i.test(meta.printerModel)) {
    errors.push(
      issue(
        "error",
        "integrity",
        `gcode header printer_model must be A1 mini (got ${meta.printerModel ?? "missing"})`,
      ),
    );
  }
  if (slice) {
    if (slice.printerModelId && slice.printerModelId.trim() !== "") {
      const id = slice.printerModelId.trim();
      // N1 is the A1 mini model code; empty is common from Orca (rely on gcode header, no warning).
      // Unknown non-empty ids are unverified — warn only.
      if (!/^(N1|a1[\s_-]*mini)$/i.test(id)) {
        warnings.push(
          issue(
            "warning",
            "integrity",
            `slice_info printer_model_id="${id}" is not a known A1 mini id (N1); id mapping unverified`,
          ),
        );
      }
    }
    const sliceNozzle = slice.filamentNozzle ?? (slice.nozzleDiameters != null ? Number(slice.nozzleDiameters) : null);
    if (meta.nozzleDiameter != null && sliceNozzle != null && Math.abs(meta.nozzleDiameter - sliceNozzle) > 0.011) {
      errors.push(
        issue(
          "error",
          "integrity",
          `nozzle diameter mismatch: gcode ${meta.nozzleDiameter} vs slice_info ${sliceNozzle}`,
        ),
      );
    }
    if (meta.filamentType && slice.filamentType && meta.filamentType.split(";")[0].trim().toUpperCase() !== slice.filamentType.trim().toUpperCase()) {
      errors.push(
        issue(
          "error",
          "integrity",
          `filament type mismatch: gcode "${meta.filamentType}" vs slice_info "${slice.filamentType}"`,
        ),
      );
    }
    if (meta.filamentWeightG != null && slice.filamentUsedG != null && Math.abs(meta.filamentWeightG - slice.filamentUsedG) > 0.15) {
      warnings.push(
        issue(
          "warning",
          "integrity",
          `filament weight gcode ${meta.filamentWeightG}g vs slice_info ${slice.filamentUsedG}g`,
        ),
      );
    }
  } else {
    warnings.push(issue("warning", "integrity", "Metadata/slice_info.config missing; skipped cross-checks"));
  }

  // Net extrusion length vs claimed filament weight (>5% → info; retract/unretract cancelled in net E).
  // 1.75 mm filament @ ~1.24 g/cm³ ≈ 0.00298 g/mm.
  if (meta.filamentWeightG != null && moves.extrudedEMm > 1) {
    const plaGPerMm = (Math.PI * (1.75 / 2) ** 2) * 0.00124;
    const impliedG = moves.extrudedEMm * plaGPerMm;
    if (impliedG > 0.5) {
      const rel = Math.abs(impliedG - meta.filamentWeightG) / Math.max(meta.filamentWeightG, impliedG);
      if (rel > 0.05) {
        infos.push(
          issue(
            "info",
            "filament_weight_vs_extrusion",
            `Claimed filament weight ${meta.filamentWeightG}g differs from net-extrusion-implied ~${impliedG.toFixed(2)}g by ${(rel * 100).toFixed(1)}% (>5%)`,
            { claimedG: meta.filamentWeightG, impliedG: Math.round(impliedG * 100) / 100, extrudedEMm: moves.extrudedEMm },
          ),
        );
      }
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    model: limits.id,
    platePath,
    moveCount: moves.moveCount,
    extrusion: moves.extrusion,
    extrudedEMm: moves.extrudedEMm,
    bedTargetC: bedTarget.celsius,
    bedTargetSource: bedTarget.source,
    md5: actualMd5,
    errors,
    warnings,
    infos,
    limits: moves.limits,
  };
}

export function assertPreflightOrFail(result, { skipped = false } = {}) {
  if (skipped) {
    return {
      skipped: true,
      warning:
        `PREFLIGHT / BED BOUNDS CHECK SKIPPED via --skip-bounds-check=${SKIP_BOUNDS_CHECK_VALUE}. Out-of-bed travels can drive the bed into its mechanical stop at full speed.`,
      warnings: result?.warnings ?? [],
    };
  }
  if (result.ok) {
    return {
      skipped: false,
      ok: true,
      moveCount: result.moveCount,
      platePath: result.platePath,
      warnings: result.warnings,
      bedTargetC: result.bedTargetC,
    };
  }
  const first = result.errors[0];
  fail(first?.message || "Preflight validation failed", {
    exitCode: 4,
    code: first?.code || "preflight",
    details: {
      model: result.model,
      platePath: result.platePath,
      bedTargetC: result.bedTargetC ?? null,
      bedTargetSource: result.bedTargetSource ?? null,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      errors: result.errors.slice(0, 20),
      warnings: result.warnings.slice(0, 20),
      limits: result.limits,
    },
  });
}

export function validateGcodeTextPreflight(gcodeText, limits = A1_MINI_LIMITS) {
  return validateGcodeBedBounds(gcodeText, limits);
}

export { A1_MINI_BOUNDS, SKIP_BOUNDS_CHECK_VALUE };
