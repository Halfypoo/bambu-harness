import { SOURCES } from "./sources.js";

const WIKI = {
  "0300010000010003": "The heatbed temperature is abnormal; the heater is over temperature.",
  "0300010000010006": "The heatbed temperature is abnormal; the sensor may have a short circuit.",
  "0300010000010007": "The heatbed temperature is abnormal; the sensor may have an open circuit.",
  "0300010000010008": "An abnormality occurs during the heating process of the heatbed; the heating modules may be broken.",
  "0300020000010001": "The nozzle temperature is abnormal; the heater may have a short circuit.",
  "0300020000010002": "The nozzle temperature is abnormal; the heater may have an open circuit.",
  "0300020000010003": "The nozzle temperature is abnormal; the heater is over temperature.",
  "0300030000010001": "The hotend cooling fan speed is too slow or stopped. It may be stuck or the connector may not be plugged in properly.",
  "0300040000020001": "The speed of the part cooling fan is too slow or stopped. It may be stuck, or the connector may not be plugged in properly.",
};

export function formatHmsCode(attr, code) {
  const a = attr >>> 0;
  const c = code >>> 0;
  if (a === 0 || c === 0) return "";
  const high = (value) => (Math.floor(value / 0x10000) & 0xffff).toString(16).padStart(4, "0");
  const low = (value) => (value & 0xffff).toString(16).padStart(4, "0");
  return `${high(a)}_${low(a)}_${high(c)}_${low(c)}`.toUpperCase();
}

export function decodeHmsEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return { code: null, text: null, raw: entry ?? null, wiki: SOURCES.hmsWiki };
  }
  const attr = Number(entry.attr);
  const code = Number(entry.code);
  if (!Number.isInteger(attr) || !Number.isInteger(code)) {
    return { code: null, text: null, raw: { attr: entry.attr ?? null, code: entry.code ?? null }, wiki: SOURCES.hmsWiki };
  }
  const formatted = formatHmsCode(attr, code);
  if (!formatted) return { code: null, text: null, raw: { attr, code }, wiki: SOURCES.hmsWiki };
  const key = formatted.replace(/_/g, "");
  const dashed = formatted.replace(/_/g, "-");
  return {
    code: dashed,
    text: WIKI[key] ?? null,
    wiki: SOURCES.hmsWiki,
    table: "local subset",
  };
}

export function decodeHmsList(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.slice(0, 40).map((entry) => decodeHmsEntry(entry));
}

export const HMS_SOURCES = [SOURCES.hmsWiki, SOURCES.hmsFormula, SOURCES.hmsStudio, SOURCES.mqtt];
