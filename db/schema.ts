import {
  bigint,
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const categories = mysqlTable("categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 80 }).notNull().unique(),
  sortOrder: int("sortOrder").notNull().default(0),
});

export const products = mysqlTable("products", {
  id: serial("id").primaryKey(),
  categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  sku: varchar("sku", { length: 40 }).notNull().unique(),
  price: int("price").notNull(),
  stock: int("stock").notNull().default(0),
  imageUrl: varchar("imageUrl", { length: 600 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const transactions = mysqlTable("transactions", {
  id: serial("id").primaryKey(),
  invoiceNumber: varchar("invoiceNumber", { length: 40 }).notNull().unique(),
  customerName: varchar("customerName", { length: 120 }),
  orderType: mysqlEnum("orderType", ["Makan di tempat", "Bawa pulang", "Pesan antar"]).notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["Tunai", "QRIS", "Kartu"]).notNull(),
  status: mysqlEnum("status", ["Selesai", "Dibatalkan"]).notNull().default("Selesai"),
  subtotal: int("subtotal").notNull(),
  discount: int("discount").notNull().default(0),
  total: int("total").notNull(),
  cashReceived: int("cashReceived"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const transactionItems = mysqlTable("transaction_items", {
  id: serial("id").primaryKey(),
  transactionId: bigint("transactionId", { mode: "number", unsigned: true }).notNull(),
  productId: bigint("productId", { mode: "number", unsigned: true }).notNull(),
  productName: varchar("productName", { length: 160 }).notNull(),
  unitPrice: int("unitPrice").notNull(),
  quantity: int("quantity").notNull(),
  subtotal: int("subtotal").notNull(),
});

export type Product = typeof products.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TransactionItem = typeof transactionItems.$inferSelect;
