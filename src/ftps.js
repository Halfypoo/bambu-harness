import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "./allow.js";
import { fail } from "./errors.js";
import { redactText } from "./redact.js";
import { connectPinned, connectTofu } from "./lan-tls.js";
import { SOURCES } from "./sources.js";

const DATA_CHUNK = 64 * 1024;

function dataTimeoutError() {
  return Object.assign(new Error("FTPS data timed out"), { code: "ftps" });
}

function transferTimers({ idleTimeoutMs, maxTimeoutMs, onTimeout }) {
  let idleTimer = null;
  const maxTimer = setTimeout(onTimeout, maxTimeoutMs);
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onTimeout, idleTimeoutMs);
  };
  const clear = () => {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  };
  armIdle();
  return { armIdle, clear };
}

function attach(socket) {
  const state = { buf: "", queue: [], waiter: null, dead: null };
  socket.on("data", (chunk) => {
    state.buf += chunk.toString("latin1");
    pump(state);
  });
  socket.on("error", (error) => {
    state.dead = error;
    if (state.waiter) {
      const waiter = state.waiter;
      state.waiter = null;
      waiter.reject(error);
    }
  });
  return state;
}

function takeReply(state) {
  let rest = state.buf;
  const lines = [];
  let code = null;
  while (rest.length) {
    const nl = rest.indexOf("\r\n");
    if (nl < 0) return null;
    const line = rest.slice(0, nl);
    if (!/^\d{3}[ -]/.test(line)) return null;
    const nextCode = line.slice(0, 3);
    if (code === null) code = nextCode;
    if (nextCode !== code) return null;
    lines.push(line);
    rest = rest.slice(nl + 2);
    if (line[3] === " ") {
      state.buf = rest;
      return { code: Number(code), text: lines.join("\n") };
    }
  }
  return null;
}

function pump(state) {
  for (;;) {
    const reply = takeReply(state);
    if (!reply) return;
    if (state.waiter) {
      const waiter = state.waiter;
      state.waiter = null;
      waiter.resolve(reply);
    } else state.queue.push(reply);
  }
}

function nextReply(state, timeoutMs) {
  if (state.queue.length) return Promise.resolve(state.queue.shift());
  if (state.dead) return Promise.reject(state.dead);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.waiter = null;
      reject(Object.assign(new Error("FTPS reply timed out"), { code: "ftps" }));
    }, timeoutMs);
    state.waiter = {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    pump(state);
  });
}

async function command(socket, state, line, accept, accessCode) {
  socket.write(`${line}\r\n`);
  let reply;
  try {
    reply = await nextReply(state, 15_000);
  } catch (error) {
    fail(redactText(error.message || "FTPS failed", [accessCode]), { code: "ftps" });
  }
  if (!accept.includes(reply.code)) {
    const text = redactText(reply.text, [accessCode]).slice(0, 240);
    fail(`FTPS ${line.slice(0, 4)} returned ${reply.code}: ${text}`, { code: "ftps", details: { verification: "UNVERIFIED" } });
  }
  return reply;
}

function parsePasv(text, expectedHost) {
  const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(text);
  if (!match) fail("FTPS PASV reply had no address", { code: "ftps" });
  const host = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
  const port = Number(match[5]) * 256 + Number(match[6]);
  if (host !== expectedHost) {
    fail(`FTPS PASV address ${host} is not the configured printer. The file was not sent.`, { code: "host_refused" });
  }
  if (port < 1 || port > 65535) fail("FTPS PASV port is invalid", { code: "ftps" });
  return { host, port };
}

/** Quote an FTP path so names with spaces survive LIST/RETR/STOR. */
export function ftpPathArg(remotePath) {
  const value = String(remotePath ?? "");
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    fail("remote path must not contain control characters", { exitCode: 4, code: "bad_args" });
  }
  if (value.length > 240) fail("remote path is too long", { exitCode: 4, code: "bad_args" });
  if (/[\x00-\x1f\x7f]/.test(value)) {
    fail("remote path must not contain control characters", { exitCode: 4, code: "bad_args" });
  }
  if (value.includes('"')) {
    fail('remote path must not contain a double quote', { exitCode: 4, code: "bad_args" });
  }
  if (value === "") return "";
  if (/[\s*]/.test(value) || value.startsWith("-")) return `"${value}"`;
  return value;
}

