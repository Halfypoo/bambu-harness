import net from "node:net";
import { once } from "node:events";
import {
  decodePacket,
  encodeConnack,
  encodePingresp,
  encodePuback,
  encodePublish,
  encodeSuback,
  takePacket,
} from "../../src/mqtt.js";

function parseSubscribe(body) {
  const packetId = body.readUInt16BE(0);
  let offset = 2;
  const topics = [];
  while (offset + 3 <= body.length) {
    const length = body.readUInt16BE(offset);
    offset += 2;
    const topic = body.subarray(offset, offset + length).toString("utf8");
    offset += length;
    const qos = body[offset];
    offset += 1;
    topics.push({ topic, qos });
  }
  return { packetId, topics };
}

export async function startMqttMock(handler) {
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = takePacket(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.total);
        const type = parsed.header >> 4;
        if (type === 1) {
          socket.write(encodeConnack(0));
          continue;
        }
        if (type === 8) {
          const sub = parseSubscribe(parsed.body);
          socket.write(encodeSuback(sub.packetId, 0));
          socket.topics = sub.topics.map((item) => item.topic);
          continue;
        }
        if (type === 12) {
          socket.write(encodePingresp());
          continue;
        }
        if (type === 14) continue;
        if (type === 3) {
          const message = decodePacket(parsed.header, parsed.body);
          if (message.qos === 1) socket.write(encodePuback(message.packetId));
          let json = null;
          try {
            json = JSON.parse(message.payload.toString("utf8"));
          } catch {
            json = null;
          }
          handler({ socket, topic: message.topic, json, clients, publish });
        }
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  function publish(topic, json) {
    const body = encodePublish(topic, JSON.stringify(json), { qos: 0 });
    for (const socket of clients) socket.write(body);
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    publish,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
