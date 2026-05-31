// Integration tests for the listing discovery parser. Drives it with a
// stubbed fetchImpl and asserts pagination/dedup/error semantics. The
// underlying HTML payloads come from test/fixtures/listing-page-basic.html
// (a redacted snapshot of a real source listing) plus in-memory variants
// produced by test/_helpers/listing-mutate.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scrapeMarketplaceListingCards as scrapeListingCards } from "../../src/lib/marketplace-source.js";
import { HttpError } from "../../src/lib/utils.js";
import { makeFetchStub, StubResponse } from "../_helpers/fetch-stub.js";
import {
  withDuplicateFirstEdge,
  withEmptyEdges,
  withPagination,
  withSlicedEdges,
  withoutAdvertSearch,
} from "../_helpers/listing-mutate.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const LISTING_HTML = readFileSync(join(FIXTURES_DIR, "listing-page-basic.html"), "utf8");
// Pre-built empty-edges HTML reused by every test that needs to terminate the
// listing pagination loop. The parser keeps fetching `pageN+1`,
// `pageN+2` (PAGINATION_SAFETY_MARGIN beyond reportedPageCount) until a page
// returns 0 cards — so any test that expects to stop after K pages must stub
// the next page as an empty-edges 200, not let the fetch stub fall through to
// its default 404.
const EMPTY_EDGES_HTML = withEmptyEdges(LISTING_HTML);

const SOURCE_URL = "https://www.otomoto.pl/osobowe/porsche/taycan";
// The parser forces search[order]=created_at:desc on every request unless the
// source URL already pins one. The first page request
// therefore lands at this exact URL.
const PAGE_1 = "https://www.otomoto.pl/osobowe/porsche/taycan?search%5Border%5D=created_at%3Adesc";
// Production pageUrl() sets `page` first then `search[order]` second, so the
// resulting URLSearchParams string has page first. The order is significant —
// the route map key in the fetch stub must match exactly.
const pageN = (n) =>
  `https://www.otomoto.pl/osobowe/porsche/taycan?page=${n}&search%5Border%5D=created_at%3Adesc`;

test("listing discovery forces created_at:desc sort on the first request", async () => {
  // totalCount=4 + pageSize=4 → reportedPageCount=1, but PAGINATION_SAFETY_MARGIN
  // means the loop still tries page 2; we stub it with empty edges so it
  // breaks cleanly on the next iteration.
  const html = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 4, pageSize: 4 });
  const { stub, calls } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: html }),
    [pageN(2)]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  });

  const result = await scrapeListingCards(SOURCE_URL, stub);

  // First fetch must be the sort-forced URL
  assert.equal(calls[0], PAGE_1);
  assert.equal(result.unique_cards.length, 4);
  assert.equal(result.metadata.page_count, 1, "page_count reflects last page with cards");
  assert.equal(result.metadata.duplicate_ids && Object.keys(result.metadata.duplicate_ids).length, 0);
});

test("listing discovery honors a user-supplied search[order] without overriding it", async () => {
  // When the source URL already pins a sort, the parser must NOT replace it.
  // The page-2 URL inherits the user sort and appends &page=2.
  const userSortUrl = "https://www.otomoto.pl/osobowe/porsche/taycan?search%5Border%5D=filter_float_price%3Aasc";
  const userSortPage2 = `${userSortUrl}&page=2`;
  const html = withPagination(withSlicedEdges(LISTING_HTML, 2), { totalCount: 2, pageSize: 32 });
  const { stub, calls } = makeFetchStub({
    [userSortUrl]: new StubResponse({ body: html }),
    [userSortPage2]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  });

  await scrapeListingCards(userSortUrl, stub);

  assert.equal(calls[0], userSortUrl);
  // Sanity: page 2 also follows the user sort, not the default
  assert.ok(calls[1]?.includes("filter_float_price%3Aasc"), "page 2 lost user sort");
});

test("listing discovery deduplicates ad_id repeats across pages", async () => {
  // Page 1 has 4 cards. Page 2 also has 4 cards but the first one is a
  // duplicate of page 1's first card — the parser must drop it.
  const page1 = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 8, pageSize: 4 });
  const page2 = withPagination(
    withDuplicateFirstEdge(withSlicedEdges(LISTING_HTML, 4)),
    { totalCount: 8, pageSize: 4 },
  );

  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
    [pageN(2)]: new StubResponse({ body: page2 }),
    // page 3 within the safety margin — terminate cleanly with empty edges
    [pageN(3)]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  });

  const result = await scrapeListingCards(SOURCE_URL, stub);

  // raw rows include the duplicate; unique drops it
  assert.equal(result.metadata.raw_row_count, 9);
  assert.equal(result.metadata.unique_row_count, 4);
  assert.equal(result.unique_cards.length, 4);
  // duplicate_ids reports the doubled id with count 2 (page1 first + page2 first + page2 dup of page2 first)
  assert.ok(Object.keys(result.metadata.duplicate_ids).length >= 1);
});

test("listing discovery stops paginating when a page returns zero edges", async () => {
  // totalCount=8 + pageSize=4 → reportedPageCount=2. Page 2 returns 0 edges,
  // so pagination must stop and we should NOT see a page=3 fetch attempt.
  const page1 = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 8, pageSize: 4 });
  const page2Empty = withPagination(withEmptyEdges(LISTING_HTML), { totalCount: 8, pageSize: 4 });

  const { stub, calls } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
    [pageN(2)]: new StubResponse({ body: page2Empty }),
  });

  const result = await scrapeListingCards(SOURCE_URL, stub);

  assert.equal(result.unique_cards.length, 4);
  assert.equal(result.metadata.page_count, 1, "page_count should reflect last page with cards");
  // Only page 1 and page 2 fetched — no page 3 attempt
  assert.deepEqual(calls, [PAGE_1, pageN(2)]);
});

