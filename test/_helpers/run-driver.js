// Mini-driver for runSource. Wires up a tmp-file SQLite database, a single
// marketplace source, and a stubbed fetch backed by listing/detail fixture HTMLs.
// Tests use this to exercise the full transactional path through commitRun
// (applyDetail / applyCardOnly / reconcile / change emission) without ever
// hitting the network.
//
// Why a driver instead of testing applyDetail directly: the assertions we
// care about — placeholder upgrade NOT emitting a second __listing_created,
// MISSING_THRESHOLD only flipping after two consecutive misses, reactivation
// counters — all live in commitRun's transaction body and depend on the
// row state that prior runs have left in the db. Calling applyDetail in
// isolation would skip half the logic.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDatabase, openDatabase } from "../../src/lib/db.js";
import { createSource, runSource } from "../../src/lib/scrape.js";
import { withEmptyEdges, withFirstEdge, withPagination, withSlicedEdges } from "./listing-mutate.js";
import { makeFetchStub, StubResponse } from "./fetch-stub.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const LISTING_HTML_BASE = readFileSync(join(FIXTURES_DIR, "listing-page-basic.html"), "utf8");
const DETAIL_HTML = readFileSync(join(FIXTURES_DIR, "detail-page-full.html"), "utf8");

// Synthetic IDs the fixture builder bakes in. The detail fixture has
// advert.id = "1000000001"; we retag the listing fixture's first edge to use
// the same id so card.ad_id === detail.external_id.
export const FIXTURE_DETAIL_ID = "1000000001";
export const FIXTURE_DETAIL_URL = "https://www.otomoto.pl/osobowe/oferta/test-fixture-detail.html";

const SOURCE_URL = "https://www.otomoto.pl/osobowe/porsche/taycan";
// pageUrl() forces this exact query string on the first request.
const PAGE_1_URL = `${SOURCE_URL}?search%5Border%5D=created_at%3Adesc`;
const PAGE_N_URL = (n) => `${SOURCE_URL}?page=${n}&search%5Border%5D=created_at%3Adesc`;

// Pre-computed empty-edges HTML reused to terminate the listing pagination
// loop within PAGINATION_SAFETY_MARGIN (=2) extra pages. Inherits totalCount
// from the fixture (=87), which matches real-world out-of-range pages where
// upstream raportuje totalCount>0 ale page>1 zwraca puste edges.
const EMPTY_EDGES_HTML = withEmptyEdges(LISTING_HTML_BASE);

// Pre-computed "source went empty" HTML — totalCount=0 + edges=[]. Używane
// jako page 1 w testach reconcile/MISSING/reactivation, gdzie modelujemy
// legalnie wyczyszczone źródło. Z totalCount>0 + edges=[] discovery rzuca
// (anomaly guard), bo to sygnał bot-challenge'u, nie pustego stocku.
const EMPTY_LISTING_HTML = withPagination(withEmptyEdges(LISTING_HTML_BASE), {
  totalCount: 0,
  pageSize: 32,
});

// Builds a one-card listing HTML whose only edge is retagged to FIXTURE_DETAIL_ID
// + FIXTURE_DETAIL_URL. Used by every flow test that drives a single
// listing → detail round-trip.
export function singleCardListingHtml() {
  const sliced = withSlicedEdges(LISTING_HTML_BASE, 1);
  const repaginated = withPagination(sliced, { totalCount: 1, pageSize: 1 });
  return withFirstEdge(repaginated, { id: FIXTURE_DETAIL_ID, url: FIXTURE_DETAIL_URL });
}

// A logger that swallows everything. runSource hits .log/.error/.warn during
// normal operation, and we don't want that noise in test output.
export const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

export function createDriver() {
  const workDir = mkdtempSync(join(tmpdir(), "market-flow-"));
  const dbPath = join(workDir, "test.sqlite");
  const db = openDatabase(dbPath);
  const source = createSource(db, { url: SOURCE_URL, name: "test-source" });

  const cleanup = () => {
    closeDatabase(db, dbPath);
    rmSync(workDir, { recursive: true, force: true });
  };

  // Helper: drive one runSource pass with the given route map. The map keys
  // are URLs the production parser will request; values are StubResponse or
  // factory functions returning one. Returns the runSource result + the
  // recorded fetch call list for assertions.
  const runOnce = async (routes, options = {}) => {
    const { stub, calls } = makeFetchStub(routes);
    const result = await runSource(db, source, {
      triggerType: "test",
      logger: silentLogger,
      fetchImpl: stub,
      // Zero retry delay so the placeholder-upgrade test doesn't sleep
      // 6 seconds while DETAIL_RETRIES (=2) cycles through 5xx responses.
      retryBaseDelayMs: 0,
      ...options,
    });
    return { result, calls };
  };

  return {
    db,
    dbPath,
    source,
    runOnce,
    cleanup,
  };
}

// Convenience route builders so tests stay declarative.
export function listingRoute(html) {
  return {
    [PAGE_1_URL]: new StubResponse({ body: html }),
    // Always pad page 2 with empty edges so PAGINATION_SAFETY_MARGIN doesn't
    // hit the default 404 fallback. Tests that want to test failure modes
    // override the page-1 entry.
    [PAGE_N_URL(2)]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  };
}

export function detailRoute({ status = 200, body = DETAIL_HTML, url = FIXTURE_DETAIL_URL } = {}) {
  return {
    [url]: new StubResponse({ status, body }),
  };
}

export { PAGE_1_URL, PAGE_N_URL, EMPTY_EDGES_HTML, EMPTY_LISTING_HTML };
