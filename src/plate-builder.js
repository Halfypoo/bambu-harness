import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { LIMITS } from "./allow.js";
import { arcBounds, parseWordMap, validateGcodeBedBounds } from "./bed-bounds.js";
import { fail } from "./errors.js";
import {
  forEachZipEntryLine,
  listZip,
  makeStoredZip,
  plateGcodePath,
  readZipEntry,
  zipEntryCompressedBytes,
} from "./gcode3mf.js";
import {
  m624ForObjectIndex,
  parseHeaderTimeSec,
  parseHeaderWeightG,
  retargetGcodeLines,
  sumExtrudedE,
} from "./gcode-retarget.js";
import { lookupFilamentDefaults } from "./filament-defaults.js";
import { validatePrintPreflight } from "./preflight.js";
import { A1_MINI_LIMITS } from "./printer-limits.js";

const OBJECT_START = /^;\s*start printing object, unique label id:\s*(\d+)\s*$/;
const OBJECT_STOP = /^;\s*stop printing object/;
const LAYER_CHANGE = /^;\s*CHANGE_LAYER\s*$/;
const END_START = /^;\s*(filament end gcode|MACHINE_END_GCODE_START)\b/i;

function readAllPlateLines(buf, plate = 1) {
  const platePath = plateGcodePath(plate);
  const lines = [];
  const found = forEachZipEntryLine(buf, platePath, (line) => lines.push(line), {
    maxBytes: LIMITS.maxPlateGcodeBytes,
  });
  if (!found) fail(`missing ${platePath} inside the 3mf`, { exitCode: 4, code: "bad_3mf" });
  return { platePath, lines };
}

function splitHeaderBodyTail(lines) {
  const firstLayer = lines.findIndex((line) => LAYER_CHANGE.test(line));
  if (firstLayer < 0) fail("plate gcode has no ; CHANGE_LAYER marker", { exitCode: 4, code: "bad_gcode" });
  const endStart = lines.findIndex((line, idx) => idx > firstLayer && END_START.test(line));
  const endIdx = endStart < 0 ? lines.length : endStart;
  return {
    header: lines.slice(0, firstLayer),
    body: lines.slice(firstLayer, endIdx),
    tail: lines.slice(endIdx),
  };
}

/**
 * Yield ('x', lines) for non-object segments and (oid, lines) for object toolpath blocks.
 * Mirrors the ad-hoc gparse.stream() used by tile2.py.
 */
export function streamObjectBlocks(bodyLines) {
  const out = [];
  let i = 0;
  let buf = [];
  const n = bodyLines.length;
  while (i < n) {
    const line = bodyLines[i];
    const match = OBJECT_START.exec(line);
    if (!match) {
      buf.push(line);
      i += 1;
      continue;
    }
    if (buf.length) {
      out.push({ kind: "x", lines: buf });
      buf = [];
    }
    const oid = Number(match[1]);
    i += 1;
    if (i < n && bodyLines[i].startsWith("M624")) i += 1;
    let blk = [];
    let orphan = false;
    while (i < n && !OBJECT_STOP.test(bodyLines[i])) {
      const cur = bodyLines[i];
      if (LAYER_CHANGE.test(cur)) {
        out.push({ kind: "object", id: oid, lines: blk });
        blk = [];
        const hdr = [cur];
        if (i + 1 < n) hdr.push(bodyLines[i + 1]);
        if (i + 2 < n) hdr.push(bodyLines[i + 2]);
        i += 3;
        out.push({ kind: "x", lines: hdr });
        orphan = true;
        continue;
      }
      if (orphan) {
        if (cur.startsWith("G1") && /\sE-?(?:\d|\.)/.test(` ${cur}`)) {
          const words = cur.split(";", 1)[0].split(/\s+/).filter(Boolean);
          const e = words.find((w) => w[0] === "E");
          const f = words.find((w) => w[0] === "F");
          if (e) blk.push(`G1 ${e}${f ? ` ${f}` : ""}`);
          else blk.push(cur);
        } else if (/^G1\s+F/.test(cur)) blk.push(cur);
        else blk.push(cur);
      } else {
        blk.push(cur);
      }
      i += 1;
    }
    i += 1; // stop comment
    if (i < n && bodyLines[i] === "M625") i += 1;
    if (!orphan) out.push({ kind: "object", id: oid, lines: blk });
  }
  if (buf.length) out.push({ kind: "x", lines: buf });
  return out;
}

function motionCode(line) {
  const code = String(line || "").split(";", 1)[0].trim();
  const match = /^G(\d+)/i.exec(code);
  if (!match) return "";
  const n = Number(match[1]);
  if (n === 0 || n === 1 || n === 2 || n === 3) return `G${n}`;
  return "";
}

function isMotionLine(line) {
  return motionCode(line) !== "";
}

