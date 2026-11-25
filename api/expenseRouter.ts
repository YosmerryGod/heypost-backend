import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { expenses } from "@db/schema";
import { createRouter, ownerQuery, permissionQuery } from "./middleware";
import { getDb } from "./queries/connection";

const expenseDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus menggunakan format YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Tanggal tidak valid.");

export const expenseRouter = createRouter({
  list: permissionQuery("expenses.daily.view").input(z.object({
    fromDate: expenseDateSchema.optional(),
    toDate: expenseDateSchema.optional(),
  }).optional()).query(({ ctx, input }) => {
    if (input?.fromDate && input.toDate && input.fromDate > input.toDate) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Rentang tanggal tidak valid." });
    }

    const conditions = [
      eq(expenses.storeId, ctx.auth.storeId),
      eq(expenses.outletId, ctx.auth.activeOutletId),
    ];
    if (input?.fromDate) conditions.push(gte(expenses.expenseDate, input.fromDate));
    if (input?.toDate) conditions.push(lte(expenses.expenseDate, input.toDate));

    return getDb().select().from(expenses)
      .where(and(...conditions))
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(500)
      .all();
  }),

  create: permissionQuery("expenses.daily.create").input(z.object({
    category: z.string().trim().min(2).max(60),
    description: z.string().trim().max(500).optional(),
    amount: z.number().int().min(1).max(1_000_000_000_000),
    paymentMethod: z.enum(["Tunai", "QRIS", "Kartu"]),
    expenseDate: expenseDateSchema,
  })).mutation(({ ctx, input }) => {
    const [expense] = getDb().insert(expenses).values({
      storeId: ctx.auth.storeId,
      outletId: ctx.auth.activeOutletId,
      userId: ctx.auth.userId,
      employeeId: ctx.auth.employeeId,
      category: input.category,
      description: input.description || null,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      expenseDate: input.expenseDate,
    }).returning().all();

    return expense;
  }),

  cancel: ownerQuery.input(z.object({
    id: z.number().int().positive(),
  })).mutation(({ ctx, input }) => {
    const db = getDb();
    const conditions = and(
      eq(expenses.id, input.id),
      eq(expenses.storeId, ctx.auth.storeId),
      eq(expenses.outletId, ctx.auth.activeOutletId),
    );
    const [existing] = db.select().from(expenses).where(conditions).limit(1).all();
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Pengeluaran tidak ditemukan." });
    }
    if (existing.status === "Dibatalkan") {
      return { ok: true as const, status: "Dibatalkan" as const };
    }
    db.update(expenses).set({ status: "Dibatalkan" })
      .where(and(conditions, eq(expenses.status, "Aktif"))).run();
    const [updated] = db.select({ status: expenses.status }).from(expenses).where(conditions).limit(1).all();
    if (!updated) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Pengeluaran tidak ditemukan." });
    }
    return { ok: true as const, status: updated.status };
  }),
});
