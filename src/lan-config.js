import { isRfc1918 } from "./a1mini.js";
import { testModeEnabled } from "./allow.js";
import { validateSerial, readSecretFile } from "./printer.js";
import { fail } from "./errors.js";
import { noteSecret } from "./redact.js";
import { readPrivateJson, writePrivateJson } from "./session.js";

const LAN_FILE = "lan.json";

export function assertLanHost(host) {
  const value = String(host ?? "").trim();
  if (testModeEnabled()) {
    if (value !== "127.0.0.1") {
      fail("LAN test mode only allows 127.0.0.1. Discovery and other addresses are refused.", { code: "host_refused" });
    }
    return value;
  }
  if (!isRfc1918(value)) {
    fail("LAN host must be one RFC1918 IPv4 address (10/8, 172.16/12, or 192.168/16). Names, public addresses, and link-local addresses are refused.", {
      exitCode: 4,
      code: "host_refused",
    });
  }
  return value;
}

export function lanPort(kind) {
  const fixed = { camera: 6000, mqtt: 8883, ftps: 990 };
  if (!testModeEnabled()) return fixed[kind];
  const envName = kind === "camera" ? "BAMBU_LAN_CAMERA_PORT" : kind === "mqtt" ? "BAMBU_LAN_MQTT_PORT" : "BAMBU_LAN_FTPS_PORT";
  const raw = process.env[envName];
  if (!/^\d+$/.test(raw || "")) fail(`test mode requires ${envName}`, { code: "test_config" });
  const port = Number(raw);
  if (port < 1 || port > 65535) fail(`${envName} is not a port`, { code: "test_config" });
  return port;
}

export function saveLanConfig({ host, serial }) {
  const checkedHost = assertLanHost(host);
  const checkedSerial = validateSerial(serial);
  writePrivateJson(LAN_FILE, { version: 1, host: checkedHost, serial: checkedSerial });
  return { host: checkedHost, serial: checkedSerial };
}

export function loadLanConfig() {
  const parsed = readPrivateJson(LAN_FILE);
  if (!parsed) {
    fail("LAN is not configured. Run bambu lan configure --host <RFC1918> --serial <serial>. The access code is not stored in this file.", {
      exitCode: 4,
      code: "lan_unconfigured",
    });
  }
  const host = assertLanHost(parsed.host);
  const serial = validateSerial(parsed.serial);
  return { host, serial };
}

export function readAccessCode(options) {
  let value = "";
  if (options?.["access-code-file"]) value = readSecretFile(options["access-code-file"], { kind: "access code" });
  else if (process.env.BAMBU_ACCESS_CODE) value = String(process.env.BAMBU_ACCESS_CODE).replace(/\r?\n$/, "");
  else {
    fail("Set BAMBU_ACCESS_CODE or --access-code-file (mode 0600). The access code is never a command-line argument.", {
      exitCode: 4,
      code: "bad_args",
    });
  }
  if (!/^[A-Za-z0-9]{8,16}$/.test(value)) {
    fail("access code must be 8 to 16 letters or digits on one line", { exitCode: 4, code: "bad_file" });
  }
  noteSecret(value);
  return value;
}