function hasPositiveE(line) {
  const code = line.split(";", 1)[0];
  const parsed = parseWordMap(code);
  return parsed.E !== undefined && parsed.E > 1e-9;
}

function hasXY(line) {
  const parsed = parseWordMap(line.split(";", 1)[0]);
  return parsed.X !== undefined || parsed.Y !== undefined;
}

/**
 * Drop copied pre-extrusion travel waypoints.
 * Travel target is the position just BEFORE the first extruding move (its start),
 * so arcs (G2/G3 I/J) and straight moves keep their original geometry.
 */
export function stripLeadInTravel(blockLines) {
  let x = null;
  let y = null;
  let firstExtrusionIndex = -1;
  let firstExtrusionStart = null;
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (!isMotionLine(line)) continue;
    const parsed = parseWordMap(line.split(";", 1)[0]);
    const startX = x;
    const startY = y;
    if (parsed.X !== undefined) x = parsed.X;
    if (parsed.Y !== undefined) y = parsed.Y;
    // First extruding move that commands XY (in-place unretract does not count).
    if (hasPositiveE(line) && hasXY(line)) {
      if (startX == null || startY == null) {
        fail(
          "object block starts extruding without a known prior XY (cannot compute arc/line start for clean travel-in)",
          { exitCode: 4, code: "bad_gcode" },
        );
      }
      firstExtrusionStart = { x: startX, y: startY };
      firstExtrusionIndex = i;
      break;
    }
  }
  if (!firstExtrusionStart) {
    return { lines: [...blockLines], firstExtrusionXY: null, dropped: 0 };
  }
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (i < firstExtrusionIndex && isMotionLine(line) && hasXY(line) && !hasPositiveE(line)) {
      const parsed = parseWordMap(line.split(";", 1)[0]);
      const zOnly = parsed.Z !== undefined && parsed.X === undefined && parsed.Y === undefined;
      const eOnly = parsed.E !== undefined && parsed.X === undefined && parsed.Y === undefined && parsed.Z === undefined;
      if (zOnly || eOnly) kept.push(line);
      else dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, firstExtrusionXY: firstExtrusionStart, dropped };
}

/** Shift X/Y on motion lines. Does not clamp — validator refuses out-of-bed results. */
export function shiftLine(line, dx, dy) {
  if (!line || line[0] !== "G") return line;
  const commentIdx = line.indexOf(";");
  const code = commentIdx === -1 ? line : line.slice(0, commentIdx);
  const cmt = commentIdx === -1 ? "" : line.slice(commentIdx);
  const parts = code.trim().split(/\s+/);
  if (!parts.length) return line;
  if (!motionCode(parts[0])) return line;
  const next = parts.map((word) => {
    const axis = word[0].toUpperCase();
    if (axis !== "X" && axis !== "Y") return word;
    const value = Number(word.slice(1));
    if (!Number.isFinite(value)) return word;
    const shifted = value + (axis === "X" ? dx : dy);
    return `${axis}${shifted.toFixed(3)}`;
  });
  const spacing = cmt.startsWith(";") ? " " : "";
  return `${next.join(" ")}${cmt ? spacing + cmt : ""}`;
}

/**
 * Extrusion AABB for one contiguous block. Resets modal X/Y so a stale point
 * from a previous copy/layer cannot leak into the bbox. Includes G2/G3 arc extrema.
 */
export function extrusionBBox(lines) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let x = null;
  let y = null;
  let hits = 0;
  const grow = (px, py) => {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  };
  for (const line of lines) {
    if (!isMotionLine(line)) continue;
    const code = line.split(";", 1)[0];
    const parsed = parseWordMap(code);
    const startX = x;
    const startY = y;
    if (parsed.X !== undefined) x = parsed.X;
    if (parsed.Y !== undefined) y = parsed.Y;
    // Only grow the bbox from extruding moves that command XY in this block.
    if (hasPositiveE(line) && x != null && y != null && hasXY(line)) {
      hits += 1;
      const head = motionCode(code);
      if ((head === "G2" || head === "G3") && startX != null && startY != null) {
        const arc = arcBounds(startX, startY, x, y, parsed.I, parsed.J, head === "G2");
        grow(arc.minX, arc.minY);
        grow(arc.maxX, arc.maxY);
      } else {
        grow(x, y);
        if (startX != null && startY != null) grow(startX, startY);
      }
    }
  }
  if (!hits) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function shelfPack(items, usable, gapMm) {
  const shelves = [];
  for (const item of items) {
    if (item.w > usable + 1e-9 || item.h > usable + 1e-9) return null;
    let placed = false;
    for (const shelf of shelves) {
      if (item.h > shelf.height + 1e-9) continue;
      const x = shelf.items.length === 0 ? 0 : shelf.xCursor + gapMm;
      if (x + item.w > usable + 1e-9) continue;
      shelf.items.push({ item, x });
      shelf.xCursor = x + item.w;
      placed = true;
      break;
    }
    if (!placed) {
      const y = shelves.length === 0 ? 0 : shelves[shelves.length - 1].y + shelves[shelves.length - 1].height + gapMm;
      shelves.push({ y, height: item.h, xCursor: item.w, items: [{ item, x: 0 }] });
    }
  }
  const totalH = shelves.length === 0 ? 0 : shelves[shelves.length - 1].y + shelves[shelves.length - 1].height;
  const totalW = shelves.reduce((m, s) => Math.max(m, s.xCursor), 0);
  return { shelves, totalH, totalW };
}

