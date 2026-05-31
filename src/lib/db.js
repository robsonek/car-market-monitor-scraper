import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const DEFAULT_DB_PATH = join(REPO_ROOT, "db", "car-market-monitor.sqlite");

// Ścieżka do pliku bazy — eksportowana, bo helpery (pisanie manifestu,
// wywoływane z bin/) muszą odwoływać się do tego samego pliku co
// openDatabase. Obliczona raz na import, żeby nie ryzykować rozjazdu
// jeśli ktoś zmieni process.env.CAR_MARKET_MONITOR_DB_PATH w trakcie runa.
export const DB_PATH = process.env.CAR_MARKET_MONITOR_DB_PATH || DEFAULT_DB_PATH;

export function openDatabase(dbPath = DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applyMigrations(db);
  return db;
}

// Writes <dbPath>.version.json with a sha256 of the database file bytes.
// Must be called AFTER db.close() — better-sqlite3 checkpoints the WAL
// into the main file only at close, so running this earlier produces a
// sha that doesn't match what ends up in the git commit.
//
// No-op when the existing manifest already has the same sha. Without
// this check, `sources list` on an up-to-date db would still rewrite
// the file with a fresh `generated_at`, dirtying the worktree and
// generating noise commits. The manifest is only a cache key for the
// dashboard — as long as sha tracks the db bytes, the timestamp is
// just diagnostic metadata and doesn't need to advance on no-ops.
//
// Prefer closeDatabase() below over calling this directly: closeDatabase
// couples the manifest refresh to the close itself so it can never be
// accidentally skipped.
export function writeDbManifest(dbPath = DB_PATH) {
  const buf = readFileSync(dbPath);
  const sha = createHash("sha256").update(buf).digest("hex");
  const manifestPath = `${dbPath}.version.json`;

  // Skip the write if sha matches the existing manifest. readFileSync
  // + JSON.parse is cheap; we're optimizing for a clean worktree, not
  // throughput.
  try {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (existing.sha === sha) return existing;
  } catch {
    // Manifest missing or corrupt — fall through and write a fresh one.
  }

  const manifest = {
    sha,
    size: buf.length,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// The ONLY supported way to close a database opened via openDatabase().
// Guarantees the manifest gets refreshed whenever the file on disk may
// have changed — which, critically, includes "read-only" paths, because
// openDatabase() always runs applyMigrations() and that can bump
// user_version / ALTER TABLE on an older db. Before this helper existed,
// `bin/sources.js list` on a pre-migration db would silently upgrade
// the schema without touching the manifest, and the dashboard kept
// serving the stale HTTP-cached copy.
//
// Writes manifest unconditionally — the cost (one sha256 of the file)
// is negligible compared to the risk of forgetting it somewhere.
export function closeDatabase(db, dbPath = DB_PATH) {
  // In WAL mode writes may still live only in <db>.sqlite-wal even after the
  // last statement finishes. Checkpoint before close so git/manifest always
  // reflect the real latest state of the tracked main db file.
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  writeDbManifest(dbPath);
}

function applyMigrations(db) {
  // Migration tracking via SQLite's built-in PRAGMA user_version. Each .sql
  // file in /migrations corresponds to one schema version (1-indexed by
  // lexical sort order). On open we apply only the files whose target version
  // is greater than the current user_version, then bump it. This lets us mix
  // CREATE TABLE IF NOT EXISTS migrations (idempotent) with ALTER TABLE
  // migrations (NOT idempotent in SQLite — no IF NOT EXISTS for ADD COLUMN).
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const currentVersion = db.pragma("user_version", { simple: true });

  // Guard: legacy database that has seen more migration files than currently
  // exist in the repo. Zdarza się gdy spłaszczamy historię migracji i
  // publikujemy nowy model "wyczyść plik i puść scrape od zera" — stara
  // baza ma user_version=N (N>1), nowy repo ma pojedynczy plik 0001_init.sql
  // (files.length=1), więc domyślny kod BYŁBY no-opem i zostawiłby schemę
  // w starym kształcie. Następny INSERT od razu eksplodowałby na NOT NULL
  // constraint albo "column does not exist", w momencie w którym jesteśmy
  // już w środku scrape'a. Wolimy fail-fast przy otwarciu.
  if (currentVersion > files.length) {
    throw new Error(
      `Database at this path was created against a newer or incompatible ` +
      `migration history (user_version=${currentVersion}, but the repo only ` +
      `has ${files.length} migration file${files.length === 1 ? "" : "s"}). ` +
      `The schema was flattened and legacy databases cannot be upgraded ` +
      `in-place. Delete the database file and its -wal/-shm/.version.json ` +
      `siblings, then re-run the scrape to rebuild from scratch.`,
    );
  }

  files.forEach((file, idx) => {
    const targetVersion = idx + 1;
    if (currentVersion >= targetVersion) return;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${targetVersion}`);
    });
    tx();
  });

  // Schema fingerprint guard. Pre-check na user_version łapie „baza widziała
  // więcej migracji niż dziś istnieje", ale zostaje jeszcze klasa stanów
  // w których user_version wygląda OK, a schema pod spodem jest stara —
  // np. ktoś ręcznie dotknął PRAGMA, migracja padła w połowie, albo
  // zewnętrzne narzędzie obcięło tabelę. Sprawdzamy kilka kolumn których
  // obecność/brak jest podpisem bieżącej wersji schematu.
  //
  // Brak tabeli listing_snapshots to też błąd — fresh apply ZAWSZE ją
  // tworzy, więc nieobecność sygnalizuje niekompletny lub ręcznie zepsuty
  // stan, a nie "nowa baza". Wolimy tu failnąć niż pozwolić scrape'owi
  // wywrócić się dopiero na pierwszym INSERT.
  const snapshotInfo = db.prepare("PRAGMA table_info(listing_snapshots)").all();
  if (snapshotInfo.length === 0) {
    throw new Error(
      `Database is missing the listing_snapshots table after migration. ` +
      `This means either the migration file did not run (check file ` +
      `permissions on ${MIGRATIONS_DIR}) or the database was partially ` +
      `mutated after apply. Delete the database file and re-scrape.`,
    );
  }
  const names = new Set(snapshotInfo.map((r) => r.name));
  const mustExist = ["payload_json"];
  const mustNotExist = ["description_text", "field_map_json"];
  const missing = mustExist.filter((c) => !names.has(c));
  const legacy = mustNotExist.filter((c) => names.has(c));
  if (missing.length > 0 || legacy.length > 0) {
    throw new Error(
      `Database schema does not match the expected shape after migration. ` +
      `listing_snapshots is missing [${missing.join(", ") || "none"}] and ` +
      `still has legacy columns [${legacy.join(", ") || "none"}]. This ` +
      `usually means the file was created against an older migration ` +
      `history. Delete the database file and re-scrape.`,
    );
  }
}
