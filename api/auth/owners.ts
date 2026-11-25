import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { outlets, stores, users } from "@db/schema";
import { getDb } from "../queries/connection";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function createOwnerAccount(input: {
  name: string;
  email: string;
  storeName: string;
  outletName?: string;
  passwordHash?: string | null;
  googleSub?: string | null;
  avatarUrl?: string | null;
}) {
  const db = getDb();
  const email = normalizeEmail(input.email);
  const [existing] = db.select({ id: users.id }).from(users)
    .where(eq(users.email, email)).limit(1).all();
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "Email sudah terdaftar." });
  }

  try {
    return db.transaction((tx) => {
      const [store] = tx.insert(stores).values({ name: input.storeName })
        .returning().all();
      const [outlet] = tx.insert(outlets).values({
        storeId: store.id,
        name: input.outletName || "Outlet Utama",
      }).returning().all();
      const [user] = tx.insert(users).values({
        storeId: store.id,
        name: input.name,
        email,
        passwordHash: input.passwordHash,
        googleSub: input.googleSub,
        avatarUrl: input.avatarUrl,
        lastLoginAt: new Date(),
      }).returning().all();
      return { user, store, outlet };
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new TRPCError({ code: "CONFLICT", message: "Email sudah terdaftar." });
    }
    throw error;
  }
}

export function findOrCreateGoogleOwner(input: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl?: string;
}) {
  const db = getDb();
  const email = normalizeEmail(input.email);
  const [byGoogle] = db.select().from(users)
    .where(eq(users.googleSub, input.googleSub)).limit(1).all();
  if (byGoogle) {
    const [outlet] = db.select().from(outlets)
      .where(and(eq(outlets.storeId, byGoogle.storeId), eq(outlets.active, true)))
      .orderBy(asc(outlets.id)).limit(1).all();
    if (!outlet) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Outlet akun tidak ditemukan." });
    db.update(users).set({
      name: input.name || byGoogle.name,
      avatarUrl: input.avatarUrl || byGoogle.avatarUrl,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(users.id, byGoogle.id)).run();
    return { user: { ...byGoogle, name: input.name || byGoogle.name }, outlet };
  }

  const [byEmail] = db.select().from(users).where(eq(users.email, email)).limit(1).all();
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== input.googleSub) {
      throw new TRPCError({ code: "CONFLICT", message: "Email terhubung ke akun Google lain." });
    }
    db.update(users).set({
      googleSub: input.googleSub,
      avatarUrl: input.avatarUrl || byEmail.avatarUrl,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(users.id, byEmail.id)).run();
    const [outlet] = db.select().from(outlets)
      .where(and(eq(outlets.storeId, byEmail.storeId), eq(outlets.active, true)))
      .orderBy(asc(outlets.id)).limit(1).all();
    if (!outlet) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Outlet akun tidak ditemukan." });
    return { user: { ...byEmail, googleSub: input.googleSub }, outlet };
  }

  const created = createOwnerAccount({
    name: input.name || email.split("@")[0],
    email,
    storeName: `Toko ${input.name || email.split("@")[0]}`,
    passwordHash: null,
    googleSub: input.googleSub,
    avatarUrl: input.avatarUrl,
  });
  return { user: created.user, outlet: created.outlet };
}