function placementsFromShelves(packed, objectStats, marginMm, bedMm, layout) {
  let originX = marginMm;
  let originY = marginMm;
  if (layout === "center") {
    originX = Math.max(marginMm, (bedMm - packed.totalW) / 2);
    originY = Math.max(marginMm, (bedMm - packed.totalH) / 2);
  }
  const placements = [];
  for (const shelf of packed.shelves) {
    for (const { item, x } of shelf.items) {
      const st = objectStats[item.id];
      placements.push({
        id: item.id,
        copy: item.copy,
        cx: originX + x + st.w / 2,
        cy: originY + shelf.y + st.h / 2,
      });
    }
  }
  return placements;
}

/** 2-object copies as pair rows. cols=1 is a 2×2 for two copies. */
function pairGridCandidates(ids, copies, objectStats, gapMm, usable) {
  if (ids.length !== 2) return [];
  const [a, b] = ids;
  const A = objectStats[a];
  const B = objectStats[b];
  const pairW = A.w + gapMm + B.w;
  const pairH = Math.max(A.h, B.h);
  const out = [];
  for (let cols = 1; cols <= copies; cols++) {
    const rows = Math.ceil(copies / cols);
    const totalW = cols * pairW + (cols - 1) * gapMm;
    const totalH = rows * pairH + (rows - 1) * gapMm;
    if (totalW > usable + 1e-9 || totalH > usable + 1e-9) continue;
    const shelves = [];
    for (let r = 0; r < rows; r++) {
      const items = [];
      let x = 0;
      for (let c = 0; c < cols; c++) {
        const copy = r * cols + c;
        if (copy >= copies) break;
        if (c > 0) x += gapMm;
        items.push({ item: { id: a, copy, w: A.w, h: A.h }, x });
        x += A.w + gapMm;
        items.push({ item: { id: b, copy, w: B.w, h: B.h }, x });
        x += B.w;
      }
      shelves.push({ y: r * (pairH + gapMm), height: pairH, xCursor: x, items });
    }
    const width = shelves.reduce((m, s) => Math.max(m, s.xCursor), 0);
    const height = shelves.length === 0 ? 0 : shelves[shelves.length - 1].y + shelves[shelves.length - 1].height;
    out.push({ shelves, totalW: width, totalH: height });
  }
  return out;
}

function preferPack(next, prev, layout) {
  if (layout === "front") {
    if (next.totalH !== prev.totalH) return next.totalH < prev.totalH;
    return next.totalW < prev.totalW;
  }
  const nextAspect = Math.abs(next.totalW - next.totalH);
  const prevAspect = Math.abs(prev.totalW - prev.totalH);
  if (Math.abs(nextAspect - prevAspect) > 1e-6) return nextAspect < prevAspect;
  const nextMax = Math.max(next.totalW, next.totalH);
  const prevMax = Math.max(prev.totalW, prev.totalH);
  if (Math.abs(nextMax - prevMax) > 1e-6) return nextMax < prevMax;
  return next.totalH < prev.totalH;
}

/**
 * Pack copies of selected objects onto the bed with gap and margin.
 * Tries several orderings (height-FFD, copy-major, type-major) and keeps the shortest fit.
 */
