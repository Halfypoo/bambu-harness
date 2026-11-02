/**
 * Built-in filament bands for plate retargeting and preflight.
 * Numbers are typical A1 mini slicer windows, not the machine's absolute max.
 * --nozzle-range-low / --nozzle-range-high override the values written into the header.
 * The validator still refuses a header window that sticks out past the built-in band
 * for the declared type (a stale PETG 220..270 header on a PLA plate).
 */
export const FILAMENT_DEFAULTS = Object.freeze({
  PLA: Object.freeze({ nozzleLow: 190, nozzleHigh: 240, bedC: 60, volumetric: 21 }),
  "PLA-SILK": Object.freeze({ nozzleLow: 190, nozzleHigh: 240, bedC: 55, volumetric: 12 }),
  PETG: Object.freeze({ nozzleLow: 230, nozzleHigh: 270, bedC: 70, volumetric: 12 }),
  ABS: Object.freeze({ nozzleLow: 240, nozzleHigh: 280, bedC: 90, volumetric: 12 }),
  TPU: Object.freeze({ nozzleLow: 200, nozzleHigh: 250, bedC: 35, volumetric: 3 }),
});

export function lookupFilamentDefaults(type) {
  if (type == null || type === "") return null;
  const raw = String(type).split(";")[0].trim().toUpperCase().replace(/[\s_]+/g, "-");
  if (!raw) return null;
  if (raw === "PLA-SILK" || raw === "PLASILK" || raw === "SILK-PLA" || raw === "SILKPLA") {
    return FILAMENT_DEFAULTS["PLA-SILK"];
  }
  if (FILAMENT_DEFAULTS[raw]) return FILAMENT_DEFAULTS[raw];
  if (raw.includes("PLA") && raw.includes("SILK")) return FILAMENT_DEFAULTS["PLA-SILK"];
  if (raw.includes("PLA")) return FILAMENT_DEFAULTS.PLA;
  if (raw.startsWith("PETG")) return FILAMENT_DEFAULTS.PETG;
  if (raw.startsWith("ABS")) return FILAMENT_DEFAULTS.ABS;
  if (raw.startsWith("TPU")) return FILAMENT_DEFAULTS.TPU;
  return null;
}

/**
 * Nozzle window the validator should enforce.
 * A header range contained in the declared filament's built-in band is kept
 * (narrower custom window). A header that extends outside that band — the
 * PETG 220..270 leftover on a PLA plate — is ignored and the built-in band is used.
 * With no declared type, the header is trusted and the fallback is only a default.
 */
export function effectiveNozzleRange(meta, fallback = { low: 190, high: 240 }) {
  const profile = lookupFilamentDefaults(meta?.filamentType);
  const builtinLow = profile ? profile.nozzleLow : fallback.low;
  const builtinHigh = profile ? profile.nozzleHigh : fallback.high;
  const headerLow = meta?.nozzleRangeLow;
  const headerHigh = meta?.nozzleRangeHigh;
  const headerOk = Number.isFinite(headerLow) && Number.isFinite(headerHigh) && headerLow <= headerHigh;
  if (!headerOk) {
    return { low: builtinLow, high: builtinHigh, source: profile ? "builtin" : "fallback", ignoredHeader: false };
  }
  if (!profile) {
    return { low: headerLow, high: headerHigh, source: "header", ignoredHeader: false };
  }
  const contained = headerLow >= profile.nozzleLow - 0.5 && headerHigh <= profile.nozzleHigh + 0.5;
  if (!contained) {
    return { low: profile.nozzleLow, high: profile.nozzleHigh, source: "builtin", ignoredHeader: true };
  }
  return { low: headerLow, high: headerHigh, source: "header", ignoredHeader: false };
}