export function remotePrintName(name) {
  const base = String(name || "");
  if (!/^[A-Za-z0-9._+-]{1,120}\.gcode\.3mf$/.test(base)) {
    fail("LAN upload file name must be a simple .gcode.3mf (letters, digits, dot, underscore, plus, hyphen). Rename the file; the access code is not part of the name.", {
      exitCode: 4,
      code: "bad_file",
    });
  }
  return base;
}

export function normalizeRemotePath(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    if (required) fail("remote path is required", { exitCode: 4, code: "bad_args" });
    return "";
  }
  const value = String(raw);
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    fail("remote path must not contain control characters", { exitCode: 4, code: "bad_args" });
  }
  if (value.length > 240) fail("remote path is too long", { exitCode: 4, code: "bad_args" });
  if (value.split("/").includes("..")) {
    fail("remote path must not contain ..", { exitCode: 4, code: "bad_args" });
  }
  return value;
}

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Printer FTPS LIST/MLSD stamps are the printer's own clock with no zone; keep them zoneless. */
export function formatPrinterLocalStamp(year, monthIndex, day, hours = 0, minutes = 0, seconds = 0) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function parseListLine(line) {
  const text = String(line || "").replace(/\r$/, "");
  if (!text || text.startsWith("total ")) return null;
  const unix = /^([bcdlps-])([rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/.exec(text);
  if (unix) {
    const typeChar = unix[1];
    const size = Number(unix[3]);
    const month = MONTHS[unix[4].toLowerCase()];
    const day = Number(unix[5]);
    const timeOrYear = unix[6];
    const name = unix[7];
    let modified = null;
    if (month !== undefined) {
      const now = new Date();
      // Year when LIST shows HH:MM is not on the wire; borrow the client's calendar year, then
      // roll back one year if that stamp would sit more than a day in the future (classic FTP).
      let year = now.getFullYear();
      let hours = 0;
      let minutes = 0;
      if (timeOrYear.includes(":")) {
        const [h, m] = timeOrYear.split(":").map(Number);
        hours = h;
        minutes = m;
        const candidate = new Date(year, month, day, hours, minutes);
        if (candidate.getTime() - now.getTime() > 86_400_000) year -= 1;
      } else {
        year = Number(timeOrYear);
      }
      modified = formatPrinterLocalStamp(year, month, day, hours, minutes, 0);
    }
    return {
      name,
      size,
      modified,
      type: typeChar === "d" ? "dir" : typeChar === "l" ? "link" : "file",
      raw: text,
    };
  }
  const mlsd = /^(\S+);?\s+(.+)$/.exec(text);
  if (mlsd && /(?:^|;)Size=\d+/i.test(mlsd[1])) {
    const facts = Object.fromEntries(
      mlsd[1].split(";").filter(Boolean).map((part) => {
        const eq = part.indexOf("=");
        if (eq < 0) return [part.toLowerCase(), true];
        return [part.slice(0, eq).toLowerCase(), part.slice(eq + 1)];
      }),
    );
    const size = Number(facts.size);
    let modified = null;
    if (facts.modify && /^\d{14}$/.test(facts.modify)) {
      const m = facts.modify;
      modified = formatPrinterLocalStamp(
        Number(m.slice(0, 4)),
        Number(m.slice(4, 6)) - 1,
        Number(m.slice(6, 8)),
        Number(m.slice(8, 10)),
        Number(m.slice(10, 12)),
        Number(m.slice(12, 14)),
      );
    }
    const type = String(facts.type || "").toLowerCase().includes("dir") ? "dir" : "file";
    return { name: mlsd[2], size: Number.isFinite(size) ? size : null, modified, type, raw: text };
  }
  return null;
}

async function withFtpsSession({ host, port, accessCode, acceptNewPin }, run) {
  const connection = await connectTofu({ host, port, acceptNewPin });
  const state = attach(connection.socket);
  let dataSocket = null;
  try {
    const banner = await nextReply(state, 10_000);
    if (banner.code !== 220) fail(`FTPS banner was ${banner.code}`, { code: "ftps" });
    await command(connection.socket, state, "USER bblp", [331, 230], accessCode);
    await command(connection.socket, state, `PASS ${accessCode}`, [230, 202], accessCode);
    const pbsz = await command(connection.socket, state, "PBSZ 0", [200, 250, 500, 502], accessCode);
    void pbsz;
    await command(connection.socket, state, "PROT P", [200, 250, 500, 502], accessCode);
    await command(connection.socket, state, "TYPE I", [200, 250], accessCode);
    return await run({
      socket: connection.socket,
      state,
      fingerprint: connection.fingerprint,
      pin: connection.pin,
      setDataSocket: (socket) => {
        dataSocket = socket;
      },
      openData: async () => {
        const pasv = await command(connection.socket, state, "PASV", [227], accessCode);
        const dataTarget = parsePasv(pasv.text, host);
        const session = typeof connection.socket.getSession === "function" ? connection.socket.getSession() : null;
        dataSocket = await connectPinned({
          host: dataTarget.host,
          port: dataTarget.port,
          fingerprint: connection.fingerprint,
          session,
          // Modest HWM so a stalled peer produces backpressure and the idle timer can fire.
          highWaterMark: 16 * 1024,
        });
        return dataSocket;
      },
      command: (line, accept) => command(connection.socket, state, line, accept, accessCode),
      nextReply: (timeoutMs) => nextReply(state, timeoutMs),
    });
  } catch (error) {
    if (error?.code) throw error;
    fail(redactText(error.message || "FTPS failed", [accessCode]), { code: "ftps" });
  } finally {
    dataSocket?.destroy();
    try {
      connection.socket.write("QUIT\r\n");
    } catch {
      // already closed
    }
    connection.socket.destroy();
  }
}

function resolveTransferTimeouts({ idleTimeoutMs, maxTimeoutMs } = {}) {
  const idle = idleTimeoutMs ?? LIMITS.ftpsIdleTimeoutMs;
  const max = maxTimeoutMs ?? LIMITS.ftpsMaxTransferTimeoutMs;
  if (!Number.isFinite(idle) || idle < 1) fail("FTPS idle timeout is invalid", { code: "ftps" });
  if (!Number.isFinite(max) || max < 1) fail("FTPS transfer timeout is invalid", { code: "ftps" });
  return { idleTimeoutMs: idle, maxTimeoutMs: max };
}

async function readDataSocket(dataSocket, timeouts = {}) {
  const { idleTimeoutMs, maxTimeoutMs } = resolveTransferTimeouts(timeouts);
  const chunks = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.clear();
      fn(value);
    };
    const timers = transferTimers({
      idleTimeoutMs,
      maxTimeoutMs,
      onTimeout: () => {
        dataSocket.destroy();
        finish(reject, dataTimeoutError());
      },
    });
    dataSocket.on("data", (chunk) => {
      chunks.push(chunk);
      timers.armIdle();
    });
    dataSocket.on("error", (error) => finish(reject, error));
    dataSocket.on("end", () => finish(resolve));
  });
  return Buffer.concat(chunks);
}

