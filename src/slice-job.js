import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { A1_MINI, assertWholeNumber } from "./a1mini.js";
import { fail } from "./errors.js";
import { inspectGcode3mf, readZipEntry } from "./gcode3mf.js";
import { summarizeGcode } from "./gcode-summary.js";
import { assertPrintableModel, inspectModelFile } from "./mesh.js";
import { renderToolpathPng } from "./preview.js";
import { flattenProfile, officialProfilePaths, profilesRootFromBinary } from "./profiles.js";
import { redactText } from "./redact.js";
import { spawnSlicer } from "./slicer-spawn.js";
import { SOURCES } from "./sources.js";

const SLICE_SOURCES = [
  SOURCES.orcaRelease,
  SOURCES.orcaCli,
  SOURCES.orcaInherits,
  SOURCES.studioCli,
  SOURCES.machineProfile,
  SOURCES.processProfile,
  SOURCES.filamentProfile,
  SOURCES.a1Product,
];

function resolveBinary() {
  const explicit = process.env.BAMBU_SLICER_BIN || process.env.ORCA_SLICER_BIN || process.env.BAMBU_STUDIO_BIN;
  if (explicit) return path.resolve(explicit);
  const share = path.join(process.env.HOME || "", ".local", "share", "bambu-harness");
  const defaults = [
    path.join(share, "squashfs-root", "AppRun"),
    path.join(share, "OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage"),
  ];
  return defaults.find((item) => fs.existsSync(item)) || defaults[0];
}

function layerHeight(raw) {
  if (raw === undefined) return null;
  if (!/^\d+(?:\.\d+)?$/.test(String(raw))) {
    fail("--layer must be millimeters, for example 0.2", { exitCode: 4, code: "bad_args" });
  }
  const value = Number(raw);
  if (value < A1_MINI.layerMinMm - 1e-9 || value > A1_MINI.layerMaxMm + 1e-9) {
    fail(
      `--layer must be from ${A1_MINI.layerMinMm} to ${A1_MINI.layerMaxMm} mm. That range is the official A1 mini 0.4 nozzle process (min_layer_height / max_layer_height).`,
      { exitCode: 4, code: "bad_args" },
    );
  }
  return value;
}

function infillPercent(raw) {
  if (raw === undefined) return null;
  return assertWholeNumber(raw, "--infill", 0, 100);
}

function filamentName(raw) {
  const name = String(raw || "PLA").trim().toUpperCase();
  if (name !== "PLA") {
    fail("this harness only loads the official Bambu PLA Basic @BBL A1M profile. Pass --filament PLA.", {
      exitCode: 4,
      code: "bad_args",
    });
  }
  return "PLA";
}

function outputPath(model, out) {
  const resolved = out
    ? path.resolve(out)
    : path.resolve(`${model.name.replace(/\.(stl|3mf)$/i, "")}.gcode.3mf`);
  if (resolved.includes("\n") || path.basename(resolved).startsWith("-")) {
    fail("refusing output path", { exitCode: 4, code: "bad_file" });
  }
  if (!resolved.toLowerCase().endsWith(".gcode.3mf")) {
    fail("--out must end in .gcode.3mf", { exitCode: 4, code: "bad_file" });
  }
  return resolved;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`profile is not JSON: ${file}`, { code: "slicer" });
  }
}

function applyProcess(profile, { layer, infillPct, supports }) {
  const next = { ...profile, from: profile.from || "system" };
  if (layer !== null) next.layer_height = String(layer);
  if (infillPct !== null) next.sparse_infill_density = `${infillPct}%`;
  if (supports) next.enable_support = "1";
  delete next.inherits;
  return next;
}

