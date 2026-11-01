import tls from "node:tls";
import { once } from "node:events";

export function tinyJpeg(fill = 0x11, width = 8, height = 4) {
  const payload = Buffer.alloc(11);
  payload.writeUInt16BE(11, 0);
  payload[2] = 8;
  payload.writeUInt16BE(height, 3);
  payload.writeUInt16BE(width, 5);
  payload[7] = 1;
  payload[8] = 1;
  payload[9] = 0x11;
  payload[10] = 0;
  const body = Buffer.alloc(64, fill & 0xff);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
    payload,
    body,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function framePacket(jpeg, flags = 1) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(jpeg.length, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(flags, 8);
  header.writeUInt32LE(0, 12);
  return Buffer.concat([header, jpeg]);
}

export async function startFakeCamera({ cert, key, accessCode, port = 0, flags = 1 }) {
  const connections = [];
  const events = { secure: 0, clientError: 0, raw: 0 };
  let fills = 0;
  const server = tls.createServer({ cert, key }, (socket) => {
    events.secure += 1;
    const record = { bytes: 0, authed: false };
    connections.push(record);
    const chunks = [];
    socket.on("data", (chunk) => {
      record.bytes += chunk.length;
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 80 || record.authed) return;
      const user = buf.subarray(16, 48).toString("utf8").replace(/\0+$/, "");
      const code = buf.subarray(48, 80).toString("utf8").replace(/\0+$/, "");
      record.authed = true;
      record.user = user;
      record.codeOk = code === accessCode;
      record.magic = buf.readUInt32LE(0);
      record.type = buf.readUInt32LE(4);
      if (user === "bblp" && code === accessCode) {
        fills += 1;
        socket.write(framePacket(tinyJpeg(0x20 + fills), flags));
      } else {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
  });
  server.on("tlsClientError", () => {
    events.clientError += 1;
  });
  server.on("connection", () => {
    events.raw += 1;
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    connections,
    events,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
