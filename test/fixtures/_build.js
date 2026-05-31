// Fixture builder. Reads raw HTML pulled from the source marketplace into test/fixtures/.raw/
// (gitignored), redacts every PII-bearing field, re-encrypts VIN/registration/
// phone tokens with synthetic secrets so the production decryptToken() round-
// trips them back to known plaintext, and writes sanitized fixture HTMLs that
// are safe to commit.
//
// This script is NOT run by `npm test`. Re-run manually when the source page
// shape changes:
//
//     curl ... -o test/fixtures/.raw/listing.html
//     curl ... -o test/fixtures/.raw/detail.html
//     node test/fixtures/_build.js
//
// Design notes:
//   - We rebuild the entire __NEXT_DATA__ <script> tag from the redacted JSON.
//     The rest of the HTML body is replaced with a tiny stub: nothing in the
//     scrape pipeline reads outside __NEXT_DATA__, so the body just needs to
//     contain enough of a shell that fetchHtml's `includes("__NEXT_DATA__")`
//     guard fires.
//   - Encrypted token replacement uses a fixed IV (see test/_helpers/encrypt.js)
//     so the fixture is byte-stable across rebuilds — re-running this script
//     against an unchanged raw HTML produces no diff.
//   - Synthetic ad IDs are deterministic counters, not hashes, so they stay
//     human-readable in the fixture and tests can hard-code them.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encryptToken } from "../_helpers/encrypt.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(FIXTURES_DIR, ".raw");

const FAKE_ADVERT_ID = "1000000001";
const FAKE_SELLER_UUID = "00000000-0000-0000-0000-000000000001";
const FAKE_SELLER_ID = "9000001";
const FAKE_SELLER_NAME = "Test Dealer";
const FAKE_CITY = "TestCity";
const FAKE_REGION = "TestRegion";
const FAKE_VIN = "WAUZZZ00000000001";
const FAKE_REGISTRATION = "XX00000";
const FAKE_DATE_REGISTRATION = "2024-01-15";
const FAKE_PHONE = "+48000000001";
const FAKE_DESCRIPTION = "<p>Lorem ipsum placeholder description for fixture.</p>";

// Replacement-aware "marker" used to compute synthetic ad ids in the listing.
// Each card gets `100000000{idx+1}` so test code can hard-reference any card
// by position without grepping the fixture.
function fakeListingAdId(idx) {
  return `200000${String(idx + 1).padStart(4, "0")}`;
}

function fakeListingUrl(idx) {
  return `https://www.otomoto.pl/osobowe/oferta/test-fixture-${idx + 1}.html`;
}

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s;

function extractNextData(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) throw new Error("__NEXT_DATA__ not found in raw HTML");
  return JSON.parse(m[1]);
}

// Build a sanitized HTML shell. Production fetchHtml only checks for
// `__NEXT_DATA__` substring, then hands the whole HTML to a regex that pulls
// the script content. So a minimal <html><body> with the new script suffices.
function buildHtmlShell(nextData) {
  const json = JSON.stringify(nextData);
  // Escape </script in the JSON if present (defensive — the source payload
  // doesn't contain it, but synthetic descriptions might).
  const safe = json.replace(/<\/script/gi, "<\\/script");
  return `<!DOCTYPE html>
<html lang="pl"><head><meta charset="utf-8"><title>market fixture</title></head>
<body>
<script id="__NEXT_DATA__" type="application/json">${safe}</script>
</body></html>
`;
}

// ---------- detail redaction ----------

