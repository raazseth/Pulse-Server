#!/usr/bin/env node
/**
 * Programmatic migration runner.
 * Reads DATABASE_URL from the environment and executes each .sql file in
 * migrations/ in lexicographic order (001_, 002_, …).
 *
 * Usage:
 *   DATABASE_URL=postgres://… node migrations/run.js
 *   node migrations/run.js  # reads .env if dotenv is present
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const migrationsDir = __dirname;
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (sqlFiles.length === 0) {
    console.log("No .sql migration files found.");
    return;
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    for (const file of sqlFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf8");
      console.log(`Running migration: ${file}`);
      await client.query(sql);
      console.log(`  ✓ ${file} completed`);
    }
    console.log("All migrations completed successfully.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
