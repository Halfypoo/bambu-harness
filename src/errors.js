export class HarnessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HarnessError";
    this.exitCode = options.exitCode ?? 1;
    this.code = options.code ?? "error";
    this.details = options.details ?? null;
  }
}

export function fail(message, options) {
  throw new HarnessError(message, options);
}
