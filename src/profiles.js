import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

const SKIP = new Set(["inherits", "instantiation", "setting_id", "renamed_from"]);

export const OFFICIAL_PROFILES = {
  machine: "BBL/machine/Bambu Lab A1 mini 0.4 nozzle.json",
  process: "BBL/process/0.20mm Standard @BBL A1M.json",
  filament: "BBL/filament/Bambu PLA Basic @BBL A1M.json",
};

function indexProfiles(root) {
  const index = new Map();
  const realRoot = fs.realpathSync(root);
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const real = fs.realpathSync(full);
        if (!real.startsWith(realRoot + path.sep) && real !== realRoot) continue;
      }
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".json")) {
        const name = ent.name.slice(0, -5);
        const list = index.get(name) ?? [];
        list.push(full);
        index.set(name, list);
      }
    }
  }
  walk(root);
  return { index, realRoot };
}

function choose(index, root, name, fromFile) {
  const candidates = index.get(name);
  if (!candidates?.length) fail(`profile parent not found: ${name}`, { code: "slicer" });
  const fromVendor = path.relative(root, fromFile).split(path.sep)[0];
  const fromDir = path.dirname(fromFile);
  const ranked = candidates.map((candidate) => {
    let score = 0;
    if (path.dirname(candidate) === fromDir) score += 100;
    const vendor = path.relative(root, candidate).split(path.sep)[0];
    if (vendor === fromVendor) score += 40;
    if (path.basename(path.dirname(candidate)) === path.basename(fromDir)) score += 10;
    return { candidate, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].candidate;
}

export function flattenProfile(file, root) {
  const { index } = indexProfiles(root);
  const realRoot = fs.realpathSync(root);
  function load(target, seen) {
    const real = fs.realpathSync(target);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      fail("profile path escaped the profiles directory", { code: "slicer" });
    }
    if (seen.has(real)) fail(`profile inheritance cycle at ${path.basename(target)}`, { code: "slicer" });
    if (seen.size > 16) fail("profile inheritance is too deep", { code: "slicer" });
    seen.add(real);
    const json = JSON.parse(fs.readFileSync(real, "utf8"));
    let merged = {};
    if (typeof json.inherits === "string" && json.inherits) {
      merged = load(choose(index, root, json.inherits, real), seen);
    }
    for (const [key, value] of Object.entries(json)) {
      if (SKIP.has(key)) continue;
      merged[key] = value;
    }
    if (!merged.from) merged.from = "system";
    delete merged.inherits;
    return merged;
  }
  return load(file, new Set());
}

export function profilesRootFromBinary(binary) {
  if (!binary) return null;
  const resolved = path.resolve(binary);
  const appRunDir = path.basename(resolved) === "AppRun" ? path.dirname(resolved) : null;
  const candidates = [
    appRunDir ? path.join(appRunDir, "resources", "profiles") : null,
    path.join(path.dirname(resolved), "squashfs-root", "resources", "profiles"),
    path.join(path.dirname(resolved), "resources", "profiles"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function officialProfilePaths(root) {
  const paths = {
    machine: path.join(root, OFFICIAL_PROFILES.machine),
    process: path.join(root, OFFICIAL_PROFILES.process),
    filament: path.join(root, OFFICIAL_PROFILES.filament),
  };
  for (const [key, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) fail(`official ${key} profile is missing under ${root}`, { code: "slicer" });
  }
  return paths;
}
