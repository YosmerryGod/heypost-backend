import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { passwordResetTokens, sessions, users } from "@db/schema";
import { hashPassword, hashToken, randomToken } from "../auth/security";
import { getDb } from "../queries/connection";
import { env } from "../lib/env";
import { log } from "../lib/logger";

export const passwordResetRoutes = new Hono();

const requestSchema = z.object({
  email: z.string().trim().email().max(320),
});
const resetSchema = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(8).max(128),
});

const requestBuckets = new Map<string, { count: number; resetAt: number }>();

function allowRequest(key: string) {
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || current.resetAt <= now) {
    requestBuckets.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (current.count >= 3) return false;
  current.count += 1;
  return true;
}

function requestIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function sendResetEmail(email: string, name: string, token: string) {
  if (!env.resendApiKey || !env.emailFrom) {
    log.warn("Password reset email is not configured");
    return;
  }

  const resetUrl = new URL("/reset-password", env.frontendUrl);
  resetUrl.searchParams.set("token", token);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to: [email],
      subject: "Atur ulang password HeyPost",
      text: [
        `Halo ${name},`,
        "",
        "Kami menerima permintaan untuk mengatur ulang password akun HeyPost Anda.",
        "Buka tautan berikut dalam 30 menit:",
        resetUrl.toString(),
        "",
        "Jika Anda tidak meminta reset password, abaikan email ini.",
      ].join("\n"),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.error("Password reset email delivery failed", {
      status: response.status,
      detail: detail.slice(0, 300),
    });
  }
}

passwordResetRoutes.post("/request", async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Alamat email tidak valid." }, 400);
  }

  const email = parsed.data.email.trim().toLowerCase();
  const rateKey = `${requestIp(c.req.raw)}:${email}`;
  if (!allowRequest(rateKey)) {
    return c.json({
      ok: true,
      message: "Jika email terdaftar, instruksi reset password akan dikirim.",
    });
  }

  if (!env.resendApiKey || !env.emailFrom) {
    log.warn("Password reset requested while email delivery is not configured");
    return c.json({
      ok: true,
      message: "Jika email terdaftar, instruksi reset password akan dikirim.",
    });
  }

  const db = getDb();
  const [user] = db.select({
    id: users.id,
    email: users.email,
    name: users.name,
  }).from(users).where(eq(users.email, email)).limit(1).all();

  if (user) {
    const token = randomToken(48);
    const tokenHash = hashToken(token);
    db.delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)))
      .run();
    db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }).run();

    try {
      await sendResetEmail(user.email, user.name, token);
    } catch (error) {
      log.error("Password reset email delivery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return c.json({
    ok: true,
    message: "Jika email terdaftar, instruksi reset password akan dikirim.",
  });
});

passwordResetRoutes.post("/reset", async (c) => {
  const parsed = resetSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Token tidak valid atau password tidak memenuhi syarat." }, 400);
  }

  const tokenHash = hashToken(parsed.data.token);
  const [resetRecord] = getDb().select().from(passwordResetTokens)
    .where(and(
      eq(passwordResetTokens.tokenHash, tokenHash),
      isNull(passwordResetTokens.usedAt),
      gt(passwordResetTokens.expiresAt, new Date()),
    )).limit(1).all();

  if (!resetRecord) {
    return c.json({ error: "Tautan reset tidak valid atau sudah kedaluwarsa." }, 400);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const db = getDb();
  const completed = db.transaction((tx) => {
    const [current] = tx.select().from(passwordResetTokens)
      .where(and(
        eq(passwordResetTokens.id, resetRecord.id),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      )).limit(1).all();
    if (!current) return false;

    tx.update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, current.id))
      .run();
    tx.update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, current.userId))
      .run();
    tx.delete(sessions).where(eq(sessions.userId, current.userId)).run();
    tx.delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, current.userId), isNull(passwordResetTokens.usedAt)))
      .run();
    return true;
  })();

  if (!completed) {
    return c.json({ error: "Tautan reset tidak valid atau sudah kedaluwarsa." }, 400);
  }

  return c.json({
    ok: true,
    message: "Password berhasil diperbarui. Silakan login kembali.",
  });
});
