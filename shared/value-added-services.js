const VALUE_ADDED_SERVICE_LABELS = {
  ad_homepage: "Strona główna",
  bump_up: "Podbicie",
  export_olx: "Eksport do OLX",
  highlight: "Wyróżnienie",
  topads: "Top Ads",
};

function compareNullableStrings(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function normalizeValueAddedService(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.name !== "string" || item.name.length === 0) return null;
  return {
    name: item.name,
    validity: typeof item.validity === "string" && item.validity ? item.validity : null,
    appliedAt: typeof item.appliedAt === "string" && item.appliedAt ? item.appliedAt : null,
    exportedAdId: typeof item.exportedAdId === "string" && item.exportedAdId ? item.exportedAdId : null,
  };
}

function compareValueAddedServices(a, b) {
  return (
    compareNullableStrings(a.name, b.name) ||
    compareNullableStrings(a.exportedAdId, b.exportedAdId) ||
    compareNullableStrings(a.validity, b.validity) ||
    compareNullableStrings(a.appliedAt, b.appliedAt)
  );
}

function servicesEqual(a, b) {
  return (
    a.name === b.name &&
    a.validity === b.validity &&
    a.appliedAt === b.appliedAt &&
    a.exportedAdId === b.exportedAdId
  );
}

function groupByName(services) {
  const groups = new Map();
  for (const service of services) {
    const existing = groups.get(service.name);
    if (existing) existing.push(service);
    else groups.set(service.name, [service]);
  }
  return groups;
}

export function formatValueAddedServiceName(name) {
  return VALUE_ADDED_SERVICE_LABELS[name] || name.replace(/_/g, " ");
}

export function normalizeValueAddedServices(services) {
  if (!Array.isArray(services)) return [];
  return services
    .map(normalizeValueAddedService)
    .filter(Boolean)
    .sort(compareValueAddedServices);
}

export function parseValueAddedServices(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? normalizeValueAddedServices(parsed) : null;
  } catch {
    return null;
  }
}

export function diffValueAddedServices(oldInput, newInput) {
  const oldServices = Array.isArray(oldInput) ? normalizeValueAddedServices(oldInput) : parseValueAddedServices(oldInput);
  const newServices = Array.isArray(newInput) ? normalizeValueAddedServices(newInput) : parseValueAddedServices(newInput);
  if (oldServices == null || newServices == null) return null;

  const oldGroups = groupByName(oldServices);
  const newGroups = groupByName(newServices);
  const names = [...new Set([...oldGroups.keys(), ...newGroups.keys()])].sort((a, b) => a.localeCompare(b));

  const oldItems = [];
  const newItems = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;

  for (const name of names) {
    const oldGroup = oldGroups.get(name) || [];
    const newGroup = newGroups.get(name) || [];
    const max = Math.max(oldGroup.length, newGroup.length);
    for (let i = 0; i < max; i += 1) {
      const oldService = oldGroup[i];
      const newService = newGroup[i];
      if (oldService && !newService) {
        removedCount += 1;
        oldItems.push({ ...oldService, diffKind: "removed" });
      } else if (!oldService && newService) {
        addedCount += 1;
        newItems.push({ ...newService, diffKind: "added" });
      } else if (oldService && newService && !servicesEqual(oldService, newService)) {
        changedCount += 1;
        oldItems.push({ ...oldService, diffKind: "changed" });
        newItems.push({ ...newService, diffKind: "changed" });
      }
    }
  }

  return {
    oldItems,
    newItems,
    addedCount,
    removedCount,
    changedCount,
    equivalentAfterNormalization: addedCount === 0 && removedCount === 0 && changedCount === 0,
  };
}
