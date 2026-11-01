#!/usr/bin/env node

import { parseArgs, timeoutMs, transferTimeoutMs } from "./args.js";
import { LIMITS } from "./allow.js";
import { dispatch } from "./dispatch.js";
import { HarnessError } from "./errors.js";
import { notedSecrets, redactText } from "./redact.js";

const HELP = `bambu — LAN harness for a Bambu Lab A1 mini

Usage: bambu <command> [options]

This tool talks to one printer on your local network. Enable LAN Only Mode and
Developer Mode on the printer. There is no cloud login.

Commands:
  slice      Slice an STL or 3MF for the A1 mini (local OrcaSlicer).
  lan        Talk to the printer over LAN. See subcommands below.

LAN setup:
  bambu lan configure --host <printer-ip> --serial <SERIAL>

Credentials (never argv, never logged):
  --access-code-file ~/.bambu-harness/access-code   # regular file, mode 0600
  BAMBU_ACCESS_CODE is also accepted but is visible in /proc; prefer the file.

LAN commands:
  bambu lan status --access-code-file FILE
  bambu lan ls [path] --access-code-file FILE
  bambu lan get <remote path> [--out file] [--timeout-sec N] --access-code-file FILE
  bambu lan snapshot --out frame.jpg --access-code-file FILE
  bambu lan upload FILE.gcode.3mf [--timeout-sec N] --access-code-file FILE
  bambu lan print FILE.gcode.3mf --yes [--timeout-sec N] --access-code-file FILE
  bambu lan print FILE.gcode.3mf --yes --force --access-code-file FILE
  bambu lan stop --yes --access-code-file FILE
  bambu lan diagnose --access-code-file FILE
  bambu lan calibrate bed-level|vibration|flow [--yes]
  bambu lan temperature nozzle|bed CELSIUS --yes
  bambu lan fan part PWM --yes
  bambu lan speed silent|standard|sport|ludicrous --yes
  bambu lan watch-first-layer --out DIR [--every 10] [--minutes 3] [--auto-stop --yes]

Options:
  --timeout N         MQTT command / print ack wait (1–120 seconds).
  --timeout-sec N     FTPS data-transfer overall max (1–7200 seconds; default 600).
                      Transfers also use a 20s idle timeout that resets on every chunk.

Notes:
  Remote FTPS names may contain spaces; quote them in the shell.
  lan print refuses a sliced first-layer bed target below ~50C (PLA) unless --force.
  Missing or unknown bed temperature is refused unless --force.
  --auto-stop requires --yes (it can stop a print).
  lan print may report an MQTT puback timeout even when the job started.
  If that happens, run lan status before retrying (do not double-start).
  First TLS use pins the printer certificate; later changes need --accept-new-pin.

Slice:
  bambu slice model.stl [--layer 0.2] [--infill 15] [--supports] [--filament PLA] [--out file.gcode.3mf]

Stdout is JSON. Add --text for one plain line. Errors are JSON on stderr.
`;

function emit(payload, text, asText) {
  if (asText) console.log(text);
  else console.log(JSON.stringify(payload));
}

function textStatus(payload) {
  const remain = payload.remainingMinutes == null ? "?" : `${payload.remainingMinutes}m`;
  return [
    payload.serial,
    payload.state ?? "?",
    `${payload.progress ?? "?"}%`,
    `layer ${payload.layer ?? "?"}/${payload.totalLayers ?? "?"}`,
    `nozzle ${payload.nozzle ?? "?"}/${payload.nozzleTarget ?? "?"}C`,
    `bed ${payload.bed ?? "?"}/${payload.bedTarget ?? "?"}C`,
    `remaining ${remain}`,
    `light ${payload.light ?? "?"}`,
    `firmware ${payload.firmware ?? "?"}`,
    `error ${payload.printError ?? 0}`,
  ].join(" ");
}

async function main() {
  const { positionals, options, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const command = positionals[0];
  const asText = flags.has("text");
  const timeout = timeoutMs(options.timeout, command === "lan" && positionals[1] === "print" ? LIMITS.printAckTimeoutMs : LIMITS.commandTimeoutMs);
  const transferTimeout = transferTimeoutMs(options["timeout-sec"], LIMITS.ftpsMaxTransferTimeoutMs);
  const result = await dispatch({ command, positionals, options, flags, timeout, transferTimeout });
  if (!result) {
    throw new HarnessError(`unknown command ${command}`, { exitCode: 4, code: "bad_args" });
  }
  const payload = result.payload;
  if (payload == null) return;
  const text = payload.command === "lan-status" || payload.command === "status" || payload.command === "watch"
    ? textStatus(payload)
    : `${payload.command}: ${payload.acknowledgement || (payload.ok ? "ok" : "failed")}`;
  emit(payload, text, asText);
}

main().catch((error) => {
  const secrets = [...notedSecrets()];
  if (process.env.BAMBU_ACCESS_CODE) secrets.push(process.env.BAMBU_ACCESS_CODE);
  const message = redactText(error.message || "failed", secrets);
  const payload = {
    ok: false,
    error: message,
    code: error.code || "error",
    ...(error.details ?? {}),
  };
  console.error(JSON.stringify(payload));
  process.exitCode = error.exitCode || 1;
});
