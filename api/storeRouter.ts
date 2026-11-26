import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { categories, outlets, products, receiptSettings, sessions, stores } from "@db/schema"; // [MODIFIED]
import { saveStoreLogo } from "./lib/uploads"; // [ADDED]
import { createRouter, ownerQuery, permissionQuery } from "./middleware"; // [MODIFIED]
import { getDb } from "./queries/connection";

function ownedOutlet(storeId: number, outletId: number, activeOnly = false) {
  const conditions = [eq(outlets.id, outletId), eq(outlets.storeId, storeId)];
  if (activeOnly) conditions.push(eq(outlets.active, true));
  const [outlet] = getDb().select().from(outlets).where(and(...conditions)).limit(1).all();
  if (!outlet) throw new TRPCError({ code: "NOT_FOUND", message: "Outlet tidak ditemukan." });
  return outlet;
}

export const storeRouter = createRouter({
  // [MODIFIED] Profil toko dapat memperbarui nama dan/atau logo tanpa mengirim field yang tidak berubah.
  updateProfile: ownerQuery.input(z.object({
    name: z.string().trim().min(2).max(120).optional(),
    logoUrl: z.string().url().max(600).nullable().optional(),
  }).refine((input) => input.name !== undefined || input.logoUrl !== undefined, {
    message: "Minimal satu data toko harus diubah.",
  })).mutation(({ ctx, input }) => {
    getDb().update(stores).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      updatedAt: new Date(),
    }).where(eq(stores.id, ctx.auth.storeId)).run();
    return { ok: true };
  }),

  // [ADDED] Upload logo toko terpisah dari penyimpanan foto produk.
  uploadLogo: ownerQuery.input(z.object({
    dataUrl: z.string().max(7_000_000),
  })).mutation(async ({ ctx, input }) => {
    let uploaded: { imageUrl: string };
    try {
      uploaded = await saveStoreLogo(input.dataUrl);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Logo gagal diunggah.",
      });
    }
    getDb().update(stores).set({
      logoUrl: uploaded.imageUrl,
      updatedAt: new Date(),
    }).where(eq(stores.id, ctx.auth.storeId)).run();
    return uploaded;
  }),

  // [ADDED] Ambil preferensi struk; baris default dibuat otomatis untuk toko lama.
  getReceiptSettings: permissionQuery("pos.access").query(({ ctx }) => { // [MODIFIED]
    const db = getDb();
    db.insert(receiptSettings).values({ storeId: ctx.auth.storeId }).onConflictDoNothing().run();
    const [settings] = db.select().from(receiptSettings)
      .where(eq(receiptSettings.storeId, ctx.auth.storeId)).limit(1).all();
    return settings;
  }),

  // [ADDED] Simpan preferensi struk pada tingkat toko, bukan per perangkat.
  updateReceiptSettings: ownerQuery.input(z.object({
    showLogo: z.boolean().optional(),
    showStoreName: z.boolean().optional(),
    showOutletName: z.boolean().optional(),
    showAddress: z.boolean().optional(),
    showWhatsapp: z.boolean().optional(),
    showCashier: z.boolean().optional(),
    showCustomer: z.boolean().optional(),
    showHeyPostWatermark: z.boolean().optional(),
    footerMessage: z.string().trim().max(300).nullable().optional(),
  }).refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Minimal satu pengaturan struk harus diubah.",
  })).mutation(({ ctx, input }) => {
    const db = getDb();
    db.insert(receiptSettings).values({ storeId: ctx.auth.storeId }).onConflictDoNothing().run();
    db.update(receiptSettings).set({
      ...input,
      updatedAt: new Date(),
    }).where(eq(receiptSettings.storeId, ctx.auth.storeId)).run();
    const [settings] = db.select().from(receiptSettings)
      .where(eq(receiptSettings.storeId, ctx.auth.storeId)).limit(1).all();
    return settings;
  }),

  createOutlet: ownerQuery.input(z.object({
    name: z.string().trim().min(2).max(120),
    address: z.string().trim().max(300).optional(),
    whatsappNumber: z.string().trim().max(30).nullable().optional(), // [ADDED]
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
        whatsappNumber: input.whatsappNumber,
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
    whatsappNumber: z.string().trim().max(30).nullable().optional(), // [ADDED]
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
      ...(input.whatsappNumber !== undefined ? { whatsappNumber: input.whatsappNumber } : {}), // [ADDED]
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(and(eq(outlets.id, input.id), eq(outlets.storeId, ctx.auth.storeId))).run();
    return { ok: true };
  }),
});
