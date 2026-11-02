export const LIMITS = {
  max3mfBytes: 100 * 1024 * 1024,
  maxZipEntryBytes: 4 * 1024 * 1024,
  /**
   * Unpacked plate gcode stream ceiling for preflight / plate tooling.
   * Large multi-copy plates can exceed max3mfBytes when inflated; we still stream-check them.
   */
  maxPlateGcodeBytes: 1024 * 1024 * 1024,
  commandTimeoutMs: 8_000,
  printAckTimeoutMs: 20_000,
  watchMinIntervalSec: 15,
  watchDefaultIntervalSec: 60,
  /** No FTPS data for this long → fail (resets on every chunk). */
  ftpsIdleTimeoutMs: 20_000,
  /** Hard ceiling for one FTPS data transfer (overridable with --timeout-sec). */
  ftpsMaxTransferTimeoutMs: 600_000,
};

export function normalizeHost(hostname) {
  return String(hostname || "").replace(/\.+$/, "").toLowerCase();
}

export function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function testModeEnabled() {
  return process.env.BAMBU_HARNESS_TEST === "1";
}