export function layoutCopies(objectStats, { copies = 1, gapMm = 4, marginMm = 5, bedMm = 180, objectIds = null, layout = "center" } = {}) {
  if (layout !== "center" && layout !== "front") {
    fail("--layout must be center or front", { exitCode: 4, code: "bad_args" });
  }
  if (copies < 1 || copies > 64) fail("--copies must be from 1 to 64", { exitCode: 4, code: "bad_args" });
  if (gapMm < 4) fail("gap must be >= 4 mm", { exitCode: 4, code: "bad_args" });
  if (marginMm < 5) fail("bed margin must be >= 5 mm", { exitCode: 4, code: "bad_args" });
  const ids = (objectIds ?? Object.keys(objectStats).map(Number)).map(Number).sort((a, b) => a - b);
  if (!ids.length) fail("source plate has no printable objects", { exitCode: 4, code: "bad_gcode" });
  for (const id of ids) {
    if (!objectStats[id]) fail(`object id ${id} not found in source plate`, { exitCode: 4, code: "bad_args" });
  }

  const usable = bedMm - 2 * marginMm;
  const items = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const id of ids) {
      const st = objectStats[id];
      items.push({ id, copy, w: st.w, h: st.h });
    }
  }

  const orderings = [
    [...items].sort((a, b) => b.h - a.h || b.w - a.w || a.id - b.id || a.copy - b.copy),
    [...items],
    [...items].sort((a, b) => a.id - b.id || a.copy - b.copy),
    // Alternate types within each copy index (A,B,A,B… by copy groups of ids).
    [...items].sort((a, b) => a.copy - b.copy || a.id - b.id),
  ];

  const candidates = [];
  for (const ordered of orderings) {
    const packed = shelfPack(ordered, usable, gapMm);
    if (packed) candidates.push(packed);
  }
  if (layout === "center") {
    candidates.push(...pairGridCandidates(ids, copies, objectStats, gapMm, usable));
  }

  let best = null;
  let bestEffort = null;
  for (const packed of candidates) {
    if (!bestEffort || packed.totalH < bestEffort.totalH) bestEffort = packed;
    if (packed.totalH <= usable + 1e-9 && packed.totalW <= usable + 1e-9) {
      if (!best || preferPack(packed, best, layout)) best = packed;
    }
  }

  if (!best) {
    const needW = (bestEffort?.totalW ?? items.reduce((m, it) => Math.max(m, it.w), 0)) + 2 * marginMm;
    const needH = (bestEffort?.totalH ?? items.reduce((s, it) => s + it.h, 0)) + 2 * marginMm;
    const missW = Math.max(0, needW - bedMm);
    const missH = Math.max(0, needH - bedMm);
    fail(
      `layout of ${copies} copies of [${ids.join(",")}] does not fit on ${bedMm}x${bedMm} mm with gap ${gapMm} and margin ${marginMm}: packed footprint needs ${needW.toFixed(1)}x${needH.toFixed(1)} mm (short by ${missW.toFixed(1)} mm in X, ${missH.toFixed(1)} mm in Y)`,
      { exitCode: 4, code: "layout", details: { needW, needH, missW, missH, usable, gapMm, marginMm } },
    );
  }

  return placementsFromShelves(best, objectStats, marginMm, bedMm, layout);
}

function rewriteLevelArea(header, levelArea) {
  return header.map((line) => {
    if (/^\s*G29\s+A1\b/.test(line) && levelArea) {
      const indent = line.match(/^\s*/)[0];
      return `${indent}G29 A1 X${levelArea.x0.toFixed(4)} Y${levelArea.y0.toFixed(4)} I${levelArea.i.toFixed(3)} J${levelArea.j.toFixed(3)}`;
    }
    return line;
  });
}

function xmlSafe(value) {
  return String(value ?? "").replace(/--/g, "—").replace(/[<>]/g, "").trim();
}

function setXmlAttr(attrs, key, value) {
  const re = new RegExp(`\\b${key}="[^"]*"`, "i");
  if (re.test(attrs)) return attrs.replace(re, `${key}="${value}"`);
  return `${attrs} ${key}="${value}"`;
}

function bedTemperatureNote({ bedC, plateType, filamentType }) {
  const temp = Number.isInteger(bedC) ? String(bedC) : String(bedC);
  const plate = xmlSafe(plateType) || "unspecified plate";
  const filament = xmlSafe(filamentType) || "unspecified filament";
  return `<!-- ; first_layer_bed_temperature = ${temp} (${plate}, ${filament}; matches M140/M190 S${temp} in plate_1.gcode) -->`;
}

function updateSliceInfo(text, { filament, weightG, timeSec, lengthM, bedC, plateType }) {
  let out = String(text || "");
  if (weightG != null) {
    out = out.replace(/(key="weight" value=")[^"]+/, `$1${Number(weightG).toFixed(2)}`);
    out = out.replace(/used_g="[^"]+"/g, `used_g="${Number(weightG).toFixed(2)}"`);
  }
  if (lengthM != null) {
    out = out.replace(/used_m="[^"]+"/g, `used_m="${Number(lengthM).toFixed(2)}"`);
  }
  if (timeSec != null) {
    out = out.replace(/(key="prediction" value=")[^"]+/, `$1${Math.round(timeSec)}`);
    out = out.replace(/(key="estimated_printing_time" value=")[^"]+/, `$1${Math.round(timeSec)}`);
  }
  if (filament?.type) {
    out = out.replace(/(<filament\b[^>]*\btype=")[^"]+/i, `$1${filament.type}`);
  }
  if (filament?.trayInfoIdx || filament?.colour) {
    out = out.replace(/<filament\b([^>]*?)\/?>/gi, (full, attrs) => {
      let next = attrs;
      if (filament.trayInfoIdx) next = setXmlAttr(next, "tray_info_idx", filament.trayInfoIdx);
      if (filament.colour) next = setXmlAttr(next, "color", filament.colour);
      return `<filament${next}/>`;
    });
  }
  if (bedC != null && Number.isFinite(bedC)) {
    const note = bedTemperatureNote({
      bedC,
      plateType,
      filamentType: filament?.type,
    });
    if (/<!--\s*;\s*first_layer_bed_temperature\s*=/.test(out)) {
      out = out.replace(/<!--\s*;\s*first_layer_bed_temperature\s*=[\s\S]*?-->/, note);
    } else if (out.includes("</config>")) {
      out = out.replace("</config>", `${note}\n</config>`);
    } else {
      out = `${out}${out.endsWith("\n") ? "" : "\n"}${note}\n`;
    }
  }
  return out;
}

