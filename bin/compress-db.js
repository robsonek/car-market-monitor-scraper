#!/usr/bin/env node
// Kompresuje bazę brotli do <db>.br. Tę wersję dashboard
// (car-market-monitor-web) dostaje przez proxy z nagłówkiem
// Content-Encoding: br i przeglądarka sama ją rozpakowuje — transfer spada
// z ~120 MB do ~17 MB.
//
// Uruchamiać PO closeDatabase() — w CI po kroku prune, który robi VACUUM
// i pisze manifest. Kompresujemy dokładnie te bajty, których sha jest
// w manifeście, bo dashboard używa tego sha jako klucza cache.
//
// Parametry brotli:
//  - quality 5: ~1 s na 120 MB przy ~17 MB wyniku. Wyższe poziomy dają
//    1–2 MB mniej kosztem dziesiątek sekund do minut na KAŻDYM godzinnym
//    runie.
//  - lgwin 24 (okno 16 MiB) to maksimum standardowego brotli. Przeglądarki
//    nie obsługują trybu "large window", więc nie wolno go włączać.
//
// Zapis atomowy (tmp + rename): przerwany run nie zostawi uciętego .br.

import {
  createReadStream,
  createWriteStream,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress } from "node:zlib";
import { DB_PATH } from "../src/lib/db.js";

async function main() {
  // statSync rzuca ENOENT zanim cokolwiek otworzymy do zapisu.
  const inputBytes = statSync(DB_PATH).size;
  const outPath = `${DB_PATH}.br`;
  const tmpPath = `${outPath}.tmp`;

  try {
    await pipeline(
      createReadStream(DB_PATH),
      createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 5,
          [constants.BROTLI_PARAM_LGWIN]: 24,
          [constants.BROTLI_PARAM_SIZE_HINT]: inputBytes,
        },
      }),
      createWriteStream(tmpPath),
    );
    renameSync(tmpPath, outPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }

  const outputBytes = statSync(outPath).size;
  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  console.log(`brotli: ${mb(inputBytes)} MB -> ${mb(outputBytes)} MB (${outPath})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
