import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_EMPLOYEE_PERMISSIONS } from "../api/permissions";

const connectionString = process.env.DATABASE_URL || "file:./data/heypost.db";
const databasePath = path.resolve(connectionString.replace(/^file:/, ""));
if (!fs.existsSync(databasePath)) {
  throw new Error(`Database tidak ditemukan: ${databasePath}. Migrasi dibatalkan.`);
}

const db = new Database(databasePath);
try {
  const columns = db.prepare("PRAGMA table_info(employees)").all() as Array<{ name: string }>;
  if (!columns.length) throw new Error("Tabel employees tidak ditemukan. Migrasi dibatalkan.");

  db.transaction(() => {
    if (!columns.some((column) => column.name === "permissions")) {
      db.exec("ALTER TABLE employees ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'");
    }
    db.prepare("UPDATE employees SET permissions = ? WHERE role = 'manager' AND (permissions IS NULL OR permissions = '' OR permissions = '[]')")
      .run(JSON.stringify(DEFAULT_EMPLOYEE_PERMISSIONS.manager));
    db.prepare("UPDATE employees SET permissions = ? WHERE role = 'kasir' AND (permissions IS NULL OR permissions = '' OR permissions = '[]')")
      .run(JSON.stringify(DEFAULT_EMPLOYEE_PERMISSIONS.kasir));
  })();

  console.log("Migrasi employee permissions selesai. Tidak ada data karyawan yang dihapus.");
} finally {
  db.close();
}
