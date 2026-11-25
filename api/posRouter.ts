import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { assertPermission, createRouter, permissionQuery, permissionQueryAny } from "./middleware";
import { getDb } from "./queries/connection";
import { saveProductImage } from "./lib/uploads";
import { categories, outlets, products, transactionItems, transactions } from "@db/schema";
import type { AuthPrincipal } from "./auth/types";

const productInput = z.object({
  name: z.string().trim().min(2).max(160),
  categoryId: z.number().int().positive(),
  price: z.number().int().min(100).max(100_000_000),
  stock: z.number().int().min(0).max(1_000_000),
  imageUrl: z.string().url().max(600).nullable(),
});

function tenant(auth: AuthPrincipal) {
  return { storeId: auth.storeId, outletId: auth.activeOutletId };
}

function requireCategory(auth: AuthPrincipal, categoryId: number) {
  const [category] = getDb().select().from(categories).where(and(
    eq(categories.id, categoryId),
    eq(categories.storeId, auth.storeId),
    eq(categories.outletId, auth.activeOutletId),
  )).limit(1).all();
  if (!category) throw new TRPCError({ code: "NOT_FOUND", message: "Kategori tidak ditemukan di outlet ini." });
  return category;
}

export const posRouter = createRouter({
  bootstrap: permissionQuery("pos.access").query(({ ctx }) => {
    const db = getDb();
    const scope = and(eq(products.storeId, ctx.auth.storeId), eq(products.outletId, ctx.auth.activeOutletId));
    const productRows = db.select().from(products).where(and(scope, eq(products.active, true))).all();
    const categoryRows = db.select().from(categories).where(and(
      eq(categories.storeId, ctx.auth.storeId),
      eq(categories.outletId, ctx.auth.activeOutletId),
    )).all();
    const [outlet] = db.select().from(outlets).where(eq(outlets.id, ctx.auth.activeOutletId)).limit(1).all();
    return {
      products: productRows,
      categories: categoryRows.sort((a, b) => a.sortOrder - b.sortOrder),
      outlet,
      role: ctx.auth.role,
    };
  }),

  createCategory: permissionQuery("menu.create").input(z.object({
    name: z.string().trim().min(2).max(100),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })).mutation(({ ctx, input }) => {
    try {
      const [category] = getDb().insert(categories).values({
        ...tenant(ctx.auth),
        ...input,
      }).returning().all();
      return category;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new TRPCError({ code: "CONFLICT", message: "Nama kategori sudah digunakan di outlet ini." });
      }
      throw error;
    }
  }),

  uploadProductImage: permissionQueryAny("menu.create", "menu.edit").input(z.object({ dataUrl: z.string().max(7_000_000) })).mutation(async ({ input }) => {
    try {
      return await saveProductImage(input.dataUrl);
    } catch (error) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Foto gagal diunggah." });
    }
  }),

  createProduct: permissionQuery("menu.create").input(productInput).mutation(({ ctx, input }) => {
    requireCategory(ctx.auth, input.categoryId);
    const db = getDb();
    const sku = `HP-${randomUUID().slice(0, 10).toUpperCase()}`;
    const [{ id }] = db.insert(products).values({
      ...tenant(ctx.auth),
      ...input,
      sku,
    }).returning({ id: products.id }).all();
    const [product] = db.select().from(products).where(eq(products.id, id)).all();
    return product;
  }),

  updateProduct: permissionQueryAny("menu.edit", "stock.edit").input(productInput.extend({ id: z.number().int().positive() })).mutation(({ ctx, input }) => {
    const { id, ...values } = input;
    requireCategory(ctx.auth, input.categoryId);
    const db = getDb();
    const scope = and(
      eq(products.id, id),
      eq(products.storeId, ctx.auth.storeId),
      eq(products.outletId, ctx.auth.activeOutletId),
    );
    const [currentProduct] = db.select().from(products).where(scope).limit(1).all();
    if (!currentProduct) throw new TRPCError({ code: "NOT_FOUND", message: "Produk tidak ditemukan di outlet ini." });
    const menuChanged = values.name !== currentProduct.name
      || values.categoryId !== currentProduct.categoryId
      || values.price !== currentProduct.price
      || values.imageUrl !== currentProduct.imageUrl;
    const stockChanged = values.stock !== currentProduct.stock;
    if (menuChanged) assertPermission(ctx.auth, "menu.edit");
    if (stockChanged) assertPermission(ctx.auth, "stock.edit");
    db.update(products).set(values).where(scope).run();
    const [product] = db.select().from(products).where(scope).limit(1).all();
    if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Produk tidak ditemukan di outlet ini." });
    return product;
  }),

  archiveProduct: permissionQuery("menu.edit").input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => {
    const result = getDb().update(products).set({ active: false }).where(and(
      eq(products.id, input.id),
      eq(products.storeId, ctx.auth.storeId),
      eq(products.outletId, ctx.auth.activeOutletId),
    )).run();
    if (!result.changes) throw new TRPCError({ code: "NOT_FOUND", message: "Produk tidak ditemukan di outlet ini." });
    return { ok: true };
  }),

  createTransaction: permissionQuery("pos.access").input(z.object({
    customerName: z.string().trim().max(120).optional(),
    orderType: z.enum(["Makan di tempat", "Bawa pulang", "Pesan antar"]),
    paymentMethod: z.enum(["Tunai", "QRIS", "Kartu"]),
    discount: z.number().int().min(0).default(0),
    cashReceived: z.number().int().min(0).optional(),
    items: z.array(z.object({
      productId: z.number().int().positive(),
      quantity: z.number().int().min(1).max(999),
    })).min(1).max(100),
  })).mutation(({ ctx, input }) => {
    const db = getDb();
    return db.transaction((tx) => {
      const quantities = new Map<number, number>();
      for (const item of input.items) {
        quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
        if (quantities.get(item.productId)! > 999) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Jumlah per produk maksimal 999." });
        }
      }
      const ids = [...quantities.keys()];
      const rows = tx.select().from(products).where(and(
        inArray(products.id, ids),
        eq(products.storeId, ctx.auth.storeId),
        eq(products.outletId, ctx.auth.activeOutletId),
      )).all();
      const productMap = new Map(rows.map((product) => [product.id, product]));

      for (const [productId, quantity] of quantities) {
        const product = productMap.get(productId);
        if (!product || !product.active) throw new TRPCError({ code: "BAD_REQUEST", message: "Produk tidak ditemukan di outlet ini." });
        if (product.stock < quantity) throw new TRPCError({ code: "BAD_REQUEST", message: `Stok ${product.name} hanya ${product.stock}.` });
      }
      const lines = [...quantities].map(([productId, quantity]) => {
        const product = productMap.get(productId)!;
        return { product, quantity, subtotal: product.price * quantity };
      });
      const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
      if (input.discount > subtotal) throw new TRPCError({ code: "BAD_REQUEST", message: "Diskon melebihi subtotal." });
      const total = subtotal - input.discount;
      if (input.paymentMethod === "Tunai" && (input.cashReceived ?? 0) < total) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Uang tunai kurang dari total pembayaran." });
      }

      const invoiceNumber = `HP${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const [{ id: transactionId }] = tx.insert(transactions).values({
        ...tenant(ctx.auth),
        userId: ctx.auth.userId,
        employeeId: ctx.auth.employeeId,
        invoiceNumber,
        customerName: input.customerName || "Pelanggan toko",
        orderType: input.orderType,
        paymentMethod: input.paymentMethod,
        subtotal,
        discount: input.discount,
        total,
        cashReceived: input.paymentMethod === "Tunai" ? input.cashReceived : total,
      }).returning({ id: transactions.id }).all();
      tx.insert(transactionItems).values(lines.map((line) => ({
        transactionId,
        productId: line.product.id,
        productName: line.product.name,
        unitPrice: line.product.price,
        quantity: line.quantity,
        subtotal: line.subtotal,
      }))).run();
      for (const line of lines) {
        tx.update(products).set({ stock: line.product.stock - line.quantity }).where(and(
          eq(products.id, line.product.id),
          eq(products.storeId, ctx.auth.storeId),
          eq(products.outletId, ctx.auth.activeOutletId),
        )).run();
      }
      const [transaction] = tx.select().from(transactions).where(eq(transactions.id, transactionId)).all();
      return {
        ...transaction,
        items: lines.map((line) => ({
          productName: line.product.name,
          unitPrice: line.product.price,
          quantity: line.quantity,
          subtotal: line.subtotal,
        })),
      };
    });
  }),

  transactions: permissionQuery("history.daily.view").query(({ ctx }) => {
    const db = getDb();
    const rows = db.select().from(transactions).where(and(
      eq(transactions.storeId, ctx.auth.storeId),
      eq(transactions.outletId, ctx.auth.activeOutletId),
    )).orderBy(desc(transactions.createdAt)).limit(200).all();
    if (!rows.length) return [];
    const items = db.select().from(transactionItems)
      .where(inArray(transactionItems.transactionId, rows.map((row) => row.id))).all();
    return rows.map((row) => ({ ...row, items: items.filter((item) => item.transactionId === row.id) }));
  }),

  summary: permissionQuery("reports.sales.view").input(z.object({
    range: z.enum(["today", "week", "month", "all"]).default("week"),
    allOutlets: z.boolean().default(false),
  })).query(({ ctx, input }) => {
    if (input.allOutlets && ctx.auth.role !== "owner") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Rekap seluruh outlet hanya untuk owner." });
    }
    const db = getDb();
    const conditions = [
      eq(transactions.storeId, ctx.auth.storeId),
      eq(transactions.status, "Selesai"),
    ];
    if (!input.allOutlets) conditions.push(eq(transactions.outletId, ctx.auth.activeOutletId));
    const rows = db.select().from(transactions).where(and(...conditions))
      .orderBy(desc(transactions.createdAt)).all();
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (input.range === "week") start.setDate(start.getDate() - 6);
    if (input.range === "month") start.setDate(start.getDate() - 29);
    if (input.range === "all") start.setTime(0);
    const filtered = rows.filter((row) => row.createdAt >= start);
    const ids = filtered.map((row) => row.id);
    const items = ids.length
      ? db.select().from(transactionItems).where(inArray(transactionItems.transactionId, ids)).all()
      : [];
    const dailyMap = new Map<string, { date: string; label: string; revenue: number; orders: number }>();
    const days = input.range === "today" ? 1 : input.range === "month" ? 30 : input.range === "all"
      ? Math.min(30, Math.max(7, Math.ceil((now.getTime() - (filtered.at(-1)?.createdAt.getTime() ?? now.getTime())) / 86400000) + 1))
      : 7;
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      const key = date.toISOString().slice(0, 10);
      dailyMap.set(key, {
        date: key,
        label: date.toLocaleDateString("id-ID", { day: "numeric", month: "short" }),
        revenue: 0,
        orders: 0,
      });
    }
    for (const row of filtered) {
      const day = dailyMap.get(row.createdAt.toISOString().slice(0, 10));
      if (day) {
        day.revenue += row.total;
        day.orders += 1;
      }
    }
    const productMap = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const item of items) {
      const current = productMap.get(item.productName) ?? { name: item.productName, quantity: 0, revenue: 0 };
      current.quantity += item.quantity;
      current.revenue += item.subtotal;
      productMap.set(item.productName, current);
    }
    const payments = ["Tunai", "QRIS", "Kartu"].map((method) => ({
      method,
      total: filtered.filter((row) => row.paymentMethod === method).reduce((sum, row) => sum + row.total, 0),
    }));
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
