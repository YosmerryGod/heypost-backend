import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const createdAt = () => integer("createdAt", { mode: "timestamp_ms" })
  .notNull()
  .default(sql`(unixepoch() * 1000)`);

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  sortOrder: integer("sortOrder").notNull().default(0),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  categoryId: integer("categoryId").notNull().references(() => categories.id),
  name: text("name").notNull(),
  sku: text("sku").notNull().unique(),
  price: integer("price").notNull(),
  stock: integer("stock").notNull().default(0),
  imageUrl: text("imageUrl").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceNumber: text("invoiceNumber").notNull().unique(),
  customerName: text("customerName"),
  orderType: text("orderType", { enum: ["Makan di tempat", "Bawa pulang", "Pesan antar"] }).notNull(),
  paymentMethod: text("paymentMethod", { enum: ["Tunai", "QRIS", "Kartu"] }).notNull(),
  status: text("status", { enum: ["Selesai", "Dibatalkan"] }).notNull().default("Selesai"),
  subtotal: integer("subtotal").notNull(),
  discount: integer("discount").notNull().default(0),
  total: integer("total").notNull(),
  cashReceived: integer("cashReceived"),
  createdAt: createdAt(),
});

export const transactionItems = sqliteTable("transaction_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: integer("transactionId").notNull().references(() => transactions.id),
  productId: integer("productId").notNull().references(() => products.id),
  productName: text("productName").notNull(),
  unitPrice: integer("unitPrice").notNull(),
  quantity: integer("quantity").notNull(),
  subtotal: integer("subtotal").notNull(),
});

export type Product = typeof products.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TransactionItem = typeof transactionItems.$inferSelect;