async function redactDetail(rawHtml) {
  const nextData = extractNextData(rawHtml);
  const advert = nextData?.props?.pageProps?.advert;
  if (!advert) throw new Error("advert not found in detail payload");

  // Re-encrypt every token field with the FAKE secrets so the production
  // decrypt path round-trips back to FAKE plaintext. Real tokens are entirely
  // replaced — original ciphertext + original keys never reach the fixture.
  const vinToken = await encryptToken(FAKE_VIN, FAKE_ADVERT_ID);
  const regToken = await encryptToken(FAKE_REGISTRATION, FAKE_ADVERT_ID);
  const dateRegToken = await encryptToken(FAKE_DATE_REGISTRATION, FAKE_ADVERT_ID);
  const phoneToken = await encryptToken(FAKE_PHONE, FAKE_SELLER_UUID);

  advert.id = FAKE_ADVERT_ID;
  advert.url = `https://www.otomoto.pl/osobowe/oferta/test-fixture-detail-ID${FAKE_ADVERT_ID}.html`;
  advert.description = FAKE_DESCRIPTION;
  advert.phoneNumbers = [phoneToken];

  // parametersDict: replace token values for the three crypto-bearing keys.
  // Other params (make/model/mileage/etc.) are non-PII car attributes — keep.
  if (advert.parametersDict?.vin?.values?.[0]) {
    advert.parametersDict.vin.values[0].value = vinToken;
    advert.parametersDict.vin.values[0].label = "—";
  }
  if (advert.parametersDict?.registration?.values?.[0]) {
    advert.parametersDict.registration.values[0].value = regToken;
    advert.parametersDict.registration.values[0].label = "—";
  }
  if (advert.parametersDict?.date_registration?.values?.[0]) {
    advert.parametersDict.date_registration.values[0].value = dateRegToken;
    advert.parametersDict.date_registration.values[0].label = "—";
  }

  // details[]: same crypto fields appear here too as `value`. Strip hrefs
  // because some carry advert-id query params; source category hrefs (no
  // ad-specific data) are kept where present, but for safety we null all.
  for (const d of advert.details || []) {
    if (d.key === "vin") d.value = vinToken;
    else if (d.key === "registration") d.value = regToken;
    else if (d.key === "date_registration") d.value = dateRegToken;
    d.href = null;
  }

  // Seller: every field synthetic. Wipe location to a single city/region
  // pair — no address, no postal code, no map coordinates pinning a real
  // dealer.
  advert.seller = {
    type: advert.seller?.type || "company",
    name: FAKE_SELLER_NAME,
    id: FAKE_SELLER_ID,
    uuid: FAKE_SELLER_UUID,
    featuresBadges: [],
    location: {
      city: FAKE_CITY,
      region: FAKE_REGION,
      map: { latitude: 0, longitude: 0 },
    },
  };

  // Images: rebuild from scratch with only `photos` (the only key the parser
  // reads). The raw payload also has `thumbnails[]` whose URLs leak the
  // original CDN hashes — drop them entirely.
  const photoCount = advert.images?.photos?.length || 0;
  advert.images = {
    photos: Array.from({ length: photoCount }, (_, idx) => ({
      url: `https://example.invalid/photo-${idx + 1}.jpg`,
    })),
  };

  // Strip everything from props except pageProps.advert. The detail parser
  // only reads pageProps.advert; the rest (widgets, sentry, financingX,
  // urqlState, dealerRatings, $_optimusContextProps at 234 KB,
  // __namespaces at 63 KB, ...) is dead weight in the fixture and may
  // contain stale PII from related queries. Cuts the fixture from 322 KB
  // → ~35 KB.
  nextData.props = { pageProps: { advert } };

  return buildHtmlShell(nextData);
}

// ---------- listing redaction ----------

