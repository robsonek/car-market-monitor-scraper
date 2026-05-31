// Tests for computeSnapshotHash. Two regression classes covered:
//
// 1. Determinism under key permutation. flattenForDiff produces an object,
//    and JSON.stringify of an object is sensitive to key insertion order. If
//    a future refactor inadvertently builds the field map with a different
//    iteration order, the hash will silently flip every run and we'll see
//    `changed=N, listing_changes=0` in production. stableStringify is the
//    backstop — this test ensures it stays the backstop.
//
// 2. Noisy-field filtering. Rotating ciphertexts (vin/registration tokens,
//    description_html with inline phone spans) MUST NOT influence the hash.
//    This is the same regression class that motivated commit history around
//    NOISY_FIELD_PREFIXES.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeSnapshotHash, NOISY_FIELD_PREFIXES } from "../../src/lib/scrape.js";

test("computeSnapshotHash is stable when field_map keys are inserted in different order", () => {
  const a = {
    field_map: {
      "title": "Porsche Taycan",
      "price.value": "300000",
      "decrypted.vin": "WAUZZZ00000000001",
      "images.count": "12",
    },
  };
  // Same logical content, opposite key insertion order
  const b = {
    field_map: {
      "images.count": "12",
      "decrypted.vin": "WAUZZZ00000000001",
      "price.value": "300000",
      "title": "Porsche Taycan",
    },
  };
  assert.equal(computeSnapshotHash(a), computeSnapshotHash(b));
});

test("computeSnapshotHash ignores all noisy field prefixes", () => {
  const base = {
    field_map: {
      "title": "Porsche Taycan",
      "price.value": "300000",
    },
  };
  // For each noisy prefix, build a field_map that adds a child key under it.
  // The hash MUST equal the base hash — otherwise rotating ciphertext on
  // every render produces fresh hashes and applyDetail flips the listing
  // through the "hash changed" branch with zero diff rows.
  const baseHash = computeSnapshotHash(base);
  for (const prefix of NOISY_FIELD_PREFIXES) {
    const dirty = {
      field_map: {
        ...base.field_map,
        [`${prefix}.0.value`]: "rotating-ciphertext-blob",
        [prefix]: "another-rotating-blob",
      },
    };
    assert.equal(
      computeSnapshotHash(dirty),
      baseHash,
      `noisy prefix "${prefix}" leaked into hash`,
    );
  }
});

test("computeSnapshotHash changes when a non-noisy field changes", () => {
  const a = { field_map: { "title": "Porsche Taycan", "price.value": "300000" } };
  const b = { field_map: { "title": "Porsche Taycan", "price.value": "290000" } };
  assert.notEqual(computeSnapshotHash(a), computeSnapshotHash(b));
});

test("computeSnapshotHash handles empty field_map without crashing", () => {
  const empty1 = computeSnapshotHash({ field_map: {} });
  const empty2 = computeSnapshotHash({ field_map: {} });
  assert.equal(empty1, empty2);
  // Sanity: empty hash differs from any non-empty hash
  assert.notEqual(empty1, computeSnapshotHash({ field_map: { x: "1" } }));
});
