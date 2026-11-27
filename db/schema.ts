import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () => integer("createdAt", { mode: "timestamp_ms" })
  .notNull()
  .default(sql`(unixepoch() * 1000)`);

const updatedAt = () => integer("updatedAt", { mode: "timestamp_ms" })
  .notNull()
  .default(sql`(unixepoch() * 1000)`);

export const stores = sqliteTable("stores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  logoUrl: text("logoUrl"), // [ADDED]
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outlets = sqliteTable("outlets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").notNull().references(() => stores.id),
  name: text("name").notNull(),
  address: text("address"),
  whatsappNumber: text("whatsappNumber"), // [ADDED]
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("outlets_store_name_unique").on(table.storeId, table.name),
  index("outlets_store_idx").on(table.storeId),
]);

// [ADDED] Preferensi struk berlaku untuk seluruh outlet dalam satu toko.
export const receiptSettings = sqliteTable("receipt_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").notNull().unique().references(() => stores.id),
  showLogo: integer("showLogo", { mode: "boolean" }).notNull().default(true),
  showStoreName: integer("showStoreName", { mode: "boolean" }).notNull().default(true),
  showOutletName: integer("showOutletName", { mode: "boolean" }).notNull().default(true),
  showAddress: integer("showAddress", { mode: "boolean" }).notNull().default(true),
  showWhatsapp: integer("showWhatsapp", { mode: "boolean" }).notNull().default(false),
  showCashier: integer("showCashier", { mode: "boolean" }).notNull().default(true),
  showCustomer: integer("showCustomer", { mode: "boolean" }).notNull().default(false),
  showHeyPostWatermark: integer("showHeyPostWatermark", { mode: "boolean" }).notNull().default(false),
  footerMessage: text("footerMessage"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").notNull().unique().references(() => stores.id),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("passwordHash"),
  googleSub: text("googleSub").unique(),
  avatarUrl: text("avatarUrl"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: integer("lastLoginAt", { mode: "timestamp_ms" }),
});

export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").notNull().references(() => stores.id),
  outletId: integer("outletId").notNull().references(() => outlets.id),
  name: text("name").notNull(),
  role: text("role", { enum: ["manager", "kasir"] }).notNull(),
  permissions: text("permissions").notNull().default("[]"),
  pinHash: text("pinHash").notNull(),
  barcodeHash: text("barcodeHash").notNull().unique(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  failedPinAttempts: integer("failedPinAttempts").notNull().default(0),
  lockedUntil: integer("lockedUntil", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: integer("lastLoginAt", { mode: "timestamp_ms" }),
}, (table) => [
  index("employees_store_idx").on(table.storeId),
  index("employees_outlet_idx").on(table.outletId),
]);

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("tokenHash").notNull().unique(),
  userId: integer("userId").references(() => users.id),
  employeeId: integer("employeeId").references(() => employees.id),
  storeId: integer("storeId").notNull().references(() => stores.id),
  activeOutletId: integer("activeOutletId").notNull().references(() => outlets.id),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  lastUsedAt: integer("lastUsedAt", { mode: "timestamp_ms" }),
}, (table) => [
  index("sessions_user_idx").on(table.userId),
  index("sessions_employee_idx").on(table.employeeId),
  index("sessions_expiry_idx").on(table.expiresAt),
]);

// Nullable tenant columns keep pre-auth databases migratable without deleting
// rows. Protected procedures never read NULL tenant data. Use db/attach-legacy.ts
// to assign those rows to an owner-controlled outlet explicitly.
export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("tokenHash").notNull().unique(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("usedAt", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
}, (table) => [
  index("password_reset_tokens_user_idx").on(table.userId),
  index("password_reset_tokens_expiry_idx").on(table.expiresAt),
]);

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").references(() => stores.id),
  outletId: integer("outletId").references(() => outlets.id),
  name: text("name").notNull(),
  sortOrder: integer("sortOrder").notNull().default(0),
}, (table) => [
  uniqueIndex("categories_outlet_name_unique").on(table.outletId, table.name),
  index("categories_outlet_idx").on(table.outletId),
]);

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").references(() => stores.id),
  outletId: integer("outletId").references(() => outlets.id),
  categoryId: integer("categoryId").notNull().references(() => categories.id),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  price: integer("price").notNull(),
  stock: integer("stock").notNull().default(0),
  imageUrl: text("imageUrl"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("products_outlet_sku_unique").on(table.outletId, table.sku),
  index("products_outlet_idx").on(table.outletId),
  index("products_category_idx").on(table.categoryId),
]);

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").references(() => stores.id),
  outletId: integer("outletId").references(() => outlets.id),
  userId: integer("userId").references(() => users.id),
  employeeId: integer("employeeId").references(() => employees.id),
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
}, (table) => [
  index("transactions_outlet_created_idx").on(table.outletId, table.createdAt),
  index("transactions_store_created_idx").on(table.storeId, table.createdAt),
]);

// [ADDED] Pengeluaran dipisahkan dari transaksi penjualan agar omzet tidak tercampur.
export const expenses = sqliteTable("expenses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("storeId").notNull().references(() => stores.id),
  outletId: integer("outletId").notNull().references(() => outlets.id),
  userId: integer("userId").references(() => users.id),
  employeeId: integer("employeeId").references(() => employees.id),
  category: text("category").notNull(),
  description: text("description"),
  amount: integer("amount").notNull(),
  paymentMethod: text("paymentMethod", { enum: ["Tunai", "QRIS", "Kartu"] }).notNull(),
  expenseDate: text("expenseDate").notNull(),
  status: text("status", { enum: ["Aktif", "Dibatalkan"] }).notNull().default("Aktif"), // [ADDED]
  createdAt: createdAt(),
}, (table) => [
  index("expenses_outlet_date_idx").on(table.outletId, table.expenseDate),
  index("expenses_store_date_idx").on(table.storeId, table.expenseDate),
]);

export const transactionItems = sqliteTable("transaction_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: integer("transactionId").notNull().references(() => transactions.id),
  productId: integer("productId").notNull().references(() => products.id),
  productName: text("productName").notNull(),
  unitPrice: integer("unitPrice").notNull(),
  quantity: integer("quantity").notNull(),
  subtotal: integer("subtotal").notNull(),
}, (table) => [
  index("transaction_items_transaction_idx").on(table.transactionId),
]);

export type Store = typeof stores.$inferSelect;
export type ReceiptSettings = typeof receiptSettings.$inferSelect; // [ADDED]
export type Outlet = typeof outlets.$inferSelect;
export type User = typeof users.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TransactionItem = typeof transactionItems.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Role = "owner" | Employee["role"];


// [ADDED] State OAuth mobile sementara, disimpan agar proses tetap valid lintas worker/restart.
export const mobileOAuthStates = sqliteTable("mobile_oauth_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stateHash: text("stateHash").notNull().unique(),
  verifier: text("verifier").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  index("mobile_oauth_states_expiry_idx").on(table.expiresAt),
]);

// [ADDED] Kode pertukaran sekali pakai sebelum session bearer diberikan ke aplikasi.
export const mobileOAuthCodes = sqliteTable("mobile_oauth_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  codeHash: text("codeHash").notNull().unique(),
  userId: integer("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  storeId: integer("storeId").notNull().references(() => stores.id, { onDelete: "cascade" }),
  outletId: integer("outletId").notNull().references(() => outlets.id, { onDelete: "cascade" }),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("usedAt", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
}, (table) => [
  index("mobile_oauth_codes_expiry_idx").on(table.expiresAt),
  index("mobile_oauth_codes_user_idx").on(table.userId),
]);
