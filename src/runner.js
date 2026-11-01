import { LIMITS, testModeEnabled } from "./allow.js";
import {
  activePrintState,
  commandResult,
  extractStatus,
  mergeReport,
  pushallBody,
  reportTopic,
  requestTopic,
  versionBody,
} from "./printer.js";
import { HarnessError } from "./errors.js";
import { MqttSession } from "./mqtt.js";
import { noteSecret, redactText } from "./redact.js";
import { lanPort, loadLanConfig, readAccessCode } from "./lan-config.js";

export async function openLanMqtt(options, flags) {
  const config = loadLanConfig();
  const accessCode = readAccessCode(options);
  noteSecret(accessCode);
  const port = lanPort("mqtt");
  const target = {
    host: config.host,
    port,
    tls: !testModeEnabled(),
  };
  if (target.tls) {
    target.tlsOptions = { rejectUnauthorized: false, servername: false };
    target.assertPeer = async (socket) => {
      const { fingerprintOf, rememberPin, savePin } = await import("./lan-tls.js");
      const fingerprint = fingerprintOf(socket);
      const state = rememberPin(config.host, port, fingerprint);
      if (state.previous && state.previous !== fingerprint && !flags.has("accept-new-pin")) {
        throw new HarnessError(
          `UNVERIFIED TLS certificate changed for ${state.key}. Stored sha256 ${state.previous}. Peer presented ${fingerprint}. The access code was not sent. Pass --accept-new-pin only after you have checked the printer.`,
          { exitCode: 4, code: "cert_changed", details: { fingerprint, previous: state.previous, verification: "UNVERIFIED" } },
        );
      }
      if (!state.previous || state.previous !== fingerprint) savePin(state, fingerprint);
      target.pin = state.previous ? (state.previous === fingerprint ? "match" : "replaced") : "first-use";
      target.fingerprint = fingerprint;
    };
  }
  try {
    const mqtt = await MqttSession.connect(target, {
      username: "bblp",
      password: accessCode,
      keepalive: 30,
    });
    mqtt.lanPin = target.pin ?? (target.tls ? "match" : "test-plaintext");
    return { mqtt, config, accessCode };
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const message = redactText(error.message || "LAN MQTT failed", [accessCode]);
    throw new HarnessError(message, { code: error.code || "mqtt" });
  }
}

export async function acknowledged({ mqtt, serial, topicBody, sequenceId, command, timeout, what }) {
  try {
    await mqtt.subscribe(reportTopic(serial), 1);
    try {
      await mqtt.publish(requestTopic(serial), JSON.stringify(topicBody), 1);
    } catch (error) {
      if (/timed out waiting for MQTT puback/i.test(error.message || "")) {
        throw Object.assign(
          new Error(
            `MQTT puback timed out for ${what || command}. The printer may still have accepted the command. Run lan status before retrying.`,
          ),
          { code: "puback_timeout" },
        );
      }
      throw error;
    }
    const message = await mqtt.waitFor((item) => commandResult(item, sequenceId, command), timeout);
    const result = commandResult(message, sequenceId, command);
    if (!result?.ok) {
      throw new HarnessError(
        `Printer rejected ${command}${result?.reason ? `: ${result.reason}` : ""}.`,
        { exitCode: 3, code: "rejected", details: { result: result?.result ?? null, errCode: result?.errCode ?? null, verification: "UNVERIFIED" } },
      );
    }
    return { acknowledgement: "acknowledged", result: result.result || "success" };
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    if (error.code === "puback_timeout") {
      throw new HarnessError(error.message, {
        exitCode: 3,
        code: "puback_timeout",
        details: { serial, doNotRetry: true, verification: "UNVERIFIED" },
      });
    }
    if (error.code === "not_acknowledged" || /timed out waiting for printer report/.test(error.message || "")) {
      throw new HarnessError(
        `Not acknowledged. The MQTT publish for ${what || command} got no matching report. Broker acceptance is not printer acknowledgement. Check the printer screen and run lan status before retrying.`,
        { exitCode: 3, code: "not_acknowledged", details: { serial, verification: "UNVERIFIED" } },
      );
    }
    throw error;
  }
}

export async function acknowledgedPrint({ mqtt, serial, topicBody, sequenceId, timeout }) {
  try {
    return await acknowledged({
      mqtt,
      serial,
      topicBody,
      sequenceId,
      command: "project_file",
      timeout,
      what: "lan print",
    });
  } catch (error) {
    if (!(error instanceof HarnessError) || (error.code !== "puback_timeout" && error.code !== "not_acknowledged")) {
      throw error;
    }
    let status = null;
    try {
      const snap = await readSnapshot(mqtt, serial, Math.min(timeout, LIMITS.commandTimeoutMs));
      status = extractStatus(snap.merged, snap.version, null);
    } catch {
      status = null;
    }
    if (status && activePrintState(status.state)) {
      return {
        acknowledgement: "puback_timeout_job_started",
        result: "assumed_started",
        pubackTimedOut: true,
        verifiedViaStatus: true,
        status,
        doNotRetry: true,
        note: "MQTT puback timed out, but lan status shows the printer is no longer idle. The job likely started. Do not retry the same file until you confirm the printer is idle.",
      };
    }
    error.details = {
      ...(error.details ?? {}),
      doNotRetry: true,
      verifiedViaStatus: Boolean(status),
      status,
      note: "MQTT puback or printer report timed out. The print may still have started. Run lan status before retrying.",
    };
    throw error;
  }
}

export async function readSnapshot(mqtt, serial, timeout) {
  const merged = {};
  let version = null;
  await mqtt.subscribe(reportTopic(serial), 1);
  mqtt.on("message", (item) => {
    mergeReport(merged, item);
    if (item.json?.info?.command === "get_version") version = item.json;
  });
  await mqtt.publish(requestTopic(serial), JSON.stringify(pushallBody()), 0);
  await mqtt.publish(requestTopic(serial), JSON.stringify(versionBody()), 0);
  await mqtt.waitFor(() => Boolean(merged.print?.gcode_state), timeout);
  return { merged, version };
}

export function commandTimeout(timeout) {
  return timeout || LIMITS.commandTimeoutMs;
}
