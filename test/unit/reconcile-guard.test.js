// Unit-testy progów H2 completeness guard (isReconcileSuspect). Czysta funkcja
// decydująca, czy discovery jest na tyle niekompletny, że reconcile zniknięć
// byłby niebezpieczny. Progi: RECONCILE_MIN_MISSING_FOR_GUARD=10,
// RECONCILE_MAX_MISSING_RATIO=0.30.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isReconcileSuspect } from "../../src/lib/scrape.js";

test("isReconcileSuspect: pierwszy run / brak inwentarza nie wyzwala guarda", () => {
  assert.equal(isReconcileSuspect({ activeCount: 0, seenCount: 0, missingCount: 0 }), false);
  assert.equal(isReconcileSuspect({ activeCount: 0, seenCount: 5, missingCount: 0 }), false);
});

test("isReconcileSuspect: mała skala zniknięć NIE wyzwala guarda", () => {
  // Pojedyncze realne zniknięcie - reconcile/hysteresis ma działać normalnie.
  assert.equal(isReconcileSuspect({ activeCount: 1, seenCount: 0, missingCount: 1 }), false);
  // Małe źródło legalnie schodzi do zera (total=0) - poniżej progu bezwzględnego.
  assert.equal(isReconcileSuspect({ activeCount: 5, seenCount: 0, missingCount: 5 }), false);
  // 9 zniknięć < próg 10.
  assert.equal(isReconcileSuspect({ activeCount: 100, seenCount: 91, missingCount: 9 }), false);
});

test("isReconcileSuspect: total=0 / soft-block przy dużym inwentarzu -> suspect", () => {
  assert.equal(isReconcileSuspect({ activeCount: 15, seenCount: 0, missingCount: 15 }), true);
  assert.equal(isReconcileSuspect({ activeCount: 965, seenCount: 0, missingCount: 965 }), true);
});

test("isReconcileSuspect: obcięta paginacja (duże znikanie powyżej progu %) -> suspect", () => {
  assert.equal(isReconcileSuspect({ activeCount: 965, seenCount: 10, missingCount: 955 }), true);
  assert.equal(isReconcileSuspect({ activeCount: 100, seenCount: 60, missingCount: 40 }), true); // 40%
});

test("isReconcileSuspect: normalny churn NIE wyzwala guarda", () => {
  // Duże źródło, znika powyżej progu bezwzględnego, ale poniżej procentowego.
  assert.equal(isReconcileSuspect({ activeCount: 965, seenCount: 945, missingCount: 20 }), false); // ~2%
  assert.equal(isReconcileSuspect({ activeCount: 100, seenCount: 75, missingCount: 25 }), false); // 25%
});

test("isReconcileSuspect: granice progów", () => {
  // missingCount dokładnie = MIN (10) ale ratio mały -> false.
  assert.equal(isReconcileSuspect({ activeCount: 100, seenCount: 90, missingCount: 10 }), false); // 10%
  // ratio dokładnie 30% -> false (próg ostry >).
  assert.equal(isReconcileSuspect({ activeCount: 100, seenCount: 70, missingCount: 30 }), false);
  // tuż powyżej 30% i powyżej MIN -> true.
  assert.equal(isReconcileSuspect({ activeCount: 100, seenCount: 69, missingCount: 31 }), true);
});
