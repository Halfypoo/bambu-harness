import crypto from "node:crypto";
import tls from "node:tls";
import { fail } from "./errors.js";
import { readPrivateJson, writePrivateJson } from "./session.js";

const PIN_FILE = "lan-pins.json";

function tlsConnect(host, port, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      ...extra,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("TLS handshake timed out"), { code: "network" }));
    }, extra.timeout ?? 10_000);
    const failConnect = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", failConnect);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.removeListener("error", failConnect);
      resolve(socket);
    });
  });
}

export function fingerprintOf(socket) {
  const cert = socket.getPeerCertificate(true);
  if (!cert || !cert.raw || cert.raw.length === 0) {
    fail("TLS peer presented no certificate", { code: "cert_changed", exitCode: 4 });
  }
  return crypto.createHash("sha256").update(cert.raw).digest("hex");
}

export function rememberPin(host, port, fingerprint) {
  const key = `${host}:${port}`;
  const stored = readPrivateJson(PIN_FILE) ?? { version: 1, pins: {} };
  const pins = stored.pins && typeof stored.pins === "object" ? stored.pins : {};
  const previous = typeof pins[key]?.sha256 === "string" ? pins[key].sha256 : null;
  return { key, previous, stored: { version: 1, pins } };
}

export function savePin(state, fingerprint) {
  const prior = state.stored.pins[state.key];
  state.stored.pins[state.key] = {
    sha256: fingerprint,
    firstSeen: prior?.firstSeen || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writePrivateJson(PIN_FILE, state.stored);
}

export async function connectTofu({ host, port, acceptNewPin }) {
  const socket = await tlsConnect(host, port);
  try {
    const fingerprint = fingerprintOf(socket);
    const state = rememberPin(host, port, fingerprint);
    if (state.previous && state.previous !== fingerprint && !acceptNewPin) {
      socket.destroy();
      fail(
        `UNVERIFIED TLS certificate changed for ${state.key}. Stored sha256 ${state.previous}. Peer presented ${fingerprint}. The access code was not sent. Pass --accept-new-pin only after you have checked the printer.`,
        { exitCode: 4, code: "cert_changed", details: { fingerprint, previous: state.previous, verification: "UNVERIFIED" } },
      );
    }
    let pin = "match";
    if (!state.previous) {
      savePin(state, fingerprint);
      pin = "first-use";
    } else if (state.previous !== fingerprint) {
      savePin(state, fingerprint);
      pin = "replaced";
    }
    return { socket, fingerprint, pin };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function connectPinned({ host, port, fingerprint, session, highWaterMark }) {
  const extra = {};
  if (session) extra.session = session;
  if (highWaterMark != null) extra.highWaterMark = highWaterMark;
  const socket = await tlsConnect(host, port, extra);
  try {
    // A resumed TLS session sends no certificate (abbreviated handshake); its keys
    // derive from the control connection session already pinned, so the peer is the
    // same authenticated server.
    const resumed = Boolean(session) && typeof socket.isSessionReused === "function" && socket.isSessionReused();
    const peer = resumed ? fingerprint : fingerprintOf(socket);
    if (peer !== fingerprint) {
      socket.destroy();
      fail("FTPS data connection certificate does not match the control connection. The file was not sent.", {
        exitCode: 4,
        code: "cert_changed",
        details: { verification: "UNVERIFIED" },
      });
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
