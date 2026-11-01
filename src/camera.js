import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { jpegSize } from "./preview.js";
import { connectTofu } from "./lan-tls.js";
import { SOURCES } from "./sources.js";

export function cameraAuthPacket(accessCode) {
  const buf = Buffer.alloc(80);
  buf.writeUInt32LE(0x40, 0);
  buf.writeUInt32LE(0x3000, 4);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(0, 12);
  buf.write("bblp", 16, "ascii");
  buf.write(accessCode, 48, "ascii");
  return buf;
}

class ByteReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.failed = null;
    socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.waiter && this.buf.length >= this.waiter.need) this.waiter.resolve();
    });
    socket.on("error", (error) => {
      this.failed = error;
      if (this.waiter) this.waiter.reject(error);
    });
    socket.on("close", () => {
      if (!this.failed) this.failed = Object.assign(new Error("camera connection closed"), { code: "camera" });
      if (this.waiter) this.waiter.reject(this.failed);
    });
  }

  read(need, timeoutMs) {
    if (this.buf.length >= need) {
      const data = this.buf.subarray(0, need);
      this.buf = this.buf.subarray(need);
      return Promise.resolve(data);
    }
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(Object.assign(new Error("camera timed out waiting for a frame"), { code: "camera" }));
      }, timeoutMs);
      this.waiter = {
        need,
        resolve: () => {
          clearTimeout(timer);
          this.waiter = null;
          const data = this.buf.subarray(0, need);
          this.buf = this.buf.subarray(need);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiter = null;
          reject(error);
        },
      };
    });
  }
}

export async function readCameraFrame(socket, timeoutMs) {
  return readFrame(new ByteReader(socket), timeoutMs);
}

async function readFrame(reader, timeoutMs) {
  const header = await reader.read(16, timeoutMs);
  const size = header.readUInt32LE(0);
  const itrack = header.readUInt32LE(4);
  const flags = header.readUInt32LE(8);
  if (size < 32 || size > 8_000_000) {
    fail(`unexpected camera frame length ${size}`, { code: "camera", details: { verification: "UNVERIFIED" } });
  }
  const jpeg = Buffer.from(await reader.read(size, timeoutMs));
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    fail("camera payload is not a JPEG", { code: "camera", details: { verification: "UNVERIFIED" } });
  }
  return { jpeg, itrack, flags, dimensions: jpegSize(jpeg) };
}

export async function grabFrame({ host, port, accessCode, acceptNewPin, timeoutMs = 10_000 }) {
  const connection = await connectTofu({ host, port, acceptNewPin });
  try {
    const reader = new ByteReader(connection.socket);
    connection.socket.write(cameraAuthPacket(accessCode));
    const frame = await readFrame(reader, timeoutMs);
    return { ...frame, pin: connection.pin, fingerprint: connection.fingerprint };
  } finally {
    connection.socket.destroy();
  }
}

export function writeFrameFile(file, jpeg) {
  const resolved = path.resolve(file);
  if (!/\.jpe?g$/i.test(resolved) || path.basename(resolved).startsWith("-")) {
    fail("snapshot output must be a .jpg or .jpeg path", { exitCode: 4, code: "bad_file" });
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, jpeg, { mode: 0o600 });
  fs.chmodSync(resolved, 0o600);
  return resolved;
}

export const CAMERA_SOURCES = [SOURCES.video, SOURCES.cameraStub];
