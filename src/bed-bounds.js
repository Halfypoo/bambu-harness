import { LIMITS } from "./allow.js";
import { fail } from "./errors.js";
import { isSlicedLayerMarker } from "./gcode-summary.js";
import { forEachZipEntryLine, plateGcodePath } from "./gcode3mf.js";
import { A1_MINI_LIMITS, resolvePrinterLimits } from "./printer-limits.js";

export const A1_MINI_BOUNDS = A1_MINI_LIMITS;
export const PRINTER_BOUNDS = Object.freeze({ "a1-mini": A1_MINI_LIMITS });

/** Exact value required by `--skip-bounds-check=` so the override is hard to pass by accident. */
export const SKIP_BOUNDS_CHECK_VALUE = "I_UNDERSTAND_BED_CRASH_RISK";

/** Number, optional exponent. `+` is required: `Y+200` is valid G-code and must not be dropped. */
const NUM_SRC = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const AXIS_RE = new RegExp(`([XYZEFIJKR])\\s*(${NUM_SRC})`, "gi");
const WORD_RE = new RegExp(`([A-Za-z])\\s*(${NUM_SRC})?`, "g");
const END_MARKER_RE = /^;\s*(filament end gcode|MACHINE_END_GCODE_START|EXECUTABLE_BLOCK_END)\b/i;
const SKIPPABLE_START_RE = /^;\s*SKIPPABLE_START\b/i;
const SKIPPABLE_END_RE = /^;\s*SKIPPABLE_END\b/i;

export function resolvePrinterBounds(model) {
  const found = resolvePrinterLimits(model);
  if (!found) {
    fail(`unknown printer bounds model "${model}". Known: a1-mini`, {
      exitCode: 4,
      code: "bad_args",
    });
  }
  return found;
}

export function parseSkipBoundsCheck(options) {
  if (options["skip-bounds-check"] === undefined) return false;
  const value = String(options["skip-bounds-check"]);
  if (value !== SKIP_BOUNDS_CHECK_VALUE) {
    fail(
      `--skip-bounds-check requires the exact value ${SKIP_BOUNDS_CHECK_VALUE} (refusing a silent override that can crash the bed into its stop)`,
      { exitCode: 4, code: "bad_args" },
    );
  }
  return true;
}

export function parseWordMap(code) {
  const out = {};
  AXIS_RE.lastIndex = 0;
  let match;
  while ((match = AXIS_RE.exec(code))) {
    out[match[1].toUpperCase()] = Number(match[2]);
  }
  return out;
}

/** Drop `;` comments and `(...)` comments before parsing words. */
export function stripGcodeComments(line) {
  let out = "";
  let depth = 0;
  for (const ch of String(line ?? "")) {
    if (depth === 0 && ch === ";") break;
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out.trim();
}

/**
 * Words in order. Values keep exponents (`Y2E2` → 200) so a truncated read cannot fail open.
 * A letter with no value (G28 X, M211 S) yields value null.
 */
export function tokenizeGcodeWords(code) {
  const words = [];
  WORD_RE.lastIndex = 0;
  let match;
  while ((match = WORD_RE.exec(code))) {
    const letter = match[1].toUpperCase();
    const value = match[2] === undefined ? null : Number(match[2]);
    words.push({ letter, value });
  }
  return words;
}

function gCodeKey(num) {
  if (num == null || !Number.isFinite(num)) return null;
  const rounded = Math.round(num * 1000) / 1000;
  if (Math.abs(rounded - Math.trunc(rounded)) < 1e-9) return String(Math.trunc(rounded));
  return String(rounded);
}

/** Group a line into G/M commands with their parameters. A leading N word is a line number. */
export function groupGcodeCommands(code) {
  const words = tokenizeGcodeWords(stripGcodeComments(code));
  const cmds = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i === 0 && w.letter === "N") continue;
    if (w.letter === "G" || w.letter === "M") {
      if (cur) cmds.push(cur);
      cur = { letter: w.letter, key: gCodeKey(w.value), params: {} };
    } else if (cur) {
      cur.params[w.letter] = w.value;
    }
  }
  if (cur) cmds.push(cur);
  return cmds;
}

