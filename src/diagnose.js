import { extractStatus } from "./printer.js";
import { HMS_SOURCES, decodeHmsList } from "./hms.js";
import { SOURCES } from "./sources.js";

function firmwareModules(version) {
  const modules = version?.info?.module;
  if (!Array.isArray(modules)) return [];
  return modules
    .filter((mod) => mod && typeof mod === "object")
    .map((mod) => ({ name: String(mod.name ?? ""), swVer: mod.sw_ver ?? null }))
    .filter((mod) => mod.name);
}

function wifiDbm(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

export function summarizeDiagnosis({ print, version, device }) {
  const status = extractStatus({ print: print ?? {} }, version ?? null, null);
  const problems = [];
  const notes = [];
  if (device && device.online === false) problems.push("The device list says this printer is offline.");
  if (status.state === "FAILED") problems.push("gcode_state is FAILED.");
  if (status.printError !== null && status.printError !== undefined && status.printError !== 0 && status.printError !== "0") {
    problems.push(`print_error is ${status.printError}.`);
  }
  if (status.failReason && status.failReason !== "0" && status.failReason !== 0) {
    problems.push(`fail_reason is ${status.failReason}.`);
  }
  const hms = decodeHmsList(print?.hms);
  for (const item of hms) {
    if (!item.code) continue;
    problems.push(item.text ? `HMS ${item.code}: ${item.text}` : `HMS ${item.code}. No text in the local subset; see the wiki.`);
  }
  const bits = print?.ams_exist_bits;
  let amsPresent = null;
  if (bits === 0 || bits === "0") {
    amsPresent = false;
    notes.push("ams_exist_bits is 0. No AMS is reported. An A1 mini is often used without one.");
  } else if (bits !== undefined && bits !== null && bits !== "") {
    amsPresent = true;
    notes.push(`ams_exist_bits is ${bits}.`);
  } else {
    notes.push("ams_exist_bits was absent, so AMS presence is unknown from this report.");
  }
  const dbm = wifiDbm(status.wifi);
  if (dbm !== null && dbm <= -75) {
    notes.push(`wifi_signal is ${status.wifi}. Heuristic only: -75 dBm is not a Bambu threshold.`);
  }
  if (status.state === "RUNNING" && Number(status.nozzleTarget) >= 40) {
    const gap = Math.abs(Number(status.nozzle) - Number(status.nozzleTarget));
    if (Number.isFinite(gap) && gap > 15) {
      notes.push(`Nozzle is ${status.nozzle} C with target ${status.nozzleTarget} C while printing. This gap is a heuristic, not an error code.`);
    }
  }
  const detector = print?.xcam?.spaghetti_detector;
  return {
    verification: "UNVERIFIED",
    serial: device?.serial ?? null,
    name: device?.name ?? null,
    model: device?.model ?? null,
    product: device?.product ?? null,
    online: device?.online ?? null,
    state: status.state,
    progress: status.progress,
    layer: status.layer,
    totalLayers: status.totalLayers,
    nozzle: status.nozzle,
    nozzleTarget: status.nozzleTarget,
    bed: status.bed,
    bedTarget: status.bedTarget,
    nozzleDiameter: print?.nozzle_diameter ?? device?.nozzleDiameter ?? null,
    speedLevel: print?.spd_lvl ?? null,
    wifi: status.wifi ?? null,
    amsPresent,
    hms,
    firmware: status.firmware,
    modules: firmwareModules(version),
    printerSpaghettiDetector: typeof detector === "boolean" ? detector : null,
    problems,
    notes,
    sources: [SOURCES.mqtt, ...HMS_SOURCES],
  };
}
