import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL || "file:./data/heypost.db";
const databasePath = connectionString.replace(/^file:/, "");
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: databasePath },
});
