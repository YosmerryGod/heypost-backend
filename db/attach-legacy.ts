import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { normalizeEmail } from "../api/auth/owners";
import { categories, outlets, products, transactions, users } from "./schema";

const email = process.env.LEGACY_OWNER_EMAIL;
const outletId = Number(process.env.LEGACY_OUTLET_ID);

if (!email || !Number.isInteger(outletId) || outletId <= 0) {
  console.error("Isi LEGACY_OWNER_EMAIL dan LEGACY_OUTLET_ID sebelum menjalankan script ini.");
  process.exit(1);
}

const db = getDb();
const [user] = db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1).all();
if (!user) throw new Error("Akun owner tidak ditemukan.");
const [outlet] = db.select().from(outlets).where(and(
  eq(outlets.id, outletId),
  eq(outlets.storeId, user.storeId),
)).limit(1).all();
if (!outlet) throw new Error("Outlet tidak ditemukan di toko owner tersebut.");

const unassigned = and(isNull(categories.storeId), isNull(categories.outletId));
const result = db.transaction((tx) => {
  const categoryResult = tx.update(categories).set({ storeId: user.storeId, outletId })
    .where(unassigned).run();
  const productResult = tx.update(products).set({ storeId: user.storeId, outletId })
    .where(and(isNull(products.storeId), isNull(products.outletId))).run();
  const transactionResult = tx.update(transactions).set({ storeId: user.storeId, outletId })
    .where(and(isNull(transactions.storeId), isNull(transactions.outletId))).run();
  return {
    categories: categoryResult.changes,
    products: productResult.changes,
    transactions: transactionResult.changes,
  };
});

console.log(`Data lama dipindahkan: ${result.categories} kategori, ${result.products} produk, ${result.transactions} transaksi.`);
