import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { grabFrame, writeFrameFile } from "./camera.js";
import { SOURCES } from "./sources.js";

export function byteDeltaRatio(left, right) {
  const length = Math.max(left.length, right.length);
  if (length === 0) return 0;
  const shared = Math.min(left.length, right.length);
  let delta = Math.abs(left.length - right.length);
  for (let i = 0; i < shared; i++) if (left[i] !== right[i]) delta += 1;
  return delta / length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function watchFirstLayer({
  host,
  port,
  accessCode,
  acceptNewPin,
  directory,
  everySec,
  durationSec,
  autoStop,
  stop,
}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const notesPath = path.join(directory, "notes.jsonl");
  const frames = [];
  const notes = [];
  let previous = null;
  let hot = 0;
  let pin = null;
  const fast = everySec === 0;
  const count = fast ? 4 : Math.max(1, Math.floor(durationSec / everySec));
  if (!fast && count > 400) {
    fail("that interval would store more than 400 frames. Raise --every or shorten the duration.", { exitCode: 4, code: "bad_args" });
  }
  const deadline = Date.now() + durationSec * 1000;
  for (let index = 1; index <= count; index++) {
    if (!fast && Date.now() > deadline && index > 1) break;
    const frame = await grabFrame({ host, port, accessCode, acceptNewPin, timeoutMs: 8_000 });
    pin = frame.pin;
    const file = writeFrameFile(path.join(directory, `frame-${String(index).padStart(4, "0")}.jpg`), frame.jpeg);
    frames.push({ file: path.basename(file), bytes: frame.jpeg.length, flags: frame.flags });
    if (previous) {
      const ratio = byteDeltaRatio(previous, frame.jpeg);
      if (ratio >= 0.45) hot += 1;
      else hot = 0;
      if (hot >= 3) {
        const note = {
          at: new Date().toISOString(),
          kind: "possible-visual-change",
          metric: Math.round(ratio * 1000) / 1000,
          frame: path.basename(file),
          autoStop: false,
          verification: "UNVERIFIED",
          detail: "Byte-delta between JPEGs. This is not a spaghetti detector and it does not mean the print failed.",
        };
        if (autoStop && stop) {
          note.autoStop = true;
          try {
            note.stop = await stop();
          } catch (error) {
            note.stopError = error.message || "stop failed";
            notes.push(note);
            fs.appendFileSync(notesPath, `${JSON.stringify(note)}\n`, { mode: 0o600 });
            throw error;
          }
        }
        notes.push(note);
        fs.appendFileSync(notesPath, `${JSON.stringify(note)}\n`, { mode: 0o600 });
        hot = 0;
      }
    }
    previous = frame.jpeg;
    if (!fast && index < count) await sleep(everySec * 1000);
  }
  return {
    ok: true,
    command: "lan-watch-first-layer",
    directory,
    frames: frames.length,
    files: frames,
    notes,
    autoStop: Boolean(autoStop),
    pin,
    verification: "UNVERIFIED",
    sources: [SOURCES.video, SOURCES.cameraStub],
  };
}
