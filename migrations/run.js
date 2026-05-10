#!/usr/bin/env node

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: `.env.${process.env.NODE_ENV || "development"}` });
require("dotenv").config();
require("ts-node/register");

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { logger } = require("../internal/pkg/logger");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    logger.error("ERROR: DATABASE_URL environment variable is not set.");
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
      logger.info(`Running migration: ${file}`);
      await client.query(sql);
      logger.success(`  ✓ ${file} completed`);
    }
    logger.success("All migrations completed successfully.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  logger.error("Migration failed", err);
  process.exit(1);
});
