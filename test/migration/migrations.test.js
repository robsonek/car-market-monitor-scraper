// Migration tests. Schema żyje w pojedynczym pliku 0001_init.sql — nie mamy
// już historii ALTER TABLE, bo przyjęliśmy model "wyczyść bazę i puść scrape"
// zamiast wspierać upgrade'y in-place. Te testy weryfikują jedynie że świeża
// baza wstaje z oczekiwanym kształtem schematu i że manifest sha-file działa.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { openDatabase, closeDatabase, writeDbManifest } from "../../src/lib/db.js";

let workDir;
let dbPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "market-mig-"));
  dbPath = join(workDir, "test.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fileSha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function listIndexes(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((r) => r.name);
}

test("openDatabase on a fresh file applies the schema and bumps user_version", () => {
  const db = openDatabase(dbPath);
  try {
    const version = db.pragma("user_version", { simple: true });
    // 1 .sql file in /migrations → user_version = 1
    assert.equal(version, 1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const required of ["sources", "scrape_runs", "listings", "listing_snapshots", "listing_changes"]) {
      assert.ok(tables.includes(required), `missing table ${required}`);
    }

    // scrape_runs should carry batch_id (used by run grouping in the UI).
    assert.ok(listColumns(db, "scrape_runs").includes("batch_id"));

    const listingIndexes = listIndexes(db, "listings");
    assert.ok(
      listingIndexes.some((n) => n.includes("idx_listings_source_active")),
      "missing idx_listings_source_active",
    );

    // Condition / decrypt-redesign columns must all exist.
    const listingCols = listColumns(db, "listings");
    for (const col of ["damaged", "no_accident", "country_origin", "new_used",
                       "vin", "registration", "date_registration", "phones_json",
                       "image_count", "seller_uuid"]) {
      assert.ok(listingCols.includes(col), `listings missing column: ${col}`);
    }
    // description_text on listings is the "one format" refactor — ensure the
    // old denormalization column did not sneak back into the schema.
    assert.equal(listingCols.includes("description_text"), false, "listings.description_text should not exist");

    // listing_snapshots: opis żyje wyłącznie w payload_json.description_html,
    // więc ani description_text, ani legacy field_map_json nie powinny
    // istnieć jako osobne kolumny.
    const snapCols = listColumns(db, "listing_snapshots");
    assert.ok(snapCols.includes("payload_json"), "listing_snapshots missing payload_json");
    assert.equal(snapCols.includes("description_text"), false, "listing_snapshots.description_text should not exist");
    assert.equal(snapCols.includes("field_map_json"), false, "listing_snapshots.field_map_json should not exist");
  } finally {
    closeDatabase(db, dbPath);
  }
});

test("re-opening an already-migrated db is a no-op (idempotent)", () => {
  const db1 = openDatabase(dbPath);
  const v1 = db1.pragma("user_version", { simple: true });
  closeDatabase(db1, dbPath);

  const db2 = openDatabase(dbPath);
  const v2 = db2.pragma("user_version", { simple: true });
  closeDatabase(db2, dbPath);

  assert.equal(v2, v1, "user_version drifted on re-open");

  // After the second close, subsequent no-op opens must not touch bytes.
  const shaAfterSecondClose = fileSha(dbPath);
  const db3 = openDatabase(dbPath);
  closeDatabase(db3, dbPath);
  const shaAfterThirdClose = fileSha(dbPath);
  assert.equal(
    shaAfterThirdClose,
    shaAfterSecondClose,
    "no-op re-open changed db file bytes",
  );
});

test("closeDatabase writes a manifest whose sha matches the on-disk db file", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);

  const manifest = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8"));
  const actualSha = fileSha(dbPath);

  assert.equal(manifest.sha, actualSha, "manifest sha != db file sha");
  assert.equal(manifest.size, readFileSync(dbPath).length);
  assert.ok(manifest.generated_at, "manifest missing generated_at");
});

