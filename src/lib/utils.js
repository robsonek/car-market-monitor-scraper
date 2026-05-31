import { createHash, randomUUID } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function randomId() {
  return randomUUID();
}

export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const NAMED_HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(text) {
  if (!text) {
    return "";
  }
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => NAMED_HTML_ENTITIES[name] ?? `&${name};`)
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

export function stripHtml(html) {
  if (!html) {
    return "";
  }
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function flattenForDiff(value, prefix = "", out = {}) {
  if (Array.isArray(value)) {
    out[prefix] = stableStringify(value);
    return out;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0 && prefix) {
      out[prefix] = "{}";
      return out;
    }
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      flattenForDiff(value[key], path, out);
    }
    return out;
  }

  out[prefix] = value === undefined || value === null ? null : String(value);
  return out;
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
