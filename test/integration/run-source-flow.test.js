// End-to-end tests for runSource: discovery → detail fetch → commitRun
// transaction (applyDetail / applyCardOnly / hysteresis reconcile / change
// emission). Each test wires a tmp-file db via createDriver() and drives
// 1–4 successive runs through runOnce(), then asserts on the resulting
// listings / listing_changes / listing_snapshots / scrape_runs rows.
//
// What this suite covers (the round-2 scrape-flow checklist):
//   1. placeholder upgrade — failed detail on run 1, success on run 2 must
//      NOT emit a second __listing_created and must NOT bump
//      new_listings_count again.
//   2. MISSING_THRESHOLD — single miss only bumps missed_count; second
//      consecutive miss flips is_active=0 and emits __listing_status MISSING.
//   3. reactivation — listing returning after a MISSING flip emits
//      __listing_status MISSING→ACTIVE and bumps reactivated counter.
//   4. discovery failure — listing discovery throwing must persist
//      a FAILED scrape_run row WITHOUT touching listings.missed_count
//      (otherwise upstream flakiness would cascade into spurious MISSING
//      flips after MISSING_THRESHOLD failed runs).

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createDriver,
  detailRoute,
  EMPTY_LISTING_HTML,
  FIXTURE_DETAIL_ID,
  FIXTURE_DETAIL_URL,
  listingRoute,
  PAGE_1_URL,
  singleCardListingHtml,
} from "../_helpers/run-driver.js";
import { StubResponse } from "../_helpers/fetch-stub.js";

let driver;

beforeEach(() => {
  driver = createDriver();
});

afterEach(() => {
  driver.cleanup();
});

