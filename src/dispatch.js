import path from "node:path";
import { testModeEnabled } from "./allow.js";
import { assertWholeNumber } from "./a1mini.js";
import { grabFrame, writeFrameFile, CAMERA_SOURCES } from "./camera.js";
import { summarizeDiagnosis } from "./diagnose.js";
import { fail, HarnessError } from "./errors.js";
import { getFtps, listFtps, uploadFtps } from "./ftps.js";
import { assertLanHost, lanPort, loadLanConfig, readAccessCode, saveLanConfig } from "./lan-config.js";
import {
  controlBody,
  extractStatus,
  loadPrintFile,
  nextSequenceId,
  PLA_BED_MIN_C,
  plateIndex,
  printFlags,
} from "./printer.js";
import { localProjectFile, calibrationRequest, fanRequest, flowCalibrationExplanation, speedRequest, temperatureRequest } from "./payloads.js";
import { acknowledged, acknowledgedPrint, openLanMqtt, readSnapshot } from "./runner.js";
import { runSlice } from "./slice-job.js";
import { SOURCES } from "./sources.js";
import { watchFirstLayer } from "./watch-layer.js";

function requireYes(flags, label) {
  if (!flags.has("yes")) {
    fail(`${label} changes the printer and requires --yes`, { exitCode: 4, code: "confirmation_required" });
  }
}

function publicBuilt(built) {
  const copy = { ...built };
  delete copy.topicBody;
  return copy;
}

async function sendLan(options, flags, timeout, label, build) {
  const checked = build("0");
  requireYes(flags, label);
  const { mqtt, config } = await openLanMqtt(options, flags);
  void checked;
  const built = build(nextSequenceId());
  try {
    const ack = await acknowledged({
      mqtt,
      serial: config.serial,
      topicBody: built.topicBody,
      sequenceId: built.sequenceId,
      command: built.command,
      timeout,
      what: label,
    });
    return {
      ok: true,
      route: "lan",
      serial: config.serial,
      host: config.host,
      pin: mqtt.lanPin,
      ...publicBuilt(built),
      ...ack,
    };
  } finally {
    mqtt.close();
  }
}

async function runCalibrate(positionals, options, flags, timeout) {
  const action = positionals[2];
  if (action !== "bed-level" && action !== "vibration" && action !== "flow") {
    fail("calibrate requires bed-level, vibration, or flow", { exitCode: 4, code: "bad_args" });
  }
  if (action === "flow") {
    return { ...flowCalibrationExplanation(), route: "lan" };
  }
  const payload = await sendLan(options, flags, timeout, `calibrate ${action}`, (sequenceId) => calibrationRequest(sequenceId, action));
  return { ...payload, command: "calibrate" };
}

async function runTemperature(positionals, options, flags, timeout) {
  const part = positionals[2];
  const value = positionals[3];
  const payload = await sendLan(options, flags, timeout, "temperature", (sequenceId) => temperatureRequest(sequenceId, part, value));
  return { ...payload, command: "temperature" };
}

async function runFan(positionals, options, flags, timeout) {
  const channel = positionals[2];
  const value = positionals[3];
  const payload = await sendLan(options, flags, timeout, "fan", (sequenceId) => fanRequest(sequenceId, channel, value));
  return { ...payload, command: "fan" };
}

async function runSpeed(positionals, options, flags, timeout) {
  const level = positionals[2];
  const payload = await sendLan(options, flags, timeout, "speed", (sequenceId) => speedRequest(sequenceId, level));
  return { ...payload, command: "speed" };
}

async function runDiagnose(options, flags, timeout) {
  const { mqtt, config } = await openLanMqtt(options, flags);
  try {
    const snap = await readSnapshot(mqtt, config.serial, timeout);
    const summary = summarizeDiagnosis({
      print: snap.merged.print,
      version: snap.version,
      device: { serial: config.serial, online: null },
    });
    return { ok: true, command: "diagnose", route: "lan", host: config.host, pin: mqtt.lanPin, ...summary };
  } finally {
    mqtt.close();
  }
}

function everySeconds(raw) {
  if (raw === undefined) return 10;
  if (!/^\d+$/.test(String(raw))) fail("--every must be a whole number of seconds", { exitCode: 4, code: "bad_args" });
  const value = Number(raw);
  if (value === 0) {
    if (!testModeEnabled()) {
      fail("--every 0 is refused outside the test suite", { exitCode: 4, code: "bad_args" });
    }
    return 0;
  }
  if (value < 1 || value > 3600) fail("--every must be from 1 to 3600 seconds", { exitCode: 4, code: "bad_args" });
  return value;
}

