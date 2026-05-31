import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diffValueAddedServices,
  formatValueAddedServiceName,
  normalizeValueAddedServices,
} from "../../shared/value-added-services.js";

test("normalizeValueAddedServices sorts entries and strips transport noise", () => {
  const normalized = normalizeValueAddedServices([
    { __typename: "AdValueAddedService", appliedAt: "2026-04-08T10:50:00Z", exportedAdId: null, name: "bump_up", validity: null },
    { __typename: "AdValueAddedService", appliedAt: null, exportedAdId: "1051121566", name: "export_olx", validity: "2026-04-23T10:50:12Z" },
    { __typename: "AdValueAddedService", appliedAt: null, exportedAdId: null, name: "ad_homepage", validity: "2026-04-15T10:50:02Z" },
  ]);

  assert.deepEqual(normalized, [
    { name: "ad_homepage", validity: "2026-04-15T10:50:02Z", appliedAt: null, exportedAdId: null },
    { name: "bump_up", validity: null, appliedAt: "2026-04-08T10:50:00Z", exportedAdId: null },
    { name: "export_olx", validity: "2026-04-23T10:50:12Z", appliedAt: null, exportedAdId: "1051121566" },
  ]);
});

test("diffValueAddedServices treats pure reorder as equivalent after normalization", () => {
  const oldValue = JSON.stringify([
    { name: "export_olx", validity: "2026-04-12T08:41:08Z", appliedAt: null, exportedAdId: "996609190" },
    { name: "bump_up", validity: null, appliedAt: "2026-04-02T08:41:00Z", exportedAdId: null },
  ]);
  const newValue = JSON.stringify([
    { name: "bump_up", validity: null, appliedAt: "2026-04-02T08:41:00Z", exportedAdId: null },
    { name: "export_olx", validity: "2026-04-12T08:41:08Z", appliedAt: null, exportedAdId: "996609190" },
  ]);

  const diff = diffValueAddedServices(oldValue, newValue);
  assert.equal(diff.equivalentAfterNormalization, true);
  assert.equal(diff.addedCount, 0);
  assert.equal(diff.removedCount, 0);
  assert.equal(diff.changedCount, 0);
});

test("diffValueAddedServices surfaces added removed and changed services", () => {
  const oldValue = JSON.stringify([
    { name: "highlight", validity: "2026-04-26T15:05:32Z", appliedAt: null, exportedAdId: null },
    { name: "bump_up", validity: null, appliedAt: "2026-04-04T15:05:00Z", exportedAdId: null },
    { name: "export_olx", validity: "2026-04-26T15:05:32Z", appliedAt: null, exportedAdId: "1063522845" },
  ]);
  const newValue = JSON.stringify([
    { name: "export_olx", validity: "2026-04-26T15:05:32Z", appliedAt: null, exportedAdId: "1063522845" },
    { name: "ad_homepage", validity: "2026-04-15T10:50:02Z", appliedAt: null, exportedAdId: null },
    { name: "bump_up", validity: null, appliedAt: "2026-04-08T10:50:03Z", exportedAdId: null },
    { name: "topads", validity: "2026-04-15T10:50:03Z", appliedAt: null, exportedAdId: null },
  ]);

  const diff = diffValueAddedServices(oldValue, newValue);
  assert.equal(diff.equivalentAfterNormalization, false);
  assert.equal(diff.addedCount, 2);
  assert.equal(diff.removedCount, 1);
  assert.equal(diff.changedCount, 1);
  assert.deepEqual(diff.oldItems.map((item) => [item.name, item.diffKind]), [
    ["bump_up", "changed"],
    ["highlight", "removed"],
  ]);
  assert.deepEqual(diff.newItems.map((item) => [item.name, item.diffKind]), [
    ["ad_homepage", "added"],
    ["bump_up", "changed"],
    ["topads", "added"],
  ]);
});

test("formatValueAddedServiceName maps known service names to readable labels", () => {
  assert.equal(formatValueAddedServiceName("bump_up"), "Podbicie");
  assert.equal(formatValueAddedServiceName("export_olx"), "Eksport do OLX");
  assert.equal(formatValueAddedServiceName("unknown_service"), "unknown service");
});
