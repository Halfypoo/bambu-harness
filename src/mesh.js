import fs from "node:fs";
import path from "node:path";
import { A1_MINI } from "./a1mini.js";
import { fail } from "./errors.js";
import { listZip, makeStoredZip, readZipEntry } from "./gcode3mf.js";

const NUMBER = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
const VERTEX = new RegExp(`vertex\\s+${NUMBER}\\s+${NUMBER}\\s+${NUMBER}`, "g");

export function cubeTriangles(size) {
  const s = size;
  const point = (x, y, z) => [x ? s : 0, y ? s : 0, z ? s : 0];
  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0],
    [0, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 1, 1], [1, 0, 1],
    [0, 0, 1], [0, 1, 1], [1, 1, 1],
    [0, 0, 0], [1, 0, 1], [1, 0, 0],
    [0, 0, 0], [0, 0, 1], [1, 0, 1],
    [0, 1, 0], [1, 1, 0], [1, 1, 1],
    [0, 1, 0], [1, 1, 1], [0, 1, 1],
    [0, 0, 0], [0, 1, 0], [0, 1, 1],
    [0, 0, 0], [0, 1, 1], [0, 0, 1],
    [1, 0, 0], [1, 1, 1], [1, 1, 0],
    [1, 0, 0], [1, 0, 1], [1, 1, 1],
  ];
  const triangles = [];
  for (let i = 0; i < corners.length; i += 3) {
    triangles.push([point(...corners[i]), point(...corners[i + 1]), point(...corners[i + 2])]);
  }
  return triangles;
}

export function asciiStl(triangles, name = "model") {
  const lines = [`solid ${name}`];
  for (const [a, b, c] of triangles) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    lines.push(`  facet normal ${nx.toExponential(6)} ${ny.toExponential(6)} ${nz.toExponential(6)}`);
    lines.push("    outer loop");
    for (const vertex of [a, b, c]) {
      lines.push(`      vertex ${vertex[0].toExponential(6)} ${vertex[1].toExponential(6)} ${vertex[2].toExponential(6)}`);
    }
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join("\n")}\n`;
}

export function model3mf(triangles) {
  const vertices = [];
  const index = new Map();
  function id(vertex) {
    const key = vertex.map((value) => value.toFixed(5)).join(",");
    if (index.has(key)) return index.get(key);
    const next = vertices.length;
    vertices.push(vertex);
    index.set(key, next);
    return next;
  }
  const faces = triangles.map((triangle) => triangle.map((vertex) => id(vertex)));
  const vertexXml = vertices.map(([x, y, z]) => `          <vertex x="${x}" y="${y}" z="${z}"/>`).join("\n");
  const faceXml = faces.map(([a, b, c]) => `          <triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("\n");
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
${vertexXml}
        </vertices>
        <triangles>
${faceXml}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>
`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return makeStoredZip({
    "[Content_Types].xml": types,
    "_rels/.rels": rels,
    "3D/3dmodel.model": model,
  });
}

function quantize(value) {
  return Math.round(value * 1000);
}

function edgeKey(a, b) {
  const left = `${quantize(a[0])},${quantize(a[1])},${quantize(a[2])}`;
  const right = `${quantize(b[0])},${quantize(b[1])},${quantize(b[2])}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

