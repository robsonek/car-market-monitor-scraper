// Integration test H2: pełna ścieżka runSource przy niekompletnym discovery.
// Modelujemy najgroźniejszy wariant - source zwraca totalCount=0 (soft-block /
// zmiana taksonomii URL) przy istniejącym dużym aktywnym inwentarzu. Bez guarda
// reconcile bumpnąłby missed_count całej bazie i po dwóch takich runach
// flipnąłby wszystko na MISSING (run = SUCCESS, brak alarmu). Z guardem run jest
// PARTIAL_SUCCESS, a inwentarz nietknięty.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDriver, listingRoute, EMPTY_LISTING_HTML } from "../_helpers/run-driver.js";
import { randomId } from "../../src/lib/utils.js";

// Wstawia n aktywnych listingów bez snapshotów (wystarcza do reconcile - liczy
// się tylko external_id + is_active). Kolumny jak w applyCardOnly INSERT.
function seedActiveListings(db, sourceId, n) {
  const now = "2026-01-01T00:00:00Z";
  const stmt = db.prepare(`
    INSERT INTO listings (
      id, source_id, external_id, listing_url, title, seller_type, current_status, is_active,
      first_seen_at, last_seen_at, last_snapshot_id, last_snapshot_hash, last_price_amount,
      last_mileage, last_year, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `);
  for (let i = 0; i < n; i += 1) {
    stmt.run(
      randomId(),
      sourceId,
      `seed-ext-${i}`,
      `https://www.otomoto.pl/osobowe/oferta/seed-${i}.html`,
      now,
      now,
      now,
      now,
    );
  }
}

test("H2 guard: empty discovery (total=0) przy dużym inwentarzu pomija reconcile", async () => {
  const d = createDriver();
  try {
    seedActiveListings(d.db, d.source.id, 15);

    // total=0, zero kart - powyżej progu bezwzględnego (15 >= 10) i seenCount=0.
    const { result } = await d.runOnce(listingRoute(EMPTY_LISTING_HTML));

    // Reconcile pominięty: nic nie flipnięte, nic nie bumpnięte.
    const active = d.db.prepare("SELECT COUNT(*) AS c FROM listings WHERE is_active = 1").get();
    assert.equal(active.c, 15, "guard powinien zostawić wszystkie 15 aktywnych");

    const bumped = d.db.prepare("SELECT COUNT(*) AS c FROM listings WHERE missed_count > 0").get();
    assert.equal(bumped.c, 0, "guard nie powinien bumpować missed_count");

    const missingChanges = d.db
      .prepare(
        "SELECT COUNT(*) AS c FROM listing_changes WHERE field_name = '__listing_status' AND new_value = 'MISSING'",
      )
      .get();
    assert.equal(missingChanges.c, 0, "nie powinno powstać żadne MISSING");

    // Run oznaczony jako niepełny + powód zapisany (sygnał dla alertingu).
    assert.equal(result.status, "PARTIAL_SUCCESS");
    assert.equal(result.removed_listings_count, 0);
    const run = d.db
      .prepare("SELECT status, error FROM scrape_runs ORDER BY started_at DESC, finished_at DESC LIMIT 1")
      .get();
    assert.equal(run.status, "PARTIAL_SUCCESS");
    assert.match(run.error, /completeness guard/);
  } finally {
    d.cleanup();
  }
});