function parseSliceUsedM(text) {
  const match = /\bused_m="([^"]+)"/i.exec(String(text || ""));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function normalizeFilamentOptions(filament) {
  if (!filament) return null;
  const out = { ...filament };
  const profile = lookupFilamentDefaults(out.type);
  if (profile) {
    if (out.rangeLow == null) out.rangeLow = profile.nozzleLow;
    if (out.rangeHigh == null) out.rangeHigh = profile.nozzleHigh;
    if (out.bedC == null) out.bedC = profile.bedC;
    if (out.volumetric == null) out.volumetric = profile.volumetric;
  }
  if (out.nozzleC != null && out.firstLayerC == null) out.firstLayerC = out.nozzleC;
  if (out.firstLayerC != null && out.nozzleC == null) out.nozzleC = out.firstLayerC;
  if (out.fanPercent != null && out.fan == null) {
    out.fan = Math.round((Math.min(100, Math.max(0, out.fanPercent)) / 100) * 255);
  }
  if (out.bridgeFanPercent != null && out.bridgeFan == null) {
    out.bridgeFan = Math.round((Math.min(100, Math.max(0, out.bridgeFanPercent)) / 100) * 255);
  }
  if (out.bridgeFan == null && out.fan != null) out.bridgeFan = out.fan;
  return out;
}

function inflateEntry(buf, entry) {
  const compressed = zipEntryCompressedBytes(buf, entry);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  fail(`unsupported zip compression method ${entry.method}`, { exitCode: 4, code: "bad_3mf" });
}

function parseObjectIdsOption(value) {
  if (value === undefined || value === null || value === "") return null;
  const ids = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (!/^\d+$/.test(part)) fail(`--objects entries must be integers (got "${part}")`, { exitCode: 4, code: "bad_args" });
      return Number(part);
    });
  return [...new Set(ids)];
}

/**
 * List printable objects found in a .gcode.3mf (gcode label ids + plate_1.json names/bboxes).
 */
export function listPlateObjects(buf, { plate = 1 } = {}) {
  const { lines } = readAllPlateLines(buf, plate);
  const { body } = splitHeaderBodyTail(lines);
  const segments = streamObjectBlocks(body);
  const byId = new Map();
  for (const seg of segments) {
    if (seg.kind !== "object") continue;
    if (!byId.has(seg.id)) byId.set(seg.id, []);
    byId.get(seg.id).push(seg.lines);
  }
  let jsonObjects = [];
  const jsonText = readZipEntry(buf, `Metadata/plate_${plate}.json`);
  if (jsonText) {
    try {
      const json = JSON.parse(jsonText.toString("utf8"));
      jsonObjects = Array.isArray(json.bbox_objects) ? json.bbox_objects : [];
    } catch {
      jsonObjects = [];
    }
  }
  const objects = [];
  for (const [id, blocks] of [...byId.entries()].sort((a, b) => a[0] - b[0])) {
    let bbox = null;
    for (const block of blocks) {
      const part = extrusionBBox(block);
      if (!part) continue;
      if (!bbox) bbox = { ...part };
      else {
        bbox.minX = Math.min(bbox.minX, part.minX);
        bbox.minY = Math.min(bbox.minY, part.minY);
        bbox.maxX = Math.max(bbox.maxX, part.maxX);
        bbox.maxY = Math.max(bbox.maxY, part.maxY);
        bbox.w = bbox.maxX - bbox.minX;
        bbox.h = bbox.maxY - bbox.minY;
        bbox.cx = (bbox.minX + bbox.maxX) / 2;
        bbox.cy = (bbox.minY + bbox.maxY) / 2;
      }
    }
    const meta = jsonObjects.find((o) => Number(o.id) === Number(id)) || null;
    objects.push({
      id,
      name: meta?.name ?? `object-${id}`,
      bbox: bbox ? [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] : meta?.bbox ?? null,
      width: bbox?.w ?? null,
      height: bbox?.h ?? null,
      blocks: blocks.length,
    });
  }
  return objects;
}