function listChanges(db, listingId, fieldName) {
  const where = fieldName ? "AND field_name = ?" : "";
  const params = fieldName ? [listingId, fieldName] : [listingId];
  return db
    .prepare(`SELECT * FROM listing_changes WHERE listing_id = ? ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params);
}

function getListing(db, externalId) {
  return db.prepare("SELECT * FROM listings WHERE external_id = ?").get(externalId);
}

// ----------------------------------------------------------------------
// 1. placeholder upgrade
// ----------------------------------------------------------------------

test("placeholder upgrade: failed detail then success emits exactly one __listing_created", async () => {
  const listingHtml = singleCardListingHtml();

  // Run 1: discovery returns 1 card, but detail fetch returns 500 on every
  // retry. fetchDetailWithRetry burns DETAIL_RETRIES + 1 attempts (with
  // retryBaseDelayMs=0 from the driver) and gives up. applyCardOnly fires
  // and creates a placeholder listing with last_snapshot_id=NULL.
  const run1 = await driver.runOnce({
    ...listingRoute(listingHtml),
    [FIXTURE_DETAIL_URL]: new StubResponse({ status: 500, body: "<html>oops</html>" }),
  });

  assert.equal(run1.result.detail_failed_count, 1);
  assert.equal(run1.result.new_listings_count, 1, "placeholder should count as new");

  const placeholder = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.ok(placeholder, "placeholder listing was not created");
  assert.equal(placeholder.is_active, 1);
  assert.equal(placeholder.last_snapshot_id, null, "placeholder must have null snapshot pointer");
  assert.equal(placeholder.last_snapshot_hash, null);

  const createsAfterRun1 = listChanges(driver.db, placeholder.id, "__listing_created");
  assert.equal(createsAfterRun1.length, 1, "expected one __listing_created from applyCardOnly");

  // Run 2: same listing, detail succeeds this time. The placeholder upgrade
  // path must:
  //   - write a fresh snapshot row
  //   - update listing.last_snapshot_id / last_snapshot_hash
  //   - NOT emit a second __listing_created (the first one already counted)
  //   - NOT bump new_listings_count again
  //   - count as unchanged in the run summary (it's a silent backfill)
  const run2 = await driver.runOnce({
    ...listingRoute(listingHtml),
    ...detailRoute(),
  });

  assert.equal(run2.result.new_listings_count, 0, "second run must not re-count as new");
  assert.equal(run2.result.unchanged_listings_count, 1, "placeholder upgrade should count as unchanged");
  assert.equal(run2.result.changed_listings_count, 0, "placeholder upgrade must not emit a diff");

  const upgraded = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.ok(upgraded.last_snapshot_id, "snapshot pointer must be set after upgrade");
  assert.ok(upgraded.last_snapshot_hash, "snapshot hash must be set after upgrade");
  assert.equal(upgraded.vin, "WAUZZZ00000000001", "decrypt path must populate vin column");

  // The critical assertion: still exactly one __listing_created across both runs.
  const createsAfterRun2 = listChanges(driver.db, placeholder.id, "__listing_created");
  assert.equal(
    createsAfterRun2.length,
    1,
    "placeholder upgrade emitted a phantom second __listing_created",
  );

  // And no diff rows were emitted for the upgrade (would be ~50 spurious
  // "added" rows comparing the placeholder's empty field_map to the real one).
  const allChanges = listChanges(driver.db, placeholder.id);
  assert.equal(allChanges.length, 1, "placeholder upgrade leaked diff rows into listing_changes");
});

// ----------------------------------------------------------------------
// 2. MISSING_THRESHOLD hysteresis
// ----------------------------------------------------------------------

test("MISSING_THRESHOLD: single miss does NOT flip is_active; second consecutive miss does", async () => {
  const listingHtml = singleCardListingHtml();

  // Run 1: listing appears, detail succeeds → row exists with missed_count=0
  await driver.runOnce({ ...listingRoute(listingHtml), ...detailRoute() });
  let row = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(row.is_active, 1);
  assert.equal(row.missed_count, 0);

  // Run 2: listing disappears (empty edges). Hysteresis bumps missed_count
  // to 1 but is_active MUST stay 1 — one transient miss isn't enough to
  // flip a listing to MISSING (otherwise promoted-ad shuffle on the source
  // would generate false positives every other run).
  const run2 = await driver.runOnce(listingRoute(EMPTY_LISTING_HTML));
  assert.equal(run2.result.removed_listings_count, 0, "single miss must not count as removed");

  row = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(row.is_active, 1, "single miss flipped is_active prematurely");
  assert.equal(row.missed_count, 1, "missed_count should be 1 after first miss");
  // No __listing_status change yet
  const statusChangesAfterRun2 = listChanges(driver.db, row.id, "__listing_status");
  assert.equal(statusChangesAfterRun2.length, 0);

  // Run 3: still missing. missed_count hits MISSING_THRESHOLD (2), is_active
  // flips to 0, summary.removed_listings_count bumps, __listing_status
  // ACTIVE→MISSING is emitted.
  const run3 = await driver.runOnce(listingRoute(EMPTY_LISTING_HTML));
  assert.equal(run3.result.removed_listings_count, 1, "second consecutive miss should remove");

  row = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(row.is_active, 0, "is_active should flip after MISSING_THRESHOLD");
  assert.equal(row.missed_count, 2);

  const statusChangesAfterRun3 = listChanges(driver.db, row.id, "__listing_status");
  assert.equal(statusChangesAfterRun3.length, 1);
  assert.equal(statusChangesAfterRun3[0].old_value, "ACTIVE");
  assert.equal(statusChangesAfterRun3[0].new_value, "MISSING");
});

// ----------------------------------------------------------------------
// 3. reactivation
// ----------------------------------------------------------------------

test("reactivation: listing returning after MISSING flip emits __listing_status MISSING→ACTIVE", async () => {
  const listingHtml = singleCardListingHtml();

  // Setup: drive the same path as the MISSING test until is_active=0
  await driver.runOnce({ ...listingRoute(listingHtml), ...detailRoute() });
  await driver.runOnce(listingRoute(EMPTY_LISTING_HTML));
  await driver.runOnce(listingRoute(EMPTY_LISTING_HTML));

  let row = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(row.is_active, 0, "test setup precondition: row should be MISSING by now");

  // Run 4: same listing reappears with the same detail payload. applyDetail
  // detects existing.is_active=0, takes the "hash unchanged" branch (same
  // payload → same hash), sets is_active=1, emits __listing_status
  // MISSING→ACTIVE, and bumps reactivated_listings_count.
  const run4 = await driver.runOnce({ ...listingRoute(listingHtml), ...detailRoute() });
  assert.equal(run4.result.reactivated_listings_count, 1);
  // The reactivated listing also counts as unchanged (hash didn't move),
  // not as "new" — that bookkeeping must not regress.
  assert.equal(run4.result.new_listings_count, 0);
  assert.equal(run4.result.unchanged_listings_count, 1);

  row = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(row.is_active, 1);
  assert.equal(row.missed_count, 0, "missed_count must reset on reactivation");

  const statusChanges = listChanges(driver.db, row.id, "__listing_status");
  // Two transitions total: ACTIVE→MISSING from run 3, MISSING→ACTIVE from run 4
  assert.equal(statusChanges.length, 2);
  assert.equal(statusChanges[1].old_value, "MISSING");
  assert.equal(statusChanges[1].new_value, "ACTIVE");
});

test("legacy value_added_services reorder heals hash drift without emitting change rows", async () => {
  const listingHtml = singleCardListingHtml();

  await driver.runOnce({ ...listingRoute(listingHtml), ...detailRoute() });

  const row = getListing(driver.db, FIXTURE_DETAIL_ID);
  // Field map jest teraz rekonstruowany z payload_json (migration 0005), więc
  // żeby zasymulować "legacy" stan w którym w bazie siedzi nieznormalizowana
  // kolejność value_added_services, podmieniamy payload_json snapshotu.
  const snapshot = driver.db
    .prepare("SELECT payload_json FROM listing_snapshots WHERE id = ?")
    .get(row.last_snapshot_id);
  const payload = JSON.parse(snapshot.payload_json);
  const normalizedServices = payload.value_added_services || [];

  payload.value_added_services = normalizedServices
    .slice()
    .reverse()
    .map((service) => ({ __typename: "AdValueAddedService", ...service }));
  driver.db
    .prepare("UPDATE listing_snapshots SET payload_json = ? WHERE id = ?")
    .run(JSON.stringify(payload), row.last_snapshot_id);
  driver.db
    .prepare("UPDATE listings SET last_snapshot_hash = ? WHERE id = ?")
    .run("legacy-reorder-hash", row.id);

  const run2 = await driver.runOnce({ ...listingRoute(listingHtml), ...detailRoute() });

  assert.equal(run2.result.changed_listings_count, 0, "reorder-only heal must not count as changed");
  assert.equal(run2.result.unchanged_listings_count, 1, "reorder-only heal should count as unchanged");

  const vasChanges = listChanges(driver.db, row.id, "value_added_services");
  assert.equal(vasChanges.length, 0, "reorder-only heal emitted phantom value_added_services diff");
});

// ----------------------------------------------------------------------
// 4. discovery failure does NOT touch listings (no missed_count cascade)
// ----------------------------------------------------------------------

test("discovery failure: persists FAILED scrape_run, leaves missed_count untouched", async () => {
  // Seed: one healthy run so a listing exists with missed_count=0
  await driver.runOnce({
    ...listingRoute(singleCardListingHtml()),
    ...detailRoute(),
  });
  const seeded = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(seeded.missed_count, 0);
  const seededUpdatedAt = seeded.updated_at;

  // Discovery failure run: page 1 returns 503. The listing discovery step
  // throws, runSource catches → persistDiscoveryFailure. The reconcile loop
  // never runs, so the existing listing's missed_count must remain at 0
  // even though it was technically "not seen" in this run.
  //
  // This is the load-bearing invariant: without it, MISSING_THRESHOLD upstream
  // hiccups (the source returning 503 twice in a row) would cascade into mass
  // false-positive MISSING flips on every active listing.
  const result = await driver.runOnce({
    [PAGE_1_URL]: new StubResponse({ status: 503, body: "<html>upstream gone</html>" }),
  });

  assert.equal(result.result.status, "FAILED");
  assert.ok(result.result.error, "FAILED run must surface an error message");

  // The scrape_runs table must have a FAILED row for this run id.
  const runRow = driver.db
    .prepare("SELECT * FROM scrape_runs WHERE id = ?")
    .get(result.result.run_id);
  assert.ok(runRow, "FAILED run was not persisted");
  assert.equal(runRow.status, "FAILED");
  assert.ok(runRow.error, "FAILED run row must carry the error message");
  assert.ok(runRow.finished_at, "FAILED run must have finished_at set");
  // Counters stay at their default (NULL or 0) — nothing was committed.
  assert.equal(runRow.detail_success_count ?? 0, 0);
  assert.equal(runRow.removed_listings_count ?? 0, 0);

  // Listing row is untouched by the reconcile pass.
  const after = getListing(driver.db, FIXTURE_DETAIL_ID);
  assert.equal(after.missed_count, 0, "discovery failure cascaded into missed_count");
  assert.equal(after.is_active, 1, "discovery failure flipped is_active");
  assert.equal(
    after.updated_at,
    seededUpdatedAt,
    "listing row was rewritten despite discovery failure",
  );
});

test("runSource persists explicit batch_id on scrape_runs", async () => {
  const batchId = "batch-test-123";
  const run = await driver.runOnce({
    ...listingRoute(singleCardListingHtml()),
    ...detailRoute(),
  }, { batchId });

  const runRow = driver.db
    .prepare("SELECT batch_id FROM scrape_runs WHERE id = ?")
    .get(run.result.run_id);
  assert.equal(runRow.batch_id, batchId);
  assert.equal(run.result.batch_id, batchId);
});
