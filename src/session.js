import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail } from "./errors.js";

export function configDir() {
  const home = path.resolve(os.homedir());
  const override = process.env.BAMBU_HARNESS_HOME;
  const dir = override ? path.resolve(override) : path.join(home, ".bambu-harness");
  if (override && !path.isAbsolute(override)) fail("BAMBU_HARNESS_HOME must be absolute", { code: "config" });
  const forbidden = new Set([
    path.resolve("/"),
    home,
    path.resolve("/Users"),
    path.resolve("/home"),
    path.resolve("/tmp"),
    path.resolve("/var/tmp"),
    path.resolve(os.tmpdir()),
  ]);
  if (forbidden.has(dir)) {
    fail("refusing to use the home directory, a temp root, or a filesystem root as the config directory", { code: "config" });
  }
  return dir;
}

function assertPrivate(stat, label) {
  if (stat.isSymbolicLink()) fail(`refusing symlink ${label}`, { code: "config" });
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) fail(`${label} is group or world accessible`, { code: "config" });
}

export function ensureConfigDir() {
  const dir = configDir();
  if (fs.existsSync(dir)) {
    const existing = fs.lstatSync(dir);
    if (existing.isSymbolicLink()) fail("refusing symlink config directory", { code: "config" });
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  assertPrivate(fs.lstatSync(dir), "config directory");
  return dir;
}

export function writePrivateJson(name, value) {
  if (!/^[\w.-]{1,80}$/.test(name)) fail("bad config file name", { code: "config" });
  const dir = ensureConfigDir();
  const file = path.join(dir, name);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    fail(`refusing symlink ${name}`, { code: "config" });
  }
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  assertPrivate(fs.lstatSync(file), name);
  return file;
}

export function readPrivateJson(name) {
  if (!/^[\w.-]{1,80}$/.test(name)) fail("bad config file name", { code: "config" });
  const file = path.join(configDir(), name);
  if (!fs.existsSync(file)) return null;
  assertPrivate(fs.lstatSync(file), name);
  assertPrivate(fs.lstatSync(path.dirname(file)), "config directory");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${name} is not valid JSON`, { code: "config" });
  }
}
