// Tests for normalizeDetail. The function fans out into:
//   - parametersDict → typed param columns (extractParams)
//   - encrypted-token decryption (vin/registration/date_registration + phones)
//   - inline phone token harvest from description HTML
//   - image URL canonicalization (sorted)
//   - flattenForDiff field_map
//   - condition mapping (extractCondition / yesNoToInt)
//
// We feed it a synthetic advert object built in code (not HTML) so the test
// is independent of __NEXT_DATA__ shape changes that the HTTP-level fixture
// tests will catch separately.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeDetail } from "../../src/lib/marketplace-source.js";
import { encryptToken } from "../_helpers/encrypt.js";

const FAKE_ADVERT_ID = "99999999";
const FAKE_SELLER_UUID = "00000000-0000-0000-0000-000000000001";
const FAKE_VIN = "WAUZZZ00000000001";
const FAKE_REG = "XX00000";
const FAKE_DATE_REG = "2023-01-15";
const FAKE_PHONE_A = "+48000000001";
const FAKE_PHONE_B = "+48000000002";
const FAKE_INLINE_PHONE = "+48000000003";

async function buildSyntheticAdvert() {
  // Encrypted tokens are deterministic (fixed IV in test/_helpers/encrypt.js),
  // so the field_map / hash assertions below stay stable across runs.
  const vinToken = await encryptToken(FAKE_VIN, FAKE_ADVERT_ID);
  const regToken = await encryptToken(FAKE_REG, FAKE_ADVERT_ID);
  const dateRegToken = await encryptToken(FAKE_DATE_REG, FAKE_ADVERT_ID);
  const phoneAToken = await encryptToken(FAKE_PHONE_A, FAKE_SELLER_UUID);
  const phoneBToken = await encryptToken(FAKE_PHONE_B, FAKE_SELLER_UUID);
  const inlinePhoneToken = await encryptToken(FAKE_INLINE_PHONE, FAKE_SELLER_UUID);

  return {
    id: FAKE_ADVERT_ID,
    url: "https://www.otomoto.pl/osobowe/oferta/test-ID99999.html",
    title: "Porsche Taycan Turbo S",
    status: "active",
    createdAt: "2026-01-01T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
    originalCreatedAt: "2025-12-15T10:00:00Z",
    price: { value: 450000, currency: "PLN", labels: ["Cena do negocjacji"], isUnderBudget: false },
    description: `<p>Stan idealny.</p><span id="hiddenPhoneNumber" phoneNumber="${inlinePhoneToken}"></span>`,
    mainFeatures: ["abs", "esp"],
    adFeatures: ["heated_seats", "navi"],
    badges: ["promoted", "top"],
    seller: {
      type: "company",
      name: "Test Seller GmbH",
      id: 12345,
      uuid: FAKE_SELLER_UUID,
      featuresBadges: [{ label: "Authorized" }],
      location: {
        city: "Warszawa",
        region: "Mazowieckie",
        map: { latitude: 52.23, longitude: 21.01 },
      },
    },
    details: [
      { key: "title", label: "Tytuł", value: "Porsche Taycan", group: "general" },
    ],
    detailsGroups: [{ key: "general", label: "Ogólne" }],
    equipment: [
      // Note: values intentionally unsorted; normalizeDetail must sort them.
      { key: "comfort", label: "Komfort", values: [{ label: "Klimatyzacja" }, { label: "Apple CarPlay" }] },
    ],
    parametersDict: {
      make: { label: "Marka", values: [{ label: "Porsche", value: "porsche" }] },
      model: { label: "Model", values: [{ label: "Taycan", value: "taycan" }] },
      year: { label: "Rok", values: [{ label: "2022", value: "2022" }] },
      mileage: { label: "Przebieg", values: [{ label: "30 000 km", value: "30000" }] },
      fuel_type: { label: "Paliwo", values: [{ label: "Elektryczny", value: "electric" }] },
      engine_power: { label: "Moc", values: [{ label: "761 KM", value: "761" }] },
      damaged: { label: "Uszkodzony", values: [{ label: "Nie", value: "0" }] },
      no_accident: { label: "Bezwypadkowy", values: [{ label: "Tak", value: "1" }] },
      vin: { label: "VIN", values: [{ label: "—", value: vinToken }] },
      registration: { label: "Nr rej.", values: [{ label: "—", value: regToken }] },
      date_registration: { label: "Pierwsza rej.", values: [{ label: "—", value: dateRegToken }] },
      new_used: { label: "Stan", values: [{ label: "Używane", value: "used" }] },
    },
    images: {
      photos: [
        // intentionally out of lexical order; normalizeDetail must sort
        { url: "https://example.invalid/photo-c.jpg" },
        { url: "https://example.invalid/photo-a.jpg" },
        { url: "https://example.invalid/photo-b.jpg" },
      ],
    },
    phoneNumbers: [phoneBToken, phoneAToken], // unsorted on purpose
    verifiedCar: true,
    isUsedCar: true,
    isParts: false,
    packages: [],
    valueAddedServices: [
      { __typename: "AdValueAddedService", name: "export_olx", validity: "2026-04-13T13:40:19Z", appliedAt: null, exportedAdId: "1000574777" },
      { __typename: "AdValueAddedService", name: "bump_up", validity: null, appliedAt: "2026-04-07T13:40:00Z", exportedAdId: null },
      { __typename: "AdValueAddedService", name: "topads", validity: "2026-03-21T14:40:20Z", appliedAt: null, exportedAdId: null },
    ],
  };
}

