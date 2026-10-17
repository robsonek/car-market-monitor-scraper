// Testy bin/compress-db.js — wersji bazy skompresowanej brotli, którą dashboard
// (car-market-monitor-web) pobiera przez proxy z Content-Encoding: br zamiast
// surowego pliku. Skrypt odpalamy jako subprocess (jak prune-snapshot-payloads),
// a bazę kierujemy do tmpdir przez CAR_MARKET_MONITOR_DB_PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

import { closeDatabase, openDatabase } from "../../src/lib/db.js";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "compress-db.js",
);

function runCompress(dbPath) {
  return execFileSync("node", [SCRIPT], {
    env: { ...process.env, CAR_MARKET_MONITOR_DB_PATH: dbPath },
    stdio: "pipe",
    encoding: "utf8",
  });
}

function withWorkDir(fn) {
  const workDir = mkdtempSync(join(tmpdir(), "cmm-compress-"));
  try {
    return fn(workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("compress-db: <db>.br rozpakowuje się bajt w bajt do pliku bazy i nadpisuje stary .br", () => {
  withWorkDir((workDir) => {
    const dbPath = join(workDir, "car-market-monitor.sqlite");
    closeDatabase(openDatabase(dbPath), dbPath);
    // Stary .br z poprzedniego runu nie może przetrwać — dashboard dostałby
    // nieaktualną bazę pod nowym sha z manifestu.
    writeFileSync(`${dbPath}.br`, "stale");

    runCompress(dbPath);

    const original = readFileSync(dbPath);
    const restored = brotliDecompressSync(readFileSync(`${dbPath}.br`));
    assert.ok(restored.equals(original), "rozpakowany .br różni się od pliku bazy");
    assert.deepEqual(
      readdirSync(workDir).filter((name) => name.endsWith(".tmp")),
      [],
      "po udanym runie nie powinien zostać plik tymczasowy",
    );
  });
});

test("compress-db: brak pliku bazy kończy się błędem i nie tworzy .br", () => {
  withWorkDir((workDir) => {
    const dbPath = join(workDir, "missing.sqlite");

    assert.throws(() => runCompress(dbPath), "brak bazy powinien dać exit code != 0");
    assert.equal(existsSync(`${dbPath}.br`), false, "nie wolno zostawić .br bez bazy");
  });
});
