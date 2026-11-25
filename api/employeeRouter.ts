import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { employees, outlets, sessions } from "@db/schema";
import { hashPassword, hashToken, randomToken } from "./auth/security";
import { createRouter, ownerQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { DEFAULT_EMPLOYEE_PERMISSIONS, parsePermissions, permissionsSchema } from "./permissions";

const pinSchema = z.string().regex(/^\d{6}$/, "PIN harus 6 digit angka.");

function requireOutlet(storeId: number, outletId: number) {
  const [outlet] = getDb().select().from(outlets).where(and(
    eq(outlets.id, outletId),
    eq(outlets.storeId, storeId),
    eq(outlets.active, true),
  )).limit(1).all();
  if (!outlet) throw new TRPCError({ code: "NOT_FOUND", message: "Outlet tujuan tidak ditemukan atau nonaktif." });
}

function requireEmployee(storeId: number, employeeId: number) {
  const [employee] = getDb().select().from(employees).where(and(
    eq(employees.id, employeeId),
    eq(employees.storeId, storeId),
  )).limit(1).all();
  if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "Karyawan tidak ditemukan." });
  return employee;
}

export const employeeRouter = createRouter({
  list: ownerQuery.query(({ ctx }) => {
    return getDb().select({
      id: employees.id,
      name: employees.name,
      role: employees.role,
      outletId: employees.outletId,
      outletName: outlets.name,
      active: employees.active,
      permissions: employees.permissions,
      lockedUntil: employees.lockedUntil,
      lastLoginAt: employees.lastLoginAt,
      createdAt: employees.createdAt,
    }).from(employees)
      .innerJoin(outlets, eq(outlets.id, employees.outletId))
      .where(eq(employees.storeId, ctx.auth.storeId))
      .orderBy(desc(employees.createdAt)).all().map((employee) => ({ ...employee, permissions: parsePermissions(employee.permissions) }));
  }),

  create: ownerQuery.input(z.object({
    name: z.string().trim().min(2).max(100),
    role: z.enum(["manager", "kasir"]),
    outletId: z.number().int().positive(),
    pin: pinSchema,
    permissions: permissionsSchema.optional(),
  })).mutation(async ({ ctx, input }) => {
    requireOutlet(ctx.auth.storeId, input.outletId);
    const barcode = `HP-${randomToken(24)}`;
    const pinHash = await hashPassword(input.pin);
    const [employee] = getDb().insert(employees).values({
      storeId: ctx.auth.storeId,
      outletId: input.outletId,
      name: input.name,
      role: input.role,
      permissions: JSON.stringify(input.permissions ?? DEFAULT_EMPLOYEE_PERMISSIONS[input.role]),
      pinHash,
      barcodeHash: hashToken(barcode),
    }).returning({
      id: employees.id,
      name: employees.name,
      role: employees.role,
      outletId: employees.outletId,
      active: employees.active,
      permissions: employees.permissions,
      createdAt: employees.createdAt,
    }).all();

    // The plaintext barcode is returned only here. The database stores its hash.
    return { ...employee, permissions: parsePermissions(employee.permissions), barcode };
  }),

  update: ownerQuery.input(z.object({
    id: z.number().int().positive(),
    name: z.string().trim().min(2).max(100).optional(),
    role: z.enum(["manager", "kasir"]).optional(),
    outletId: z.number().int().positive().optional(),
    active: z.boolean().optional(),
    pin: pinSchema.optional(),
    permissions: permissionsSchema.optional(),
  })).mutation(async ({ ctx, input }) => {
    requireEmployee(ctx.auth.storeId, input.id);
    if (input.outletId) requireOutlet(ctx.auth.storeId, input.outletId);
    const pinHash = input.pin ? await hashPassword(input.pin) : undefined;

    getDb().update(employees).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.permissions !== undefined ? { permissions: JSON.stringify(input.permissions) } : {}),
      ...(input.role !== undefined && input.permissions === undefined ? { permissions: JSON.stringify(DEFAULT_EMPLOYEE_PERMISSIONS[input.role]) } : {}),
      ...(input.outletId !== undefined ? { outletId: input.outletId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(pinHash ? { pinHash } : {}),
      failedPinAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    }).where(and(eq(employees.id, input.id), eq(employees.storeId, ctx.auth.storeId))).run();
    getDb().delete(sessions).where(eq(sessions.employeeId, input.id)).run();
    return { ok: true };
  }),

  regenerateBarcode: ownerQuery.input(z.object({
    id: z.number().int().positive(),
  })).mutation(({ ctx, input }) => {
    requireEmployee(ctx.auth.storeId, input.id);
    const barcode = `HP-${randomToken(24)}`;
    const db = getDb();
    db.update(employees).set({
      barcodeHash: hashToken(barcode),
      failedPinAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    }).where(and(eq(employees.id, input.id), eq(employees.storeId, ctx.auth.storeId))).run();
    db.delete(sessions).where(eq(sessions.employeeId, input.id)).run();
    return { barcode };
  }),
});
