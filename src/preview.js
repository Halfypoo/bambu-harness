import zlib from "node:zlib";
import { isSlicedLayerMarker } from "./gcode-summary.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    raw[start] = 0;
    rgb.copy(raw, start + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function words(line) {
  const found = {};
  const re = /([XYZEF])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi;
  let match;
  while ((match = re.exec(line))) found[match[1].toUpperCase()] = Number(match[2]);
  return found;
}

function plot(rgb, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const offset = (y * width + x) * 3;
  rgb[offset] = color[0];
  rgb[offset + 1] = color[1];
  rgb[offset + 2] = color[2];
}

function line(rgb, width, x0, y0, x1, y1, color) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const dx = Math.abs(Math.round(x1) - x);
  const dy = Math.abs(Math.round(y1) - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx - dy;
  const targetX = Math.round(x1);
  const targetY = Math.round(y1);
  for (let guard = 0; guard < width * 4; guard++) {
    plot(rgb, width, x, y, color);
    if (x === targetX && y === targetY) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export function renderToolpathPng(gcode, bedMm = 180) {
  const size = 360;
  const margin = 8;
  const span = size - margin * 2;
  const rgb = Buffer.alloc(size * size * 3, 255);
  const scale = (value) => margin + (value / bedMm) * span;
  const border = [180, 180, 180];
  line(rgb, size, margin, margin, size - margin, margin, border);
  line(rgb, size, size - margin, margin, size - margin, size - margin, border);
  line(rgb, size, size - margin, size - margin, margin, size - margin, border);
  line(rgb, size, margin, size - margin, margin, margin, border);
  let absolute = true;
  let relativeE = true;
  let x = null;
  let y = null;
  let e = 0;
  let moves = 0;
  const body = String(gcode || "");
  const limit = Math.min(body.length, 2_000_000);
  const sample = body.slice(0, limit);
  const gated = sample.split(/\r?\n/).some((line) => isSlicedLayerMarker(line));
  let checking = !gated;
  for (const raw of sample.split(/\r?\n/)) {
    if (gated && isSlicedLayerMarker(raw)) checking = true;
    const code = raw.split(";", 1)[0].trim();
    if (!code) continue;
    const head = code.split(/\s+/, 1)[0].toUpperCase();
    if (head === "G90") absolute = true;
    else if (head === "G91") absolute = false;
    else if (head === "M82") relativeE = false;
    else if (head === "M83") relativeE = true;
    else if (head === "G0" || head === "G1") {
      const parsed = words(code);
      const nextX = parsed.X === undefined ? x : (absolute || x === null ? parsed.X : x + parsed.X);
      const nextY = parsed.Y === undefined ? y : (absolute || y === null ? parsed.Y : y + parsed.Y);
      let extruding = false;
      if (parsed.E !== undefined) {
        if (relativeE) extruding = parsed.E > 0;
        else {
          extruding = parsed.E > e + 1e-6;
          e = parsed.E;
        }
      }
      if (checking && extruding && x !== null && y !== null && nextX !== null && nextY !== null) {
        line(rgb, size, scale(x), size - scale(y), scale(nextX), size - scale(nextY), [20, 20, 20]);
        moves += 1;
      }
      x = nextX;
      y = nextY;
    }
  }
  return { png: encodePng(size, size, rgb), moves, width: size, height: size };
}

export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const length = buf.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