function loadProfiles(binary, overrides, plan) {
  const envMachine = process.env.BAMBU_MACHINE_JSON;
  const envProcess = process.env.BAMBU_PROCESS_JSON;
  const envFilament = process.env.BAMBU_FILAMENT_JSON;
  if (envMachine || envProcess || envFilament) {
    if (!envMachine || !envProcess || !envFilament) {
      fail("Set all of BAMBU_MACHINE_JSON, BAMBU_PROCESS_JSON, and BAMBU_FILAMENT_JSON, or unset all three to use the official A1 mini profiles inside OrcaSlicer.", {
        exitCode: 4,
        code: "bad_args",
      });
    }
    for (const file of [envMachine, envProcess, envFilament]) {
      if (!fs.existsSync(file)) fail(`profile not found: ${file}`, { code: "slicer" });
    }
    return {
      flattened: false,
      machineJson: { ...readJson(envMachine), from: readJson(envMachine).from || "system" },
      processJson: applyProcess(readJson(envProcess), overrides),
      filamentJson: { ...readJson(envFilament), from: readJson(envFilament).from || "system" },
      described: { machine: path.resolve(envMachine), process: path.resolve(envProcess), filament: path.resolve(envFilament) },
    };
  }
  const root = profilesRootFromBinary(binary);
  if (!root) {
    if (plan) {
      return {
        flattened: true,
        missing: true,
        machineJson: null,
        processJson: null,
        filamentJson: null,
        described: {
          machine: "resources/profiles/BBL/machine/Bambu Lab A1 mini 0.4 nozzle.json",
          process: "resources/profiles/BBL/process/0.20mm Standard @BBL A1M.json",
          filament: "resources/profiles/BBL/filament/Bambu PLA Basic @BBL A1M.json",
        },
      };
    }
    fail(
      "official A1 mini profiles were not found next to the slicer. Run scripts/install-orcaslicer.sh, or set BAMBU_MACHINE_JSON, BAMBU_PROCESS_JSON, and BAMBU_FILAMENT_JSON to full configs.",
      { code: "slicer" },
    );
  }
  const paths = officialProfilePaths(root);
  return {
    flattened: true,
    machineJson: flattenProfile(paths.machine, root),
    processJson: applyProcess(flattenProfile(paths.process, root), overrides),
    filamentJson: flattenProfile(paths.filament, root),
    described: paths,
  };
}

