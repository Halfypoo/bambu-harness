import { A1_MINI, assertWholeNumber } from "./a1mini.js";
import { fail } from "./errors.js";
import { SOURCES } from "./sources.js";

const UNVERIFIED = "UNVERIFIED";

export function calibrationRequest(sequenceId, action) {
  const bits = { "bed-level": 2, vibration: 4 };
  const option = bits[action];
  if (!option) {
    fail("calibration action must be bed-level, vibration, or flow", { exitCode: 4, code: "bad_args" });
  }
  return {
    topicBody: {
      print: {
        sequence_id: sequenceId,
        command: "calibration",
        option,
      },
    },
    sequenceId,
    command: "calibration",
    action,
    option,
    lidarBit: 0,
    verification: UNVERIFIED,
    sources: [SOURCES.mqtt],
    notes: [
      "OpenBambuAPI print.calibration option is a bitmask: lidar 1, bed levelling 2, vibration compensation 4, motor noise 8.",
      "Bit 0 (lidar) is left clear. The A1 mini has no lidar.",
      "Bit 3 (motor noise) is not sent. A1 mini support for that bit was not established.",
      "The same page says some printers need gcode_file /usr/etc/print/auto_cali_for_user.gcode instead. This harness does not send that path.",
    ],
  };
}

export function flowCalibrationExplanation() {
  return {
    ok: true,
    command: "calibrate",
    action: "flow",
    sent: false,
    performed: false,
    verification: UNVERIFIED,
    sources: [SOURCES.mqtt],
    reason: "Flow calibration is the project_file field flow_cali (and, on the cloud task, flowCali plus extrudeCaliFlag). It is not a print.calibration bitmask bit. No standalone MQTT command was sourced.",
    next: "bambu lan print FILE.gcode.3mf --flow-cali --yes",
    lanNext: "bambu lan print FILE.gcode.3mf --flow-cali --yes",
  };
}

export function temperatureRequest(sequenceId, part, raw) {
  if (part !== "nozzle" && part !== "bed") {
    fail("temperature target must be nozzle or bed", { exitCode: 4, code: "bad_args" });
  }
  const limit = part === "bed" ? A1_MINI.bedMaxC : A1_MINI.nozzleMaxC;
  const celsius = assertWholeNumber(raw, `${part} temperature`, 0, limit);
  const line = part === "nozzle" ? `M104 S${celsius}\n` : `M140 S${celsius}\n`;
  return {
    topicBody: { print: { sequence_id: sequenceId, command: "gcode_line", param: line } },
    sequenceId,
    command: "gcode_line",
    gcode: line.trim(),
    part,
    celsius,
    limitC: part === "nozzle" ? A1_MINI.nozzleMaxC : A1_MINI.bedMaxC,
    verification: UNVERIFIED,
    sources: [SOURCES.mqtt, SOURCES.gcode, SOURCES.machineProfile],
    notes: [
      "The MQTT command is print.gcode_line. There is no separate nozzle or bed field in the sourced MQTT reference.",
      "M104 sets nozzle temperature and M140 sets bed temperature in the official A1 mini 0.4 nozzle machine_start_gcode (M104 S170 and M140 S[bed_temperature_initial_layer_single]).",
      "The numeric caps are this harness: nozzle <= 260 C and bed <= 80 C. They are enforced here, not by a sourced firmware limit.",
    ],
  };
}

export function fanRequest(sequenceId, channel, raw) {
  if (channel !== "part") {
    fail("A1 mini fan control in this harness is part only (M106 P1). The official 0.4 nozzle profile sets auxiliary_fan to 0. aux and chamber are not sent.", {
      exitCode: 4,
      code: "bad_args",
    });
  }
  const pwm = assertWholeNumber(raw, "fan speed", 0, A1_MINI.fanPwmMax);
  const line = `M106 P${A1_MINI.partFanP} S${pwm}\n`;
  return {
    topicBody: { print: { sequence_id: sequenceId, command: "gcode_line", param: line } },
    sequenceId,
    command: "gcode_line",
    gcode: line.trim(),
    channel: "part",
    pwm,
    verification: UNVERIFIED,
    sources: [SOURCES.mqtt, SOURCES.gcode, SOURCES.machineProfile],
    notes: [
      "OpenBambuAPI gcode.md: M106 P1 S0-255 is the part cooling fan, P2 aux, P3 chamber.",
      "Live acceptance of this line over print.gcode_line is UNVERIFIED on an A1 mini.",
    ],
  };
}

const SPEED_LEVELS = {
  silent: "1",
  standard: "2",
  sport: "3",
  ludicrous: "4",
};

export function speedRequest(sequenceId, name) {
  const param = SPEED_LEVELS[String(name || "").toLowerCase()];
  if (!param) fail("speed must be silent, standard, sport, or ludicrous", { exitCode: 4, code: "bad_args" });
  return {
    topicBody: { print: { sequence_id: sequenceId, command: "print_speed", param } },
    sequenceId,
    command: "print_speed",
    level: name.toLowerCase(),
    param,
    verification: UNVERIFIED,
    sources: [SOURCES.mqtt],
    notes: ["OpenBambuAPI print.print_speed param is the string 1 silent, 2 standard, 3 sport, 4 ludicrous. The report field spd_lvl echoes the active level."],
  };
}

export function localProjectFile({ sequenceId, fileName, platePath, md5, flags }) {
  return {
    print: {
      sequence_id: sequenceId,
      command: "project_file",
      param: platePath,
      project_id: "0",
      profile_id: "0",
      task_id: "0",
      subtask_id: "0",
      subtask_name: "",
      file: "",
      url: `ftp:///${fileName}`,
      md5,
      timelapse: flags.timelapse,
      bed_type: "auto",
      bed_levelling: flags.bedLeveling,
      flow_cali: flags.flowCali,
      vibration_cali: flags.vibrationCali,
      layer_inspect: flags.layerInspect,
      ams_mapping: "",
      use_ams: false,
    },
  };
}
