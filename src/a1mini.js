import { fail } from "./errors.js";

export const A1_MINI = {
  marketingName: "Bambu Lab A1 mini",
  modelCode: "N1",
  nozzleMm: 0.4,
  bedMm: 180,
  nozzleMaxC: 260,
  bedMaxC: 80,
  layerMinMm: 0.08,
  layerMaxMm: 0.28,
  partFanP: 1,
  fanPwmMax: 255,
};

export function isRfc1918(host) {
  const parts = String(host ?? "").split(".");
  if (parts.length !== 4) return false;
  const nums = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    nums.push(value);
  }
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function assertWholeNumber(value, label, min, max) {
  if (!/^-?\d+$/.test(String(value ?? ""))) {
    fail(`${label} must be a whole number`, { exitCode: 4, code: "bad_args" });
  }
  const number = Number(value);
  if (number < min || number > max) {
    fail(`${label} must be from ${min} to ${max}`, { exitCode: 4, code: "bad_args" });
  }
  return number;
}