function durationSeconds(options, every) {
  if (every === 0) return 0;
  if (options.seconds !== undefined) return assertWholeNumber(options.seconds, "--seconds", 1, 3600);
  const minutes = options.minutes === undefined ? 3 : assertWholeNumber(options.minutes, "--minutes", 1, 30);
  return minutes * 60;
}

function assertPlaBedTarget(inspection, flags) {
  const bedTargetC = inspection.bedTargetC;
  if (bedTargetC === null || bedTargetC === undefined || Number.isNaN(bedTargetC)) {
    if (flags.has("force")) {
      return {
        forcedUnknownBed: true,
        bedTargetC: null,
        bedType: inspection.bedType,
        note: "Sliced first-layer bed target is missing or unknown. Continuing because --force was set. Confirm plate type and bed temperature match the physical plate.",
      };
    }
    fail(
      "Sliced first-layer bed target is missing or unknown. Refusing to print; pass --force only after you have confirmed the plate type and bed temperature match the physical plate.",
      {
        exitCode: 4,
        code: "bed_target_unknown",
        details: {
          bedTargetC: null,
          bedType: inspection.bedType,
          minimumC: PLA_BED_MIN_C,
          bedTargetSource: inspection.bedTargetSource ?? null,
        },
      },
    );
  }
  if (bedTargetC >= PLA_BED_MIN_C) return null;
  if (flags.has("force")) {
    return {
      forcedLowBed: true,
      bedTargetC,
      bedType: inspection.bedType,
      note: `Sliced first-layer bed target is ${bedTargetC}C (below ${PLA_BED_MIN_C}C typical for PLA). Continuing because --force was set. Confirm the plate type matches the slice.`,
    };
  }
  fail(
    `Sliced first-layer bed target is ${bedTargetC}C, below ~${PLA_BED_MIN_C}C expected for PLA on a warm plate. Confirm plate type and bed temperature match the physical plate, or pass --force to print anyway.`,
    {
      exitCode: 4,
      code: "bed_too_cool",
      details: {
        bedTargetC,
        bedType: inspection.bedType,
        minimumC: PLA_BED_MIN_C,
        bedTargetSource: inspection.bedTargetSource,
      },
    },
  );
}

