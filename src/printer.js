import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "./allow.js";
import { fail } from "./errors.js";
import { inspectGcode3mf } from "./gcode3mf.js";

/** PLA first-layer bed targets below this are refused by lan print unless --force. Missing/unknown targets are refused the same way. */
export const PLA_BED_MIN_C = 50;

export function validateSerial(serial) {
  const value = String(serial ?? "").trim();
  if (!/^[A-Za-z0-9]{10,20}$/.test(value)) {
    fail("serial must be 10 to 20 letters or digits", { exitCode: 4, code: "bad_serial" });
  }
  return value;
}

export function readSecretFile(file, { kind }) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${kind} file must be a regular file`, { exitCode: 4, code: "bad_file" });
  if ((stat.mode & 0o077) !== 0) {
    fail(`${kind} file is group or world accessible`, { exitCode: 4, code: "bad_file" });
  }
  const text = fs.readFileSync(resolved, "utf8").replace(/\r?\n$/, "");
  if (text.includes("\n") || text.includes("\r") || text.length < 1 || text.length > 256) {
    fail(`${kind} file contents are not a single line`, { exitCode: 4, code: "bad_file" });
  }
  return text;
}

let sequence = 30_000 + Math.floor(Math.random() * 1000);

export function nextSequenceId() {
  sequence = sequence >= 65_000 ? 30_000 : sequence + 1;
  return String(sequence);
}

export function reportTopic(serial) {
  return `device/${validateSerial(serial)}/report`;
}

export function requestTopic(serial) {
  return `device/${validateSerial(serial)}/request`;
}

export function commandResult(message, sequenceId, command) {
  if (!message?.json || typeof message.json !== "object") return null;
  for (const section of Object.values(message.json)) {
    if (!section || typeof section !== "object") continue;
    if (section.command !== command) continue;
    if (String(section.sequence_id ?? section.sequenceId ?? "") !== String(sequenceId)) continue;
    const result = String(section.result ?? "");
    const reason = String(section.reason ?? "");
    const errCode = section.err_code ?? section.errCode ?? null;
    const ok = result.toLowerCase() === "success" || (result === "" && errCode === 0);
    return { ok, result, reason, errCode, section };
  }
  return null;
}

export function pushallBody() {
  return {
    pushing: {
      sequence_id: nextSequenceId(),
      command: "pushall",
      version: 1,
      push_target: 1,
    },
  };
}

export function versionBody() {
  return { info: { sequence_id: nextSequenceId(), command: "get_version" } };
}

export function controlBody(command) {
  const sequenceId = nextSequenceId();
  if (command === "pause" || command === "resume" || command === "stop") {
    return { topicBody: { print: { sequence_id: sequenceId, command, param: "" } }, sequenceId, command, qos: 1 };
  }
  if (command === "light_on" || command === "light_off") {
    return {
      topicBody: {
        system: {
          sequence_id: sequenceId,
          command: "ledctrl",
          led_node: "chamber_light",
          led_mode: command === "light_on" ? "on" : "off",
          led_on_time: 500,
          led_off_time: 500,
          loop_times: 1,
          interval_time: 1000,
        },
      },
      sequenceId,
      command: "ledctrl",
      qos: 1,
    };
  }
  fail(`unknown control command ${command}`, { code: "bad_command" });
}

export function extractStatus(merged, versionReport, firmwareHttp) {
  const print = merged.print ?? {};
  const lights = Array.isArray(print.lights_report) ? print.lights_report : [];
  const chamber = lights.find((light) => light?.node === "chamber_light");
  const hms = Array.isArray(print.hms) ? print.hms : [];
  let firmware = firmwareHttp;
  const modules = versionReport?.info?.module;
  if (Array.isArray(modules)) {
    const preferred = modules.find((mod) => mod?.name === "ota") || modules.find((mod) => mod?.name === "mc");
    if (preferred?.sw_ver) firmware = preferred.sw_ver;
  }
  return {
    state: print.gcode_state ?? null,
    progress: print.mc_percent ?? null,
    layer: print.layer_num ?? null,
    totalLayers: print.total_layer_num ?? null,
    nozzle: print.nozzle_temper ?? null,
    nozzleTarget: print.nozzle_target_temper ?? null,
    bed: print.bed_temper ?? null,
    bedTarget: print.bed_target_temper ?? null,
    remainingMinutes: print.mc_remaining_time ?? null,
    printError: print.print_error ?? null,
    printErrorCode: print.mc_print_error_code ?? null,
    failReason: print.fail_reason ?? null,
    hmsCount: hms.length,
    light: chamber?.mode ?? null,
    firmware: firmware ?? null,
    gcodeFile: print.gcode_file ?? null,
    subtask: print.subtask_name ?? null,
    wifi: print.wifi_signal ?? null,
  };
}

export function mergeReport(target, message) {
  if (!message?.json || typeof message.json !== "object") return target;
  for (const [key, value] of Object.entries(message.json)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = { ...(target[key] ?? {}), ...value };
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function md5Upper(buf) {
  return crypto.createHash("md5").update(buf).digest("hex").toUpperCase();
}

export function loadPrintFile(file, plate) {
  const resolved = path.resolve(file);
  const base = path.basename(resolved);
  if (!base.toLowerCase().endsWith(".gcode.3mf")) {
    fail("print file must end in .gcode.3mf", { exitCode: 4, code: "bad_file" });
  }
  if (!/^[\w.+\- ()]{1,180}$/.test(base)) {
    fail("print file name contains characters this harness will not send", { exitCode: 4, code: "bad_file" });
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("print file must be a regular file", { exitCode: 4, code: "bad_file" });
  if (stat.size <= 0) fail("print file is empty", { exitCode: 4, code: "bad_file" });
  if (stat.size > LIMITS.max3mfBytes) {
    fail(`print file exceeds the ${LIMITS.max3mfBytes} byte harness cap`, { exitCode: 4, code: "bad_file" });
  }
  const buf = fs.readFileSync(resolved);
  const inspection = inspectGcode3mf(buf, plate);
  return { path: resolved, name: base, buf, md5: md5Upper(buf), inspection };
}

export function printFlags(options, flags) {
  const on = (yes, no, fallback) => {
    if (flags.has(yes) && flags.has(no)) fail(`pass only one of --${yes} and --${no}`, { exitCode: 4, code: "bad_args" });
    if (flags.has(yes)) return true;
    if (flags.has(no)) return false;
    return fallback;
  };
  const bedType = options["bed-type"] ?? "auto";
  if (!["auto", "pe", "pc", "pei", "pte", "supertack"].includes(bedType)) {
    fail("bed type must be auto, pe, pc, pei, pte, or supertack", { exitCode: 4, code: "bad_args" });
  }
  let autoBed = on("bed-leveling", "no-bed-leveling", true) ? 1 : 0;
  if (options["auto-bed-leveling"] !== undefined) {
    if (!["0", "1", "2"].includes(options["auto-bed-leveling"])) {
      fail("--auto-bed-leveling must be 0, 1, or 2", { exitCode: 4, code: "bad_args" });
    }
    autoBed = Number(options["auto-bed-leveling"]);
  }
  return {
    bedLeveling: on("bed-leveling", "no-bed-leveling", true),
    autoBedLeveling: autoBed,
    flowCali: on("flow-cali", "no-flow-cali", false),
    vibrationCali: on("vibration-cali", "no-vibration-cali", true),
    layerInspect: on("layer-inspect", "no-layer-inspect", false),
    timelapse: on("timelapse", "no-timelapse", false),
    useAms: on("ams", "no-ams", false),
    bedType,
  };
}

export function plateIndex(value) {
  const plate = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(plate) || plate < 1 || plate > 36) {
    fail("--plate must be an integer from 1 to 36", { exitCode: 4, code: "bad_args" });
  }
  return plate;
}

export function activePrintState(state) {
  const value = String(state || "").toUpperCase();
  return value === "RUNNING" || value === "PREPARE" || value === "SLICING" || value === "PAUSE" || value === "PAUSED";
}