function writePrivate(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function readResult(dir) {
  const file = path.join(dir, "result.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function warningList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
  const text = String(value).trim();
  return text ? [text.slice(0, 500)] : [];
}

function needsDisplay(stderr) {
  return /could not connect to display|cannot open display|qt\.qpa\.xcb|no display|could not load the qt platform plugin/i.test(stderr || "");
}

async function runOnce(argv, cwd, xdg, extraEnv = {}) {
  const { done } = spawnSlicer(argv, {
    cwd,
    extraEnv: { XDG_RUNTIME_DIR: xdg, ...extraEnv },
    timeoutMs: 180_000,
  });
  try {
    return await done;
  } catch (error) {
    if (error?.code === "slicer_timeout") {
      fail("slicer timed out after 180 seconds", { code: "slicer_timeout" });
    }
    fail(redactText(error?.message || "slicer failed to start"), { code: "slicer" });
  }
}

export async function runSlice({ modelPath, options, flags }) {
  if (!modelPath) fail("slice requires an .stl or .3mf model", { exitCode: 4, code: "bad_args" });
  const model = inspectModelFile(modelPath);
  assertPrintableModel(model);
  const layer = layerHeight(options.layer);
  const infillPct = infillPercent(options.infill);
  const filament = filamentName(options.filament);
  const supports = flags.has("supports");
  const binary = resolveBinary();
  const out = outputPath(model, options.out);
  const outDir = path.dirname(out);
  const outName = path.basename(out);
  const profiles = loadProfiles(binary, { layer, infillPct, supports }, flags.has("print-plan"));
  const planArgv = [
    binary,
    "--arrange",
    "1",
    "--ensure-on-bed",
    "--load-settings",
    "<flattened machine.json>;<flattened process.json>",
    "--load-filaments",
    "<flattened filament.json>",
    "--slice",
    "0",
    "--export-3mf",
    outName,
    "--outputdir",
    outDir,
    model.path,
  ];
  const base = {
    ok: true,
    command: "slice",
    printer: A1_MINI.marketingName,
    modelCode: A1_MINI.modelCode,
    nozzleMm: A1_MINI.nozzleMm,
    filament,
    layerMm: layer,
    infillPercent: infillPct,
    supports,
    input: {
      path: model.path,
      kind: model.kind,
      triangles: model.triangles,
      sizeMm: model.size,
      manifold: model.manifold,
    },
    output: out,
    bedMm: [A1_MINI.bedMm, A1_MINI.bedMm, A1_MINI.bedMm],
    profiles: profiles.described,
    flattened: profiles.flattened,
    argv: planArgv,
    sources: SLICE_SOURCES,
    verification: "UNVERIFIED",
    note: "The slicer runs on this computer. Whether an A1 mini accepts the .gcode.3mf is UNVERIFIED. --load-settings does not walk profile inheritance (OrcaSlicer issue 14718), so this harness flattens the official profiles and keeps from=system.",
  };
  if (flags.has("print-plan")) {
    return { ...base, executed: false };
  }
  if (!fs.existsSync(binary)) {
    fail(`slicer binary not found at ${binary}. On Linux x86_64 run scripts/install-orcaslicer.sh. See README.`, {
      code: "slicer",
    });
  }
  if (profiles.missing || !profiles.machineJson) {
    fail("official profiles are missing and no BAMBU_*_JSON configs were set", { code: "slicer" });
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-slice-"));
  fs.chmodSync(work, 0o700);
  const xdg = path.join(work, "xdg");
  fs.mkdirSync(xdg, { mode: 0o700 });
  try {
    const machineFile = writePrivate(work, "machine.json", profiles.machineJson);
    const processFile = writePrivate(work, "process.json", profiles.processJson);
    const filamentFile = writePrivate(work, "filament.json", profiles.filamentJson);
    const argv = [
      binary,
      "--arrange",
      "1",
      "--ensure-on-bed",
      "--load-settings",
      `${machineFile};${processFile}`,
      "--load-filaments",
      filamentFile,
      "--slice",
      "0",
      "--export-3mf",
      outName,
      "--outputdir",
      outDir,
      model.path,
    ];
    let ran = await runOnce(argv, outDir, xdg);
    let displayFallback = null;
    if (ran.code !== 0 && needsDisplay(ran.stderr)) {
      const xvfb = "/usr/bin/xvfb-run";
      if (fs.existsSync(xvfb)) {
        ran = await runOnce([xvfb, "-a", ...argv], outDir, xdg, { QT_QPA_PLATFORM: "xcb" });
        displayFallback = "xvfb-run";
      }
    }
    const resultJson = readResult(outDir) || readResult(work);
    const returnCode = resultJson?.return_code;
    if (ran.code !== 0 || (returnCode !== undefined && returnCode !== 0 && returnCode !== "0")) {
      const stderr = redactText(ran.stderr || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-6)
        .join(" | ")
        .slice(0, 500);
      const why = resultJson?.error_string || resultJson?.error || "slicer failed";
      fail(`slicer failed (${returnCode ?? ran.code}): ${String(why).slice(0, 240)}${stderr ? ` | ${stderr}` : ""}`, {
        code: "slicer",
        details: { slicerExit: ran.code, returnCode: returnCode ?? null, verification: "UNVERIFIED" },
      });
    }
    if (!fs.existsSync(out)) {
      fail("slicer exited 0 but did not write the .gcode.3mf. An absolute --export-3mf path is not used because OrcaSlicer doubles it.", {
        code: "slicer",
      });
    }
    const buf = fs.readFileSync(out);
    const inspection = inspectGcode3mf(buf, 1);
    const gcodeBuf = readZipEntry(buf, inspection.platePath);
    if (!gcodeBuf) fail(`sliced file is missing ${inspection.platePath}`, { exitCode: 4, code: "bad_3mf" });
    const gcode = gcodeBuf.toString("utf8");
    const summary = summarizeGcode(gcode);
    if (summary.extrusion.outside > 0) {
      fail(
        `sliced toolpath has ${summary.extrusion.outside} extruding moves outside the A1 mini ${A1_MINI.bedMm} mm cube. The file was written and was not sent to a printer.`,
        {
          exitCode: 4,
          code: "out_of_bounds",
          details: { output: out, extrusion: summary.extrusion, verification: "UNVERIFIED" },
        },
      );
    }
    const previewPath = out.replace(/\.gcode\.3mf$/i, ".png");
    const rendered = renderToolpathPng(gcode, A1_MINI.bedMm);
    fs.writeFileSync(previewPath, rendered.png, { mode: 0o600 });
    fs.chmodSync(previewPath, 0o600);
    const warnings = [...warningList(resultJson?.warning_message), ...inspection.warnings];
    if (rendered.moves === 0) warnings.push("preview has no extrusion moves");
    return {
      ...base,
      executed: true,
      argv,
      bytes: buf.length,
      preview: previewPath,
      previewMoves: rendered.moves,
      estimatedTime: summary.estimatedTime,
      estimatedSeconds: summary.estimatedSeconds,
      modelTime: summary.modelTime,
      filamentGrams: summary.filamentGrams,
      layerCount: summary.layerCount,
      extrusion: summary.extrusion,
      warnings,
      displayFallback,
      slicer: {
        returnCode: returnCode ?? 0,
        layerHeight: resultJson?.layer_height ?? layer,
        sparseInfillDensity: resultJson?.sparse_infill_density ?? infillPct,
      },
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