test("writeDbManifest is a no-op when sha is unchanged (does not rotate the file)", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);

  const before = readFileSync(`${dbPath}.version.json`, "utf8");
  const result = writeDbManifest(dbPath);
  const after = readFileSync(`${dbPath}.version.json`, "utf8");

  assert.equal(after, before, "writeDbManifest rewrote unchanged file");
  assert.equal(result.sha, JSON.parse(before).sha);
});

test("writeDbManifest rewrites when the underlying db sha changes", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);
  const beforeSha = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8")).sha;

  const db2 = openDatabase(dbPath);
  db2
    .prepare("INSERT INTO sources (id, site, name, url, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("test-id", "OTOMOTO", "test", "https://www.otomoto.pl/osobowe/test", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  closeDatabase(db2, dbPath);

  const afterSha = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8")).sha;
  assert.notEqual(afterSha, beforeSha, "manifest sha did not advance after data write");
  const walPath = `${dbPath}-wal`;
  assert.equal(existsSync(walPath) ? statSync(walPath).size : 0, 0, "closeDatabase left uncheckpointed WAL bytes");
});

test("openDatabase fails fast on a legacy db with user_version ahead of current schema", () => {
  // Symulujemy bazę po starszej (pre-flatten) historii migracji: user_version
  // ustawiony na liczbę większą niż aktualna liczba plików .sql w /migrations.
  // Naiwny applyMigrations nic by nie zrobił (bo currentVersion >= każdego
  // targetVersion), a scrape.js wywróciłby się dopiero przy pierwszym INSERT
  // na listing_snapshots z powodu brakującej kolumny payload_json albo
  // obecnej legacy description_text. Guard w db.js wywraca przy OPEN, żeby
  // błąd pojawił się natychmiast.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY);
    CREATE TABLE listing_snapshots (
      id TEXT PRIMARY KEY,
      description_text TEXT,
      payload_json TEXT NOT NULL,
      field_map_json TEXT NOT NULL
    );
  `);
  seed.pragma("user_version = 7");
  seed.close();

  assert.throws(
    () => openDatabase(dbPath),
    /user_version=7.*migration file|Delete the database file/i,
  );
});

test("openDatabase fails fast when listing_snapshots table is entirely missing", () => {
  // Ktoś ręcznie obciął listing_snapshots (np. DROP TABLE) ale zostawił
  // user_version na aktualnej wartości. Poprzednia iteracja guarda traktowała
  // brak tabeli jako "fresh db, skip check" i milcząco wracała — scrape
  // wywalał się potem na pierwszym INSERT. Teraz post-check wymaga aby
  // tabela istniała po applyMigrations.
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY);`);
  seed.pragma("user_version = 1");
  seed.close();

  assert.throws(
    () => openDatabase(dbPath),
    /missing the listing_snapshots table/i,
  );
});

test("openDatabase fails fast on a db with matching user_version but legacy schema columns", () => {
  // Bardziej podstępny wariant: ktoś z zewnątrz ręcznie obciął user_version
  // do 1 (albo uruchamiał narzędzie które to zrobiło), ale schema pod spodem
  // jest stara. Drugi guard — schema fingerprint — musi ten przypadek
  // wykryć niezależnie od user_version.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY);
    CREATE TABLE listing_snapshots (
      id TEXT PRIMARY KEY,
      description_text TEXT,
      payload_json TEXT NOT NULL,
      field_map_json TEXT NOT NULL
    );
  `);
  seed.pragma("user_version = 1");
  seed.close();

  assert.throws(
    () => openDatabase(dbPath),
    /schema does not match|legacy columns/i,
  );
});

test("openDatabase regenerates a missing manifest after closeDatabase", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);

  rmSync(`${dbPath}.version.json`);
  const db2 = openDatabase(dbPath);
  closeDatabase(db2, dbPath);

  const manifest = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8"));
  assert.equal(manifest.sha, fileSha(dbPath));
});
