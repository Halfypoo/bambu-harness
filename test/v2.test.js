import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { isRfc1918 } from "../src/a1mini.js";
import { cameraAuthPacket } from "../src/camera.js";
import { summarizeGcode } from "../src/gcode-summary.js";
import { inspectGcode3mf, makeStoredZip, readZipEntry } from "../src/gcode3mf.js";
import { formatHmsCode } from "../src/hms.js";
import { connectPinned, fingerprintOf } from "../src/lan-tls.js";
import { asciiStl, cubeTriangles } from "../src/mesh.js";
import { calibrationRequest, fanRequest, speedRequest, temperatureRequest } from "../src/payloads.js";
import { renderToolpathPng } from "../src/preview.js";
import { noteSecret, redactText } from "../src/redact.js";
import { byteDeltaRatio, watchFirstLayer } from "../src/watch-layer.js";
import { startMqttMock } from "./support/mock.js";
import { startFakeCamera, tinyJpeg } from "./support/fake-camera.js";
import { getFtps, uploadFtps } from "../src/ftps.js";
import { startFakeFtps } from "./support/fake-ftps.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const certA = fileURLToPath(new URL("./fixtures/certs/a.crt", import.meta.url));
const keyA = fileURLToPath(new URL("./fixtures/certs/a.key", import.meta.url));
const certB = fileURLToPath(new URL("./fixtures/certs/b.crt", import.meta.url));
const keyB = fileURLToPath(new URL("./fixtures/certs/b.key", import.meta.url));
// Synthetic test credentials and serial — not a real printer.
const CODE = "TestCode1234";
const SERIAL = "03919D000000001";
// TLS fixtures under test/fixtures/certs/ are synthetic (see that directory's README).

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), "bambu-v2-"));
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

function plateFile(modelText = "Bambu Lab A1 mini", bedC = 60) {
  return makeStoredZip({
    "Metadata/plate_1.gcode": `; header\n; first_layer_bed_temperature = ${bedC}\n; curr_bed_type = Textured PEI Plate\nG1 X10 Y10 E0.02\n`,
    "Metadata/project_settings.config": modelText,
  });
}

test("keeps child_process inside the slicer wrapper", () => {
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("slicer-spawn.js"));
  for (const name of files) {
    const text = readFileSync(path.join(srcDir, name), "utf8");
    assert.equal(/\beval\s*\(/.test(text), false, name);
    assert.equal(text.includes("shell: true"), false, name);
    if (name !== "slicer-spawn.js") {
      assert.equal(text.includes("child_process"), false, name);
      assert.equal(text.includes("node:child_process"), false, name);
    }
  }
  const wrapper = readFileSync(path.join(srcDir, "slicer-spawn.js"), "utf8");
  assert.match(wrapper, /shell:\s*false/);
  assert.match(wrapper, /node:child_process/);
});

