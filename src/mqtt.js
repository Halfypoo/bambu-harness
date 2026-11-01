import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { fail } from "./errors.js";
import { redactText } from "./redact.js";

const MAX_PACKET = 2 * 1024 * 1024;

export function encodeRemainingLength(length) {
  if (!Number.isInteger(length) || length < 0 || length > 268_435_455) {
    throw new Error("bad MQTT remaining length");
  }
  const bytes = [];
  let value = length;
  do {
    let encoded = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) encoded |= 0x80;
    bytes.push(encoded);
  } while (value > 0);
  return Buffer.from(bytes);
}

export function encodeUtf8(value) {
  const body = Buffer.from(String(value), "utf8");
  if (body.length > 65_535) throw new Error("MQTT string too long");
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

function packet(typeAndFlags, body) {
  return Buffer.concat([Buffer.from([typeAndFlags]), encodeRemainingLength(body.length), body]);
}

export function encodeConnect({ clientId, username, password, keepalive = 30 }) {
  const head = Buffer.concat([
    encodeUtf8("MQTT"),
    Buffer.from([0x04, 0xc2, (keepalive >> 8) & 0xff, keepalive & 0xff]),
  ]);
  const payload = Buffer.concat([encodeUtf8(clientId), encodeUtf8(username), encodeUtf8(password)]);
  return packet(0x10, Buffer.concat([head, payload]));
}

export function encodeSubscribe(packetId, topic, qos = 0) {
  const body = Buffer.concat([
    Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]),
    encodeUtf8(topic),
    Buffer.from([qos & 0x03]),
  ]);
  return packet(0x82, body);
}

export function encodePublish(topic, payload, { qos = 0, packetId = 1 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const parts = [encodeUtf8(topic)];
  if (qos === 1) parts.push(Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]));
  parts.push(data);
  const flags = qos === 1 ? 0x32 : 0x30;
  return packet(flags, Buffer.concat(parts));
}

export function encodePuback(packetId) {
  return packet(0x40, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]));
}

export function encodePingreq() {
  return Buffer.from([0xc0, 0x00]);
}

export function encodePingresp() {
  return Buffer.from([0xd0, 0x00]);
}

export function encodeConnack(returnCode = 0) {
  return Buffer.from([0x20, 0x02, 0x00, returnCode & 0xff]);
}

export function encodeSuback(packetId, qos = 0) {
  return packet(0x90, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff, qos & 0xff]));
}

export function encodeDisconnect() {
  return Buffer.from([0xe0, 0x00]);
}

export function takePacket(buffer) {
  if (buffer.length < 2) return null;
  let multiplier = 1;
  let value = 0;
  let offset = 1;
  for (;;) {
    if (offset >= buffer.length) return null;
    const byte = buffer[offset];
    value += (byte & 0x7f) * multiplier;
    offset += 1;
    if ((byte & 0x80) === 0) break;
    if (offset > 4) throw new Error("bad MQTT remaining length");
    multiplier *= 128;
  }
  if (value > MAX_PACKET) throw new Error("MQTT packet too large");
  const total = offset + value;
  if (buffer.length < total) return null;
  return {
    header: buffer[0],
    body: buffer.subarray(offset, total),
    total,
  };
}

function readUtf8(body, offset) {
  if (offset + 2 > body.length) throw new Error("truncated MQTT string");
  const length = body.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > body.length) throw new Error("truncated MQTT string");
  return { value: body.subarray(start, end).toString("utf8"), offset: end };
}

function decodePublish(header, body) {
  const qos = (header >> 1) & 0x03;
  let offset = 0;
  const topic = readUtf8(body, offset);
  offset = topic.offset;
  let packetId = null;
  if (qos === 1 || qos === 2) {
    if (offset + 2 > body.length) throw new Error("truncated MQTT publish");
    packetId = body.readUInt16BE(offset);
    offset += 2;
  }
  return {
    type: "publish",
    qos,
    topic: topic.value,
    packetId,
    payload: body.subarray(offset),
  };
}

export function decodePacket(header, body) {
  const type = header >> 4;
  if (type === 2) {
    return { type: "connack", sessionPresent: body[0] ?? 0, returnCode: body[1] ?? 0xff };
  }
  if (type === 3) return decodePublish(header, body);
  if (type === 4) return { type: "puback", packetId: body.length >= 2 ? body.readUInt16BE(0) : 0 };
  if (type === 9) return { type: "suback", packetId: body.length >= 2 ? body.readUInt16BE(0) : 0, codes: [...body.subarray(2)] };
  if (type === 13) return { type: "pingresp" };
  return { type: "other", kind: type };
}