/**
 * Center offset (I/J) for an R-form arc. Null when the radius cannot reach the endpoint
 * (caller must hard-fail — treating it as a straight chord fails open).
 */
export function ijFromRadius(startX, startY, endX, endY, radius, clockwise) {
  if (startX == null || startY == null || !Number.isFinite(radius)) return null;
  const dx = endX - startX;
  const dy = endY - startY;
  const d = Math.hypot(dx, dy);
  if (!(d > 1e-9)) return null;
  if (Math.abs(radius) < d / 2 - 1e-4) return null;
  const r = Math.abs(radius);
  const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
  const ux = -dy / d;
  const uy = dx / d;
  let sign = clockwise ? -1 : 1;
  if (radius < 0) sign = -sign;
  const cx = (startX + endX) / 2 + sign * h * ux;
  const cy = (startY + endY) / 2 + sign * h * uy;
  return { i: cx - startX, j: cy - startY, r };
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function nextAxis(current, deltaOrAbs, absolute) {
  if (deltaOrAbs === undefined) return current;
  if (absolute || current === null) return deltaOrAbs;
  return current + deltaOrAbs;
}

/**
 * Sample an arc (G2/G3 with I/J) and return extrema plus the endpoint.
 */
export function arcBounds(startX, startY, endX, endY, i, j, clockwise, samples = 64) {
  if (startX === null || startY === null) {
    return { minX: endX, maxX: endX, minY: endY, maxY: endY, endX, endY };
  }
  if (i === undefined || j === undefined) {
    return {
      minX: Math.min(startX, endX),
      maxX: Math.max(startX, endX),
      minY: Math.min(startY, endY),
      maxY: Math.max(startY, endY),
      endX,
      endY,
    };
  }
  const cx = startX + i;
  const cy = startY + j;
  const r0 = Math.hypot(startX - cx, startY - cy);
  const a0 = Math.atan2(startY - cy, startX - cx);
  let a1 = Math.atan2(endY - cy, endX - cx);
  if (clockwise) {
    if (a1 >= a0) a1 -= Math.PI * 2;
  } else if (a1 <= a0) {
    a1 += Math.PI * 2;
  }
  let minX = Math.min(startX, endX);
  let maxX = Math.max(startX, endX);
  let minY = Math.min(startY, endY);
  let maxY = Math.max(startY, endY);
  const consider = (px, py) => {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  };
  const steps = Math.max(8, samples);
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const a = a0 + (a1 - a0) * t;
    consider(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
  }
  // Exact axis extrema. Sampling alone can miss a bulge that leaves the bed between samples.
  const sweep = a1 - a0;
  for (const ang of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    let delta = ang - a0;
    if (sweep >= 0) {
      while (delta < -1e-9) delta += Math.PI * 2;
      if (delta <= sweep + 1e-9) consider(cx + r0 * Math.cos(ang), cy + r0 * Math.sin(ang));
    } else {
      while (delta > 1e-9) delta -= Math.PI * 2;
      if (delta >= sweep - 1e-9) consider(cx + r0 * Math.cos(ang), cy + r0 * Math.sin(ang));
    }
  }
  return { minX, maxX, minY, maxY, endX, endY, cx, cy, r: r0, sweep };
}

/** True arc length for G2/G3 with I/J (falls back to chord when I/J missing). */
export function arcLength(startX, startY, endX, endY, i, j, clockwise) {
  if (startX == null || startY == null || endX == null || endY == null) {
    return Math.hypot((endX ?? 0) - (startX ?? 0), (endY ?? 0) - (startY ?? 0));
  }
  if (i === undefined || j === undefined) {
    return Math.hypot(endX - startX, endY - startY);
  }
  const cx = startX + i;
  const cy = startY + j;
  const r = Math.hypot(startX - cx, startY - cy);
  if (r < 1e-9) return 0;
  const a0 = Math.atan2(startY - cy, startX - cx);
  let a1 = Math.atan2(endY - cy, endX - cx);
  if (clockwise) {
    if (a1 >= a0) a1 -= Math.PI * 2;
  } else if (a1 <= a0) {
    a1 += Math.PI * 2;
  }
  return Math.abs(a1 - a0) * r;
}

function violation(kind, axis, value, min, max, line, lineNo, phase, extruding) {
  return {
    kind,
    axis,
    value: round3(value),
    min,
    max,
    lineNo,
    phase,
    extruding: Boolean(extruding),
    line: String(line).slice(0, 160),
  };
}

function isEndMarker(line) {
  return END_MARKER_RE.test(line);
}

/** Normalize an M211 command for comparison with the stock start whitelist. */
export function normalizeM211(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/M211$/, "M211");
}

