const SECRET_KEY = /token|password|passwd|secret|access_code|accesscode|authkey|ttcode|credential/i;

const noted = new Set();

export function noteSecret(value) {
  if (typeof value === "string" && value.length >= 4) noted.add(value);
}

export function notedSecrets() {
  return [...noted];
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const SIGNED_QUERY =
  /([?&](?:Signature|AWSAccessKeyId|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|security-token)=)[^&\s"']+/gi;

export function redactText(text, secrets = []) {
  let out = String(text ?? "");
  const unique = [...new Set([...secrets, ...noted].filter((s) => typeof s === "string" && s.length >= 4))];
  unique.sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(BEARER, "Bearer [redacted]");
  out = out.replace(JWT, "[redacted]");
  out = out.replace(SIGNED_QUERY, "$1[redacted]");
  return out;
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = url.search ? "?[redacted]" : "";
    return url.toString();
  } catch {
    return "[unparsed-url]";
  }
}

export function sanitizeValue(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) out[key] = "[redacted]";
      else out[key] = sanitizeValue(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactText(value).slice(0, 500);
  return value;
}

export function safeJsonSnippet(text, secrets = []) {
  const raw = String(text ?? "").slice(0, 4000);
  try {
    return JSON.stringify(sanitizeValue(JSON.parse(raw)));
  } catch {
    return redactText(raw, secrets).slice(0, 500);
  }
}
