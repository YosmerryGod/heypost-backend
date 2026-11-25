import { and, eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@contracts/auth";
import {
  employees,
  outlets,
  sessions,
  users,
  type Role,
} from "@db/schema";
import { env } from "../lib/env";
import { getDb } from "../queries/connection";
import { hashToken, randomToken } from "./security";
import type { AuthPrincipal } from "./types";

const OWNER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const EMPLOYEE_SESSION_MS = 12 * 60 * 60 * 1000;

function cookieString(value: string, maxAge: number) {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${env.isProduction ? "None" : "Lax"}`,
    env.isProduction ? "Secure" : "",
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join("; ");
}

export function setSessionCookie(headers: Headers, token: string, maxAgeSeconds: number) {
  headers.append("Set-Cookie", cookieString(token, maxAgeSeconds));
}

export function clearSessionCookie(headers: Headers) {
  headers.append("Set-Cookie", cookieString("", 0));
}

function requestToken(req: Request) {
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();

  const cookies = req.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

export function createSession(input: {
  userId?: number;
  employeeId?: number;
  storeId: number;
  activeOutletId: number;
  role: Role;
}) {
  const token = randomToken();
  const duration = input.role === "owner" ? OWNER_SESSION_MS : EMPLOYEE_SESSION_MS;
  const expiresAt = new Date(Date.now() + duration);
  const db = getDb();

  db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId: input.userId,
    employeeId: input.employeeId,
    storeId: input.storeId,
    activeOutletId: input.activeOutletId,
    expiresAt,
    lastUsedAt: new Date(),
  }).run();

  return { token, expiresAt, maxAgeSeconds: Math.floor(duration / 1000) };
}

export function getPrincipalFromRequest(req: Request): AuthPrincipal | undefined {
  const token = requestToken(req);
  if (!token) return undefined;

  const db = getDb();
  const [session] = db.select().from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1).all();
  if (!session) return undefined;

  if (session.expiresAt.getTime() <= Date.now()) {
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return undefined;
  }

  const [outlet] = db.select().from(outlets).where(and(
    eq(outlets.id, session.activeOutletId),
    eq(outlets.storeId, session.storeId),
    eq(outlets.active, true),
  )).limit(1).all();
  if (!outlet) return undefined;

  let principal: AuthPrincipal | undefined;
  if (session.userId) {
    const [user] = db.select().from(users).where(and(
      eq(users.id, session.userId),
      eq(users.storeId, session.storeId),
    )).limit(1).all();
    if (user) {
      principal = {
        sessionId: session.id,
        storeId: user.storeId,
        activeOutletId: outlet.id,
        role: "owner",
        userId: user.id,
        employeeId: null,
        name: user.name,
        email: user.email,
      };
    }
  } else if (session.employeeId) {
    const [employee] = db.select().from(employees).where(and(
      eq(employees.id, session.employeeId),
      eq(employees.storeId, session.storeId),
      eq(employees.outletId, session.activeOutletId),
      eq(employees.active, true),
    )).limit(1).all();
    if (employee) {
      principal = {
        sessionId: session.id,
        storeId: employee.storeId,
        activeOutletId: employee.outletId,
        role: employee.role,
        userId: null,
        employeeId: employee.id,
        name: employee.name,
        email: null,
      };
    }
  }

  if (!principal) {
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return undefined;
  }

  if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > 5 * 60 * 1000) {
    db.update(sessions).set({ lastUsedAt: new Date() })
      .where(eq(sessions.id, session.id)).run();
  }
  return principal;
}

export function destroyRequestSession(req: Request) {
  const token = requestToken(req);
  if (token) getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
}