/**
 * Stock A1 mini start G-code runs `M211 X0 Y0 Z0` (software endstops OFF). After that,
 * this harness bed-bounds check is the only guard against driving the bed into its stop.
 * Allowed in start/end only: M211 X0 Y0 Z0, M211 S (push), M211 R (pop).
 */
export function isStockStartM211(code, limits = A1_MINI_LIMITS) {
  const norm = normalizeM211(code);
  const allowed = (limits.stockStartM211 || ["M211 X0 Y0 Z0", "M211 S", "M211 R"]).map((s) =>
    normalizeM211(s),
  );
  return allowed.includes(norm);
}

/**
 * Walk G-code lines and collect hard XY/Z / extrusion violations.
 * Bambu Studio ignores travel for outside-plate; we check ALL print-phase moves.
 *
 * Note on M211: stock start disables firmware soft endstops (`M211 X0 Y0 Z0`), so
 * out-of-bed travels will slam the mechanical stop unless this check refuses them.
 */
export function analyzeMoves(lines, limits = A1_MINI_LIMITS) {
  let absolute = true;
  let relativeE = true;
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let feed = 0;
  let phase = "start";
  let inSkippable = false;
  let moveCount = 0;
  let printMoveCount = 0;
  const violations = [];
  const warnings = [];
  const infos = [];
  const maxReport = 40;
  let extrusionMinX = Infinity;
  let extrusionMinY = Infinity;
  let extrusionMaxX = -Infinity;
  let extrusionMaxY = -Infinity;
  let extrusionMoves = 0;
  let extrudedEMm = 0; // net extrusion (retracts subtract; unretract recovery cancels)
  // G92 X/Y/Z changes logical position without moving. Machine = logical + shift.
  // Checking only the logical value fails open (G92 X0 at X100, then G1 X90 is machine X190).
  let shiftX = 0;
  let shiftY = 0;
  let shiftZ = 0;
  let zBaby = 0;
  let sawPrint = false;
  let arcPlane = "XY";
  const env = limits.startEndEnvelope;
  let enterEndAfterThisLine = false;

  const pushV = (item) => {
    if (violations.length < maxReport) violations.push(item);
  };
  const pushI = (item) => {
    if (infos.length < maxReport) infos.push(item);
  };
  const pushW = (item) => {
    if (warnings.length < maxReport) warnings.push(item);
  };

  let lineNo = 0;
  for (const rawLine of lines) {
    const raw = String(rawLine).replace(/\r$/, "");
    lineNo += 1;
    // End-marker comment stays in the prior phase; the following line is the first "end" line.
    if (enterEndAfterThisLine) {
      phase = "end";
      enterEndAfterThisLine = false;
    }
    if (phase === "start" && isSlicedLayerMarker(raw)) {
      phase = "print";
      sawPrint = true;
    }
    if ((phase === "start" || phase === "print") && isEndMarker(raw)) enterEndAfterThisLine = true;
    // Stock Bambu ; SKIPPABLE_START … ; SKIPPABLE_END wraps timelapse + head_wrap_detect parks
    // (X≈-13 safe pos, X≈187 clog-detect). M623 only closes M622 conditionals, not the section.
    if (SKIPPABLE_START_RE.test(raw)) inSkippable = true;
    if (SKIPPABLE_END_RE.test(raw)) inSkippable = false;

    const commands = groupGcodeCommands(raw);
    if (!commands.length) continue;

    for (const cmd of commands) {
      const name = `${cmd.letter}${cmd.key ?? ""}`;
      const params = cmd.params;
      const has = (k) => Object.prototype.hasOwnProperty.call(params, k);
      const num = (k) => (has(k) && params[k] != null && Number.isFinite(params[k]) ? params[k] : undefined);

      if (name === "G90") { absolute = true; continue; }
      if (name === "G91") { absolute = false; continue; }
      if (name === "G90.1" || name === "G91.1") {
        pushV({ kind: "coord", axis: name, value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `${name} (arc I/J mode) is unsupported; refusing rather than guessing the arc center` });
        continue;
      }
      if (name === "M82") { relativeE = false; continue; }
      if (name === "M83") { relativeE = true; continue; }
      if (name === "G17") { arcPlane = "XY"; continue; }
      if (name === "G18" || name === "G19") {
        arcPlane = name === "G18" ? "XZ" : "YZ";
        pushV({ kind: "coord", axis: name, value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `${name} selects a non-XY arc plane; I/J would be checked on the wrong axes` });
        continue;
      }
      if (name === "G53" || /^G5[5-9]$/.test(name)) {
        pushV({ kind: "coord", axis: name, value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `${name} changes the coordinate system; refusing so a workspace offset cannot hide an off-bed move` });
        continue;
      }
      if (name === "G54") continue;
      if (name === "G92.1") {
        x += shiftX; y += shiftY; z += shiftZ;
        shiftX = 0; shiftY = 0; shiftZ = 0;
        continue;
      }
      if (name === "G10" || name === "G11") {
        if (params.L === 2 || params.L === 20 || num("X") !== undefined || num("Y") !== undefined) {
          pushV({ kind: "coord", axis: name, value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `${name} workspace offset or XY move is unsupported` });
        }
        continue;
      }
      if (name === "G92") {
        if (num("X") !== undefined) { shiftX += x - num("X"); x = num("X"); }
        if (num("Y") !== undefined) { shiftY += y - num("Y"); y = num("Y"); }
        if (num("Z") !== undefined) { shiftZ += z - num("Z"); z = num("Z"); }
        if (num("E") !== undefined) e = num("E");
        continue;
      }
      if (name === "M290") {
        if (num("Z") !== undefined) zBaby += num("Z");
        const mz = z + shiftZ + zBaby;
        if (phase === "print" && (mz < limits.zMin - 1e-6 || mz > limits.zMax + 1e-6)) {
          pushV(violation("z", "Z", mz, limits.zMin, limits.zMax, raw, lineNo, phase, false));
        }
        continue;
      }
      if (name === "M211") {
        const bits = ["M211"];
        for (const k of ["X", "Y", "Z", "S", "R"]) {
          if (!has(k)) continue;
          bits.push(params[k] == null ? k : `${k}${params[k]}`);
        }
        if (phase === "print" || !isStockStartM211(bits.join(" "), limits)) {
          pushV({ kind: "m211", axis: "M211", value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `Refusing M211 in ${phase} (stock start may use M211 X0 Y0 Z0 / S / R only; after start this harness is the bed-crash guard)` });
        }
        continue;
      }
      if (name === "M204") {
        const accel = num("S") ?? num("P") ?? num("T") ?? num("R");
        if (phase === "print" && accel !== undefined && accel > limits.maxAccelXy) {
          pushI({ kind: "accel", value: accel, max: limits.maxAccelXy, lineNo, phase, line: raw.slice(0, 160), note: "M204 above machine_max_acceleration_x/y (info; unverified on hardware)", severity: "info" });
        }
        continue;
      }
      if (name === "G28" || name === "G29" || name === "G30") {
        if (phase === "print") {
          pushV({ kind: "homing", axis: name, value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `${name} during the print phase is refused (homing/probe leaves position unknown and can leave the bed)` });
        } else if (name === "G28") {
          const all = !has("X") && !has("Y") && !has("Z");
          if (all || has("X")) { x = 0; shiftX = 0; }
          if (all || has("Y")) { y = 0; shiftY = 0; }
          if (all || has("Z")) { z = 0; shiftZ = 0; }
        }
        continue;
      }

      const isLinear = name === "G0" || name === "G1" || name === "G380";
      const isArc = name === "G2" || name === "G3";
      if (!isLinear && !isArc) continue;

      for (const axis of ["X", "Y", "Z", "E", "F", "I", "J", "R"]) {
        if (has(axis) && params[axis] != null && !Number.isFinite(params[axis])) {
          pushV({ kind: "number", axis, value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: raw.slice(0, 160), message: `Non-finite ${axis} value at line ${lineNo}` });
        }
      }

      if (num("F") !== undefined) feed = num("F");
      const nextX = nextAxis(x, num("X"), absolute);
      const nextY = nextAxis(y, num("Y"), absolute);
      const nextZ = nextAxis(z, num("Z"), absolute);
      let extruding = false;
      let eDelta = 0;
      if (num("E") !== undefined) {
        if (relativeE) {
          eDelta = num("E");
          extruding = num("E") > 1e-9;
          e += num("E");
        } else {
          eDelta = num("E") - e;
          extruding = num("E") > e + 1e-9;
          e = num("E");
        }
        if (phase === "print") extrudedEMm += eDelta;
      }

      moveCount += 1;
      if (phase === "print") printMoveCount += 1;

      const commandedX = num("X") !== undefined;
      const commandedY = num("Y") !== undefined;
      const commandedZ = num("Z") !== undefined;
      const inStartEnd = phase === "start" || phase === "end";
      // Closed SKIPPABLE blocks are timelapse parks (X≈-13 / X≈187). Y stays on the bed.
      const skippableTravel = phase === "print" && inSkippable && !extruding;
      const inWhitelistPhase = inStartEnd || skippableTravel;
      const checkXY = (px, py, checkX, checkY) => {
        const mx = px + shiftX;
        const my = py + shiftY;
        if (!Number.isFinite(mx) || !Number.isFinite(my)) {
          pushV({ kind: "number", axis: "XY", value: 0, min: 0, max: 0, lineNo, phase, extruding, line: raw.slice(0, 160), message: `Non-finite machine position at line ${lineNo}` });
          return;
        }
        if (skippableTravel) {
          if (checkX && (mx < env.xMin - 1e-6 || mx > env.xMax + 1e-6)) pushV(violation("xy_all", "X", mx, env.xMin, env.xMax, raw, lineNo, phase, extruding));
          if (checkY && (my < limits.yMin - 1e-6 || my > limits.yMax + 1e-6)) pushV(violation("xy_all", "Y", my, limits.yMin, limits.yMax, raw, lineNo, phase, extruding));
          return;
        }
        if (inStartEnd) {
          if (checkX && (mx < env.xMin - 1e-6 || mx > env.xMax + 1e-6)) pushV(violation("xy_all", "X", mx, env.xMin, env.xMax, raw, lineNo, phase, extruding));
          if (checkY && (my < env.yMin - 1e-6 || my > env.yMax + 1e-6)) pushV(violation("xy_all", "Y", my, env.yMin, env.yMax, raw, lineNo, phase, extruding));
          return;
        }
        if (checkX && (mx < limits.xMin - 1e-6 || mx > limits.xMax + 1e-6)) pushV(violation("xy_all", "X", mx, limits.xMin, limits.xMax, raw, lineNo, phase, extruding));
        if (checkY && (my < limits.yMin - 1e-6 || my > limits.yMax + 1e-6)) pushV(violation("xy_all", "Y", my, limits.yMin, limits.yMax, raw, lineNo, phase, extruding));
      };

      if (isArc) {
        let iOff = num("I");
        let jOff = num("J");
        if (iOff === undefined && jOff === undefined && num("R") !== undefined) {
          const conv = ijFromRadius(x, y, nextX, nextY, num("R"), name === "G2");
          if (!conv) {
            pushV({ kind: "arc", axis: "R", value: num("R"), min: 0, max: 0, lineNo, phase, extruding, line: raw.slice(0, 160), message: `R-form arc cannot reach its endpoint at line ${lineNo}` });
          } else {
            iOff = conv.i;
            jOff = conv.j;
          }
        } else if (iOff === undefined && jOff === undefined) {
          pushV({ kind: "arc", axis: "IJ", value: 0, min: 0, max: 0, lineNo, phase, extruding, line: raw.slice(0, 160), message: `Arc at line ${lineNo} has no I/J or R` });
        }
        const arc = arcBounds(x, y, nextX, nextY, iOff, jOff, name === "G2");
        checkXY(arc.minX, arc.minY, true, true);
        checkXY(arc.maxX, arc.maxY, true, true);
        checkXY(nextX, nextY, true, true);
        const turns = num("P");
        if (turns !== undefined && turns >= 1 && Number.isFinite(arc.r)) {
          checkXY(arc.cx - arc.r, arc.cy - arc.r, true, true);
          checkXY(arc.cx + arc.r, arc.cy + arc.r, true, true);
        }
      } else {
        checkXY(nextX, nextY, commandedX, commandedY);
      }

      if (!inWhitelistPhase && commandedZ && nextZ !== null) {
        const mz = nextZ + shiftZ + zBaby;
        if (mz < limits.zMin - 1e-6 || mz > limits.zMax + 1e-6) {
          pushV(violation("z", "Z", mz, limits.zMin, limits.zMax, raw, lineNo, phase, extruding));
        }
      }

      const machX = nextX + shiftX;
      const machY = nextY + shiftY;
      if (!inWhitelistPhase && extruding && nextX !== null && nextY !== null) {
        if (machX < limits.xMin - 1e-6 || machX > limits.xMax + 1e-6 || machY < limits.yMin - 1e-6 || machY > limits.yMax + 1e-6) {
          pushV(violation("extrusion_xy", "XY", machY < limits.yMin || machY > limits.yMax ? machY : machX, limits.xMin, limits.xMax, raw, lineNo, phase, true));
        }
      }
      if (phase === "print" && extruding && nextX !== null && nextY !== null) {
        extrusionMoves += 1;
        extrusionMinX = Math.min(extrusionMinX, machX);
        extrusionMinY = Math.min(extrusionMinY, machY);
        extrusionMaxX = Math.max(extrusionMaxX, machX);
        extrusionMaxY = Math.max(extrusionMaxY, machY);
      }

      if (phase === "print" && num("F") !== undefined) {
        const mms = num("F") / 60;
        const isZOnly = commandedZ && !commandedX && !commandedY;
        const isTravel = !extruding;
        let cap; let note; let asInfo = false;
        if (isZOnly) { cap = limits.maxSpeedZMms; note = "Z feedrate above machine_max_speed_z (info; Z cap unverified)"; asInfo = true; }
        else if (isTravel) { cap = limits.maxTravelSpeedXyMms ?? limits.maxSpeedXyMms; note = "XY travel feedrate above machine travel limit (warning)"; }
        else { cap = limits.maxSpeedXyMms; note = "XY extruding feedrate above machine_max_speed_x/y (warning)"; }
        if (mms > cap + 1e-6) {
          const item = { kind: "feedrate", value: round3(mms), max: cap, lineNo, phase, line: raw.slice(0, 160), note, severity: asInfo ? "info" : "warning" };
          if (asInfo) pushI(item); else pushW(item);
        }
      }

      if (phase === "print" && extruding && eDelta > 0 && feed > 0 && (commandedX || commandedY || isArc)) {
        const filamentArea = Math.PI * (1.75 / 2) ** 2;
        let dist;
        if (isArc) {
          const xy = arcLength(x, y, nextX, nextY, num("I"), num("J"), name === "G2");
          dist = Math.hypot(xy, Math.abs((nextZ ?? z) - (z ?? 0)));
        } else {
          dist = Math.hypot((nextX ?? x) - x, (nextY ?? y) - y, (nextZ ?? z) - z);
        }
        if (dist > 1e-6) {
          const minutes = dist / Math.max(feed, 1);
          const mm3s = (eDelta * filamentArea) / (minutes * 60);
          if (mm3s > (limits.plaVolumetricMm3s || 21) + 0.5) {
            pushW({ kind: "volumetric", value: round3(mm3s), max: limits.plaVolumetricMm3s, lineNo, phase, line: raw.slice(0, 160), note: "Implied volumetric flow above filament_max_volumetric_speed (warning; PLA Basic 21)" });
          }
        }
      }

      x = nextX;
      y = nextY;
      z = nextZ;
    }
  }

  if (!sawPrint) {
    pushV({ kind: "no_print_phase", axis: "phase", value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: "", message: "Plate gcode never entered the print phase (no ; CHANGE_LAYER / layer marker). Refusing: otherwise every move is checked only against the loose start envelope." });
  }
  if (inSkippable) {
    pushV({ kind: "skippable", axis: "SKIPPABLE", value: 0, min: 0, max: 0, lineNo, phase, extruding: false, line: "", message: "SKIPPABLE_START was never closed with SKIPPABLE_END; refusing an open travel whitelist" });
  }

  return {
    ok: violations.length === 0,
    moveCount,
    printMoveCount,
    violationCount: violations.length,
    violations,
    warnings,
    infos,
    extrudedEMm: round3(Math.max(0, extrudedEMm)),
    extrusion: {
      moves: extrusionMoves,
      min: extrusionMoves ? [round3(extrusionMinX), round3(extrusionMinY)] : null,
      max: extrusionMoves ? [round3(extrusionMaxX), round3(extrusionMaxY)] : null,
    },
    limits: {
      xMin: limits.xMin,
      xMax: limits.xMax,
      yMin: limits.yMin,
      yMax: limits.yMax,
      zMin: limits.zMin,
      zMax: limits.zMax,
      startBrushYMax: limits.startBrushYMax,
    },
  };
}

