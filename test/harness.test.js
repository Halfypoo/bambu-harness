import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactText, redactUrl } from "../src/redact.js";
import { makeStoredZip, inspectGcode3mf, assessModelText, extractBedTarget } from "../src/gcode3mf.js";
import { parseArgs, transferTimeoutMs } from "../src/args.js";
import { LIMITS } from "../src/allow.js";
import { encodeConnect, takePacket } from "../src/mqtt.js";
import { validateSerial, PLA_BED_MIN_C } from "../src/printer.js";
import { ftpPathArg, parseListLine } from "../src/ftps.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TOKEN = "SECRET-ACCESS-TOKEN-VALUE";
const PASSWORD = "SUPER-SECRET-PASSWORD";
const ACCESS_CODE = "LANCODE1234";

function plateFile(modelText) {
  return makeStoredZip({
    "Metadata/plate_1.gcode": "; header\n; first_layer_bed_temperature = 60\n; curr_bed_type = Textured PEI Plate\nG1 X0 Y0\n",
    "Metadata/project_settings.config": modelText,
  });
}

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), "bambu-harness-"));
}

function runCli(args, env, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR || tmpdir(),
        BAMBU_HARNESS_HOME: path.join(home, "config"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("redacts tokens, bearers, and access codes", () => {
  const text = `Bearer ${TOKEN} and code ${ACCESS_CODE}`;
  const out = redactText(text, [TOKEN, ACCESS_CODE]);
  assert.equal(out.includes(TOKEN), false);
  assert.equal(out.includes(ACCESS_CODE), false);
  assert.match(out, /Bearer \[redacted\]/);
  const url = redactUrl("https://example.invalid/a?Signature=abc&X-Amz-Credential=zzz");
  assert.equal(url.includes("abc"), false);
  assert.equal(url.includes("zzz"), false);
});

test("3mf inspection requires plate gcode and extracts bed target", () => {
  const good = plateFile('{"printer_model":"Bambu Lab A1 mini","note":"N1"}');
  const inspected = inspectGcode3mf(good, 1);
  assert.equal(inspected.model.matchesN1, true);
  assert.equal(inspected.warnings.length, 0);
  assert.equal(inspected.bedTargetC, 60);
  assert.equal(inspected.bedType, "Textured PEI Plate");
  const other = plateFile('{"printer_model":"Bambu Lab X1 Carbon"}');
  const warned = inspectGcode3mf(other, 1);
  assert.equal(warned.model.matchesN1, false);
  assert.match(warned.warnings[0], /X1 Carbon/);
  const deflated = makeStoredZip({
    "Metadata/plate_1.gcode": { data: "; first_layer_bed_temperature = 55\n; gcode\n", method: 8 },
    "Metadata/project_settings.config": { data: "A1 mini", method: 8 },
  });
  assert.equal(inspectGcode3mf(deflated, 1).bedTargetC, 55);
  assert.throws(() => inspectGcode3mf(makeStoredZip({ "Metadata/foo": "x" }), 1), /plate_1/);
  assert.equal(assessModelText("Bambu Lab A1").matchesN1, false);
  assert.equal(extractBedTarget("M190 S45\n").celsius, 45);
  assert.equal(PLA_BED_MIN_C, 50);
});

test("argument parser rejects secrets on the command line", () => {
  assert.throws(() => parseArgs(["lan", "status", "--access-code", ACCESS_CODE]), /refusing --access-code/);
  try {
    parseArgs(["lan", "status", `--password=${PASSWORD}`]);
    assert.fail("expected throw");
  } catch (error) {
    assert.equal(String(error.message).includes(PASSWORD), false);
  }
  assert.throws(() => parseArgs(["lan", "status", "--nope"]), /unknown option/);
  assert.throws(() => validateSerial("bad;rm"), /serial/);
  const withTransfer = parseArgs(["lan", "get", "a.gcode.3mf", "--timeout-sec", "900"]);
  assert.equal(withTransfer.options["timeout-sec"], "900");
  assert.equal(transferTimeoutMs(undefined, LIMITS.ftpsMaxTransferTimeoutMs), 600_000);
  assert.equal(transferTimeoutMs("240", LIMITS.ftpsMaxTransferTimeoutMs), 240_000);
  assert.throws(() => transferTimeoutMs("0", 600_000), /timeout-sec/);
  assert.throws(() => transferTimeoutMs("7201", 600_000), /timeout-sec/);

  const parsed = parseArgs(["lan", "print", "job.gcode.3mf", "--yes", "--force"]);
  assert.equal(parsed.flags.has("force"), true);
});

test("CONNECT packet is well formed MQTT 3.1.1", () => {
  const packet = encodeConnect({ clientId: "bambu-harness-test", username: "bblp", password: ACCESS_CODE, keepalive: 30 });
  const parsed = takePacket(packet);
  assert.equal(parsed.header, 0x10);
  assert.equal(parsed.total, packet.length);
  assert.equal(packet.includes(Buffer.from("bblp")), true);
});

test("FTPS path quoting and LIST parsing keep spaces and dates", () => {
  assert.equal(ftpPathArg("plain.gcode.3mf"), "plain.gcode.3mf");
  assert.equal(ftpPathArg("my model.gcode.3mf"), '"my model.gcode.3mf"');
  assert.throws(() => ftpPathArg('bad"name'), /quote/);
  const entry = parseListLine("-rw-r--r-- 1 bblp bblp 1234 Oct 31 12:00 my model.gcode.3mf");
  assert.equal(entry.name, "my model.gcode.3mf");
  assert.equal(entry.size, 1234);
  assert.equal(entry.type, "file");
  assert.match(entry.modified, /^20\d\d-\d\d-\d\dT12:00:00$/);
  assert.equal(entry.modified.endsWith("Z"), false);
  const withYear = parseListLine("-rw-r--r-- 1 bblp bblp 9 Jan  2  2024 old.gcode.3mf");
  assert.equal(withYear.modified, "2024-01-02T00:00:00");
  const mlsd = parseListLine("Type=file;Size=12;Modify=20261031120000; my model.gcode.3mf");
  assert.equal(mlsd.modified, "2026-10-31T12:00:00");
  assert.equal(mlsd.modified.endsWith("Z"), false);
});

test("help describes LAN commands and omits cloud login", async () => {
  const home = await tempHome();
  try {
    const help = await runCli(["--help"], {}, home);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /lan ls/);
    assert.match(help.stdout, /lan get/);
    assert.match(help.stdout, /lan stop/);
    assert.match(help.stdout, /--force/);
    assert.match(help.stdout, /--timeout-sec/);
    assert.match(help.stdout, /idle timeout/i);
    assert.match(help.stdout, /puback/);
    assert.equal(/bambu login/i.test(help.stdout), false);
    assert.equal(/cloud\.json/i.test(help.stdout), false);
    assert.equal(help.stdout.includes(ACCESS_CODE), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