/**
 * Build a multi-copy plate from a sliced .gcode.3mf.
 * Drops lead-in travels, travels to the start of the first extruding move, runs preflight before write.
 */
export function buildPlate(buf, options = {}) {
  const copies = options.copies ?? 1;
  const gapMm = options.gapMm ?? 4;
  const marginMm = options.marginMm ?? 5;
  const liftMm = options.liftMm ?? 0.6;
  const layout = options.layout ?? "center";
  if (layout !== "center" && layout !== "front") {
    fail("--layout must be center or front", { exitCode: 4, code: "bad_args" });
  }
  const plate = options.plate ?? 1;
  const bounds = options.bounds ?? A1_MINI_LIMITS;
  const filament = normalizeFilamentOptions(options.filament ?? null);
  const selectedIds = parseObjectIdsOption(options.objects);

  const { lines } = readAllPlateLines(buf, plate);
  const { header, body, tail } = splitHeaderBodyTail(lines);
  const segments = streamObjectBlocks(body);

  const objectBlocks = new Map();
  for (const seg of segments) {
    if (seg.kind !== "object") continue;
    if (!objectBlocks.has(seg.id)) objectBlocks.set(seg.id, []);
    objectBlocks.get(seg.id).push(seg.lines);
  }
  const allIds = [...objectBlocks.keys()].sort((a, b) => a - b);
  if (selectedIds) {
    const missing = selectedIds.filter((id) => !objectBlocks.has(id));
    if (missing.length) {
      fail(
        `requested --objects ${missing.join(",")} not found in source. Available: ${allIds.join(",") || "(none)"}`,
        { exitCode: 4, code: "bad_args", details: { available: allIds, missing } },
      );
    }
  }
  const activeIds = selectedIds ?? allIds;
  if (!activeIds.length) fail("source plate has no printable objects", { exitCode: 4, code: "bad_gcode" });

  const objectStats = {};
  for (const id of activeIds) {
    let bbox = null;
    for (const block of objectBlocks.get(id)) {
      const part = extrusionBBox(block);
      if (!part) continue;
      if (!bbox) bbox = { ...part };
      else {
        bbox.minX = Math.min(bbox.minX, part.minX);
        bbox.minY = Math.min(bbox.minY, part.minY);
        bbox.maxX = Math.max(bbox.maxX, part.maxX);
        bbox.maxY = Math.max(bbox.maxY, part.maxY);
        bbox.w = bbox.maxX - bbox.minX;
        bbox.h = bbox.maxY - bbox.minY;
        bbox.cx = (bbox.minX + bbox.maxX) / 2;
        bbox.cy = (bbox.minY + bbox.maxY) / 2;
      }
    }
    if (!bbox) fail(`object ${id} has no extruding moves to measure`, { exitCode: 4, code: "bad_gcode" });
    objectStats[id] = bbox;
  }

  const placements = layoutCopies(objectStats, {
    copies,
    gapMm,
    marginMm,
    bedMm: bounds.bedMm,
    objectIds: activeIds,
    layout,
  });

  // Estimate scale from selected-object extrusion vs whole-plate extrusion, then × copies.
  const headerText = header.join("\n");
  const srcWeight = parseHeaderWeightG(headerText);
  const srcTime = parseHeaderTimeSec(headerText);
  let eSelected = 0;
  let eAll = 0;
  for (const seg of segments) {
    if (seg.kind !== "object") continue;
    const e = sumExtrudedE(seg.lines);
    eAll += e;
    if (activeIds.includes(seg.id)) eSelected += e;
  }
  const selectedFraction = eAll > 1e-6 ? eSelected / eAll : activeIds.length / Math.max(1, allIds.length);
  const weightG =
    srcWeight != null ? Number((srcWeight * selectedFraction * copies).toFixed(2)) : null;
  const timeSec = srcTime != null ? Math.round(srcTime * selectedFraction * copies) : null;
  const layerCount = body.filter((line) => LAYER_CHANGE.test(line)).length || null;
  const srcSliceText = readZipEntry(buf, "Metadata/slice_info.config")?.toString("utf8") ?? "";
  const srcUsedM = parseSliceUsedM(srcSliceText);
  let lengthM = null;
  if (srcUsedM != null) {
    lengthM = Number((srcUsedM * selectedFraction * copies).toFixed(2));
  } else if (weightG != null) {
    // Derive metres from grams for 1.75 mm PLA (~1.24 g/cm³).
    const plaGPerMm = (Math.PI * (1.75 / 2) ** 2) * 0.00124;
    lengthM = Number((weightG / plaGPerMm / 1000).toFixed(2));
  }

  // Stable tiled label ids per (source id, copy).
  const tiledIdByKey = new Map();
  let nextTiledId = 1;
  for (const place of placements) {
    const key = `${place.id}:${place.copy}`;
    if (!tiledIdByKey.has(key)) tiledIdByKey.set(key, nextTiledId++);
  }

  let z = 0.2;
  const outSegs = [];
  for (const seg of segments) {
    if (seg.kind === "x") {
      for (const line of seg.lines) {
        if (line.startsWith("; Z_HEIGHT:")) {
          const value = Number(line.split(":")[1]);
          if (Number.isFinite(value)) z = value;
        }
      }
      // Drop stale OBJECT_ID / layer object-id comments from interstitial segments.
      outSegs.push(
        seg.lines.filter(
          (line) => !/^;\s*OBJECT_ID\s*:/i.test(line) && !/^;\s*object ids of layer/i.test(line),
        ),
      );
      continue;
    }
    if (!activeIds.includes(seg.id)) continue;
    const stats = objectStats[seg.id];
    if (!stats) continue;
    const stripped = stripLeadInTravel(
      seg.lines.filter(
        (line) =>
          !/^M73\s+P/.test(line)
          && !/^M624\b/i.test(line)
          && !/^M625\b/i.test(line)
          && !/^;\s*OBJECT_ID\s*:/i.test(line),
      ),
    );
    for (const place of placements) {
      if (place.id !== seg.id) continue;
      const dx = place.cx - stats.cx;
      const dy = place.cy - stats.cy;
      const tiledId = tiledIdByKey.get(`${place.id}:${place.copy}`);
      const block = [
        `; start printing object, unique label id: ${tiledId}`,
        `M624 ${m624ForObjectIndex(tiledId)}`,
        `; source object ${seg.id} copy ${place.copy} at ${place.cx.toFixed(1)},${place.cy.toFixed(1)}`,
        `G1 Z${(z + liftMm).toFixed(2)} F3000`,
      ];
      if (stripped.firstExtrusionXY) {
        const tx = stripped.firstExtrusionXY.x + dx;
        const ty = stripped.firstExtrusionXY.y + dy;
        block.push(`G0 X${tx.toFixed(3)} Y${ty.toFixed(3)} F12000 ; clean travel-in to start of first extruding move`);
      }
      for (const line of stripped.lines) {
        block.push(shiftLine(line, dx, dy));
      }
      block.push(`; stop printing object, unique label id: ${tiledId}`);
      block.push("M625");
      outSegs.push(block);
    }
  }

  let lastObj = -1;
  for (let i = 0; i < outSegs.length; i++) {
    if (outSegs[i].some((line) => /^;\s*start printing object, unique label id:/.test(line))) lastObj = i;
  }
  const trimmed = [];
  for (let i = 0; i < outSegs.length; i++) {
    if (i > lastObj && outSegs[i].some((line) => LAYER_CHANGE.test(line))) break;
    trimmed.push(outSegs[i]);
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const place of placements) {
    const st = objectStats[place.id];
    x0 = Math.min(x0, place.cx - st.w / 2);
    y0 = Math.min(y0, place.cy - st.h / 2);
    x1 = Math.max(x1, place.cx + st.w / 2);
    y1 = Math.max(y1, place.cy + st.h / 2);
  }
  const levelPad = 2;
  const levelArea = {
    x0: Math.max(0, x0 - levelPad),
    y0: Math.max(0, y0 - levelPad),
    i: Math.min(bounds.bedMm, x1 + levelPad) - Math.max(0, x0 - levelPad),
    j: Math.min(bounds.bedMm, y1 + levelPad) - Math.max(0, y0 - levelPad),
  };

  const leveledHeader = rewriteLevelArea(header, levelArea);
  const bodyLines = trimmed.flat();
  const assembled = [...leveledHeader, ...bodyLines, ...tail];
  const retargeted = retargetGcodeLines(assembled, {
    filament,
    weightG,
    timeSec,
    layerCount,
    rangeHigh: filament?.rangeHigh ?? bounds.plaNozzleRangeC?.high ?? 240,
  });
  const gcode = `${retargeted.join("\n")}\n`;
  // Align plate_1.json bbox_all with the actual extruded toolpath (arcs included).
  const measured = validateGcodeBedBounds(gcode, bounds);
  if (measured.extrusion.moves) {
    x0 = measured.extrusion.min[0];
    y0 = measured.extrusion.min[1];
    x1 = measured.extrusion.max[0];
    y1 = measured.extrusion.max[1];
  }

  const entries = listZip(buf);
  const files = {};
  const platePath = plateGcodePath(plate);
  const gcodeBuf = Buffer.from(gcode, "utf8");
  const md5 = crypto.createHash("md5").update(gcodeBuf).digest("hex").toUpperCase();

  for (const entry of entries) {
    if (entry.name !== platePath && entry.uncompSize > LIMITS.maxZipEntryBytes) {
      fail(`source entry too large to rebuild: ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
    }
    let data = inflateEntry(buf, entry);
    if (entry.name === platePath) data = gcodeBuf;
    else if (entry.name === `${platePath}.md5`) data = Buffer.from(md5, "utf8");
    else if (entry.name === "Metadata/slice_info.config") {
      const plateType = (/;\s*curr_bed_type\s*=\s*(.+)$/im.exec(gcode)?.[1] || "").trim();
      const headerBed = /;\s*first_layer_bed_temperature\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(gcode);
      const bedC = filament?.bedC ?? (headerBed ? Number(headerBed[1]) : null);
      const sliceFilament = filament ? { ...filament } : {};
      if (sliceFilament.type && /pla/i.test(sliceFilament.type)) {
        if (!sliceFilament.trayInfoIdx) sliceFilament.trayInfoIdx = "GFA00";
        if (!sliceFilament.colour) sliceFilament.colour = "#FFFFFF";
      }
      data = Buffer.from(
        updateSliceInfo(data.toString("utf8"), {
          filament: Object.keys(sliceFilament).length ? sliceFilament : null,
          weightG,
          timeSec,
          lengthM,
          bedC,
          plateType,
        }),
        "utf8",
      );
    } else if (entry.name === `Metadata/plate_${plate}.json`) {
      try {
        const json = JSON.parse(data.toString("utf8"));
        json.bbox_all = [Number(x0.toFixed(3)), Number(y0.toFixed(3)), Number(x1.toFixed(3)), Number(y1.toFixed(3))];
        if (weightG != null) json.filament_weight_g = weightG;
        if (timeSec != null) {
          json.prediction = Math.round(timeSec);
          json.estimated_printing_time = Math.round(timeSec);
        }
        const template = Array.isArray(json.bbox_objects) ? json.bbox_objects : [];
        json.bbox_objects = placements.map((place) => {
          const st = objectStats[place.id];
          const tiledId = tiledIdByKey.get(`${place.id}:${place.copy}`);
          const base = template.find((o) => Number(o.id) === Number(place.id)) || {
            area: st.w * st.h,
            layer_height: 0.2,
            name: `object-${place.id}`,
          };
          return {
            area: st.w * st.h,
            layer_height: base.layer_height ?? 0.2,
            name: `${base.name || `object-${place.id}`}#${place.copy}`,
            id: tiledId,
            source_id: place.id,
            copy: place.copy,
            bbox: [
              Number((place.cx - st.w / 2).toFixed(3)),
              Number((place.cy - st.h / 2).toFixed(3)),
              Number((place.cx + st.w / 2).toFixed(3)),
              Number((place.cy + st.h / 2).toFixed(3)),
            ],
          };
        });
        data = Buffer.from(JSON.stringify(json), "utf8");
      } catch {
        // leave unchanged
      }
    }
    files[entry.name] = { data, method: 8 };
  }

  const outBuf = makeStoredZip(files);
  const preflight = validatePrintPreflight(outBuf, { plate, model: bounds.id || "a1-mini" });
  if (!preflight.ok) {
    const first = preflight.errors[0];
    fail(`plate builder refused to write a file that fails preflight: ${first?.message || "validation failed"}`, {
      exitCode: 4,
      code: "plate_preflight",
      details: { errors: preflight.errors.slice(0, 12), warnings: preflight.warnings.slice(0, 12) },
    });
  }
  return {
    buf: outBuf,
    md5,
    placements,
    levelArea,
    preflight,
    gcodeBytes: gcodeBuf.length,
    objects: activeIds,
  };
}

export function buildPlateFromFile(inputPath, outputPath, options = {}) {
  const resolvedIn = path.resolve(inputPath);
  const resolvedOut = path.resolve(outputPath);
  const stat = fs.lstatSync(resolvedIn);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("plate source must be a regular file", { exitCode: 4, code: "bad_file" });
  if (stat.size > LIMITS.max3mfBytes) fail("plate source exceeds harness size cap", { exitCode: 4, code: "bad_file" });
  const buf = fs.readFileSync(resolvedIn);
  const built = buildPlate(buf, options);
  fs.writeFileSync(resolvedOut, built.buf, { mode: 0o644 });
  return { ...built, input: resolvedIn, output: resolvedOut };
}

export function listPlateObjectsFromFile(inputPath, options = {}) {
  const resolvedIn = path.resolve(inputPath);
  const stat = fs.lstatSync(resolvedIn);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("plate source must be a regular file", { exitCode: 4, code: "bad_file" });
  const buf = fs.readFileSync(resolvedIn);
  return { file: resolvedIn, objects: listPlateObjects(buf, options) };
}
