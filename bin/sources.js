#!/usr/bin/env node
import { Command } from "commander";
import { closeDatabase, openDatabase } from "../src/lib/db.js";
import { createSource, listSources, removeSource, setSourceActive } from "../src/lib/scrape.js";

const program = new Command();
program.name("sources").description("Manage Car Market Monitor sources");

// Każda komenda (także `list`!) musi iść przez closeDatabase, bo
// openDatabase() zawsze woła applyMigrations() — na starej bazie
// samo otwarcie może zbumpować user_version i zmienić plik na dysku.
// closeDatabase() gwarantuje że manifest pozostaje zgodny z bazą.
function withDb(fn) {
  const db = openDatabase();
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

program
  .command("add")
  .requiredOption("--url <url>", "source search URL")
  .option("--name <name>", "human-readable label")
  .action((opts) => {
    withDb((db) => {
      const source = createSource(db, { url: opts.url, name: opts.name || null });
      console.log(JSON.stringify(source, null, 2));
    });
  });

program
  .command("list")
  .action(() => {
    withDb((db) => {
      const rows = listSources(db);
      if (rows.length === 0) {
        console.log("no sources");
        return;
      }
      for (const row of rows) {
        console.log(
          `${row.id}  active=${row.is_active ? "y" : "n"}  ${row.name || "(unnamed)"}\n  ${row.url}\n  last_run=${row.last_run_at || "-"}  last_success=${row.last_success_at || "-"}`,
        );
      }
    });
  });

program
  .command("remove")
  .requiredOption("--id <id>", "source id")
  .action((opts) => {
    withDb((db) => {
      const removed = removeSource(db, opts.id);
      console.log(removed ? "removed" : "not found");
    });
  });

program
  .command("disable")
  .requiredOption("--id <id>", "source id")
  .action((opts) => {
    withDb((db) => {
      const ok = setSourceActive(db, opts.id, false);
      console.log(ok ? "disabled" : "not found");
    });
  });

program
  .command("enable")
  .requiredOption("--id <id>", "source id")
  .action((opts) => {
    withDb((db) => {
      const ok = setSourceActive(db, opts.id, true);
      console.log(ok ? "enabled" : "not found");
    });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
