import { parseWordMap } from "./bed-bounds.js";
import { isSlicedLayerMarker } from "./gcode-summary.js";

const END_MARKER_RE = /^;\s*(filament end gcode|MACHINE_END_GCODE_START|EXECUTABLE_BLOCK_END)\b/i;

/**
 * Remap a nozzle setpoint for PLA-safe plate retargeting.
 * - Print body: first layer vs later layer
 * - Start extreme flush (≥260, e.g. S270): firstLayer+20 capped at rangeHigh
 * - Start print-ish / PETG leftovers (200–259, incl. S255): first-layer temp
 * - Start standby (<200, >0): left alone (preheat ladder)
 * - S0: left alone (heaters off)
 */
export function remapNozzleSetpoint(s, { phase, layerIndex, firstLayerC, nozzleC, rangeHigh = 240 }) {
  if (s == null || Number.isNaN(s) || s <= 0) return s;
  if (phase === "print") return layerIndex <= 1 ? firstLayerC : nozzleC;
  if (phase === "end") return s <= 0 ? s : nozzleC; // rare; keep off, else print temp
  // start
  if (s >= 260) return Math.min(firstLayerC + 20, rangeHigh);
  if (s >= 200) return firstLayerC;
  return s;
}

export function replaceTempCommand(line, { nozzle, bed, phase, layerIndex, firstLayerC, nozzleC, bedC, rangeHigh }) {
  const code = line.split(";", 1)[0];
  if (!/\bM10[49]\b|\bM1[49]0\b/i.test(code)) return line;
  const head = code.trim().split(/\s+/, 1)[0].toUpperCase();
  const match = /\bS(-?\d+(?:\.\d+)?)/i.exec(code);
  if (!match) return line;
  const s = Number(match[1]);
  let next = s;
  if ((head === "M104" || head === "M109") && nozzle) {
    next = remapNozzleSetpoint(s, { phase, layerIndex, firstLayerC, nozzleC, rangeHigh });
  } else if ((head === "M140" || head === "M190") && bed && bedC != null && s > 0) {
    next = bedC;
  } else {
    return line;
  }
  if (next === s) return line;
  return line.replace(/\bS-?\d+(?:\.\d+)?/i, `S${next}`);
}