test("listing discovery throws on 5xx mid-pagination (does NOT silently truncate)", async () => {
  // Regression: if a chwilowy 5xx in the middle of pagination is swallowed,
  // the resulting "shorter" listing causes the reconcile loop to flip every
  // listing past the failure point to MISSING after MISSING_THRESHOLD runs.
  // The parser MUST surface the error and let the caller persist a FAILED run
  // instead of corrupting state.
  const page1 = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 12, pageSize: 4 });
  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
    [pageN(2)]: new StubResponse({ status: 500, body: "<html>oops</html>" }),
  });

  await assert.rejects(
    () => scrapeListingCards(SOURCE_URL, stub),
    (err) => err instanceof HttpError && err.status === 500,
  );
});

test("listing discovery throws on first-page 404 (cannot kick off discovery)", async () => {
  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ status: 404, body: "<html>not found</html>" }),
  });
  await assert.rejects(
    () => scrapeListingCards(SOURCE_URL, stub),
    (err) => err instanceof HttpError && err.status === 404,
  );
});

test("listing discovery throws when first page has totalCount>0 but zero edges", async () => {
  // Regression for P1#2: jeśli upstream zwróci HTTP 200 + advertSearch z
  // niezerowym totalCount i pustą listą edges na page 1 (bot-challenge,
  // throttling, skeleton bez danych), discovery NIE może po cichu zwrócić 0
  // kart - bo computeStatus(0,0) sklasyfikuje to jako SUCCESS, a reconcile
  // zwiększy missed_count na całej bazie i po dwóch takich runach hysteresis
  // sflipuje wszystkie listings na MISSING. Zamiast tego musi rzucić, żeby
  // run zapisał się jako FAILED bez dotykania missed_count.
  const page1 = withPagination(withEmptyEdges(LISTING_HTML), { totalCount: 87, pageSize: 32 });
  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
  });
  await assert.rejects(
    () => scrapeListingCards(SOURCE_URL, stub),
    (err) => err instanceof Error && /Discovery anomaly/.test(err.message),
  );
});

test("listing discovery accepts empty first page when totalCount is 0 (legit empty source)", async () => {
  // Counter-test: legalnie pusta kategoria (np. nowo dodane źródło bez
  // matchujących listings) powinna przechodzić bez błędu - guard celuje
  // wyłącznie w totalCount>0 z pustymi edges. Page 2 stubowany dla
  // PAGINATION_SAFETY_MARGIN (parser próbuje page 2 nawet przy totalCount=0).
  const page1 = withPagination(withEmptyEdges(LISTING_HTML), { totalCount: 0, pageSize: 32 });
  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
    [pageN(2)]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  });
  const result = await scrapeListingCards(SOURCE_URL, stub);
  assert.equal(result.unique_cards.length, 0);
  assert.equal(result.metadata.reported_total_count, 0);
});

test("listing discovery rejects mid-pagination 404 the same way as 5xx", async () => {
  // 404 mid-pagination is also a hard error, NOT end-of-pagination, because
  // The source returns 200 + empty edges for legit out-of-range pages. Anything
  // non-200 is upstream weirdness and must surface.
  const page1 = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 12, pageSize: 4 });
  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
    [pageN(2)]: new StubResponse({ status: 404, body: "<html>not found</html>" }),
  });
  await assert.rejects(
    () => scrapeListingCards(SOURCE_URL, stub),
    (err) => err instanceof HttpError && err.status === 404,
  );
});

test("listing discovery rejects when __NEXT_DATA__ is missing from upstream payload", async () => {
  const { stub } = makeFetchStub({
    [PAGE_1]: new StubResponse({ status: 200, body: "<html>maintenance page</html>" }),
  });
  await assert.rejects(
    () => scrapeListingCards(SOURCE_URL, stub),
    (err) => err instanceof HttpError && err.status === 502,
  );
});

test("listing discovery retries first page when __NEXT_DATA__ lacks advertSearch", async () => {
  const html = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 4, pageSize: 4 });
  let firstPageAttempts = 0;
  const { stub, calls } = makeFetchStub({
    [PAGE_1]: () => {
      firstPageAttempts += 1;
      return new StubResponse({
        body: firstPageAttempts === 1 ? withoutAdvertSearch(html) : html,
      });
    },
    [pageN(2)]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  });

  const result = await scrapeListingCards(SOURCE_URL, stub);

  assert.equal(result.unique_cards.length, 4);
  assert.equal(calls.filter((url) => url === PAGE_1).length, 2, "first page should be retried once");
});

test("listing discovery retries mid-pagination when __NEXT_DATA__ lacks advertSearch", async () => {
  const page1 = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 8, pageSize: 4 });
  const page2 = withPagination(withSlicedEdges(LISTING_HTML, 4), { totalCount: 8, pageSize: 4 });
  let page2Attempts = 0;
  const { stub, calls } = makeFetchStub({
    [PAGE_1]: new StubResponse({ body: page1 }),
    [pageN(2)]: () => {
      page2Attempts += 1;
      return new StubResponse({
        body: page2Attempts === 1 ? withoutAdvertSearch(page2) : page2,
      });
    },
    [pageN(3)]: new StubResponse({ body: EMPTY_EDGES_HTML }),
  });

  const result = await scrapeListingCards(SOURCE_URL, stub);

  assert.equal(result.metadata.page_count, 2);
  assert.equal(result.metadata.raw_row_count, 8);
  assert.equal(calls.filter((url) => url === pageN(2)).length, 2, "page 2 should be retried once");
});