function redactListing(rawHtml) {
  const nextData = extractNextData(rawHtml);
  const urqlState = nextData?.props?.pageProps?.urqlState || {};

  // Strip every urql entry that doesn't carry advertSearch. The raw page
  // also caches a related-listings query (~660 KB) that the parser ignores
  // but bloats the fixture; dropping it cuts the file by ~75%.
  for (const key of Object.keys(urqlState)) {
    const state = urqlState[key];
    let keep = false;
    try {
      keep = !!JSON.parse(state?.data || "{}")?.advertSearch;
    } catch {}
    if (!keep) delete urqlState[key];
  }

  // Find the urql cache entry that holds advertSearch. We rewrite it in place
  // and then re-stringify back into state.data — same shape the parser reads.
  let touched = false;
  for (const state of Object.values(urqlState)) {
    if (!state?.data) continue;
    let payload;
    try {
      payload = JSON.parse(state.data);
    } catch {
      continue;
    }
    if (!payload?.advertSearch) continue;

    const search = payload.advertSearch;
    const edges = search.edges || [];
    // Rebuild every edge from scratch with ONLY the fields extractListingCards
    // reads. Spreading `...node` into the fake leaks fields we don't even
    // know about (sellerUUID, thumbnail, dealer4thPackage, priceEvaluation,
    // brandProgram, ...) — see leak audit. The parser only touches:
    //   node: id, title, shortDescription, url, createdAt, parameters,
    //         price, location, sellerLink, isPremiumTopAd, badges
    //   edge: vas (isHighlighted, isPromoted, bumpDate)
    const sanitizedEdges = edges.map((edge, idx) => {
      const node = edge.node || {};
      const fakeId = fakeListingAdId(idx);
      return {
        __typename: "AdvertSearchEdge",
        node: {
          __typename: "Advert",
          id: fakeId,
          title: `Porsche Taycan Test #${idx + 1}`,
          shortDescription: null,
          url: fakeListingUrl(idx),
          createdAt: node.createdAt || "2026-01-01T00:00:00Z",
          // parameters[] are non-PII car specs (make/model/year/mileage/...)
          // — keep as-is so extractListingCards has realistic typed input.
          parameters: node.parameters || [],
          // price.amount + price.badges are the only fields the parser reads.
          // Strip currency conversion data and whatever else might be nested.
          price: {
            __typename: "Price",
            amount: {
              __typename: "Money",
              value: node.price?.amount?.value || null,
              currencyCode: node.price?.amount?.currencyCode || null,
            },
            badges: node.price?.badges || [],
          },
          location: {
            __typename: "Location",
            city: { __typename: "AdministrativeLevel", name: FAKE_CITY },
            region: { __typename: "AdministrativeLevel", name: FAKE_REGION },
          },
          sellerLink: {
            __typename: "AdvertSellerLink",
            id: FAKE_SELLER_ID,
            name: FAKE_SELLER_NAME,
            websiteUrl: "https://example.invalid/dealer",
          },
          isPremiumTopAd: !!node.isPremiumTopAd,
          badges: node.badges || [],
        },
        vas: {
          __typename: "VAS",
          isHighlighted: !!edge.vas?.isHighlighted,
          isPromoted: !!edge.vas?.isPromoted,
          bumpDate: edge.vas?.bumpDate || null,
        },
      };
    });
    // Rebuild advertSearch from scratch with only parser-needed fields.
    // Drops facets/alternativeLinks/subscriptionKey/breadcrumbs/appliedLocation
    // which can carry city names and other PII.
    payload.advertSearch = {
      __typename: "AdvertSearchOutput",
      totalCount: search.totalCount || 0,
      pageInfo: search.pageInfo || { __typename: "Pager", pageSize: 32, currentOffset: 0 },
      edges: sanitizedEdges,
    };
    state.data = JSON.stringify(payload);
    touched = true;
  }

  if (!touched) throw new Error("advertSearch not found in listing payload");

  // Prune everything from props except pageProps.urqlState. The listing
  // parser only reads pageProps.urqlState; the rest ($_optimusContextProps
  // alone is 234 KB) is dead weight. Same logic as the detail prune.
  nextData.props = { pageProps: { urqlState } };
  return buildHtmlShell(nextData);
}

// ---------- main ----------

async function main() {
  const rawDetail = readFileSync(join(RAW_DIR, "detail.html"), "utf8");
  const rawListing = readFileSync(join(RAW_DIR, "listing.html"), "utf8");

  const detailOut = await redactDetail(rawDetail);
  const listingOut = redactListing(rawListing);

  writeFileSync(join(FIXTURES_DIR, "detail-page-full.html"), detailOut);
  writeFileSync(join(FIXTURES_DIR, "listing-page-basic.html"), listingOut);

  // Sanity report
  const sizeKb = (s) => `${(s.length / 1024).toFixed(1)} KB`;
  console.log(`detail-page-full.html  ${sizeKb(detailOut)}`);
  console.log(`listing-page-basic.html ${sizeKb(listingOut)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
