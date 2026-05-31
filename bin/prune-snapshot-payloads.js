#!/usr/bin/env node
// Archives payload_json for historical snapshots (= those that are NOT the
// current last_snapshot_id of their listing) into
// local-payload-archive/raw-payloads/<source_id>/YYYY/MM/<snap_id>.json,
// appends manifest lines to raw-manifest.jsonl, and replaces the in-DB
// payload with "{}" to honor the schema's NOT NULL constraint while
// reclaiming space. VACUUMs at the end.
//
// Idempotent: skips snapshots whose payload is already a stub (LENGTH < 100)
// and dedupes manifest writes by snapshot_id, so re-running on top of a
// previous prune just no-ops.
//
// Usage:
//   node bin/prune-snapshot-payloads.js                # prune + archive
//   node bin/prune-snapshot-payloads.js --no-archive  # prune + VACUUM, skip archive
//   node bin/prune-snapshot-payloads.js --dry-run     # report only

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase, DB_PATH } from "../src/lib/db.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
// Archiwum domyślnie w repo; nadpisywalne przez env, żeby testy (i ewentualny
// alternatywny storage) mogły kierować zapis poza drzewo repo.
const ARCHIVE_DIR =
  process.env.CAR_MARKET_MONITOR_ARCHIVE_DIR ||
  join(REPO_ROOT, "local-payload-archive");
const PAYLOAD_DIR = join(ARCHIVE_DIR, "raw-payloads");
const MANIFEST_PATH = join(ARCHIVE_DIR, "raw-manifest.jsonl");
// Schema declares payload_json NOT NULL (see migration 0001_init), so we
// can't NULL it out. "{}" matches the stub value used by the prior prune
// (Apr 25 2026), keeping the column shape consistent across history.
const STUB_PAYLOAD = "{}";

function loadArchivedIds() {
  if (!existsSync(MANIFEST_PATH)) return new Set();
  const ids = new Set();
  const text = readFileSync(MANIFEST_PATH, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const id = JSON.parse(line).snapshot_id;
      if (id) ids.add(id);
    } catch {
      // Tolerate the occasional malformed line — the manifest is append-only,
      // and a bad row from a crashed earlier run shouldn't block today's prune.
    }
  }
  return ids;
}

// Forward-slash path that goes into the manifest (matches prior entries
// regardless of OS — manifest must stay portable across darwin/linux CI).
function buildPayloadPath(sourceId, capturedAt, snapshotId) {
  const date = new Date(capturedAt);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `raw-payloads/${sourceId}/${yyyy}/${mm}/${snapshotId}.json`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const noArchive = args.includes("--no-archive");

  if (!noArchive) mkdirSync(PAYLOAD_DIR, { recursive: true });

  const db = openDatabase();
  const archivedIds = noArchive ? new Set() : loadArchivedIds();

  // LENGTH(payload_json) > 100 filters out anything already stubbed without
  // assuming the exact stub bytes — works whether the prior prune wrote "{}",
  // "" (empty), or any other tiny placeholder.
  const candidates = db.prepare(`
    SELECT s.id, s.listing_id, s.run_id, s.captured_at, s.payload_json,
           l.source_id
    FROM listing_snapshots s
    JOIN listings l ON l.id = s.listing_id
    WHERE LENGTH(s.payload_json) > 100
      AND NOT EXISTS (
        SELECT 1 FROM listings l2 WHERE l2.last_snapshot_id = s.id
      )
  `).all();

  console.log(`Snapshoty kandydujące do prune: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log("Nic do roboty.");
    closeDatabase(db);
    return 0;
  }

  let bytesArchived = 0;
  let filesWritten = 0;
  let manifestAppended = 0;

  // Phase 1: write payloads to disk + append manifest. Doing this BEFORE the
  // DB stub-update means a crash between phases just leaves an extra file on
  // disk + manifest line - safe to re-run. Reverse order would lose data on
  // crash (DB stubbed but archive not flushed yet).
  // With --no-archive, skip this phase entirely - just count bytes for reporting.
  for (const row of candidates) {
    const payloadBytes = Buffer.byteLength(row.payload_json);
    bytesArchived += payloadBytes;

    if (dryRun || noArchive) continue;

    const relPath = buildPayloadPath(row.source_id, row.captured_at, row.id);
    const absPath = join(ARCHIVE_DIR, relPath);
    const sha = createHash("sha256").update(row.payload_json).digest("hex");

    let needsWrite = true;
    if (existsSync(absPath)) {
      const existing = readFileSync(absPath, "utf8");
      const existingSha = createHash("sha256").update(existing).digest("hex");
      if (existingSha === sha) {
        needsWrite = false;
      } else {
        throw new Error(
          `Archive collision for snapshot ${row.id}: ${absPath} exists with ` +
          `different sha256 than current DB payload. Refusing to overwrite.`,
        );
      }
    }

    if (needsWrite) {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, row.payload_json);
      filesWritten += 1;
    }

    if (!archivedIds.has(row.id)) {
      const line = JSON.stringify({
        snapshot_id: row.id,
        listing_id: row.listing_id,
        run_id: row.run_id,
        source_id: row.source_id,
        captured_at: row.captured_at,
        payload_path: relPath,
        payload_sha256: sha,
        payload_bytes: payloadBytes,
      });
      appendFileSync(MANIFEST_PATH, line + "\n");
      archivedIds.add(row.id);
      manifestAppended += 1;
    }
  }

  // Phase 2: stub DB rows in a single transaction.
  let stubbed = 0;
  if (!dryRun) {
    const updateStmt = db.prepare(
      "UPDATE listing_snapshots SET payload_json = ? WHERE id = ?",
    );
    const tx = db.transaction((rows) => {
      for (const r of rows) updateStmt.run(STUB_PAYLOAD, r.id);
    });
    tx(candidates);
    stubbed = candidates.length;
  }

  const archivedMb = (bytesArchived / 1024 / 1024).toFixed(1);
  console.log(
    `${dryRun ? "[dry-run] " : ""}` +
    `archived: ${candidates.length} snapshotów (${archivedMb} MB w plikach), ` +
    `pliki nowo zapisane: ${filesWritten}, manifest nowych linii: ${manifestAppended}, ` +
    `DB stubbed: ${stubbed}`,
  );

  if (!dryRun) {
    console.log("VACUUM...");
    db.exec("VACUUM");
  }

  closeDatabase(db);
  if (!dryRun) {
    console.log(`DB: ${DB_PATH}`);
  }
  return 0;
}

process.exit(main());
