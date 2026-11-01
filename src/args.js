import { fail } from "./errors.js";

const VALUE_OPTIONS = new Set([
  "serial",
  "timeout",
  "timeout-sec",
  "plate",
  "bed-type",
  "auto-bed-leveling",
  "layer",
  "infill",
  "filament",
  "out",
  "host",
  "every",
  "minutes",
  "seconds",
  "access-code-file",
]);

const BOOLEAN_OPTIONS = new Set([
  "help",
  "text",
  "yes",
  "force",
  "bed-leveling",
  "no-bed-leveling",
  "flow-cali",
  "no-flow-cali",
  "vibration-cali",
  "no-vibration-cali",
  "layer-inspect",
  "no-layer-inspect",
  "timelapse",
  "no-timelapse",
  "ams",
  "no-ams",
  "supports",
  "print-plan",
  "auto-stop",
  "accept-new-pin",
]);

const FORBIDDEN = new Set(["password", "code", "token", "access-token", "refresh-token", "access-code"]);

export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.add("help");
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      fail(`unknown argument ${arg}`, { exitCode: 4, code: "bad_args" });
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!/^[a-z0-9-]{1,40}$/.test(name)) fail("malformed option", { exitCode: 4, code: "bad_args" });
    if (FORBIDDEN.has(name)) {
      fail(`refusing --${name}. Use an environment variable or a mode 0600 file. The value is not read from the command line.`, {
        exitCode: 4,
        code: "bad_args",
      });
    }
    if (eq !== -1) {
      if (!VALUE_OPTIONS.has(name)) fail(`unknown option --${name}`, { exitCode: 4, code: "bad_args" });
      if (options[name] !== undefined) fail(`duplicate option --${name}`, { exitCode: 4, code: "bad_args" });
      options[name] = arg.slice(eq + 1);
      continue;
    }
    if (VALUE_OPTIONS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined) fail(`missing value for --${name}`, { exitCode: 4, code: "bad_args" });
      options[name] = value;
      i += 1;
      continue;
    }
    if (!BOOLEAN_OPTIONS.has(name)) fail(`unknown option --${name}`, { exitCode: 4, code: "bad_args" });
    flags.add(name);
  }
  return { positionals, options, flags };
}

export function timeoutMs(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) fail("--timeout must be a whole number of seconds", { exitCode: 4, code: "bad_args" });
  const seconds = Number(value);
  if (seconds < 1 || seconds > 120) fail("--timeout must be from 1 to 120 seconds", { exitCode: 4, code: "bad_args" });
  return seconds * 1000;
}

/** Overall FTPS data-transfer ceiling (idle gap stays fixed; see LIMITS.ftpsIdleTimeoutMs). */
export function transferTimeoutMs(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) fail("--timeout-sec must be a whole number of seconds", { exitCode: 4, code: "bad_args" });
  const seconds = Number(value);
  if (seconds < 1 || seconds > 7200) {
    fail("--timeout-sec must be from 1 to 7200 seconds", { exitCode: 4, code: "bad_args" });
  }
  return seconds * 1000;
}