async function writeDataSocket(dataSocket, body, timeouts = {}) {
  const { idleTimeoutMs, maxTimeoutMs } = resolveTransferTimeouts(timeouts);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  await new Promise((resolve, reject) => {
    let settled = false;
    let offset = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.clear();
      fn(value);
    };
    const timers = transferTimers({
      idleTimeoutMs,
      maxTimeoutMs,
      onTimeout: () => {
        dataSocket.destroy();
        finish(reject, dataTimeoutError());
      },
    });
    dataSocket.on("error", (error) => finish(reject, error));
    const writeMore = () => {
      if (settled) return;
      while (offset < buf.length) {
        const next = Math.min(offset + DATA_CHUNK, buf.length);
        const slice = buf.subarray(offset, next);
        offset = next;
        timers.armIdle();
        const ok = dataSocket.write(slice);
        if (!ok) {
          dataSocket.once("drain", () => {
            timers.armIdle();
            writeMore();
          });
          return;
        }
      }
      dataSocket.end(() => finish(resolve));
    };
    writeMore();
  });
}

async function waitTransferDone(session, remainingMs) {
  try {
    return await session.nextReply(Math.max(1, remainingMs));
  } catch (error) {
    if (error?.code === "ftps" && /FTPS reply timed out/i.test(error.message || "")) {
      throw dataTimeoutError();
    }
    throw error;
  }
}

