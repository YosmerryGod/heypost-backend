import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { categories, outlets, products, sessions } from "@db/schema";
import { createRouter, ownerQuery } from "./middleware";
import { getDb } from "./queries/connection";

function ownedOutlet(storeId: number, outletId: number, activeOnly = false) {
  const conditions = [eq(outlets.id, outletId), eq(outlets.storeId, storeId)];
  if (activeOnly) conditions.push(eq(outlets.active, true));
  const [outlet] = getDb().select().from(outlets).where(and(...conditions)).limit(1).all();
  if (!outlet) throw new TRPCError({ code: "NOT_FOUND", message: "Outlet tidak ditemukan." });
  return outlet;
}

export const storeRouter = createRouter({
  createOutlet: ownerQuery.input(z.object({
    name: z.string().trim().min(2).max(120),
    address: z.string().trim().max(300).optional(),
    copyMenuFromOutletId: z.number().int().positive().optional(),
  })).mutation(({ ctx, input }) => {
    const db = getDb();
    if (input.copyMenuFromOutletId) {
      ownedOutlet(ctx.auth.storeId, input.copyMenuFromOutletId);
    }

    return db.transaction((tx) => {
      const [outlet] = tx.insert(outlets).values({
        storeId: ctx.auth.storeId,
        name: input.name,
        address: input.address,
      }).returning().all();

      if (input.copyMenuFromOutletId) {
        const sourceCategories = tx.select().from(categories).where(and(
          eq(categories.storeId, ctx.auth.storeId),
          eq(categories.outletId, input.copyMenuFromOutletId),
        )).orderBy(asc(categories.sortOrder)).all();
        const categoryIds = new Map<number, number>();

        for (const category of sourceCategories) {
          const [copy] = tx.insert(categories).values({
            storeId: ctx.auth.storeId,
            outletId: outlet.id,
            name: category.name,
            sortOrder: category.sortOrder,
          }).returning({ id: categories.id }).all();
          categoryIds.set(category.id, copy.id);
        }

        const sourceProducts = tx.select().from(products).where(and(
          eq(products.storeId, ctx.auth.storeId),
          eq(products.outletId, input.copyMenuFromOutletId),
        )).all();
        for (const product of sourceProducts) {
          const categoryId = categoryIds.get(product.categoryId);
          if (!categoryId) continue;
          tx.insert(products).values({
            storeId: ctx.auth.storeId,
            outletId: outlet.id,
            categoryId,
            name: product.name,
            sku: product.sku,
            price: product.price,
            stock: product.stock,
            imageUrl: product.imageUrl,
            active: product.active,
          }).run();
        }
      }
      return outlet;
    });
  }),

  switchOutlet: ownerQuery.input(z.object({
    outletId: z.number().int().positive(),
  })).mutation(({ ctx, input }) => {
    const outlet = ownedOutlet(ctx.auth.storeId, input.outletId, true);
    getDb().update(sessions).set({ activeOutletId: outlet.id }).where(and(
      eq(sessions.id, ctx.auth.sessionId),
      eq(sessions.storeId, ctx.auth.storeId),
    )).run();
    return { ok: true, activeOutletId: outlet.id };
  }),

  updateOutlet: ownerQuery.input(z.object({
    id: z.number().int().positive(),
    name: z.string().trim().min(2).max(120).optional(),
    address: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().optional(),
  })).mutation(({ ctx, input }) => {
    const db = getDb();
    ownedOutlet(ctx.auth.storeId, input.id);
    if (input.active === false) {
      if (ctx.auth.activeOutletId === input.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pindah ke outlet lain sebelum menonaktifkan outlet aktif." });
      }
      const [remaining] = db.select({ id: outlets.id }).from(outlets).where(and(
        eq(outlets.storeId, ctx.auth.storeId),
        eq(outlets.active, true),
        ne(outlets.id, input.id),
      )).limit(1).all();
      if (!remaining) throw new TRPCError({ code: "BAD_REQUEST", message: "Toko harus memiliki minimal satu outlet aktif." });
    }

    db.update(outlets).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(and(eq(outlets.id, input.id), eq(outlets.storeId, ctx.auth.storeId))).run();
    return { ok: true };
  }),
});
