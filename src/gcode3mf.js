import zlib from "node:zlib";
import { fail } from "./errors.js";
import { LIMITS } from "./allow.js";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65_535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

export function listZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail("file is not a zip", { exitCode: 4, code: "bad_3mf" });
  const eocd = findEocd(buf);
  if (eocd < 0) fail("file is not a zip", { exitCode: 4, code: "bad_3mf" });
  const disk = buf.readUInt16LE(eocd + 4);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    fail("multi-disk zip is not supported", { exitCode: 4, code: "bad_3mf" });
  }
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    fail("zip64 is not supported", { exitCode: 4, code: "bad_3mf" });
  }
  if (cdOffset + cdSize > buf.length) fail("zip central directory is truncated", { exitCode: 4, code: "bad_3mf" });
  const entries = [];
  let offset = cdOffset;
  const end = cdOffset + cdSize;
  for (let n = 0; n < total; n++) {
    if (offset + 46 > end || buf.readUInt32LE(offset) !== CENTRAL) {
      fail("zip central directory is truncated", { exitCode: 4, code: "bad_3mf" });
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if ((flags & 0x1) !== 0) fail(`encrypted zip entry refused: ${name}`, { exitCode: 4, code: "bad_3mf" });
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
      fail(`unsafe zip entry name refused: ${name}`, { exitCode: 4, code: "bad_3mf" });
    }
    entries.push({ name, method, compSize, uncompSize, localOffset, flags });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf, name, maxBytes = LIMITS.maxZipEntryBytes) {
  const entries = listZip(buf);
  const entry = entries.find((item) => item.name === name);
  if (!entry) return null;
  if (entry.uncompSize > maxBytes) {
    fail(`zip entry too large to inspect: ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
  }
  return entryBytes(buf, entry, maxBytes);
}

function entryBytes(buf, entry, maxBytes = LIMITS.maxZipEntryBytes) {
  if (entry.uncompSize > maxBytes) {
    fail(`zip entry too large to inspect: ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
  }
  if (entry.localOffset + 30 > buf.length || buf.readUInt32LE(entry.localOffset) !== LOCAL) {
    fail(`zip local header missing: ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length) fail(`zip entry truncated: ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
  const compressed = buf.subarray(start, end);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) {
    const inflated = zlib.inflateRawSync(compressed);
    if (inflated.length !== entry.uncompSize && entry.uncompSize !== 0) {
      fail(`zip inflation size mismatch: ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
    }
    return inflated;
  }
  fail(`unsupported zip compression method ${entry.method} in ${entry.name}`, { exitCode: 4, code: "bad_3mf" });
}

export function assessModelText(text) {
  const source = String(text || "");
  const declared = [...source.matchAll(/"printer_model"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  if (declared.length > 0 && declared.every((name) => /a1\s*mini/i.test(name))) {
    return { matchesN1: true, otherModels: [], found: true };
  }
  const hasMini = /a1\s*mini/i.test(source) || /(^|[^A-Za-z0-9])N1([^A-Za-z0-9]|$)/.test(source);
  const others = [];
  if (/x1\s*carbon|\bx1c\b|bl-p001/i.test(source)) others.push("X1 Carbon");
  if (/\bx1\b/i.test(source) && !/x1\s*carbon|\bx1c\b/i.test(source)) others.push("X1");
  if (/\bp1s\b|\bc12\b/i.test(source)) others.push("P1S");
  if (/\bp1p\b|\bc11\b/i.test(source)) others.push("P1P");
  if (/\bp2s\b/i.test(source)) others.push("P2S");
  if (/(^|[^A-Za-z0-9])A1([^A-Za-z0-9]|$)/.test(source) && !/a1\s*mini/i.test(source)) others.push("A1");
  if (/\bh2d\b|\bh2s\b/i.test(source)) others.push("H2");
  return {
    matchesN1: hasMini,
    otherModels: [...new Set(others)],
    found: hasMini || others.length > 0,
  };
}

export function extractBedTarget(text) {
  const source = String(text || "");
  const firstLayer = /;\s*first_layer_bed_temperature\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(source);
  if (firstLayer) {
    return { celsius: Number(firstLayer[1]), source: "first_layer_bed_temperature" };
  }
  const m190 = /\bM190\s+S(-?\d+(?:\.\d+)?)/i.exec(source);
  if (m190) {
    return { celsius: Number(m190[1]), source: "M190" };
  }
  const m140 = /\bM140\s+S(-?\d+(?:\.\d+)?)/i.exec(source);
  if (m140) {
    return { celsius: Number(m140[1]), source: "M140" };
  }
  return { celsius: null, source: null };
}

export function extractBedType(text) {
  const match = /;\s*curr_bed_type\s*=\s*(.+)$/im.exec(String(text || ""));
  if (!match) return null;
  return match[1].trim() || null;
}

export function inspectGcode3mf(buf, plate = 1) {
  const entries = listZip(buf);
  const platePath = `Metadata/plate_${plate}.gcode`;
  const plateEntry = entries.find((entry) => entry.name === platePath);
  if (!plateEntry) {
    fail(`missing ${platePath} inside the 3mf`, { exitCode: 4, code: "bad_3mf" });
  }
  const interesting = [
    "Metadata/project_settings.config",
    "Metadata/slice_info.config",
    "Metadata/model_settings.config",
  ];
  const chunks = [];
  for (const name of interesting) {
    const entry = entries.find((item) => item.name === name);
    if (!entry) continue;
    if (entry.uncompSize > LIMITS.maxZipEntryBytes) continue;
    chunks.push(entryBytes(buf, entry).toString("utf8"));
  }
  let gcodeHead = "";
  if (plateEntry.uncompSize <= LIMITS.maxZipEntryBytes) {
    const gcode = entryBytes(buf, plateEntry).toString("utf8");
    gcodeHead = gcode.slice(0, 32_768);
    chunks.push(gcodeHead);
  }
  const joined = chunks.join("\n");
  const assessment = assessModelText(joined);
  const warnings = [];
  if (!assessment.matchesN1) {
    const found = assessment.otherModels.length ? assessment.otherModels.join(", ") : "no printer model";
    warnings.push(`model check did not find A1 mini / N1 (${found}). The file may be sliced for a different printer.`);
  } else if (assessment.otherModels.length) {
    warnings.push(`file mentions N1/A1 mini and also ${assessment.otherModels.join(", ")}. Confirm the plate before printing.`);
  }
  const bedTarget = extractBedTarget(gcodeHead || joined);
  const bedType = extractBedType(gcodeHead || joined);
  return {
    platePath,
    entryCount: entries.length,
    model: assessment,
    bedTargetC: bedTarget.celsius,
    bedTargetSource: bedTarget.source,
    bedType,
    warnings,
  };
}

export function makeStoredZip(files) {
  const entries = Object.entries(files).map(([name, contents]) => {
    if (contents && typeof contents === "object" && !Buffer.isBuffer(contents) && contents.data !== undefined) {
      return { name, data: Buffer.from(contents.data), method: contents.method ?? 0 };
    }
    return { name, data: Buffer.from(contents), method: 0 };
  });
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name);
    const stored = entry.method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = zlib.crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    locals.push(Buffer.concat([local, nameBuf, stored]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
