import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const connectionString = process.env.DATABASE_URL || "file:./data/heypost.db";
const databasePath = path.resolve(connectionString.replace(/^file:/, ""));
if (!fs.existsSync(databasePath)) {
  throw new Error(`Database tidak ditemukan: ${databasePath}. Migrasi dibatalkan.`);
}

const db = new Database(databasePath);
try {
  const columns = db.prepare("PRAGMA table_info(expenses)").all() as Array<{ name: string }>;
  if (!columns.length) throw new Error("Tabel expenses tidak ditemukan. Migrasi dibatalkan.");

  db.transaction(() => {
    if (!columns.some((column) => column.name === "status")) {
      db.exec("ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'Aktif'");
    }
  })();

  console.log("Migrasi status pengeluaran selesai. Data lama tetap berstatus Aktif.");
} finally {
  db.close();
}