export function validateGcodeBedBounds(gcodeText, bounds = A1_MINI_LIMITS) {
  const limits = { ...A1_MINI_LIMITS, ...bounds };
  return analyzeMoves(String(gcodeText || "").split(/\r\n|\n|\r/), limits);
}

/**
 * Stream-parse Metadata/plate_N.gcode inside a .gcode.3mf and validate bed bounds.
 * Handles plate entries larger than the usual 4 MiB inspect cap by streaming lines.
 */
export function validateGcode3mfBedBounds(buf, { plate = 1, bounds = A1_MINI_LIMITS } = {}) {
  const limits = { ...A1_MINI_LIMITS, ...bounds };
  const platePath = plateGcodePath(plate);
  const lines = [];
  const found = forEachZipEntryLine(
    buf,
    platePath,
    (raw) => {
      lines.push(raw);
    },
    { maxBytes: LIMITS.maxPlateGcodeBytes },
  );
  if (!found) {
    fail(`missing ${platePath} inside the 3mf`, { exitCode: 4, code: "bad_3mf" });
  }
  const result = analyzeMoves(lines, limits);
  return { ...result, platePath, model: limits.id };
}

export function assertBedBoundsOrFail(result, { skipped = false } = {}) {
  if (skipped) {
    return {
      skipped: true,
      warning:
        "BED BOUNDS CHECK SKIPPED via --skip-bounds-check=I_UNDERSTAND_BED_CRASH_RISK. Out-of-bed travels can drive the bed into its mechanical stop at full speed.",
    };
  }
  if (result.ok) {
    return { skipped: false, ok: true, moveCount: result.moveCount, platePath: result.platePath ?? null };
  }
  const first = result.violations[0];
  const where = first
    ? `${first.axis}=${first.value} at line ${first.lineNo} (${first.phase}; allowed ${first.min}..${first.max})`
    : "unknown move";
  fail(
    `Bed bounds check failed: ${result.violationCount} out-of-range move(s). First: ${where}. Refusing to print. Rebuild the plate with bambu plate, or pass --skip-bounds-check=${SKIP_BOUNDS_CHECK_VALUE} only if you accept a bed-crash risk.`,
    {
      exitCode: 4,
      code: "bed_bounds",
      details: {
        model: result.model ?? "a1-mini",
        platePath: result.platePath ?? null,
        violationCount: result.violationCount,
        violations: result.violations,
        limits: result.limits,
      },
    },
  );
}

export function clampTravelXY(x, y, bounds = A1_MINI_LIMITS) {
  const lo = bounds.travelClampMin ?? 2;
  const hi = bounds.travelClampMax ?? bounds.xMax - 2;
  return {
    x: Math.min(hi, Math.max(lo, x)),
    y: Math.min(hi, Math.max(lo, y)),
  };
}

export function pointInPrintable(x, y, bounds = A1_MINI_LIMITS) {
  return x >= bounds.xMin - 1e-6 && x <= bounds.xMax + 1e-6 && y >= bounds.yMin - 1e-6 && y <= bounds.yMax + 1e-6;
}
