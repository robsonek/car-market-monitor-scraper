#!/usr/bin/env node
import { closeDatabase, openDatabase } from "../src/lib/db.js";
import { RUN_STATUSES, runAllActiveSources, runSourceById } from "../src/lib/scrape.js";
import { randomId } from "../src/lib/utils.js";

async function main() {
  const args = process.argv.slice(2);
  const sourceIdFlagIdx = args.findIndex((a) => a === "--source");
  const sourceId = sourceIdFlagIdx >= 0 ? args[sourceIdFlagIdx + 1] : null;
  const triggerType = process.env.CAR_MARKET_MONITOR_TRIGGER || "scheduled";
  const batchId = randomId();

  const db = openDatabase();
  try {
    const results = sourceId
      ? [await runSourceById(db, sourceId, { triggerType, batchId })]
      : await runAllActiveSources(db, { triggerType, batchId });

    if (results.length === 0) {
      console.log("nothing to do");
      return 0;
    }

    const failed = results.filter((r) => r.status === RUN_STATUSES.FAILED).length;
    const partial = results.filter((r) => r.status === RUN_STATUSES.PARTIAL_SUCCESS).length;
    const success = results.filter((r) => r.status === RUN_STATUSES.SUCCESS).length;
    console.log(`done: success=${success} partial=${partial} failed=${failed} total=${results.length}`);

    // Exit non-zero only when EVERY source failed. Mixed results are still a
    // useful run — workflow should commit the resulting db file regardless.
    return failed === results.length ? 2 : 0;
  } finally {
    // closeDatabase checkpointuje WAL i odświeża manifest jednym
    // atomowym krokiem — nie ma ścieżki przez którą można zostawić
    // manifest rozjechany z bazą.
    closeDatabase(db);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
