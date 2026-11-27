import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { employees, outlets, stores, users } from "@db/schema";
import { createOwnerAccount, normalizeEmail } from "./auth/owners";
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginRateLimitKey,
  recordLoginFailure,
} from "./auth/rateLimit";
import { hashPassword, hashToken, verifyPassword } from "./auth/security";
import {
  clearSessionCookie,
  createSession,
  destroyRequestSession,
  setSessionCookie,
} from "./auth/session";
import type { AuthPrincipal } from "./auth/types";
import { authedQuery, createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { PERMISSION_KEYS, parsePermissions } from "./permissions";

const invalidLogin = () => new TRPCError({
  code: "UNAUTHORIZED",
  message: "Email atau password salah.",
});
const invalidEmployeeLogin = () => new TRPCError({
  code: "UNAUTHORIZED",
  message: "Barcode atau PIN salah.",
});

function authPayload(auth: AuthPrincipal) {
  const db = getDb();
  const [store] = db.select().from(stores).where(eq(stores.id, auth.storeId)).limit(1).all();
  if (!store) throw new TRPCError({ code: "NOT_FOUND", message: "Toko tidak ditemukan." });

  const outletRows = auth.role === "owner"
    ? db.select().from(outlets).where(eq(outlets.storeId, auth.storeId))
      .orderBy(asc(outlets.id)).all()
    : db.select().from(outlets).where(eq(outlets.id, auth.activeOutletId)).limit(1).all();

  // [ADDED] Outlet tambahan dapat memakai nomor WhatsApp dari outlet utama.
  const mainOutlet = db.select().from(outlets).where(eq(outlets.storeId, auth.storeId)).orderBy(asc(outlets.id)).limit(1).get();
  const effectiveOutletRows = outletRows.map((outlet) => ({
    ...outlet,
    whatsappNumber: outlet.whatsappUseMain ? (mainOutlet?.whatsappNumber ?? null) : outlet.whatsappNumber,
  }));

  const permissions = auth.role === "owner"
    ? [...PERMISSION_KEYS]
    : (() => {
      const [employee] = auth.employeeId
        ? db.select({ permissions: employees.permissions }).from(employees).where(eq(employees.id, auth.employeeId)).limit(1).all()
        : [];
      return parsePermissions(employee?.permissions);
    })();

  return {
    principal: {
      name: auth.name,
      email: auth.email,
      role: auth.role,
      userId: auth.userId,
      employeeId: auth.employeeId,
      permissions,
    },
    store,
    outlets: effectiveOutletRows,
    activeOutletId: auth.activeOutletId,
  };
}

function startSession(auth: AuthPrincipal, headers: Headers) {
  const session = createSession({
    userId: auth.userId ?? undefined,
    employeeId: auth.employeeId ?? undefined,
    storeId: auth.storeId,
    activeOutletId: auth.activeOutletId,
    role: auth.role,
  });
  setSessionCookie(headers, session.token, session.maxAgeSeconds);
  return authPayload(auth);
}

export const authRouter = createRouter({
  register: publicQuery.input(z.object({
    name: z.string().trim().min(2).max(100),
    storeName: z.string().trim().min(2).max(120),
    outletName: z.string().trim().min(2).max(120).optional(),
    email: z.string().trim().email().max(320),
    password: z.string().min(8).max(128),
  })).mutation(async ({ ctx, input }) => {
    const passwordHash = await hashPassword(input.password);
    const created = createOwnerAccount({ ...input, passwordHash });
    return startSession({
      sessionId: 0,
      storeId: created.store.id,
      activeOutletId: created.outlet.id,
      role: "owner",
      userId: created.user.id,
      employeeId: null,
      name: created.user.name,
      email: created.user.email,
    }, ctx.resHeaders);
  }),

  login: publicQuery.input(z.object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(128),
  })).mutation(async ({ ctx, input }) => {
    const email = normalizeEmail(input.email);
    const rateKey = loginRateLimitKey(ctx.req, `owner:${email}`);
    assertLoginAllowed(rateKey);

    const db = getDb();
    const [user] = db.select().from(users).where(eq(users.email, email)).limit(1).all();
    const valid = await verifyPassword(input.password, user?.passwordHash ?? null);
    if (!user || !valid) {
      recordLoginFailure(rateKey);
      throw invalidLogin();
    }

    const [outlet] = db.select().from(outlets).where(and(
      eq(outlets.storeId, user.storeId),
      eq(outlets.active, true),
    )).orderBy(asc(outlets.id)).limit(1).all();
    if (!outlet) throw new TRPCError({ code: "NOT_FOUND", message: "Toko belum memiliki outlet aktif." });

    clearLoginFailures(rateKey);
    db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)).run();
    return startSession({
      sessionId: 0,
      storeId: user.storeId,
      activeOutletId: outlet.id,
      role: "owner",
      userId: user.id,
      employeeId: null,
      name: user.name,
      email: user.email,
    }, ctx.resHeaders);
  }),

  employeeLogin: publicQuery.input(z.object({
    barcode: z.string().trim().min(20).max(512),
    pin: z.string().regex(/^\d{6}$/, "PIN harus 6 digit angka."),
  })).mutation(async ({ ctx, input }) => {
    const identity = hashToken(input.barcode).slice(0, 16);
    const rateKey = loginRateLimitKey(ctx.req, `employee:${identity}`);
    assertLoginAllowed(rateKey);

    const db = getDb();
    const [employee] = db.select().from(employees)
      .where(eq(employees.barcodeHash, hashToken(input.barcode))).limit(1).all();
    if (!employee || !employee.active) {
      recordLoginFailure(rateKey);
      throw invalidEmployeeLogin();
    }
    if (employee.lockedUntil && employee.lockedUntil.getTime() > Date.now()) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Login dikunci sementara. Coba lagi dalam 15 menit.",
      });
    }

    const valid = await verifyPassword(input.pin, employee.pinHash);
    if (!valid) {
      const failures = employee.failedPinAttempts + 1;
      db.update(employees).set({
        failedPinAttempts: failures,
        lockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null,
      }).where(eq(employees.id, employee.id)).run();
      recordLoginFailure(rateKey);
      throw invalidEmployeeLogin();
    }

    clearLoginFailures(rateKey);
    db.update(employees).set({
      failedPinAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    }).where(eq(employees.id, employee.id)).run();
    return startSession({
      sessionId: 0,
      storeId: employee.storeId,
      activeOutletId: employee.outletId,
      role: employee.role,
      userId: null,
      employeeId: employee.id,
      name: employee.name,
      email: null,
    }, ctx.resHeaders);
  }),

  me: publicQuery.query(({ ctx }) => ctx.auth ? authPayload(ctx.auth) : null),

  logout: authedQuery.mutation(({ ctx }) => {
    destroyRequestSession(ctx.req);
    clearSessionCookie(ctx.resHeaders);
    return { ok: true };
  }),
});
