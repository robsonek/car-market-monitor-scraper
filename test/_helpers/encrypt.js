// Test-only counterpart to src/lib/marketplace-source-tokens.js. Produces tokens in the
// same `<ct_b64>.1.<iv_b64>` format the source frontend emits, so test
// fixtures and synthetic advert payloads can carry encrypted VIN/phone/etc.
// values that the production decryptToken() will round-trip back to the
// expected plaintext.
//
// Lives in test/_helpers/ (not src/lib/) because the production codebase has
// no need to encrypt — only decrypt — and exposing an encrypt path would be a
// footgun (encrypted-at-rest data should never originate inside this repo).

import { createHash, webcrypto } from "node:crypto";

const SALT_BYTES = new TextEncoder().encode("d2905222-d0c5-4ec5-bfcf-e9c29041de3c");
const PBKDF2_ITERATIONS = 10;

async function deriveKey(secret) {
  // Mirror of src/lib/marketplace-source-tokens.js getKey(). Kept inline (not imported)
  // because the production module only exports a `decrypt`-capable key, and we
  // need `encrypt` capability here.
  const passwordHex = createHash("sha256").update(secret).digest().subarray(0, 16).toString("hex");
  const passwordBytes = new TextEncoder().encode(passwordHex);
  const baseKey = await webcrypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT_BYTES, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToken(plaintext, secret) {
  const key = await deriveKey(secret);
  // 12-byte IV is the AES-GCM standard. Using a fixed IV here would be
  // catastrophic in production but is fine for fixtures: tokens are
  // deterministic across test runs, which keeps fixture diffs reviewable.
  const iv = new Uint8Array(12); // all zeros — deterministic
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const ctB64 = Buffer.from(ct).toString("base64");
  const ivB64 = Buffer.from(iv).toString("base64");
  return `${ctB64}.1.${ivB64}`;
}