const FAKE_CARD = {
  ad_id: FAKE_ADVERT_ID,
  page_number: 1,
  page_position: 3,
  short_description: "card desc",
  mileage: 30000,
  year: 2022,
};

test("normalizeDetail decrypts vin/registration/date_registration tokens", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  assert.equal(detail.vin, FAKE_VIN);
  assert.equal(detail.registration, FAKE_REG);
  assert.equal(detail.date_registration, FAKE_DATE_REG);
});

test("normalizeDetail decrypts phones (main + inline) and sorts them", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  const phones = JSON.parse(detail.phones_json);
  // main: original order preserved (decryptTokens preserves order)
  assert.deepEqual(phones.main, [FAKE_PHONE_B, FAKE_PHONE_A]);
  assert.deepEqual(phones.description, [FAKE_INLINE_PHONE]);

  // payload.decrypted.* must be sorted (stability across runs)
  assert.deepEqual(detail.payload.decrypted.phones_main, [FAKE_PHONE_A, FAKE_PHONE_B]);
  assert.deepEqual(detail.payload.decrypted.phones_description, [FAKE_INLINE_PHONE]);
});

test("normalizeDetail normalizes description HTML and stores only the HTML form", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  // Raw advert.description ma rotujący phoneNumber token. normalizeDetail
  // przechodzi przez normalizeDescriptionHtml, więc zapisane payload.description_html
  // powinno mieć już podmieniony <a href="tel:..."> z odszyfrowanym numerem —
  // NIE surowy ciphertext z upstream'u.
  assert.ok(detail.payload.description_html.includes("Stan idealny."), "description_html missing text");
  assert.ok(
    detail.payload.description_html.includes(FAKE_INLINE_PHONE),
    "description_html should contain resolved inline phone number",
  );
  assert.equal(
    detail.payload.description_html.includes("phoneNumber="),
    false,
    "raw phoneNumber ciphertext attribute leaked into stored HTML",
  );

  // W payload_json nie ma description_text — tylko opis jako HTML.
  assert.equal(Object.hasOwn(detail.payload, "description_text"), false);

  // field_map ma obie formy: description_text (dla diffów/hasha, derywowane
  // ze stripHtml znormalizowanego HTML'a) i description_html (transit, filtr
  // noisy w computeSnapshotHash). Tekst musi zawierać widoczny numer telefonu,
  // bo siedzi teraz w HTML jako plaintext po ingest'cie.
  assert.ok(detail.field_map.description_text.includes("Stan idealny."));
  assert.ok(detail.field_map.description_text.includes(FAKE_INLINE_PHONE));
  assert.ok(Object.hasOwn(detail.field_map, "description_html"));
});

test("normalizeDetail no longer exposes top-level description_text (stored only via payload_json)", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  // detail.description_text zostało skasowane z return value — scrape.js
  // nie pisze już do listing_snapshots.description_text bo kolumna nie istnieje.
  assert.equal(Object.hasOwn(detail, "description_text"), false);
});

test("normalizeDetail extracts and resolves lowercase phonenumber attribute", async () => {
  // Upstream HTML miesza `phoneNumber` i `phonenumber` — regex wyciągający
  // tokeny MUSI być case-insensitive, inaczej inline numer znika przed
  // decryptem i phones_json.description zostaje puste. Regresja: wcześniej
  // regex miał tylko `g` bez `i`, więc ten test by failował.
  const lowercaseInlineToken = await encryptToken(FAKE_INLINE_PHONE, FAKE_SELLER_UUID);
  const advert = await buildSyntheticAdvert();
  advert.description = `<p>Stan idealny.</p><span phonenumber="${lowercaseInlineToken}">kliknij</span>`;

  const detail = await normalizeDetail(advert, FAKE_CARD);
  const phones = JSON.parse(detail.phones_json);

  assert.deepEqual(phones.description, [FAKE_INLINE_PHONE], "lowercase phonenumber token was dropped");
  assert.ok(
    detail.payload.description_html.includes(FAKE_INLINE_PHONE),
    "lowercase phonenumber token not resolved in stored HTML",
  );
  assert.equal(
    detail.payload.description_html.toLowerCase().includes("phonenumber="),
    false,
    "raw phonenumber attribute leaked into stored HTML",
  );
});

