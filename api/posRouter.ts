import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, inArray } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { categories, products, transactionItems, transactions } from "@db/schema";
import { seedIfEmpty } from "@db/seed";

let seeded: Promise<void> | undefined;
const ready = () => (seeded ??= seedIfEmpty());

const productInput = z.object({
  name: z.string().trim().min(2).max(160),
  categoryId: z.number().int().positive(),
  price: z.number().int().min(100).max(100_000_000),
  stock: z.number().int().min(0).max(1_000_000),
  imageUrl: z.string().url().max(600),
});

export const posRouter = createRouter({
  bootstrap: publicQuery.query(async () => {
    await ready();
    const db = getDb();
    const [productRows, categoryRows] = await Promise.all([
      db.select().from(products).where(eq(products.active, true)),
      db.select().from(categories),
    ]);
    return { products: productRows, categories: categoryRows.sort((a, b) => a.sortOrder - b.sortOrder) };
  }),

  createProduct: publicQuery.input(productInput).mutation(async ({ input }) => {
    await ready();
    const sku = `HP-${Date.now().toString().slice(-7)}`;
    const [{ id }] = await getDb().insert(products).values({ ...input, sku }).$returningId();
    const [product] = await getDb().select().from(products).where(eq(products.id, id));
    return product;
  }),

  updateProduct: publicQuery.input(productInput.extend({ id: z.number().int().positive() })).mutation(async ({ input }) => {
    const { id, ...values } = input;
    await getDb().update(products).set(values).where(eq(products.id, id));
    const [product] = await getDb().select().from(products).where(eq(products.id, id));
    return product;
  }),

  archiveProduct: publicQuery.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => {
    await getDb().update(products).set({ active: false }).where(eq(products.id, input.id));
    return { ok: true };
  }),

  createTransaction: publicQuery.input(z.object({
    customerName: z.string().trim().max(120).optional(),
    orderType: z.enum(["Makan di tempat", "Bawa pulang", "Pesan antar"]),
    paymentMethod: z.enum(["Tunai", "QRIS", "Kartu"]),
    discount: z.number().int().min(0).default(0),
    cashReceived: z.number().int().min(0).optional(),
    items: z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(1).max(999) })).min(1).max(100),
  })).mutation(async ({ input }) => {
    await ready();
    const db = getDb();
    return db.transaction(async (tx) => {
      const ids = input.items.map((item) => item.productId);
      const rows = await tx.select().from(products).where(inArray(products.id, ids));
      const productMap = new Map(rows.map((product) => [product.id, product]));
      for (const item of input.items) {
        const product = productMap.get(item.productId);
        if (!product || !product.active) throw new TRPCError({ code: "BAD_REQUEST", message: "Produk tidak ditemukan." });
        if (product.stock < item.quantity) throw new TRPCError({ code: "BAD_REQUEST", message: `Stok ${product.name} hanya ${product.stock}.` });
      }
      const lines = input.items.map((item) => {
        const product = productMap.get(item.productId)!;
        return { product, quantity: item.quantity, subtotal: product.price * item.quantity };
      });
      const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
      if (input.discount > subtotal) throw new TRPCError({ code: "BAD_REQUEST", message: "Diskon melebihi subtotal." });
      const total = subtotal - input.discount;
      if (input.paymentMethod === "Tunai" && (input.cashReceived ?? 0) < total) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Uang tunai kurang dari total pembayaran." });
      }
      const invoiceNumber = `HP${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${Date.now().toString().slice(-5)}`;
      const [{ id: transactionId }] = await tx.insert(transactions).values({
        invoiceNumber,
        customerName: input.customerName || "Pelanggan toko",
        orderType: input.orderType,
        paymentMethod: input.paymentMethod,
        subtotal,
        discount: input.discount,
        total,
        cashReceived: input.paymentMethod === "Tunai" ? input.cashReceived : total,
      }).$returningId();
      await tx.insert(transactionItems).values(lines.map((line) => ({
        transactionId,
        productId: line.product.id,
        productName: line.product.name,
        unitPrice: line.product.price,
        quantity: line.quantity,
        subtotal: line.subtotal,
      })));
      for (const line of lines) {
        await tx.update(products).set({ stock: line.product.stock - line.quantity }).where(eq(products.id, line.product.id));
      }
      const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, transactionId));
      return { ...transaction, items: lines.map((line) => ({ productName: line.product.name, unitPrice: line.product.price, quantity: line.quantity, subtotal: line.subtotal })) };
    });
  }),

  transactions: publicQuery.query(async () => {
    await ready();
    const db = getDb();
    const rows = await db.select().from(transactions).orderBy(desc(transactions.createdAt)).limit(200);
    if (!rows.length) return [];
    const items = await db.select().from(transactionItems).where(inArray(transactionItems.transactionId, rows.map((row) => row.id)));
    return rows.map((row) => ({ ...row, items: items.filter((item) => item.transactionId === row.id) }));
  }),

  summary: publicQuery.input(z.object({ range: z.enum(["today", "week", "month", "all"]).default("week") })).query(async ({ input }) => {
    await ready();
    const db = getDb();
    const rows = await db.select().from(transactions).where(eq(transactions.status, "Selesai")).orderBy(desc(transactions.createdAt));
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (input.range === "week") start.setDate(start.getDate() - 6);
    if (input.range === "month") start.setDate(start.getDate() - 29);
    if (input.range === "all") start.setTime(0);
    const filtered = rows.filter((row) => row.createdAt >= start);
    const ids = filtered.map((row) => row.id);
    const items = ids.length ? await db.select().from(transactionItems).where(inArray(transactionItems.transactionId, ids)) : [];
    const dailyMap = new Map<string, { date: string; label: string; revenue: number; orders: number }>();
    const days = input.range === "today" ? 1 : input.range === "month" ? 30 : input.range === "all" ? Math.min(30, Math.max(7, Math.ceil((now.getTime() - (filtered.at(-1)?.createdAt.getTime() ?? now.getTime())) / 86400000) + 1)) : 7;
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now); date.setDate(now.getDate() - i);
      const key = date.toISOString().slice(0, 10);
      dailyMap.set(key, { date: key, label: date.toLocaleDateString("id-ID", { day: "numeric", month: "short" }), revenue: 0, orders: 0 });
    }
    for (const row of filtered) {
      const key = row.createdAt.toISOString().slice(0, 10);
      const day = dailyMap.get(key);
      if (day) { day.revenue += row.total; day.orders += 1; }
    }
    const productMap = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const item of items) {
      const current = productMap.get(item.productName) ?? { name: item.productName, quantity: 0, revenue: 0 };
      current.quantity += item.quantity; current.revenue += item.subtotal;
      productMap.set(item.productName, current);
    }
    const payments = ["Tunai", "QRIS", "Kartu"].map((method) => ({ method, total: filtered.filter((row) => row.paymentMethod === method).reduce((sum, row) => sum + row.total, 0) }));
    const revenue = filtered.reduce((sum, row) => sum + row.total, 0);
    return {
      revenue,
      orders: filtered.length,
      itemsSold: items.reduce((sum, item) => sum + item.quantity, 0),
      average: filtered.length ? Math.round(revenue / filtered.length) : 0,
      daily: [...dailyMap.values()],
      topProducts: [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
      payments,
    };
  }),
});
