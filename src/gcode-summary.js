import { A1_MINI } from "./a1mini.js";

function parseDuration(text) {
  const source = String(text || "");
  const hours = /(\d+)\s*h/i.exec(source);
  const minutes = /(\d+)\s*m/i.exec(source);
  const seconds = /(\d+)\s*s/i.exec(source);
  if (!hours && !minutes && !seconds) return null;
  return (hours ? Number(hours[1]) * 3600 : 0) + (minutes ? Number(minutes[1]) * 60 : 0) + (seconds ? Number(seconds[1]) : 0);
}

export function summarizeGcode(gcode) {
  const text = String(gcode || "");
  const header = text.slice(0, 120_000);
  const modelTime = /model printing time:\s*([^;]+)/i.exec(header);
  const totalTime = /total estimated time:\s*([^\n;]+)/i.exec(header);
  const layers = /total layer number:\s*(\d+)/i.exec(header);
  let grams = 0;
  let gramHits = 0;
  const gramRe = /filament used \[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)/gi;
  let match;
  while ((match = gramRe.exec(text))) {
    grams += Number(match[1]);
    gramHits += 1;
  }
  const bounds = extrusionBounds(text);
  return {
    estimatedTime: totalTime ? totalTime[1].trim() : null,
    estimatedSeconds: totalTime ? parseDuration(totalTime[1]) : null,
    modelTime: modelTime ? modelTime[1].trim() : null,
    modelSeconds: modelTime ? parseDuration(modelTime[1]) : null,
    filamentGrams: gramHits ? Math.round(grams * 1000) / 1000 : null,
    layerCount: layers ? Number(layers[1]) : null,
    extrusion: bounds,
  };
}

export function isSlicedLayerMarker(line) {
  return /^;\s*CHANGE_LAYER\s*$/.test(line) || /^;\s*layer num\/total_layer_count:\s*\d+\//.test(line);
}

export function extrusionBounds(gcode) {
  let absolute = true;
  let relativeE = true;
  let x = null;
  let y = null;
  let z = null;
  let e = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let moves = 0;
  let outside = 0;
  const bed = A1_MINI.bedMm;
  const source = String(gcode || "");
  const gated = source.split(/\r?\n/).some((line) => isSlicedLayerMarker(line));
  let checking = !gated;
  for (const raw of source.split(/\r?\n/)) {
    if (gated && isSlicedLayerMarker(raw)) checking = true;
    const code = raw.split(";", 1)[0].trim();
    if (!code) continue;
    const head = code.split(/\s+/, 1)[0].toUpperCase();
    if (head === "G90") absolute = true;
    else if (head === "G91") absolute = false;
    else if (head === "M82") relativeE = false;
    else if (head === "M83") relativeE = true;
    else if (head === "G0" || head === "G1") {
      const parsed = {};
      const re = /([XYZE])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi;
      let match;
      while ((match = re.exec(code))) parsed[match[1].toUpperCase()] = Number(match[2]);
      const nextX = parsed.X === undefined ? x : (absolute || x === null ? parsed.X : x + parsed.X);
      const nextY = parsed.Y === undefined ? y : (absolute || y === null ? parsed.Y : y + parsed.Y);
      const nextZ = parsed.Z === undefined ? z : (absolute || z === null ? parsed.Z : z + parsed.Z);
      let extruding = false;
      if (parsed.E !== undefined) {
        if (relativeE) extruding = parsed.E > 0;
        else {
          extruding = parsed.E > e + 1e-6;
          e = parsed.E;
        }
      }
      if (checking && extruding && nextX !== null && nextY !== null) {
        moves += 1;
        minX = Math.min(minX, nextX);
        minY = Math.min(minY, nextY);
        maxX = Math.max(maxX, nextX);
        maxY = Math.max(maxY, nextY);
        if (nextZ !== null) {
          minZ = Math.min(minZ, nextZ);
          maxZ = Math.max(maxZ, nextZ);
        }
        if (nextX < -1 || nextY < -1 || nextX > bed + 1 || nextY > bed + 1 || (nextZ !== null && (nextZ < -1 || nextZ > bed + 1))) {
          outside += 1;
        }
      }
      x = nextX;
      y = nextY;
      z = nextZ;
    }
  }
  return {
    moves,
    outside,
    min: moves ? [round(minX), round(minY), Number.isFinite(minZ) ? round(minZ) : null] : null,
    max: moves ? [round(maxX), round(maxY), Number.isFinite(maxZ) ? round(maxZ) : null] : null,
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

export function parseDurationForTest(text) {
  return parseDuration(text);
}
