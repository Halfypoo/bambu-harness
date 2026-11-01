import tls from "node:tls";
import { once } from "node:events";

async function paceSend(socket, body, { chunkSize = 1024, delayMs = 200 } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    if (socket.destroyed) return;
    socket.write(buf.subarray(offset, Math.min(offset + chunkSize, buf.length)));
    if (offset + chunkSize < buf.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!socket.destroyed) socket.end();
}

async function stallSend(socket, body, afterBytes = 1) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const n = Math.max(0, Math.min(buf.length, afterBytes));
  if (n > 0 && !socket.destroyed) socket.write(buf.subarray(0, n));
  // Leave the socket open with no further data and no end.
}

/**
 * @param {object} options
 * @param {"fast"|"slow"|"stall"} [options.retrMode]
 * @param {{ chunkSize?: number, delayMs?: number }} [options.retrPace]
 * @param {number} [options.retrStallAfter]
 * @param {"fast"|"slow"|"stall"} [options.storDrain]
 * @param {{ chunkDelayMs?: number, pauseMs?: number }} [options.storPace]
 * @param {number} [options.storStallAfter] bytes to accept before pausing reads forever
 */
export async function startFakeFtps({
  cert,
  key,
  accessCode,
  pasvHost = "127.0.0.1",
  files = null,
  retrMode = "fast",
  retrPace = { chunkSize: 1024, delayMs: 250 },
  retrStallAfter = 1,
  storDrain = "fast",
  storPace = { chunkDelayMs: 250 },
  storStallAfter = 1,
}) {
  const uploads = [];
  const store = new Map();
  if (files) {
    for (const [name, body] of Object.entries(files)) {
      store.set(name, Buffer.isBuffer(body) ? body : Buffer.from(body));
    }
  }

  let dataSocket = null;
  let dataMode = null; // "recv" | { send: Buffer } | null
  let recvWait = null;
  let recvBody = null;

  function waitRecv() {
    if (recvBody) {
      const body = recvBody;
      recvBody = null;
      return Promise.resolve(body);
    }
    return new Promise((resolve) => {
      recvWait = resolve;
    });
  }

  function finishRecv(body) {
    dataSocket = null;
    dataMode = null;
    if (recvWait) {
      const resolve = recvWait;
      recvWait = null;
      resolve(body);
    } else recvBody = body;
  }

  function attachRecv(socket) {
    if (storDrain === "stall") {
      const chunks = [];
      let received = 0;
      let stalled = false;
      socket.on("data", (chunk) => {
        if (stalled) return;
        chunks.push(chunk);
        received += chunk.length;
        if (received >= storStallAfter) {
          stalled = true;
          socket.pause();
          // Never resume; leave the transfer hanging for the client's idle timer.
        }
      });
      socket.on("end", () => finishRecv(Buffer.concat(chunks)));
      return;
    }
    if (storDrain === "slow") {
      const chunks = [];
      const delay = storPace.chunkDelayMs ?? 250;
      let resumeTimer = null;
      const scheduleResume = () => {
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          if (!socket.destroyed) socket.resume();
        }, delay);
      };
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        socket.pause();
        scheduleResume();
      });
      socket.on("end", () => {
        clearTimeout(resumeTimer);
        finishRecv(Buffer.concat(chunks));
      });
      socket.pause();
      scheduleResume();
      return;
    }
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finishRecv(Buffer.concat(chunks)));
  }

  function attachSend(socket, payload) {
    if (retrMode === "stall") {
      stallSend(socket, payload, retrStallAfter).catch(() => {});
      return;
    }
    if (retrMode === "slow") {
      paceSend(socket, payload, retrPace).catch(() => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
      return;
    }
    socket.end(payload);
  }

  function attachData(socket) {
    dataSocket = socket;
    socket.on("error", () => {});
    if (dataMode?.send) {
      const payload = dataMode.send;
      dataMode = null;
      attachSend(socket, payload);
      dataSocket = null;
      return;
    }
    if (dataMode === "recv") {
      dataMode = null;
      attachRecv(socket);
      return;
    }
    // Connected before the command chose a mode; wait for setDataMode.
    socket.once("close", () => {
      if (dataSocket === socket) dataSocket = null;
    });
  }

  function setDataMode(mode) {
    dataMode = mode;
    if (!dataSocket) return;
    const socket = dataSocket;
    if (mode?.send) {
      dataMode = null;
      dataSocket = null;
      attachSend(socket, mode.send);
      return;
    }
    if (mode === "recv") {
      dataMode = null;
      attachRecv(socket);
    }
  }

  function unquote(arg) {
    const value = String(arg || "");
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1);
    }
    return value;
  }

  const controlSockets = new Set();
  const dataSockets = new Set();

  const dataServer = tls.createServer({ cert, key }, (socket) => {
    dataSockets.add(socket);
    socket.on("close", () => dataSockets.delete(socket));
    attachData(socket);
  });
  dataServer.listen(0, "127.0.0.1");
  await once(dataServer, "listening");
  const dataPort = dataServer.address().port;

  const server = tls.createServer({ cert, key }, (socket) => {
    controlSockets.add(socket);
    socket.on("close", () => controlSockets.delete(socket));
    socket.write("220 bambu-harness fake ftps\r\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const space = line.indexOf(" ");
        const cmd = (space === -1 ? line : line.slice(0, space)).toUpperCase();
        const arg = space === -1 ? "" : line.slice(space + 1);
        if (cmd === "USER") socket.write("331 password required\r\n");
        else if (cmd === "PASS") socket.write(arg === accessCode ? "230 logged in\r\n" : "530 login incorrect\r\n");
        else if (cmd === "PBSZ" || cmd === "PROT" || cmd === "TYPE") socket.write("200 ok\r\n");
        else if (cmd === "PASV") {
          const host = pasvHost.split(".").join(",");
          const p1 = Math.floor(dataPort / 256);
          const p2 = dataPort % 256;
          dataMode = null;
          socket.write(`227 Entering Passive Mode (${host},${p1},${p2}).\r\n`);
        } else if (cmd === "STOR") {
          setDataMode("recv");
          socket.write("150 opening data connection\r\n");
          waitRecv().then((body) => {
            const name = unquote(arg);
            uploads.push({ name, body });
            store.set(name, body);
            if (!socket.destroyed) socket.write("226 transfer complete\r\n");
          }).catch(() => socket.destroy());
        } else if (cmd === "LIST") {
          const listing = [];
          const prefix = unquote(arg);
          for (const [name, body] of store.entries()) {
            if (prefix && prefix !== "." && prefix !== "/" && name !== prefix && !name.startsWith(`${prefix.replace(/\/$/, "")}/`)) {
              continue;
            }
            listing.push(`-rw-r--r-- 1 bblp bblp ${body.length} Oct 31 12:00 ${name}`);
          }
          setDataMode({ send: Buffer.from(`${listing.join("\r\n")}${listing.length ? "\r\n" : ""}`) });
          socket.write("150 opening data connection\r\n");
          setTimeout(() => {
            if (!socket.destroyed) socket.write("226 transfer complete\r\n");
          }, 15);
        } else if (cmd === "RETR") {
          const name = unquote(arg);
          const body = store.get(name);
          if (!body) {
            socket.write("550 file not found\r\n");
            continue;
          }
          setDataMode({ send: body });
          socket.write("150 opening data connection\r\n");
          if (retrMode === "stall") {
            // No 226 — transfer never finishes on the control channel either.
          } else if (retrMode === "slow") {
            const chunks = Math.ceil(body.length / (retrPace.chunkSize || 1024));
            const delay = (retrPace.delayMs || 250) * Math.max(0, chunks - 1) + 40;
            setTimeout(() => {
              if (!socket.destroyed) socket.write("226 transfer complete\r\n");
            }, delay);
          } else {
            setTimeout(() => {
              if (!socket.destroyed) socket.write("226 transfer complete\r\n");
            }, 15);
          }
        } else if (cmd === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("502 command not implemented\r\n");
      }
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    dataPort,
    uploads,
    store,
    close: () => {
      for (const socket of controlSockets) socket.destroy();
      for (const socket of dataSockets) socket.destroy();
      if (dataSocket && !dataSocket.destroyed) dataSocket.destroy();
      return Promise.all([
        new Promise((resolve) => server.close(() => resolve())),
        new Promise((resolve) => dataServer.close(() => resolve())),
      ]);
    },
  };
}
