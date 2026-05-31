// Testy sanitizera / normalizera opisu. Cel: zagwarantować że to co trafia
// do payload_json.description_html jest stabilne między scrape'ami (phone
// tokeny rozwiązane) i bezpieczne do renderowania (niebezpieczne tagi ścięte).

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeDescriptionHtml } from "../../src/lib/description-html.js";

test("normalizeDescriptionHtml returns null for empty/missing input", () => {
  assert.equal(normalizeDescriptionHtml(null, new Map()), null);
  assert.equal(normalizeDescriptionHtml("", new Map()), null);
  assert.equal(normalizeDescriptionHtml("   ", new Map()), null);
});

test("normalizeDescriptionHtml preserves allowed formatting tags", () => {
  const html = "<p>Akapit <b>bold</b> i <i>italic</i>.</p><ul><li>jedno</li><li>dwa</li></ul>";
  const out = normalizeDescriptionHtml(html, new Map());
  assert.ok(out.includes("<p>"));
  assert.ok(out.includes("<b>bold</b>"));
  assert.ok(out.includes("<i>italic</i>"));
  assert.ok(out.includes("<ul>"));
  assert.ok(out.includes("<li>jedno</li>"));
});

test("normalizeDescriptionHtml resolves phoneNumber tokens to decrypted numbers", () => {
  const tokenA = "CIPHER-AAAA";
  const tokenB = "CIPHER-BBBB";
  const phoneMap = new Map([
    [tokenA, "+48111222333"],
    [tokenB, "+48444555666"],
  ]);
  const html = `<p>Zadzwoń: <span id="x" phoneNumber="${tokenA}">kliknij</span> lub <span phoneNumber="${tokenB}">kliknij</span>.</p>`;
  const out = normalizeDescriptionHtml(html, phoneMap);

  // Oba numery muszą być widoczne jako plaintext.
  assert.ok(out.includes("+48111222333"), "first phone not resolved");
  assert.ok(out.includes("+48444555666"), "second phone not resolved");
  // Oryginalny ciphertext nie może wyciec do wyjścia.
  assert.equal(out.includes("CIPHER-"), false, "raw ciphertext leaked");
  // Powinny być wrapnięte w <a data-kind="phone" href="tel:...">.
  assert.ok(out.includes('data-kind="phone"'));
  assert.ok(out.includes('href="tel:+48111222333"'));
});

test("normalizeDescriptionHtml is byte-stable when phoneNumber ciphertext rotates", () => {
  // Symulacja: te same numery, ale upstream zwrócił inne ciphertexty (np. po
  // rotacji IV). Resolved output musi być identyczny — to jest WHOLE POINT
  // tej normalizacji: bez tego hash i diff fluktują co scrape.
  const htmlA = `<p><span phoneNumber="TOKEN-v1">x</span></p>`;
  const htmlB = `<p><span phoneNumber="TOKEN-v2">x</span></p>`;
  const mapA = new Map([["TOKEN-v1", "+48111222333"]]);
  const mapB = new Map([["TOKEN-v2", "+48111222333"]]);
  assert.equal(
    normalizeDescriptionHtml(htmlA, mapA),
    normalizeDescriptionHtml(htmlB, mapB),
  );
});

test("normalizeDescriptionHtml drops script/style/iframe tags and their content", () => {
  const html = `<p>Tekst</p><script>alert("xss")</script><style>.a{}</style><iframe src="http://evil"></iframe><p>Dalej</p>`;
  const out = normalizeDescriptionHtml(html, new Map());
  assert.ok(out.includes("Tekst"));
  assert.ok(out.includes("Dalej"));
  assert.equal(out.toLowerCase().includes("<script"), false);
  assert.equal(out.toLowerCase().includes("alert"), false);
  assert.equal(out.toLowerCase().includes("<iframe"), false);
  assert.equal(out.toLowerCase().includes("<style"), false);
});

test("normalizeDescriptionHtml unwraps unknown tags but keeps their text content", () => {
  const html = `<custom-widget data-x="1"><p>Widoczny tekst</p></custom-widget>`;
  const out = normalizeDescriptionHtml(html, new Map());
  assert.ok(out.includes("<p>Widoczny tekst</p>"));
  assert.equal(out.includes("custom-widget"), false);
});

test("normalizeDescriptionHtml strips unsafe href schemes, keeps http(s)/tel/mailto", () => {
  const cases = [
    { input: `<a href="javascript:alert(1)">x</a>`, safe: false },
    { input: `<a href="data:text/html,<script>1</script>">x</a>`, safe: false },
    { input: `<a href="https://example.com">ok</a>`, safe: true, contains: 'href="https://example.com"' },
    { input: `<a href="tel:+48111222333">ok</a>`, safe: true, contains: 'href="tel:+48111222333"' },
    { input: `<a href="mailto:a@b.com">ok</a>`, safe: true, contains: 'href="mailto:a@b.com"' },
  ];
  for (const c of cases) {
    const out = normalizeDescriptionHtml(c.input, new Map()) || "";
    if (c.safe) {
      assert.ok(out.includes(c.contains), `expected safe href: ${c.input}`);
    } else {
      assert.equal(out.toLowerCase().includes("javascript:"), false);
      assert.equal(out.toLowerCase().includes("data:text"), false);
    }
  }
});

test("normalizeDescriptionHtml strips non-href attributes from allowed tags", () => {
  const html = `<p class="cms-style" onclick="boom()" data-x="1">Tekst</p>`;
  const out = normalizeDescriptionHtml(html, new Map());
  // Tylko `<p>` — żadnych atrybutów poza whitelistą (która dla <p> jest pusta).
  assert.ok(out.includes("<p>Tekst</p>"), `expected clean <p>, got: ${out}`);
  assert.equal(out.includes("onclick"), false);
  assert.equal(out.includes("cms-style"), false);
});

test("normalizeDescriptionHtml produces identical output for the same input (determinism)", () => {
  const html = `<p>Hello <b>world</b></p><ul><li>one</li></ul><span phoneNumber="TOK">x</span>`;
  const map = new Map([["TOK", "+48111222333"]]);
  const a = normalizeDescriptionHtml(html, map);
  const b = normalizeDescriptionHtml(html, map);
  assert.equal(a, b);
});
