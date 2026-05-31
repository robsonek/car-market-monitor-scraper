// Integration tests for the detail parser. Drives it with a stubbed fetch
// returning the redacted detail fixture, then asserts that normalizeDetail
// decrypted the synthetic VIN/phones the fixture was built with (round-trip
// across the production decrypt path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scrapeMarketplaceDetail as scrapeDetail } from "../../src/lib/marketplace-source.js";
import { HttpError } from "../../src/lib/utils.js";
import { makeFetchStub, StubResponse } from "../_helpers/fetch-stub.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DETAIL_HTML = readFileSync(join(FIXTURES_DIR, "detail-page-full.html"), "utf8");

// Synthetic plaintexts the fixture builder encrypted into the redacted HTML.
// Must stay in sync with test/fixtures/_build.js.
const FIXTURE_VIN = "WAUZZZ00000000001";
const FIXTURE_DATE_REGISTRATION = "2024-01-15";
const FIXTURE_PHONE = "+48000000001";

const DETAIL_URL = "https://www.otomoto.pl/osobowe/oferta/test-detail.html";
const FAKE_CARD = {
  ad_id: "1000000001",
  url: DETAIL_URL,
  page_number: 1,
  page_position: 1,
  short_description: null,
  mileage: null,
  year: null,
};

test("detail parser decrypts VIN/date_registration/phones round-trip from fixture", async () => {
  const { stub, calls } = makeFetchStub({
    [DETAIL_URL]: new StubResponse({ body: DETAIL_HTML }),
  });

  const detail = await scrapeDetail(FAKE_CARD, stub);

  assert.equal(calls.length, 1);
  assert.equal(detail.vin, FIXTURE_VIN);
  assert.equal(detail.date_registration, FIXTURE_DATE_REGISTRATION);
  // The fixture has no `registration` token (raw page didn't carry one);
  // null is the expected behavior — decryptToken returns null on missing input.
  assert.equal(detail.registration, null);

  const phones = JSON.parse(detail.phones_json);
  assert.deepEqual(phones.main, [FIXTURE_PHONE]);
  assert.deepEqual(phones.description, []);
});

test("detail parser produces typed param columns from the fixture's parametersDict", async () => {
  const { stub } = makeFetchStub({
    [DETAIL_URL]: new StubResponse({ body: DETAIL_HTML }),
  });

  const detail = await scrapeDetail(FAKE_CARD, stub);

  // The fixture is from a real Porsche Taycan listing, so these are the
  // actual values that survived redaction (parameters[] are non-PII).
  assert.equal(detail.params.make, "porsche");
  assert.equal(detail.params.model, "taycan");
  assert.equal(typeof detail.params.year, "number");
  assert.equal(typeof detail.params.mileage, "number");
});

test("detail parser surfaces 404 as HttpError(404) — does not silently return null", async () => {
  const { stub } = makeFetchStub({
    [DETAIL_URL]: new StubResponse({ status: 404, body: "<html>gone</html>" }),
  });

  await assert.rejects(
    () => scrapeDetail(FAKE_CARD, stub),
    (err) => err instanceof HttpError && err.status === 404,
  );
});

test("detail parser does NOT retry internally on 5xx (retry lives in fetchDetailWithRetry)", async () => {
  // Regression for P1#1: scrapeMarketplaceDetail used to call retrying
  // fetchHtml(), which combined with fetchDetailWithRetry's own 3-attempt
  // loop produced 9 upstream requests and ~24s of sleep per stuck detail.
  // Detali w produkcji lecą sekwencyjnie (DETAIL_CONCURRENCY=1), więc
  // pojedynczy 5xx outage zżerał całe okno 90-minutowego workflow zanim
  // run zdążył się zapisać jako PARTIAL/FAILED. Retry musi żyć w jednej
  // warstwie - tu pilnujemy że scrapeDetail robi dokładnie 1 fetch.
  const { stub, calls } = makeFetchStub({
    [DETAIL_URL]: new StubResponse({ status: 503, body: "<html>upstream gone</html>" }),
  });

  await assert.rejects(
    () => scrapeDetail(FAKE_CARD, stub),
    (err) => err instanceof HttpError && err.status === 503,
  );
  assert.equal(calls.length, 1, "scrapeMarketplaceDetail must not retry internally");
});

test("detail parser rejects when __NEXT_DATA__ is missing", async () => {
  const { stub } = makeFetchStub({
    [DETAIL_URL]: new StubResponse({ body: "<html>maintenance</html>" }),
  });

  await assert.rejects(
    () => scrapeDetail(FAKE_CARD, stub),
    (err) => err instanceof HttpError && err.status === 502,
  );
});

test("detail parser rejects when __NEXT_DATA__ has no advert payload", async () => {
  // Build a __NEXT_DATA__ blob that has the marker substring but no advert
  // key. The parser must surface this as 502 rather than crash on a
  // null-deref or quietly return undefined.
  const brokenHtml = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {} } })}</script>
  </body></html>`;
  const { stub } = makeFetchStub({
    [DETAIL_URL]: new StubResponse({ body: brokenHtml }),
  });

  await assert.rejects(
    () => scrapeDetail(FAKE_CARD, stub),
    (err) => err instanceof HttpError && err.status === 502,
  );
});
