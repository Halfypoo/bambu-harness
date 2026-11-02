import { A1_MINI } from "./a1mini.js";

/**
 * Machine / filament limits used by preflight validation.
 * Numbers from Bambu Studio A1 mini 0.4 profiles unless marked unverified.
 */
export const A1_MINI_LIMITS = Object.freeze({
  id: "a1-mini",
  name: A1_MINI.marketingName,
  modelCode: A1_MINI.modelCode,
  bedMm: A1_MINI.bedMm,
  xMin: 0,
  xMax: A1_MINI.bedMm,
  yMin: 0,
  yMax: A1_MINI.bedMm,
  zMin: 0,
  zMax: A1_MINI.bedMm,
  /** Stock start G-code brushes at Y=185; wipe arcs reach about Y=186. */
  startBrushYMax: 186,
  /**
   * Loose envelope for stock start/end purge, wipe, and park moves observed on A1 mini
   * machine_start_gcode / machine_end_gcode (X negatives for wipe, Y brush + small arc radius).
   */
  startEndEnvelope: Object.freeze({
    xMin: -40,
    xMax: 190,
    yMin: -5,
    yMax: 190,
  }),
  travelClampMin: 2,
  travelClampMax: A1_MINI.bedMm - 2,
  bedMarginMm: 5,
  minGapMm: 4,
  bboxMatchTolMm: 1,
  nozzleMaxC: 300, // [unverified] machine max; warn only above this
  bedMaxC: A1_MINI.bedMaxC,
  maxSpeedXyMms: 500,
  /** Stock Bambu travel often uses F42000 (700 mm/s); warn only above this for non-extruding moves. */
  maxTravelSpeedXyMms: 700,
  maxSpeedZMms: 30, // [unverified, likely same as common]
  maxAccelXy: 20_000,
  maxAccelTravel: 9_000,
  maxAccelZ: 1_500,
  plaVolumetricMm3s: 21,
  plaNozzleRangeC: Object.freeze({ low: 190, high: 240 }),
  defaultNozzleMm: A1_MINI.nozzleMm,
  /**
   * Stock A1 mini start G-code turns software endstops off with `M211 X0 Y0 Z0`
   * (and uses M211 S / M211 R push/pop around wipe). After start, this harness
   * is the only bed-crash guard — any other M211 is refused.
   */
  stockStartM211: Object.freeze(["M211 X0 Y0 Z0", "M211 S", "M211 R"]),
});

export const PRINTER_LIMITS = Object.freeze({
  "a1-mini": A1_MINI_LIMITS,
});

export function resolvePrinterLimits(model = "a1-mini") {
  const key = String(model || "a1-mini").trim().toLowerCase();
  return PRINTER_LIMITS[key] ?? null;
}
