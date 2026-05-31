// Smoke-testy bin/prune-snapshot-payloads.js (rekomendacja z audytu H4).
//
// Regresja, której pilnujemy: tryb domyślny (--archive) budował linię manifestu
// z `payload_bytes: bytes`, gdzie `bytes` nie było zadeklarowane → ReferenceError
// w Phase 1, przed jakimkolwiek zapisem. CI używa wyłącznie --no-archive, więc
// bug nigdy nie ujawniał się w produkcji, a jedyny "bezpieczny" tryb był martwy.
//
// Test uruchamia REALNY skrypt jako subprocess (nie importuje main()), żeby objąć
// też `process.exit(main())` i ścieżkę env. Bazę i archiwum kierujemy do tmpdir
// przez CAR_MARKET_MONITOR_DB_PATH / CAR_MARKET_MONITOR_ARCHIVE_DIR, więc nic nie
// dotyka repo ani kanonicznej bazy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase, closeDatabase } from "../../src/lib/db.js";
import {
  createDriver,
  detailRoute,
  listingRoute,
  singleCardListingHtml,
} from "../_helpers/run-driver.js";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "prune-snapshot-payloads.js",
);

// Drives one real runSource pass (listing → detail → snapshot with a full
// payload), then detaches every snapshot from its listing so it counts as a
// historical prune candidate. Returns the closed db path + candidate ids.
async function seedDetachedSnapshots() {
  const d = createDriver();
  await d.runOnce({ ...listingRoute(singleCardListingHtml()), ...detailRoute() });
  // last_snapshot_id = NULL → snapshot przestaje być "bieżący", więc trafia w
  // selekcję kandydatów prune (NOT EXISTS l2.last_snapshot_id = s.id).
  d.db.prepare("UPDATE listings SET last_snapshot_id = NULL").run();
  const candIds = d.db
    .prepare("SELECT id FROM listing_snapshots WHERE LENGTH(payload_json) > 100")
    .all()
    .map((r) => r.id);
  closeDatabase(d.db, d.dbPath); // checkpoint WAL zanim subprocess weźmie exclusive lock na VACUUM
  return { dbPath: d.dbPath, workDir: dirname(d.dbPath), candIds };
}

function runPrune(dbPath, archiveDir, extraArgs = []) {
  return execFileSync("node", [SCRIPT, ...extraArgs], {
    env: {
      ...process.env,
      CAR_MARKET_MONITOR_DB_PATH: dbPath,
      CAR_MARKET_MONITOR_ARCHIVE_DIR: archiveDir,
    },
    stdio: "pipe",
    encoding: "utf8",
  });
}

test("prune --archive: archiwizuje payload, zapisuje payload_bytes jako liczbę, stubuje DB (regresja H4)", async () => {
  const { dbPath, workDir, candIds } = await seedDetachedSnapshots();
  try {
    assert.ok(candIds.length >= 1, "setup: oczekiwano min. 1 snapshotu z payload>100");
    const archiveDir = join(workDir, "archive");

    // Przed fixem ten call rzuciłby (subprocess exit≠0 → execFileSync throws).
    runPrune(dbPath, archiveDir);

    const lines = readFileSync(join(archiveDir, "raw-manifest.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, candIds.length, "liczba wpisów manifestu != liczba kandydatów");

    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.ok(candIds.includes(entry.snapshot_id), `nieoczekiwany snapshot w manifeście: ${entry.snapshot_id}`);
      // Sedno H4: payload_bytes musi być liczbą (>0), nie undefined/null.
      assert.equal(typeof entry.payload_bytes, "number", "payload_bytes nie jest liczbą");
      assert.ok(entry.payload_bytes > 0, "payload_bytes <= 0");
      assert.ok(existsSync(join(archiveDir, entry.payload_path)), `brak pliku payloadu: ${entry.payload_path}`);
    }

    // Phase 2: snapshoty zestubowane do "{}".
    const db = openDatabase(dbPath);
    try {
      for (const id of candIds) {
        const row = db.prepare("SELECT payload_json FROM listing_snapshots WHERE id = ?").get(id);
        assert.equal(row.payload_json, "{}", `snapshot ${id} nie został zestubowany`);
      }
    } finally {
      closeDatabase(db, dbPath);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("prune --no-archive (ścieżka CI): stubuje DB i NIE tworzy archiwum", async () => {
  const { dbPath, workDir, candIds } = await seedDetachedSnapshots();
  try {
    assert.ok(candIds.length >= 1, "setup: oczekiwano min. 1 kandydata");
    const archiveDir = join(workDir, "archive");

    runPrune(dbPath, archiveDir, ["--no-archive"]);

    assert.equal(existsSync(archiveDir), false, "--no-archive nie powinien tworzyć katalogu archiwum");

    const db = openDatabase(dbPath);
    try {
      for (const id of candIds) {
        const row = db.prepare("SELECT payload_json FROM listing_snapshots WHERE id = ?").get(id);
        assert.equal(row.payload_json, "{}", `snapshot ${id} nie został zestubowany`);
      }
    } finally {
      closeDatabase(db, dbPath);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