/** Rewrite M106 part-fan PWM. Keeps S0 (off). Optional bridgeFan when comment/feature hints bridging. */
export function replaceFanCommand(line, { fan, bridgeFan }) {
  if (fan == null) return line;
  const code = line.split(";", 1)[0];
  if (!/\bM106\b/i.test(code)) return line;
  const match = /\bS(-?\d+(?:\.\d+)?)/i.exec(code);
  if (!match) return line;
  const s = Number(match[1]);
  if (s <= 0) return line;
  const lower = line.toLowerCase();
  const useBridge =
    bridgeFan != null
    && (lower.includes("bridge") || lower.includes("overhang") || lower.includes("ironing"));
  const target = useBridge ? bridgeFan : fan;
  return line.replace(/\bS-?\d+(?:\.\d+)?/i, `S${target}`);
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function rewriteHeaderMeta(line, { filament, weightG, timeSec, layerCount }) {
  let out = line;
  if (filament?.type && /^;\s*filament_type\s*=/.test(out)) out = `; filament_type = ${filament.type}`;
  if (filament?.nozzleC != null && /^;\s*nozzle_temperature\s*=/.test(out)) {
    out = `; nozzle_temperature = ${filament.nozzleC}`;
  }
  if (filament?.firstLayerC != null && /^;\s*nozzle_temperature_initial_layer\s*=/.test(out)) {
    out = `; nozzle_temperature_initial_layer = ${filament.firstLayerC}`;
  }
  if (filament?.firstLayerC != null && /^;\s*first_layer_temperature\s*=/.test(out)) {
    out = `; first_layer_temperature = ${filament.firstLayerC}`;
  }
  if (filament?.bedC != null && /^;\s*first_layer_bed_temperature\s*=/.test(out)) {
    out = `; first_layer_bed_temperature = ${filament.bedC}`;
  }
  if (filament?.rangeLow != null && /^;\s*nozzle_temperature_range_low\s*=/.test(out)) {
    out = `; nozzle_temperature_range_low = ${filament.rangeLow}`;
  }
  if (filament?.rangeHigh != null && /^;\s*nozzle_temperature_range_high\s*=/.test(out)) {
    out = `; nozzle_temperature_range_high = ${filament.rangeHigh}`;
  }
  if (filament?.bedC != null) {
    const bedKey = /^;\s*(bed_temperature(?:_initial_layer)?)\s*=/.exec(out);
    if (bedKey) out = `; ${bedKey[1]} = ${filament.bedC}`;
    const plateKey = /^;\s*([A-Za-z0-9_]*plate_temp(?:_initial_layer)?)\s*=/.exec(out);
    if (plateKey) out = `; ${plateKey[1]} = ${filament.bedC}`;
  }
  if (filament?.volumetric != null && /^;\s*filament_max_volumetric_speed\s*=/.test(out)) {
    out = `; filament_max_volumetric_speed = ${filament.volumetric}`;
  }
  if (filament?.fan != null && /^;\s*fan_max_speed\s*=/.test(out)) {
    out = `; fan_max_speed = ${Math.round((filament.fan / 255) * 100)}`;
  }
  if (weightG != null && /^;\s*total filament weight \[g\]/.test(out)) {
    out = `; total filament weight [g] : ${Number(weightG).toFixed(2)}`;
  }
  if (weightG != null && /^;\s*filament used \[g\]\s*=/.test(out)) {
    out = `; filament used [g] = ${Number(weightG).toFixed(2)}`;
  }
  if (layerCount != null && /^;\s*total layer number\s*:/.test(out)) {
    out = `; total layer number: ${layerCount}`;
  }
  if (timeSec != null && (/^;\s*model printing time:/.test(out) || /^;\s*total estimated time:/.test(out))) {
    out = out.replace(
      /[\d]+h ?[\d]+m ?[\d]+s|[\d]+m ?[\d]+s|[\d]+s/g,
      formatDuration(timeSec),
    );
  }
  return out;
}

/**
 * Apply filament retarget + fan rewrite across header/body/tail with phase + layer tracking.
 */
export function retargetGcodeLines(lines, {
  filament = null,
  weightG = null,
  timeSec = null,
  layerCount = null,
  rangeHigh = 240,
} = {}) {
  const nozzle = filament?.nozzleC != null || filament?.firstLayerC != null;
  const bed = filament?.bedC != null;
  const firstLayerC = filament?.firstLayerC ?? filament?.nozzleC ?? null;
  const nozzleC = filament?.nozzleC ?? filament?.firstLayerC ?? null;
  const fan = filament?.fan ?? null;
  const bridgeFan = filament?.bridgeFan ?? fan;

  let phase = "start";
  let layerIndex = 0;
  let sawNozzleTemp = false;
  let sawInitialNozzle = false;
  let sawBedTemp = false;
  let sawFilamentType = false;
  let sawRangeLow = false;
  let sawRangeHigh = false;
  let injectedLaterTemp = false;
  let enterEndAfterThisLine = false;
  const out = [];
  for (const raw of lines) {
    // End-marker line stays in the prior phase; the *next* line is the first "end" line.
    if (enterEndAfterThisLine) {
      phase = "end";
      enterEndAfterThisLine = false;
    }

    // Enter print on any sliced-layer marker; count layers only on ; CHANGE_LAYER
    // (the following "; layer num/total_layer_count:" must not bump the index).
    let becameLayer2 = false;
    if (phase === "start" && isSlicedLayerMarker(raw)) {
      // Ensure settings comments exist before leaving the header so validator can cross-check.
      if (filament?.type && !sawFilamentType) {
        out.push(`; filament_type = ${filament.type}`);
        sawFilamentType = true;
      }
      if (filament?.rangeLow != null && !sawRangeLow) {
        out.push(`; nozzle_temperature_range_low = ${filament.rangeLow}`);
        sawRangeLow = true;
      }
      if (filament?.rangeHigh != null && !sawRangeHigh) {
        out.push(`; nozzle_temperature_range_high = ${filament.rangeHigh}`);
        sawRangeHigh = true;
      }
      if (filament?.nozzleC != null && !sawNozzleTemp) {
        out.push(`; nozzle_temperature = ${filament.nozzleC}`);
        sawNozzleTemp = true;
      }
      if (filament?.firstLayerC != null && !sawInitialNozzle) {
        out.push(`; nozzle_temperature_initial_layer = ${filament.firstLayerC}`);
        sawInitialNozzle = true;
      }
      if (filament?.bedC != null && !sawBedTemp) {
        out.push(`; first_layer_bed_temperature = ${filament.bedC}`);
        sawBedTemp = true;
      }
      phase = "print";
      layerIndex = 1;
    } else if (phase === "print" && /^;\s*CHANGE_LAYER\s*$/.test(raw)) {
      layerIndex += 1;
      if (layerIndex === 2) becameLayer2 = true;
    }
    if ((phase === "start" || phase === "print") && END_MARKER_RE.test(raw)) {
      enterEndAfterThisLine = true;
    }

    let line = raw;
    // Strip stale multi-object layer labels that would lie after tiling.
    if (/^;\s*OBJECT_ID\s*:/i.test(line) || /^;\s*object ids of layer/i.test(line)) {
      continue;
    }
    if (phase === "start" || line.startsWith(";")) {
      line = rewriteHeaderMeta(line, { filament, weightG, timeSec, layerCount });
    }
    if (/^;\s*filament_type\s*=/.test(line)) sawFilamentType = true;
    if (/^;\s*nozzle_temperature_range_low\s*=/.test(line)) sawRangeLow = true;
    if (/^;\s*nozzle_temperature_range_high\s*=/.test(line)) sawRangeHigh = true;
    if (/^;\s*nozzle_temperature\s*=/.test(line)) sawNozzleTemp = true;
    if (/^;\s*nozzle_temperature_initial_layer\s*=/.test(line) || /^;\s*first_layer_temperature\s*=/.test(line)) {
      sawInitialNozzle = true;
    }
    if (/^;\s*first_layer_bed_temperature\s*=/.test(line)) sawBedTemp = true;
    line = replaceTempCommand(line, {
      nozzle,
      bed,
      phase,
      layerIndex,
      firstLayerC,
      nozzleC,
      bedC: filament?.bedC,
      rangeHigh,
    });
    line = replaceFanCommand(line, { fan, bridgeFan });
    // Progress remaining time comments
    if (timeSec != null && /^M73\s+P\d+\s+R\d+/i.test(line.split(";", 1)[0])) {
      const pct = /P(\d+)/i.exec(line);
      const p = pct ? Number(pct[1]) : 0;
      const remain = Math.max(0, Math.round(((100 - p) / 100) * (timeSec / 60)));
      line = line.replace(/R\d+/i, `R${remain}`);
    }
    out.push(line);
    // When later-layer temp differs from first-layer, emit M104 at the layer-2 change so
    // the nozzle actually drops (source plates often have no body M104 at all).
    if (
      becameLayer2
      && !injectedLaterTemp
      && nozzle
      && nozzleC != null
      && firstLayerC != null
      && Math.abs(nozzleC - firstLayerC) > 0.51
    ) {
      out.push(`M104 S${nozzleC} ; set nozzle to later-layer temperature`);
      injectedLaterTemp = true;
    }
  }
  return out;
}

/** Sum positive extruded filament length (mm of 1.75 mm filament), respecting M82/M83. */
export function sumExtrudedE(lines) {
  let e = 0;
  let relativeE = false;
  let total = 0;
  for (const line of lines) {
    const code = line.split(";", 1)[0].trim();
    if (!code) continue;
    const head = code.split(/\s+/, 1)[0].toUpperCase();
    if (head === "M82") {
      relativeE = false;
      continue;
    }
    if (head === "M83") {
      relativeE = true;
      continue;
    }
    if (head === "G92") {
      const parsed = parseWordMap(code);
      if (parsed.E !== undefined) e = parsed.E;
      continue;
    }
    if (head !== "G0" && head !== "G1" && head !== "G2" && head !== "G3") continue;
    const parsed = parseWordMap(code);
    if (parsed.E === undefined) continue;
    let delta;
    if (relativeE) {
      delta = parsed.E;
      e += parsed.E;
    } else {
      delta = parsed.E - e;
      e = parsed.E;
    }
    if (delta > 0) total += delta;
  }
  return total;
}

export function parseHeaderTimeSec(headerText) {
  const text = String(headerText || "");
  const total = /total estimated time:\s*([^\n;]+)/i.exec(text);
  const model = /model printing time:\s*([^\n;]+)/i.exec(text);
  const src = total?.[1] || model?.[1];
  if (!src) return null;
  const h = /(\d+)\s*h/i.exec(src);
  const m = /(\d+)\s*m/i.exec(src);
  const s = /(\d+)\s*s/i.exec(src);
  if (!h && !m && !s) return null;
  return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
}

export function parseHeaderWeightG(headerText) {
  const text = String(headerText || "");
  const total = /;\s*total filament weight \[g\]\s*:\s*([0-9.]+)/i.exec(text);
  if (total) return Number(total[1]);
  const used = /;\s*filament used \[g\]\s*=\s*([0-9.]+)/i.exec(text);
  return used ? Number(used[1]) : null;
}

/** Trivial M624 payload for a single active object bit (Bambu-compatible length). */
export function m624ForObjectIndex(index) {
  // 12 zero bytes with bit `index % 8` set in the first byte — good enough for unique labels.
  const bytes = Buffer.alloc(12, 0);
  const bit = index % 96;
  bytes[Math.floor(bit / 8)] |= 1 << (bit % 8);
  return bytes.toString("base64");
}