test("normalizeDetail survives one undecryptable inline phone token without corrupting others", async () => {
  // Regresja: decryptTokens filtrowało nulle, więc zły token w środku listy
  // przesuwał indeksy i następny `phoneTokenMap.set(inputTokens[i], ...)`
  // łączył zły token z numerem który należał do zupełnie innego. Efekt:
  // ten sam numer pojawiał się dla dwóch różnych tokenów i/lub dobry token
  // dostawał zły numer. Poprawka: decryptTokens zachowuje nulle na swoich
  // pozycjach, caller iteruje po raw arrayu i pomija nullowe pary.
  const okTokenA = await encryptToken("+48111111111", FAKE_SELLER_UUID);
  const okTokenB = await encryptToken("+48222222222", FAKE_SELLER_UUID);
  const advert = await buildSyntheticAdvert();
  advert.description =
    `<p>Numery:</p>` +
    `<span phoneNumber="${okTokenA}">a</span>` +
    // Celowo zły token — decryptToken zwróci null.
    `<span phoneNumber="CORRUPT-NOT-BASE64">b</span>` +
    `<span phoneNumber="${okTokenB}">c</span>`;

  const detail = await normalizeDetail(advert, FAKE_CARD);
  const phones = JSON.parse(detail.phones_json);

  // phones_json.description: dobre numery zostają, zły jest odfiltrowany.
  // Kluczowe: kolejność pozostaje (+48111111111 PRZED +48222222222), bo
  // positional alignment jest zachowane w raw arrayu.
  assert.deepEqual(phones.description, ["+48111111111", "+48222222222"]);

  // Storage HTML ma dokładnie jeden anchor per numer, każdy z właściwym
  // `tel:` hrefem. Liczymy hrefy (nie surowy tekst), bo każdy numer pojawia
  // się w HTML dwa razy — raz w atrybucie `href="tel:..."` i raz jako tekst
  // linka — a interesuje nas kardynalność linków, nie surowych wystąpień.
  const html = detail.payload.description_html;
  assert.equal((html.match(/href="tel:\+48111111111"/g) || []).length, 1, "first number anchor missing or duplicated");
  assert.equal((html.match(/href="tel:\+48222222222"/g) || []).length, 1, "second number anchor missing or duplicated");
  // Uszkodzony token nie może wyciec do storage'u.
  assert.equal(html.includes("CORRUPT"), false);
  // I nie może się wyprodukować kolejny anchor z przesuniętym numerem —
  // np. drugi okToken nie może dostać numeru pierwszego przez indeks shift.
  const anchorOrder = [...html.matchAll(/href="tel:(\+48\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(anchorOrder, ["+48111111111", "+48222222222"], "anchor order desynced from token order");
});

test("normalizeDetail preserves original image URL order", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  assert.equal(detail.image_count, 3);
  assert.deepEqual(detail.payload.images.urls, [
    "https://example.invalid/photo-c.jpg",
    "https://example.invalid/photo-a.jpg",
    "https://example.invalid/photo-b.jpg",
  ]);
});

test("normalizeDetail sorts valueAddedServices to avoid reorder-only diffs", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  assert.deepEqual(detail.payload.value_added_services, [
    { name: "bump_up", validity: null, appliedAt: "2026-04-07T13:40:00Z", exportedAdId: null },
    { name: "export_olx", validity: "2026-04-13T13:40:19Z", appliedAt: null, exportedAdId: "1000574777" },
    { name: "topads", validity: "2026-03-21T14:40:20Z", appliedAt: null, exportedAdId: null },
  ]);
});

test("normalizeDetail materializes typed param columns from parametersDict", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  assert.equal(detail.params.make, "porsche");
  assert.equal(detail.params.model, "taycan");
  assert.equal(detail.params.year, 2022); // INT, not "2022"
  assert.equal(detail.params.mileage, 30000); // INT, not "30 000 km"
  assert.equal(detail.params.engine_power, 761);
  assert.equal(detail.params.damaged, 0); // BOOL "0" → 0
  assert.equal(detail.params.no_accident, 1); // BOOL "1" → 1
});

test("normalizeDetail extractCondition maps Tak/Nie labels to 1/0", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  assert.equal(detail.condition.damaged, 0);
  assert.equal(detail.condition.no_accident, 1);
  assert.equal(detail.condition.new_used, "Używane");
});

test("normalizeDetail uses typed mileage/year (not human label) for legacy text columns", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  // Regression: previously detail.mileage came from advert.details which
  // serialized "30 000 km" — Number/CAST stops at the first space and yields
  // 30 instead of 30000, breaking UI filtering.
  assert.equal(detail.mileage, "30000");
  assert.equal(detail.year, "2022");
});

test("normalizeDetail field_map excludes listing_card noise (page_number/position)", async () => {
  const advert = await buildSyntheticAdvert();
  const detail = await normalizeDetail(advert, FAKE_CARD);

  const keys = Object.keys(detail.field_map);
  // listing_card.* MUST NOT appear in field_map — it lives only in payload
  assert.equal(keys.some((k) => k.startsWith("listing_card")), false);
  // sanity: real fields ARE present
  assert.equal(keys.includes("title"), true);
});

test("normalizeDetail produces a deterministic field_map across calls", async () => {
  // Two independent advert objects with the same content must produce the
  // same field_map. This catches future regressions where iteration order or
  // Map vs Object semantics leak into the output.
  const a = await normalizeDetail(await buildSyntheticAdvert(), FAKE_CARD);
  const b = await normalizeDetail(await buildSyntheticAdvert(), FAKE_CARD);
  assert.deepEqual(a.field_map, b.field_map);
});