function openSocket({ host, port, tls: useTls, tlsOptions }) {
  return new Promise((resolve, reject) => {
    let socket;
    if (useTls) {
      const options = {
        host,
        port,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: host,
        ...(tlsOptions ?? {}),
      };
      if (options.servername === false) delete options.servername;
      socket = tls.connect(options);
    } else {
      socket = net.connect({ host, port });
    }
    const onError = (error) => {
      socket.removeListener("secureConnect", done);
      socket.removeListener("connect", done);
      reject(error);
    };
    const done = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    if (useTls) socket.once("secureConnect", done);
    else socket.once("connect", done);
  });
}

export class MqttSession extends EventEmitter {
  constructor(socket, options) {
    super();
    this.socket = socket;
    this.username = options.username;
    this.password = options.password;
    this.keepalive = options.keepalive ?? 30;
    this.buffer = Buffer.alloc(0);
    this.packetId = 1;
    this.pending = new Map();
    this.control = [];
    this.inbox = [];
    this.closed = false;
    this.pingTimer = null;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () => this.#failAll(new Error("MQTT connection closed")));
  }

  static async connect(target, credentials) {
    const clientId = `bambu-harness-${Math.random().toString(16).slice(2, 10)}`;
    const socket = await openSocket(target);
    if (typeof target.assertPeer === "function") {
      try {
        await target.assertPeer(socket);
      } catch (error) {
        socket.destroy();
        throw error;
      }
    }
    const session = new MqttSession(socket, credentials);
    session.#send(encodeConnect({
      clientId,
      username: credentials.username,
      password: credentials.password,
      keepalive: credentials.keepalive ?? 30,
    }));
    const connack = await session.#waitType("connack", 10_000);
    if (connack.returnCode !== 0) {
      session.close();
      fail(`MQTT connection refused (code ${connack.returnCode})`, { code: "mqtt" });
    }
    session.#startPing();
    return session;
  }

  #nextId() {
    this.packetId = this.packetId >= 65535 ? 1 : this.packetId + 1;
    return this.packetId;
  }

  #send(buf) {
    if (this.closed) fail("MQTT session is closed", { code: "mqtt" });
    this.socket.write(buf);
  }

  #startPing() {
    const every = Math.max(5, Math.floor(this.keepalive / 2)) * 1000;
    this.pingTimer = setInterval(() => {
      if (!this.closed) this.socket.write(encodePingreq());
    }, every);
    this.pingTimer.unref?.();
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const parsed = takePacket(this.buffer);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.total);
        const message = decodePacket(parsed.header, parsed.body);
        if (message.type === "publish" && message.qos === 1 && message.packetId) {
          this.#send(encodePuback(message.packetId));
        }
        if (message.type === "puback" || message.type === "suback" || message.type === "connack") {
          const bucket = this.pending.get(message.type);
          const waiter = bucket?.shift();
          if (waiter) waiter.resolve(message);
          else this.control.push(message);
        }
        if (message.type === "publish") {
          let json = null;
          const text = message.payload.toString("utf8");
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          const item = { topic: message.topic, json, text };
          this.inbox.push(item);
          if (this.inbox.length > 200) this.inbox.shift();
          this.emit("message", item);
        }
      }
    } catch (error) {
      this.#failAll(error);
      this.close();
    }
  }

  #waitType(type, timeoutMs) {
    const queued = this.control.findIndex((message) => message.type === type);
    if (queued >= 0) return Promise.resolve(this.control.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const bucket = this.pending.get(type) ?? [];
      const waiter = {};
      const timer = setTimeout(() => {
        const index = bucket.indexOf(waiter);
        if (index >= 0) bucket.splice(index, 1);
        reject(new Error(`timed out waiting for MQTT ${type}`));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      bucket.push(waiter);
      this.pending.set(type, bucket);
    });
  }

  #failAll(error) {
    const wrapped = new Error(redactText(error.message || "MQTT failure", [this.password, this.username]));
    for (const bucket of this.pending.values()) {
      while (bucket.length) bucket.shift().reject(wrapped);
    }
    this.pending.clear();
    this.emit("failure", wrapped);
  }

  async subscribe(topic, qos = 1) {
    const id = this.#nextId();
    this.#send(encodeSubscribe(id, topic, qos));
    const suback = await this.#waitType("suback", 10_000);
    if (suback.codes.some((code) => code >= 0x80)) fail("MQTT subscribe rejected", { code: "mqtt" });
  }

  async publish(topic, payload, qos = 0) {
    const id = qos === 1 ? this.#nextId() : 0;
    this.#send(encodePublish(topic, payload, { qos, packetId: id }));
    if (qos === 1) await this.#waitType("puback", 10_000);
  }

  async waitFor(predicate, timeoutMs) {
    const existing = this.inbox.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("message", onMessage);
        reject(Object.assign(new Error("timed out waiting for printer report"), { code: "not_acknowledged" }));
      }, timeoutMs);
      const onMessage = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.removeListener("message", onMessage);
        resolve(message);
      };
      this.on("message", onMessage);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.socket.write(encodeDisconnect());
    } catch {
      // already gone
    }
    this.socket.end();
    this.socket.destroy();
  }
}