export async function uploadFtps({
  host,
  port,
  accessCode,
  filename,
  body,
  acceptNewPin,
  idleTimeoutMs,
  maxTimeoutMs,
}) {
  const remote = remotePrintName(filename);
  const timeouts = resolveTransferTimeouts({ idleTimeoutMs, maxTimeoutMs });
  return withFtpsSession({ host, port, accessCode, acceptNewPin }, async (session) => {
    const dataSocket = await session.openData();
    session.socket.write(`STOR ${remote}\r\n`);
    const opened = await session.nextReply(15_000);
    if (opened.code !== 150 && opened.code !== 125) {
      fail(`FTPS STOR was refused (${opened.code})`, { code: "ftps", details: { verification: "UNVERIFIED" } });
    }
    // Overall ceiling spans the write and the 226 — small uploads can leave the OS
    // send buffer before a stalled peer produces backpressure for the idle timer.
    const started = Date.now();
    await writeDataSocket(dataSocket, body, timeouts);
    const remaining = timeouts.maxTimeoutMs - (Date.now() - started);
    const done = await waitTransferDone(session, remaining);
    if (done.code !== 226 && done.code !== 250) {
      fail(`FTPS transfer ended with ${done.code}`, { code: "ftps", details: { verification: "UNVERIFIED" } });
    }
    return {
      remote,
      bytes: body.length,
      pin: session.pin,
      tlsSessionReused: Boolean(dataSocket.isSessionReused?.()),
      verification: "UNVERIFIED",
      sources: [SOURCES.ftp, SOURCES.mqtt],
    };
  });
}

export async function listFtps({ host, port, accessCode, remotePath = "", acceptNewPin, idleTimeoutMs, maxTimeoutMs }) {
  const target = normalizeRemotePath(remotePath);
  const arg = ftpPathArg(target);
  const timeouts = resolveTransferTimeouts({ idleTimeoutMs, maxTimeoutMs });
  return withFtpsSession({ host, port, accessCode, acceptNewPin }, async (session) => {
    const dataSocket = await session.openData();
    const listCmd = arg ? `LIST ${arg}` : "LIST";
    session.socket.write(`${listCmd}\r\n`);
    const opened = await session.nextReply(15_000);
    if (opened.code !== 150 && opened.code !== 125) {
      fail(`FTPS LIST was refused (${opened.code})`, { code: "ftps", details: { verification: "UNVERIFIED" } });
    }
    const started = Date.now();
    const body = await readDataSocket(dataSocket, timeouts);
    const done = await waitTransferDone(session, timeouts.maxTimeoutMs - (Date.now() - started));
    if (done.code !== 226 && done.code !== 250) {
      fail(`FTPS LIST ended with ${done.code}`, { code: "ftps", details: { verification: "UNVERIFIED" } });
    }
    const text = body.toString("utf8");
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseListLine(line);
      if (parsed) entries.push(parsed);
    }
    return {
      path: target || ".",
      entries,
      pin: session.pin,
      tlsSessionReused: Boolean(dataSocket.isSessionReused?.()),
      sources: [SOURCES.ftp],
    };
  });
}

export async function getFtps({
  host,
  port,
  accessCode,
  remotePath,
  outPath,
  acceptNewPin,
  idleTimeoutMs,
  maxTimeoutMs,
}) {
  const remote = normalizeRemotePath(remotePath, { required: true });
  if (remote.endsWith("/")) fail("lan get requires a file path, not a directory", { exitCode: 4, code: "bad_args" });
  const local = path.resolve(outPath || path.basename(remote));
  if (!local || local.endsWith(path.sep)) {
    fail("lan get --out must be a file path", { exitCode: 4, code: "bad_args" });
  }
  const dir = path.dirname(local);
  fs.mkdirSync(dir, { recursive: true });
  const timeouts = resolveTransferTimeouts({ idleTimeoutMs, maxTimeoutMs });
  return withFtpsSession({ host, port, accessCode, acceptNewPin }, async (session) => {
    const dataSocket = await session.openData();
    session.socket.write(`RETR ${ftpPathArg(remote)}\r\n`);
    const opened = await session.nextReply(15_000);
    if (opened.code !== 150 && opened.code !== 125) {
      fail(`FTPS RETR was refused (${opened.code})`, { code: "ftps", details: { verification: "UNVERIFIED" } });
    }
    const started = Date.now();
    const body = await readDataSocket(dataSocket, timeouts);
    const done = await waitTransferDone(session, timeouts.maxTimeoutMs - (Date.now() - started));
    if (done.code !== 226 && done.code !== 250) {
      fail(`FTPS RETR ended with ${done.code}`, { code: "ftps", details: { verification: "UNVERIFIED" } });
    }
    fs.writeFileSync(local, body, { mode: 0o600 });
    return {
      remote,
      file: local,
      bytes: body.length,
      pin: session.pin,
      tlsSessionReused: Boolean(dataSocket.isSessionReused?.()),
      sources: [SOURCES.ftp],
    };
  });
}
