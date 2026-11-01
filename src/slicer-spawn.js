import { spawn } from "node:child_process";
import fs from "node:fs";
import { fail } from "./errors.js";

const EXTRA_ENV = new Set(["XDG_RUNTIME_DIR", "DISPLAY", "QT_QPA_PLATFORM"]);

function safeArg(value, index) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    fail(`slicer argument ${index} is not a single-line string`, { exitCode: 4, code: "bad_args" });
  }
  return value;
}

function slicerEnv(extra) {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    APPIMAGE_EXTRACT_AND_RUN: "1",
    QT_QPA_PLATFORM: "offscreen",
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!EXTRA_ENV.has(key)) continue;
      if (typeof value !== "string" || value.includes("\0") || value.includes("\n")) continue;
      env[key] = value;
    }
  }
  return env;
}

export function spawnSlicer(argv, { cwd, extraEnv, timeoutMs = 180_000 } = {}) {
  if (!Array.isArray(argv) || argv.length < 1) fail("slicer argv is empty", { code: "slicer" });
  const args = argv.map((value, index) => safeArg(value, index));
  const binary = args[0];
  if (!fs.existsSync(binary)) fail(`slicer binary not found: ${binary}`, { code: "slicer" });
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() && !stat.isSymbolicLink()) fail("slicer path is not a file", { code: "slicer" });
  const child = spawn(binary, args.slice(1), {
    cwd,
    env: slicerEnv(extraEnv),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 200_000) stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 200_000) stderr += chunk;
  });
  let timer;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("slicer timed out"), { code: "slicer_timeout", stdout, stderr }));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
  return { child, done };
}