export function analyzeTriangles(triangles) {
  if (triangles.length > 2_000_000) {
    fail(`model has ${triangles.length} triangles, over the 2000000 check limit`, { exitCode: 4, code: "mesh_too_large" });
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const edges = new Map();
  for (const triangle of triangles) {
    if (!triangle || triangle.length !== 3) fail("mesh triangle is incomplete", { exitCode: 4, code: "bad_mesh" });
    for (const vertex of triangle) {
      if (vertex.some((value) => !Number.isFinite(value))) {
        fail("mesh contains a non-finite coordinate", { exitCode: 4, code: "bad_mesh" });
      }
      minX = Math.min(minX, vertex[0]);
      minY = Math.min(minY, vertex[1]);
      minZ = Math.min(minZ, vertex[2]);
      maxX = Math.max(maxX, vertex[0]);
      maxY = Math.max(maxY, vertex[1]);
      maxZ = Math.max(maxZ, vertex[2]);
    }
    for (let i = 0; i < 3; i++) {
      const key = edgeKey(triangle[i], triangle[(i + 1) % 3]);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let badEdges = 0;
  for (const count of edges.values()) if (count !== 2) badEdges += 1;
  const size = {
    x: roundMm(maxX - minX),
    y: roundMm(maxY - minY),
    z: roundMm(maxZ - minZ),
  };
  const bed = A1_MINI.bedMm;
  const oversize = size.x > bed + 0.05 || size.y > bed + 0.05 || size.z > bed + 0.05;
  return {
    triangles: triangles.length,
    bounds: {
      min: [roundMm(minX), roundMm(minY), roundMm(minZ)],
      max: [roundMm(maxX), roundMm(maxY), roundMm(maxZ)],
    },
    size,
    manifold: badEdges === 0 && triangles.length > 0,
    badEdges,
    oversize,
    bedMm: bed,
  };
}

function roundMm(value) {
  return Math.round(value * 1000) / 1000;
}

function parseAsciiStl(text) {
  const triangles = [];
  VERTEX.lastIndex = 0;
  const found = [];
  let match;
  while ((match = VERTEX.exec(text))) {
    found.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  if (found.length < 3 || found.length % 3 !== 0) {
    fail("ASCII STL did not contain complete triangles", { exitCode: 4, code: "bad_mesh" });
  }
  for (let i = 0; i < found.length; i += 3) triangles.push([found[i], found[i + 1], found[i + 2]]);
  return triangles;
}

function parseBinaryStl(buf) {
  const count = buf.readUInt32LE(80);
  if (!Number.isInteger(count) || count < 1 || buf.length < 84 + count * 50) {
    fail("binary STL is truncated", { exitCode: 4, code: "bad_mesh" });
  }
  const triangles = [];
  for (let i = 0; i < count; i++) {
    const offset = 84 + i * 50;
    triangles.push([
      [buf.readFloatLE(offset + 12), buf.readFloatLE(offset + 16), buf.readFloatLE(offset + 20)],
      [buf.readFloatLE(offset + 24), buf.readFloatLE(offset + 28), buf.readFloatLE(offset + 32)],
      [buf.readFloatLE(offset + 36), buf.readFloatLE(offset + 40), buf.readFloatLE(offset + 44)],
    ]);
  }
  return triangles;
}

function parseStl(buf) {
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (count > 0 && count < 5_000_000 && buf.length === 84 + count * 50) return parseBinaryStl(buf);
  }
  const text = buf.toString("utf8");
  if (!/^\s*solid/i.test(text) || !/facet/i.test(text)) {
    fail("STL is neither a binary STL nor an ASCII STL", { exitCode: 4, code: "bad_mesh" });
  }
  return parseAsciiStl(text);
}

function parse3mfXml(xml) {
  const unitMatch = /<model\b[^>]*\bunit="([^"]+)"/i.exec(xml);
  const unit = (unitMatch?.[1] || "millimeter").toLowerCase();
  let scale = 1;
  if (unit === "millimeter" || unit === "mm") scale = 1;
  else if (unit === "centimeter") scale = 10;
  else if (unit === "meter") scale = 1000;
  else if (unit === "inch") scale = 25.4;
  else fail(`3MF unit ${unit} is not supported`, { exitCode: 4, code: "bad_mesh" });
  const vertices = [];
  const vertexRe = /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g;
  let match;
  while ((match = vertexRe.exec(xml))) {
    vertices.push([Number(match[1]) * scale, Number(match[2]) * scale, Number(match[3]) * scale]);
  }
  const triangles = [];
  const triRe = /<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"/g;
  while ((match = triRe.exec(xml))) {
    const ids = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (ids.some((id) => !vertices[id])) fail("3MF triangle references a missing vertex", { exitCode: 4, code: "bad_mesh" });
    triangles.push(ids.map((id) => vertices[id]));
  }
  return triangles;
}

function parse3mf(buf) {
  const entries = listZip(buf);
  const models = entries.filter((entry) => entry.name.startsWith("3D/") && entry.name.endsWith(".model") && !entry.name.includes(".."));
  if (models.length === 0) fail("3MF has no 3D model mesh", { exitCode: 4, code: "bad_mesh" });
  const triangles = [];
  for (const entry of models) {
    const xml = readZipEntry(buf, entry.name, 32 * 1024 * 1024).toString("utf8");
    triangles.push(...parse3mfXml(xml));
  }
  if (triangles.length === 0) fail("3MF mesh has no triangles", { exitCode: 4, code: "bad_mesh" });
  return triangles;
}

export function inspectModelFile(file) {
  const resolved = path.resolve(file);
  if (resolved.includes("\n") || path.basename(resolved).startsWith("-")) {
    fail("refusing model path", { exitCode: 4, code: "bad_file" });
  }
  const base = path.basename(resolved);
  const lower = base.toLowerCase();
  if (lower.endsWith(".gcode.3mf")) {
    fail("input is already a sliced .gcode.3mf. Pass an .stl or a model .3mf.", { exitCode: 4, code: "bad_file" });
  }
  const kind = lower.endsWith(".stl") ? "stl" : lower.endsWith(".3mf") ? "3mf" : "";
  if (!kind) fail("model must end in .stl or .3mf", { exitCode: 4, code: "bad_file" });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("model must be a regular file", { exitCode: 4, code: "bad_file" });
  if (stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    fail("model file is empty or larger than 64 MiB", { exitCode: 4, code: "bad_file" });
  }
  const buf = fs.readFileSync(resolved);
  const triangles = kind === "stl" ? parseStl(buf) : parse3mf(buf);
  const analysis = analyzeTriangles(triangles);
  return { path: resolved, name: base, kind, ...analysis };
}

export function assertPrintableModel(model) {
  if (!model.manifold) {
    fail(
      `model is non-manifold (${model.badEdges} edge${model.badEdges === 1 ? "" : "s"} not shared by exactly two faces). The A1 mini slice was not started.`,
      { exitCode: 4, code: "non_manifold", details: { badEdges: model.badEdges, triangles: model.triangles } },
    );
  }
  if (model.oversize) {
    fail(
      `model is ${model.size.x} x ${model.size.y} x ${model.size.z} mm and does not fit the A1 mini bed (${model.bedMm} x ${model.bedMm} x ${model.bedMm} mm). The slice was not started.`,
      {
        exitCode: 4,
        code: "out_of_bounds",
        details: { size: model.size, bedMm: model.bedMm, bounds: model.bounds },
      },
    );
  }
}