test("RFC1918 allowlist and access code never travel in argv", async () => {
  assert.equal(isRfc1918("10.1.2.3"), true);
  assert.equal(isRfc1918("172.16.0.1"), true);
  assert.equal(isRfc1918("172.31.255.255"), true);
  assert.equal(isRfc1918("172.32.0.1"), false);
  assert.equal(isRfc1918("192.168.1.20"), true);
  assert.equal(isRfc1918("192.168.01.1"), false);
  assert.equal(isRfc1918("8.8.8.8"), false);
  assert.equal(isRfc1918("127.0.0.1"), false);
  assert.equal(isRfc1918("169.254.1.1"), false);
  const home = await tempHome();
  try {
    const secret = "NotOnArgv99";
    const refused = await runCli(["lan", "snapshot", "--access-code", secret, "--out", "frame.jpg"], {}, home);
    assert.equal(refused.code, 4);
    assert.equal(refused.stderr.includes(secret), false);
    assert.equal((await runCli(["lan", "configure", "--host", "8.8.8.8", "--serial", SERIAL], {}, home)).code, 4);
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], {}, home)).code, 4);
    assert.equal((await runCli(["lan", "discover"], {}, home)).code, 4);
    const saved = await runCli(["lan", "configure", "--host", "192.168.1.20", "--serial", SERIAL], {}, home);
    assert.equal(saved.code, 0, saved.stderr);
    const file = path.join(home, "config", "lan.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(home, "config")).mode & 0o777, 0o700);
    const body = JSON.parse(await readFile(file, "utf8"));
    assert.equal(body.host, "192.168.1.20");
    assert.equal(body.accessCode, undefined);
    assert.equal(JSON.stringify(body).includes("code"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("camera auth packet matches the 80-byte layout", () => {
  const packet = cameraAuthPacket(CODE);
  assert.equal(packet.length, 80);
  assert.equal(packet.readUInt32LE(0), 0x40);
  assert.equal(packet.readUInt32LE(4), 0x3000);
  assert.equal(packet.readUInt32LE(8), 0);
  assert.equal(packet.subarray(16, 20).toString("ascii"), "bblp");
  assert.equal(packet[20], 0);
  assert.equal(packet.subarray(48, 48 + CODE.length).toString("ascii"), CODE);
  assert.equal(packet[48 + CODE.length], 0);
});

test("TOFU pins the camera cert and refuses a change before the access code is sent", async () => {
  const home = await tempHome();
  const cert = readFileSync(certA);
  const key = readFileSync(keyA);
  let camera = await startFakeCamera({ cert, key, accessCode: CODE });
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_ACCESS_CODE: CODE,
    BAMBU_LAN_CAMERA_PORT: String(camera.port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const out = path.join(home, "frame.jpg");
    const first = await runCli(["lan", "snapshot", "--out", out], env, home);
    assert.equal(first.code, 0, first.stderr);
    const frame = JSON.parse(first.stdout);
    assert.equal(frame.pin, "first-use");
    assert.equal(first.stdout.includes(CODE), false);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(readFileSync(out)[0], 0xff);
    assert.equal(readFileSync(out)[1], 0xd8);
    assert.equal(camera.connections[0].user, "bblp");
    assert.equal(camera.connections[0].codeOk, true);
    assert.equal(camera.connections[0].magic, 0x40);
    const again = await runCli(["lan", "snapshot", "--out", out], env, home);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).pin, "match");
    const pinnedPort = camera.port;
    await camera.close();
    camera = await startFakeCamera({
      cert: readFileSync(certB),
      key: readFileSync(keyB),
      accessCode: CODE,
      port: pinnedPort,
    });
    env.BAMBU_LAN_CAMERA_PORT = String(camera.port);
    const changed = await runCli(["lan", "snapshot", "--out", out], env, home);
    assert.equal(changed.code, 4, changed.stdout);
    const error = JSON.parse(changed.stderr);
    assert.equal(error.code, "cert_changed");
    assert.match(error.error, /UNVERIFIED/);
    assert.equal(changed.stderr.includes(CODE), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(camera.events.secure, 0);
    assert.equal(camera.events.clientError, 1);
    assert.equal(camera.connections.length, 0);
    const replaced = await runCli(["lan", "snapshot", "--out", out, "--accept-new-pin"], env, home);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.equal(JSON.parse(replaced.stdout).pin, "replaced");
    assert.equal(camera.connections.at(-1).codeOk, true);
  } finally {
    await camera.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("first-layer capture records a note and does not stop unless asked", async () => {
  const home = await tempHome();
  const camera = await startFakeCamera({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
  });
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_ACCESS_CODE: CODE,
    BAMBU_LAN_CAMERA_PORT: String(camera.port),
  };
  const directory = path.join(home, "layer");
  try {
    process.env.BAMBU_HARNESS_HOME = path.join(home, "config");
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const watched = await runCli(["lan", "watch-first-layer", "--out", directory, "--every", "0"], env, home);
    assert.equal(watched.code, 0, watched.stderr);
    const body = JSON.parse(watched.stdout);
    assert.equal(body.frames, 4);
    assert.equal(body.autoStop, false);
    assert.equal(body.notes.length, 1);
    assert.equal(body.notes[0].autoStop, false);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(existsSync(path.join(directory, "notes.jsonl")), true);
    assert.equal(watched.stdout.includes(CODE), false);
    let stopped = 0;
    const direct = await watchFirstLayer({
      host: "127.0.0.1",
      port: camera.port,
      accessCode: CODE,
      acceptNewPin: false,
      directory: path.join(home, "layer-stop"),
      everySec: 0,
      durationSec: 0,
      autoStop: true,
      stop: async () => {
        stopped += 1;
        return { acknowledgement: "acknowledged" };
      },
    });
    assert.equal(stopped, 1);
    assert.equal(direct.notes[0].autoStop, true);
    assert.equal(direct.notes[0].stop.acknowledgement, "acknowledged");
  } finally {
    delete process.env.BAMBU_HARNESS_HOME;
    await camera.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("connectPinned accepts a resumed TLS session with no peer certificate", async () => {
  const cert = readFileSync(certA);
  const key = readFileSync(keyA);
  const server = tls.createServer({ cert, key }, (socket) => {
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    const control = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      });
      socket.once("error", reject);
      socket.once("secureConnect", () => resolve(socket));
    });
    const fingerprint = fingerprintOf(control);
    const [session] = await once(control, "session");
    assert.ok(session?.length);
    const data = await connectPinned({
      host: "127.0.0.1",
      port,
      fingerprint,
      session,
    });
    assert.equal(data.isSessionReused(), true);
    assert.equal(Boolean(data.getPeerCertificate(true)?.raw?.length), false);
    assert.throws(() => fingerprintOf(data), (error) => error.code === "cert_changed");
    data.end();
    control.end();
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("FTPS upload stays on the configured host", async () => {
  const home = await tempHome();
  const ftps = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
  });
  const bad = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    pasvHost: "1.2.3.4",
  });
  const file = path.join(home, "job.gcode.3mf");
  const bytes = plateFile();
  await writeFile(file, bytes);
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_ACCESS_CODE: CODE,
    BAMBU_LAN_FTPS_PORT: String(ftps.port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const uploaded = await runCli(["lan", "upload", file], env, home);
    assert.equal(uploaded.code, 0, uploaded.stderr);
    const body = JSON.parse(uploaded.stdout);
    assert.equal(body.remote, "job.gcode.3mf");
    assert.equal(body.printed, false);
    assert.equal(uploaded.stdout.includes(CODE), false);
    assert.equal(ftps.uploads.length, 1);
    assert.equal(ftps.uploads[0].name, "job.gcode.3mf");
    assert.equal(Buffer.compare(ftps.uploads[0].body, bytes), 0);
    env.BAMBU_LAN_FTPS_PORT = String(bad.port);
    const refused = await runCli(["lan", "upload", file, "--accept-new-pin"], env, home);
    assert.equal(refused.code, 1, refused.stdout);
    assert.equal(JSON.parse(refused.stderr).code, "host_refused");
    assert.equal(bad.uploads.length, 0);
    assert.equal(refused.stderr.includes(CODE), false);
  } finally {
    await ftps.close();
    await bad.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("LAN print publishes the sourced project_file and reports silence", async () => {
  const home = await tempHome();
  const ftps = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
  });
  let ack = true;
  let seen = null;
  const mqtt = await startMqttMock(({ topic, json, publish }) => {
    if (json?.print?.command !== "project_file") return;
    seen = json.print;
    if (!ack) return;
    publish(topic.replace(/\/request$/, "/report"), {
      print: { command: "project_file", sequence_id: json.print.sequence_id, result: "success" },
    });
  });
  const file = path.join(home, "job.gcode.3mf");
  await writeFile(file, plateFile());
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_ACCESS_CODE: CODE,
    BAMBU_LAN_FTPS_PORT: String(ftps.port),
    BAMBU_LAN_MQTT_PORT: String(new URL(mqtt.url).port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const printed = await runCli(["lan", "print", file, "--yes", "--timeout", "3"], env, home);
    assert.equal(printed.code, 0, printed.stderr);
    const body = JSON.parse(printed.stdout);
    assert.equal(body.acknowledgement, "acknowledged");
    assert.equal(body.doNotRetry, true);
    assert.equal(seen.url, "ftp:///job.gcode.3mf");
    assert.equal(seen.use_ams, false);
    assert.equal(seen.bed_type, "auto");
    assert.equal(seen.bed_levelling, true);
    assert.equal(seen.project_id, "0");
    assert.equal(seen.param, "Metadata/plate_1.gcode");
    assert.equal(printed.stdout.includes(CODE), false);
    ack = false;
    const ignored = await runCli(["lan", "print", file, "--yes", "--timeout", "1", "--accept-new-pin"], env, home);
    assert.equal(ignored.code, 3);
    const error = JSON.parse(ignored.stderr);
    assert.equal(error.code, "not_acknowledged");
    assert.equal(error.doNotRetry, true);
    assert.match(error.error, /lan status|printer screen/i);
  } finally {
    await ftps.close();
    await mqtt.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("lan print refuses a cool PLA bed unless --force", async () => {
  const home = await tempHome();
  const cool = path.join(home, "cool.gcode.3mf");
  await writeFile(cool, plateFile("Bambu Lab A1 mini", 35));
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], { BAMBU_HARNESS_TEST: "1" }, home)).code, 0);
    const refused = await runCli(["lan", "print", cool, "--yes", "--access-code-file", codeFile], { BAMBU_HARNESS_TEST: "1", BAMBU_LAN_FTPS_PORT: "9" }, home);
    assert.equal(refused.code, 4);
    const error = JSON.parse(refused.stderr);
    assert.equal(error.code, "bed_too_cool");
    assert.equal(error.bedTargetC, 35);
    assert.equal(refused.stderr.includes(CODE), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("lan print refuses a missing bed temperature unless --force", async () => {
  const home = await tempHome();
  const unknown = path.join(home, "unknown-bed.gcode.3mf");
  await writeFile(
    unknown,
    makeStoredZip({
      "Metadata/plate_1.gcode": "; header\n; curr_bed_type = Textured PEI Plate\nG1 X10 Y10 E0.02\n",
      "Metadata/project_settings.config": "Bambu Lab A1 mini",
    }),
  );
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], { BAMBU_HARNESS_TEST: "1" }, home)).code, 0);
    const refused = await runCli(["lan", "print", unknown, "--yes", "--access-code-file", codeFile], { BAMBU_HARNESS_TEST: "1", BAMBU_LAN_FTPS_PORT: "9" }, home);
    assert.equal(refused.code, 4);
    const error = JSON.parse(refused.stderr);
    assert.equal(error.code, "bed_target_unknown");
    assert.equal(error.bedTargetC, null);
    assert.equal(refused.stderr.includes(CODE), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("lan watch-first-layer --auto-stop requires --yes", async () => {
  const home = await tempHome();
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], { BAMBU_HARNESS_TEST: "1" }, home)).code, 0);
    const refused = await runCli(
      ["lan", "watch-first-layer", "--out", path.join(home, "layer"), "--every", "0", "--auto-stop", "--access-code-file", codeFile],
      { BAMBU_HARNESS_TEST: "1", BAMBU_LAN_CAMERA_PORT: "9" },
      home,
    );
    assert.equal(refused.code, 4);
    const error = JSON.parse(refused.stderr);
    assert.equal(error.code, "confirmation_required");
    assert.match(error.error, /--yes/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("lan ls and lan get work over FTPS with spaced names", async () => {
  const home = await tempHome();
  const spaced = "my model.gcode.3mf";
  const ftps = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    files: { [spaced]: Buffer.from("hello-remote") },
  });
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_LAN_FTPS_PORT: String(ftps.port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const listed = await runCli(["lan", "ls", "--access-code-file", codeFile], env, home);
    assert.equal(listed.code, 0, listed.stderr);
    const listBody = JSON.parse(listed.stdout);
    assert.equal(listBody.command, "lan-ls");
    assert.equal(listBody.modifiedClock, "printer-local");
    const spacedEntry = listBody.entries.find((entry) => entry.name === spaced && entry.size === 12);
    assert.ok(spacedEntry);
    assert.match(spacedEntry.modified, /^20\d\d-\d\d-\d\dT12:00:00$/);
    assert.equal(spacedEntry.modified.endsWith("Z"), false);
    assert.equal(listed.stdout.includes(CODE), false);
    const out = path.join(home, "downloaded.gcode.3mf");
    const got = await runCli(["lan", "get", spaced, "--out", out, "--access-code-file", codeFile], env, home);
    assert.equal(got.code, 0, got.stderr);
    const getBody = JSON.parse(got.stdout);
    assert.equal(getBody.remote, spaced);
    assert.equal(getBody.bytes, 12);
    assert.equal((await readFile(out)).toString("utf8"), "hello-remote");
    assert.equal(got.stdout.includes(CODE), false);
  } finally {
    await ftps.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("FTPS get idle timeout allows slow-but-steady transfers and fails when stalled", async () => {
  const home = await tempHome();
  const remote = "slow.gcode.3mf";
  // 8 chunks × 250ms gap ≈ 1.75s wall time (> 500ms idle) but never idle that long.
  const payload = Buffer.alloc(8 * 1024, 0x5a);
  const slow = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    files: { [remote]: payload },
    retrMode: "slow",
    retrPace: { chunkSize: 1024, delayMs: 250 },
  });
  const stalled = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    files: { [remote]: payload },
    retrMode: "stall",
    retrStallAfter: 64,
  });
  try {
    process.env.BAMBU_HARNESS_TEST = "1";
    process.env.BAMBU_HARNESS_HOME = path.join(home, "config");
    const outOk = path.join(home, "ok.bin");
    const got = await getFtps({
      host: "127.0.0.1",
      port: slow.port,
      accessCode: CODE,
      remotePath: remote,
      outPath: outOk,
      acceptNewPin: true,
      idleTimeoutMs: 500,
      maxTimeoutMs: 15_000,
    });
    assert.equal(got.bytes, payload.length);
    assert.equal(Buffer.compare(await readFile(outOk), payload), 0);

    const outBad = path.join(home, "bad.bin");
    const started = Date.now();
    await assert.rejects(
      () => getFtps({
        host: "127.0.0.1",
        port: stalled.port,
        accessCode: CODE,
        remotePath: remote,
        outPath: outBad,
        acceptNewPin: true,
        idleTimeoutMs: 400,
        maxTimeoutMs: 15_000,
      }),
      (error) => error?.code === "ftps" && /FTPS data timed out/.test(error.message),
    );
    assert.ok(Date.now() - started < 5_000, "stalled get should idle-timeout quickly");
  } finally {
    delete process.env.BAMBU_HARNESS_TEST;
    delete process.env.BAMBU_HARNESS_HOME;
    await slow.close();
    await stalled.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("FTPS upload idle timeout allows slow drains and fails when stalled", async () => {
  const home = await tempHome();
  // Large enough to exceed the data-socket highWaterMark so backpressure engages.
  const body = Buffer.alloc(64 * 1024, 0xab);
  const slow = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    storDrain: "slow",
    storPace: { chunkDelayMs: 200 },
  });
  const stalled = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    storDrain: "stall",
    storStallAfter: 1024,
  });
  try {
    process.env.BAMBU_HARNESS_TEST = "1";
    process.env.BAMBU_HARNESS_HOME = path.join(home, "config");
    const uploaded = await uploadFtps({
      host: "127.0.0.1",
      port: slow.port,
      accessCode: CODE,
      filename: "job.gcode.3mf",
      body,
      acceptNewPin: true,
      idleTimeoutMs: 800,
      maxTimeoutMs: 60_000,
    });
    assert.equal(uploaded.bytes, body.length);
    assert.equal(slow.uploads.length, 1);
    assert.equal(Buffer.compare(slow.uploads[0].body, body), 0);

    const started = Date.now();
    await assert.rejects(
      () => uploadFtps({
        host: "127.0.0.1",
        port: stalled.port,
        accessCode: CODE,
        filename: "job.gcode.3mf",
        body,
        acceptNewPin: true,
        idleTimeoutMs: 5_000,
        // Small bodies fit in the OS send buffer; overall max still covers the hung 226.
        maxTimeoutMs: 700,
      }),
      (error) => error?.code === "ftps" && /FTPS data timed out/.test(error.message),
    );
    assert.ok(Date.now() - started < 3_000, "stalled upload should hit the overall transfer ceiling quickly");
  } finally {
    delete process.env.BAMBU_HARNESS_TEST;
    delete process.env.BAMBU_HARNESS_HOME;
    await slow.close();
    await stalled.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("lan get honors --timeout-sec overall transfer ceiling", async () => {
  const home = await tempHome();
  const remote = "ceiling.gcode.3mf";
  // Many small chunks so idle never trips, but overall max does.
  const payload = Buffer.alloc(40 * 1024, 0x11);
  const ftps = await startFakeFtps({
    cert: readFileSync(certA),
    key: readFileSync(keyA),
    accessCode: CODE,
    files: { [remote]: payload },
    retrMode: "slow",
    retrPace: { chunkSize: 1024, delayMs: 200 },
  });
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_LAN_FTPS_PORT: String(ftps.port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    process.env.BAMBU_HARNESS_HOME = path.join(home, "config");
    const out = path.join(home, "ceiling.bin");
    const started = Date.now();
    await assert.rejects(
      () => getFtps({
        host: "127.0.0.1",
        port: ftps.port,
        accessCode: CODE,
        remotePath: remote,
        outPath: out,
        acceptNewPin: true,
        idleTimeoutMs: 5_000,
        maxTimeoutMs: 600,
      }),
      (error) => error?.code === "ftps" && /FTPS data timed out/.test(error.message),
    );
    assert.ok(Date.now() - started < 3_000);

    const refused = await runCli(
      ["lan", "get", remote, "--out", path.join(home, "cli-out.bin"), "--timeout-sec", "0", "--access-code-file", codeFile],
      env,
      home,
    );
    assert.equal(refused.code, 4);
    assert.match(JSON.parse(refused.stderr).error, /timeout-sec/);
  } finally {
    delete process.env.BAMBU_HARNESS_HOME;
    await ftps.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("lan stop publishes MQTT stop", async () => {
  const home = await tempHome();
  let seen = null;
  const mqtt = await startMqttMock(({ topic, json, publish }) => {
    if (json?.print?.command !== "stop") return;
    seen = json.print;
    publish(topic.replace(/\/request$/, "/report"), {
      print: { command: "stop", sequence_id: json.print.sequence_id, result: "success" },
    });
  });
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_LAN_MQTT_PORT: String(new URL(mqtt.url).port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const needsYes = await runCli(["lan", "stop", "--access-code-file", codeFile], env, home);
    assert.equal(needsYes.code, 4);
    const stopped = await runCli(["lan", "stop", "--yes", "--access-code-file", codeFile, "--timeout", "3"], env, home);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).command, "lan-stop");
    assert.equal(seen.command, "stop");
    assert.equal(stopped.stdout.includes(CODE), false);
  } finally {
    await mqtt.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("calibration, temperature, fan, and speed stay inside sourced limits", async () => {
  const bed = calibrationRequest("9", "bed-level");
  const vibration = calibrationRequest("9", "vibration");
  assert.equal(bed.topicBody.print.option, 2);
  assert.equal(vibration.topicBody.print.option, 4);
  assert.equal(bed.topicBody.print.command, "calibration");
  assert.equal(bed.lidarBit, 0);
  assert.equal(JSON.stringify(bed.topicBody).includes("gcode_file"), false);
  assert.equal(speedRequest("9", "ludicrous").topicBody.print.param, "4");
  assert.equal(speedRequest("9", "silent").topicBody.print.param, "1");
  assert.equal(temperatureRequest("9", "nozzle", "260").gcode, "M104 S260");
  assert.equal(temperatureRequest("9", "bed", "80").gcode, "M140 S80");
  assert.throws(() => temperatureRequest("9", "nozzle", "261"));
  assert.throws(() => temperatureRequest("9", "bed", "81"));
  assert.throws(() => fanRequest("9", "aux", "10"));
  assert.equal(fanRequest("9", "part", "255").gcode, "M106 P1 S255");
  assert.equal(formatHmsCode(0x03000200, 0x00010001), "0300_0200_0001_0001");
  const home = await tempHome();
  try {
    const flow = await runCli(["lan", "calibrate", "flow"], {}, home);
    assert.equal(flow.code, 0, flow.stderr);
    const flowBody = JSON.parse(flow.stdout);
    assert.equal(flowBody.sent, false);
    assert.equal(flowBody.performed, false);
    assert.match(flowBody.next, /--flow-cali/);
    const needsYes = await runCli(["lan", "calibrate", "bed-level"], {}, home);
    assert.equal(needsYes.code, 4);
    assert.equal(JSON.parse(needsYes.stderr).code, "confirmation_required");
    const hot = await runCli(["lan", "temperature", "nozzle", "300", "--yes"], {}, home);
    assert.equal(hot.code, 4);
    assert.equal(JSON.parse(hot.stderr).code, "bad_args");
    const unconfirmed = await runCli(["lan", "temperature", "bed", "60"], {}, home);
    assert.equal(unconfirmed.code, 4);
    assert.equal(JSON.parse(unconfirmed.stderr).code, "confirmation_required");
    const aux = await runCli(["lan", "fan", "aux", "10", "--yes"], {}, home);
    assert.equal(aux.code, 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("lan calibrate and diagnose use the local broker only", async () => {
  const home = await tempHome();
  let option = null;
  const mqtt = await startMqttMock(({ topic, json, publish }) => {
    if (json?.print?.command === "calibration") {
      option = json.print.option;
      publish(topic.replace(/\/request$/, "/report"), {
        print: { command: "calibration", sequence_id: json.print.sequence_id, result: "success" },
      });
    }
    if (json?.pushing?.command === "pushall" || json?.info?.command === "get_version") {
      const report = topic.replace(/\/request$/, "/report");
      publish(report, {
        info: {
          command: "get_version",
          sequence_id: json.info?.sequence_id || "1",
          module: [{ name: "ota", sw_ver: "01.07.00.00", sn: "SHOULD-NOT-APPEAR" }],
        },
      });
      publish(report, {
        print: {
          command: "push_status",
          gcode_state: "IDLE",
          nozzle_temper: 32,
          nozzle_target_temper: 0,
          bed_temper: 21,
          bed_target_temper: 0,
          wifi_signal: "-82dBm",
          ams_exist_bits: "0",
          print_error: 0,
          fail_reason: "0",
          hms: [{ attr: 50332160, code: 65537 }],
        },
      });
    }
  });
  const codeFile = path.join(home, "access-code");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o600);
  const env = {
    BAMBU_HARNESS_TEST: "1",
    BAMBU_LAN_MQTT_PORT: String(new URL(mqtt.url).port),
  };
  try {
    assert.equal((await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], env, home)).code, 0);
    const calibrated = await runCli(["lan", "calibrate", "vibration", "--yes", "--timeout", "3", "--access-code-file", codeFile], env, home);
    assert.equal(calibrated.code, 0, calibrated.stderr);
    const body = JSON.parse(calibrated.stdout);
    assert.equal(body.option, 4);
    assert.equal(body.verification, "UNVERIFIED");
    assert.equal(option, 4);
    const diagnosis = await runCli(["lan", "diagnose", "--timeout", "3", "--access-code-file", codeFile], env, home);
    assert.equal(diagnosis.code, 0, diagnosis.stderr);
    const report = JSON.parse(diagnosis.stdout);
    assert.equal(report.nozzle, 32);
    assert.equal(report.bed, 21);
    assert.equal(report.amsPresent, false);
    assert.equal(report.hms[0].code, "0300-0200-0001-0001");
    assert.match(report.hms[0].text, /nozzle/i);
    assert.equal(diagnosis.stdout.includes("SHOULD-NOT-APPEAR"), false);
    assert.match(diagnosis.stdout, /-82dBm/);
    assert.equal(diagnosis.stdout.includes(CODE), false);
  } finally {
    await mqtt.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("slice rejects a non-manifold or oversized model before starting a slicer", async () => {
  const home = await tempHome();
  const open = path.join(home, "open.stl");
  const huge = path.join(home, "huge.stl");
  await writeFile(open, asciiStl([[[0, 0, 0], [10, 0, 0], [0, 10, 0]]], "open"));
  await writeFile(huge, asciiStl(cubeTriangles(200), "huge"));
  const env = { BAMBU_STUDIO_BIN: "/nonexistent/slicer" };
  try {
    const manifold = await runCli(["slice", open, "--print-plan"], env, home);
    assert.equal(manifold.code, 4);
    assert.equal(JSON.parse(manifold.stderr).code, "non_manifold");
    const bounds = await runCli(["slice", huge, "--print-plan"], env, home);
    assert.equal(bounds.code, 4);
    assert.equal(JSON.parse(bounds.stderr).code, "out_of_bounds");
    const cube = path.join(home, "cube.stl");
    await writeFile(cube, asciiStl(cubeTriangles(20)));
    const layer = await runCli(["slice", cube, "--layer", "0.5", "--print-plan"], env, home);
    assert.equal(layer.code, 4);
    assert.equal(JSON.parse(layer.stderr).code, "bad_args");
    const plan = await runCli(["slice", cube, "--layer", "0.2", "--infill", "15", "--filament", "PLA", "--print-plan", "--out", path.join(home, "cube.gcode.3mf")], env, home);
    assert.equal(plan.code, 0, plan.stderr);
    const body = JSON.parse(plan.stdout);
    assert.equal(body.executed, false);
    assert.equal(body.argv.includes("--slice"), true);
    assert.equal(existsSync(path.join(home, "cube.gcode.3mf")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("gcode summary ignores non-extruding travel and the preview is a PNG", () => {
  const summary = summarizeGcode([
    "; model printing time: 13m 36s; total estimated time: 19m 34s",
    "; total layer number: 100",
    "; filament used [g] = 3.68",
    "G90",
    "M83",
    "G1 X10 Y10 E0.1",
    "G0 X-13 Y10",
    "G1 X20 Y12 E0.05",
  ].join("\n"));
  assert.equal(summary.layerCount, 100);
  assert.equal(summary.filamentGrams, 3.68);
  assert.equal(summary.estimatedSeconds, 19 * 60 + 34);
  assert.equal(summary.extrusion.outside, 0);
  assert.equal(summary.extrusion.moves, 2);
  const outside = summarizeGcode("G1 X200 Y10 E0.2\n");
  assert.equal(outside.extrusion.outside, 1);
  const left = tinyJpeg(1);
  const right = tinyJpeg(9);
  assert.ok(byteDeltaRatio(left, right) > 0.45);
  assert.equal(byteDeltaRatio(left, left), 0);
  const rendered = renderToolpathPng("G1 X10 Y10 E0.1\nG1 X30 Y20 E0.2\n", 180);
  assert.equal(rendered.png[0], 137);
  assert.equal(rendered.png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(rendered.moves, 1);
});

test("the committed cube slice is an A1 mini plate with no extrusions outside the bed", () => {
  const file = fileURLToPath(new URL("./fixtures/sliced/cube-20mm.gcode.3mf", import.meta.url));
  const png = readFileSync(fileURLToPath(new URL("./fixtures/sliced/cube-20mm.png", import.meta.url)));
  const buf = readFileSync(file);
  const gcode = readZipEntry(buf, "Metadata/plate_1.gcode").toString("utf8");
  const summary = summarizeGcode(gcode);
  assert.equal(summary.layerCount, 100);
  assert.equal(summary.filamentGrams, 3.68);
  assert.equal(summary.estimatedTime, "19m 34s");
  assert.equal(summary.extrusion.outside, 0);
  assert.ok(summary.extrusion.moves > 1000);
  assert.match(gcode, /printer_model = Bambu Lab A1 mini/);
  assert.match(gcode, /inner_wall_speed = 300/);
  assert.match(gcode, /nozzle_diameter = 0.4/);
  assert.match(gcode, /sparse_infill_density = 15%/);
  const inspection = inspectGcode3mf(buf, 1);
  assert.equal(inspection.model.matchesN1, true);
  assert.deepEqual(inspection.warnings, []);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
});

test("a group-readable access code file is refused", async () => {
  const home = await tempHome();
  const codeFile = path.join(home, "access.txt");
  await writeFile(codeFile, `${CODE}\n`);
  await chmod(codeFile, 0o644);
  try {
    const result = await runCli(["lan", "configure", "--host", "127.0.0.1", "--serial", SERIAL], { BAMBU_HARNESS_TEST: "1" }, home);
    assert.equal(result.code, 0, result.stderr);
    const refused = await runCli(["lan", "status", "--access-code-file", codeFile], { BAMBU_HARNESS_TEST: "1", BAMBU_LAN_MQTT_PORT: "9" }, home);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /group or world/);
    assert.equal(refused.stderr.includes(CODE), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