async function runLan(positionals, options, flags, timeout, transferTimeout) {
  const sub = positionals[1];
  if (sub === "configure") {
    const saved = saveLanConfig({ host: options.host, serial: options.serial });
    return {
      ok: true,
      command: "lan-configure",
      host: saved.host,
      serial: saved.serial,
      accessCodeStored: false,
      note: "The access code is not in this file. Pass --access-code-file (mode 0600) when you run a LAN command.",
    };
  }
  if (sub === "snapshot") {
    if (!options.out) fail("lan snapshot requires --out file.jpg", { exitCode: 4, code: "bad_args" });
    const config = loadLanConfig();
    const accessCode = readAccessCode(options);
    const frame = await grabFrame({
      host: config.host,
      port: lanPort("camera"),
      accessCode,
      acceptNewPin: flags.has("accept-new-pin"),
    });
    const file = writeFrameFile(options.out, frame.jpeg);
    return {
      ok: true,
      command: "lan-snapshot",
      host: config.host,
      file,
      bytes: frame.jpeg.length,
      width: frame.dimensions?.width ?? null,
      height: frame.dimensions?.height ?? null,
      flags: frame.flags,
      warning: frame.flags === 1 ? null : `frame flags were ${frame.flags}. The JPEG was still saved.`,
      pin: frame.pin,
      fingerprint: frame.fingerprint,
      sources: CAMERA_SOURCES,
    };
  }
  if (sub === "status") {
    const { mqtt, config } = await openLanMqtt(options, flags);
    try {
      const snap = await readSnapshot(mqtt, config.serial, timeout);
      return {
        ok: true,
        command: "lan-status",
        route: "lan",
        host: config.host,
        serial: config.serial,
        pin: mqtt.lanPin,
        sources: [SOURCES.mqtt],
        ...extractStatus(snap.merged, snap.version, null),
      };
    } finally {
      mqtt.close();
    }
  }
  if (sub === "ls") {
    const remotePath = positionals.slice(2).join(" ");
    const config = loadLanConfig();
    const accessCode = readAccessCode(options);
    const listed = await listFtps({
      host: config.host,
      port: lanPort("ftps"),
      accessCode,
      remotePath,
      acceptNewPin: flags.has("accept-new-pin"),
      maxTimeoutMs: transferTimeout,
    });
    return {
      ok: true,
      command: "lan-ls",
      host: config.host,
      path: listed.path,
      // LIST/MLSD stamps are the printer's own clock with no timezone on the wire.
      modifiedClock: "printer-local",
      entries: listed.entries.map((entry) => ({
        name: entry.name,
        size: entry.size,
        modified: entry.modified,
        type: entry.type,
      })),
      pin: listed.pin,
      sources: listed.sources,
    };
  }
  if (sub === "get") {
    const remotePath = positionals.slice(2).join(" ");
    if (!remotePath) fail("lan get requires a remote path", { exitCode: 4, code: "bad_args" });
    const config = loadLanConfig();
    const accessCode = readAccessCode(options);
    const downloaded = await getFtps({
      host: config.host,
      port: lanPort("ftps"),
      accessCode,
      remotePath,
      outPath: options.out,
      acceptNewPin: flags.has("accept-new-pin"),
      maxTimeoutMs: transferTimeout,
    });
    return {
      ok: true,
      command: "lan-get",
      host: config.host,
      remote: downloaded.remote,
      file: downloaded.file,
      bytes: downloaded.bytes,
      pin: downloaded.pin,
      sources: downloaded.sources,
    };
  }
  if (sub === "stop") {
    requireYes(flags, "lan stop");
    const { mqtt, config } = await openLanMqtt(options, flags);
    try {
      const built = controlBody("stop");
      const ack = await acknowledged({
        mqtt,
        serial: config.serial,
        topicBody: built.topicBody,
        sequenceId: built.sequenceId,
        command: built.command,
        timeout,
        what: "lan stop",
      });
      return {
        ok: true,
        command: "lan-stop",
        route: "lan",
        host: config.host,
        serial: config.serial,
        pin: mqtt.lanPin,
        ...ack,
        sources: [SOURCES.mqtt],
      };
    } finally {
      mqtt.close();
    }
  }
  if (sub === "upload" || sub === "print") {
    const file = positionals[2];
    if (!file) fail(`lan ${sub} requires a .gcode.3mf path`, { exitCode: 4, code: "bad_args" });
    if (sub === "print") requireYes(flags, "lan print");
    const flagsParsed = printFlags(options, flags);
    if (flagsParsed.useAms) {
      fail("LAN print does not implement AMS mapping. Omit --ams. use_ams is sent as false.", { exitCode: 4, code: "bad_args" });
    }
    const plate = plateIndex(options.plate);
    const loaded = loadPrintFile(file, plate);
    const forcedBed = sub === "print" ? assertPlaBedTarget(loaded.inspection, flags) : null;
    const remoteName = path.basename(loaded.path);
    const config = loadLanConfig();
    const accessCode = readAccessCode(options);
    const uploaded = await uploadFtps({
      host: config.host,
      port: lanPort("ftps"),
      accessCode,
      filename: remoteName,
      body: loaded.buf,
      acceptNewPin: flags.has("accept-new-pin"),
      maxTimeoutMs: transferTimeout,
    });
    const bedNote = flagsParsed.bedType === "auto"
      ? null
      : "LAN project_file forces bed_type auto. The local value is always auto. The requested bed type was not sent.";
    if (sub === "upload") {
      return {
        ok: true,
        command: "lan-upload",
        host: config.host,
        remote: uploaded.remote,
        bytes: uploaded.bytes,
        md5: loaded.md5,
        pin: uploaded.pin,
        tlsSessionReused: uploaded.tlsSessionReused,
        plate: loaded.inspection.platePath,
        bedTargetC: loaded.inspection.bedTargetC,
        bedType: loaded.inspection.bedType,
        warnings: loaded.inspection.warnings,
        bedNote,
        printed: false,
        sources: uploaded.sources,
      };
    }
    const sequenceId = nextSequenceId();
    const topicBody = localProjectFile({
      sequenceId,
      fileName: uploaded.remote,
      platePath: loaded.inspection.platePath,
      md5: loaded.md5,
      flags: flagsParsed,
    });
    let mqtt = null;
    try {
      mqtt = (await openLanMqtt(options, flags)).mqtt;
      const ack = await acknowledgedPrint({
        mqtt,
        serial: config.serial,
        topicBody,
        sequenceId,
        timeout,
      });
      return {
        ok: true,
        command: "lan-print",
        host: config.host,
        serial: config.serial,
        remote: uploaded.remote,
        url: topicBody.print.url,
        md5: loaded.md5,
        plate: loaded.inspection.platePath,
        useAms: false,
        bedType: "auto",
        bedTargetC: loaded.inspection.bedTargetC,
        slicedBedType: loaded.inspection.bedType,
        bedLeveling: flagsParsed.bedLeveling,
        flowCali: flagsParsed.flowCali,
        vibrationCali: flagsParsed.vibrationCali,
        layerInspect: flagsParsed.layerInspect,
        timelapse: flagsParsed.timelapse,
        warnings: loaded.inspection.warnings,
        bedNote,
        forcedBed,
        doNotRetry: true,
        pin: mqtt.lanPin,
        ...ack,
        sources: [SOURCES.mqtt, SOURCES.ftp],
        note: ack.note
          || "If MQTT reports a puback timeout, run lan status before retrying — the job may already have started.",
      };
    } catch (error) {
      if (error instanceof HarnessError) {
        error.details = {
          ...(error.details ?? {}),
          doNotRetry: true,
          uploaded: uploaded.remote,
          note: "A lan print MQTT timeout can mean the job already started. Run lan status before retrying.",
        };
      }
      throw error;
    } finally {
      mqtt?.close();
    }
  }
  if (sub === "calibrate") return runCalibrate(positionals, options, flags, timeout);
  if (sub === "temperature") return runTemperature(positionals, options, flags, timeout);
  if (sub === "fan") return runFan(positionals, options, flags, timeout);
  if (sub === "speed") return runSpeed(positionals, options, flags, timeout);
  if (sub === "diagnose") return runDiagnose(options, flags, timeout);
  if (sub === "watch-first-layer") {
    if (!options.out) fail("lan watch-first-layer requires --out DIR", { exitCode: 4, code: "bad_args" });
    if (flags.has("auto-stop")) requireYes(flags, "lan watch-first-layer --auto-stop");
    const every = everySeconds(options.every);
    const duration = durationSeconds(options, every);
    const config = loadLanConfig();
    const accessCode = readAccessCode(options);
    const directory = path.resolve(options.out);
    const stop = flags.has("auto-stop")
      ? async () => {
        const { mqtt } = await openLanMqtt(options, flags);
        try {
          const built = controlBody("stop");
          return await acknowledged({
            mqtt,
            serial: config.serial,
            topicBody: built.topicBody,
            sequenceId: built.sequenceId,
            command: built.command,
            timeout,
            what: "stop",
          });
        } finally {
          mqtt.close();
        }
      }
      : null;
    return watchFirstLayer({
      host: config.host,
      port: lanPort("camera"),
      accessCode,
      acceptNewPin: flags.has("accept-new-pin"),
      directory,
      everySec: every,
      durationSec: duration,
      autoStop: flags.has("auto-stop"),
      stop,
    });
  }
  if (sub === "discover" || sub === "scan") {
    fail("LAN discovery and scanning are refused. Configure one RFC1918 address with bambu lan configure.", {
      exitCode: 4,
      code: "host_refused",
    });
  }
  fail(
    "lan requires configure, status, ls, get, snapshot, upload, print, stop, calibrate, temperature, fan, speed, diagnose, or watch-first-layer",
    { exitCode: 4, code: "bad_args" },
  );
}

export async function dispatch({ command, positionals, options, flags, timeout, transferTimeout }) {
  if (command === "slice") {
    return { payload: await runSlice({ modelPath: positionals[1], options, flags }) };
  }
  if (command === "lan") {
    if (options.host !== undefined && positionals[1] !== "configure") {
      assertLanHost(options.host);
    }
    if (positionals[1] !== "configure" && options.host) {
      const configured = loadLanConfig();
      if (options.host !== configured.host) {
        fail("LAN commands talk only to the host in lan.json. Refusing a different --host.", { exitCode: 4, code: "host_refused" });
      }
    }
    return { payload: await runLan(positionals, options, flags, timeout, transferTimeout) };
  }
  return null;
}
