// Helper for tokenized detail fields returned by the source.

import { createHash, webcrypto } from "node:crypto";

// Module constants for the upstream token format.
const SALT_BYTES = new TextEncoder().encode("d2905222-d0c5-4ec5-bfcf-e9c29041de3c");
const PBKDF2_ITERATIONS = 10;

// Derived AES-GCM CryptoKey is deterministic per `secret`. Caching skips ~150ms
// of redundant PBKDF2 work per repeated decrypt on the same listing (one secret
// covers vin + registration + date_registration; another covers all phones).
const keyCache = new Map();

async function getKey(secret) {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const passwordHex = createHash("sha256").update(secret).digest().subarray(0, 16).toString("hex");
  const passwordBytes = new TextEncoder().encode(passwordHex);
  const baseKey = await webcrypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const aesKey = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT_BYTES, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  keyCache.set(secret, aesKey);
  return aesKey;
}

// Format check: "<base64>.<digit>.<base64>". Cheap pre-filter so we don't try
// to PBKDF2-derive a key for accidentally-pasted plaintext.
const TOKEN_RE = /^[A-Za-z0-9+/=]+\.\d+\.[A-Za-z0-9+/=]+$/;

export function looksLikeToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value);
}

// Decrypts one token. Returns plaintext on success, null on failure.
export async function decryptToken(token, secret) {
  if (!looksLikeToken(token) || !secret) return null;
  const parts = token.split(".");
  // Support the current upstream token version only.
  if (parts[1] !== "1") return null;
  try {
    const ct = Buffer.from(parts[0], "base64");
    const iv = Buffer.from(parts[2], "base64");
    const key = await getKey(secret);
    const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// Convenience: decrypt an array of tokens with the same secret. Preserves
// order AND positional alignment — uszkodzone wejścia zostają jako `null` w
// wyniku, żeby caller mógł robić `tokens[i] ↔ decrypted[i]` mapowanie. Dla
// konsumentów którym zależy tylko na liście numerów (phones_json, sorted
// arrays w payloadzie) przejście to zwykły `.filter((v) => v != null)` na
// call-site — kosztuje linijkę, ale eliminuje klasę błędów w której jeden
// zepsuty token podmienia wszystkie kolejne na zły numer.
export async function decryptTokens(tokens, secret) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  return Promise.all(tokens.map((t) => decryptToken(t, secret)));
}

// Test-only: lets unit tests reset state between cases.
export function _clearKeyCache() {
  keyCache.clear();
}
