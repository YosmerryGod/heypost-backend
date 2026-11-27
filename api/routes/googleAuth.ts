import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from "@contracts/auth";
import { mobileOAuthCodes, mobileOAuthStates } from "@db/schema";
import { findOrCreateGoogleOwner } from "../auth/owners";
import { hashToken, randomToken } from "../auth/security";
import { createSession, setSessionCookie } from "../auth/session";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { getDb } from "../queries/connection";

export const googleAuthRoutes = new Hono();

function oauthErrorRedirect() {
  const url = new URL(env.googleSuccessUrl);
  url.searchParams.set("error", "google_login");
  return url.toString();
}

function clearOAuthCookies(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
  deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: "/" });
}

function createGoogleAuthorizationUrl(input: { redirectUri: string; state: string; verifier: string }) {
  const challenge = createHash("sha256").update(input.verifier).digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url;
}

async function exchangeGoogleCode(input: { code: string; redirectUri: string; verifier: string }) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) {
    log.error("Google OAuth token exchange failed", {
      status: tokenResponse.status,
      flow: input.redirectUri === env.googleMobileRedirectUri ? "mobile" : "web",
    });
    throw new Error("Google token exchange failed");
  }
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) throw new Error("Google access token missing");

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!profileResponse.ok) throw new Error("Google profile request failed");
  const profile = await profileResponse.json() as {
    sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string;
  };
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new Error("Google email is missing or unverified");
  }
  return profile;
}

function getGoogleOwner(profile: { sub: string; email: string; name?: string; picture?: string }) {
  return findOrCreateGoogleOwner({
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name || profile.email.split("@")[0],
    avatarUrl: profile.picture,
  });
}

// [ADDED] Memulai OAuth mobile tanpa bergantung pada cookie browser.
googleAuthRoutes.post("/mobile/start", (c) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    return c.json({ error: "Login Google belum dikonfigurasi di server." }, 503);
  }
  const state = randomToken();
  const verifier = randomToken(48);
  const now = new Date();
  const db = getDb();
  db.delete(mobileOAuthStates).where(lte(mobileOAuthStates.expiresAt, now)).run();
  db.delete(mobileOAuthCodes).where(lte(mobileOAuthCodes.expiresAt, now)).run();
  db.insert(mobileOAuthStates).values({
    stateHash: hashToken(state),
    verifier,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
  }).run();

  const authorizationUrl = createGoogleAuthorizationUrl({
    redirectUri: env.googleMobileRedirectUri,
    state,
    verifier,
  });
  return c.json({ authorizationUrl: authorizationUrl.toString(), expiresIn: 600 });
});

// [ADDED] Callback mobile memvalidasi state/PKCE dan mengirim kode singkat ke Deep Link.
googleAuthRoutes.get("/mobile/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const googleError = c.req.query("error");
  if (googleError || !code || !state) {
    const redirect = new URL(env.mobileAppRedirectUri);
    redirect.searchParams.set("error", "google_login");
    return c.redirect(redirect.toString());
  }

  const db = getDb();
  const now = new Date();
  const pending = db.transaction((tx) => {
    const [record] = tx.select().from(mobileOAuthStates).where(and(
      eq(mobileOAuthStates.stateHash, hashToken(state)),
      gt(mobileOAuthStates.expiresAt, now),
    )).limit(1).all();
    if (!record) return undefined;
    tx.delete(mobileOAuthStates).where(eq(mobileOAuthStates.id, record.id)).run();
    return record;
  });
  if (!pending) {
    const redirect = new URL(env.mobileAppRedirectUri);
    redirect.searchParams.set("error", "invalid_oauth_state");
    return c.redirect(redirect.toString());
  }

  try {
    const profile = await exchangeGoogleCode({
      code, redirectUri: env.googleMobileRedirectUri, verifier: pending.verifier,
    });
    const { user, outlet } = getGoogleOwner({
      sub: profile.sub!, email: profile.email!, name: profile.name, picture: profile.picture,
    });
    const exchangeCode = randomToken();
    db.insert(mobileOAuthCodes).values({
      codeHash: hashToken(exchangeCode),
      userId: user.id,
      storeId: user.storeId,
      outletId: outlet.id,
      expiresAt: new Date(Date.now() + 60 * 1000),
    }).run();
    const redirect = new URL(env.mobileAppRedirectUri);
    redirect.searchParams.set("code", exchangeCode);
    return c.redirect(redirect.toString());
  } catch (error) {
    log.error("Google mobile OAuth failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const redirect = new URL(env.mobileAppRedirectUri);
    redirect.searchParams.set("error", "google_login");
    return c.redirect(redirect.toString());
  }
});

// [ADDED] Kode sekali pakai ditukar menjadi session bearer untuk SecureStore.
googleAuthRoutes.post("/mobile/exchange", async (c) => {
  let body: { code?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Permintaan tidak valid." }, 400); }
  if (typeof body.code !== "string" || body.code.length < 20 || body.code.length > 200) {
    return c.json({ error: "Kode autentikasi tidak valid." }, 400);
  }

  const now = new Date();
  const db = getDb();
  const exchange = db.transaction((tx) => {
    const [record] = tx.select().from(mobileOAuthCodes).where(and(
      eq(mobileOAuthCodes.codeHash, hashToken(body.code as string)),
      gt(mobileOAuthCodes.expiresAt, now),
      isNull(mobileOAuthCodes.usedAt),
    )).limit(1).all();
    if (!record) return undefined;
    tx.update(mobileOAuthCodes).set({ usedAt: now }).where(and(
      eq(mobileOAuthCodes.id, record.id),
      isNull(mobileOAuthCodes.usedAt),
    )).run();
    return record;
  });
  if (!exchange) return c.json({ error: "Kode autentikasi sudah digunakan atau kedaluwarsa." }, 401);

  const session = createSession({
    userId: exchange.userId,
    storeId: exchange.storeId,
    activeOutletId: exchange.outletId,
    role: "owner",
  });
  return c.json({
    token: session.token,
    tokenType: "Bearer",
    expiresAt: session.expiresAt.toISOString(),
    expiresIn: session.maxAgeSeconds,
  });
});

// Web OAuth tetap menggunakan cookie browser seperti sebelumnya.
googleAuthRoutes.get("/start", (c) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    return c.json({ error: "Login Google belum dikonfigurasi di server." }, 503);
  }
  const state = randomToken();
  const verifier = randomToken(48);
  const cookieOptions = {
    path: "/", httpOnly: true, secure: env.isProduction,
    sameSite: "Lax" as const, maxAge: 600,
  };
  setCookie(c, OAUTH_STATE_COOKIE, state, cookieOptions);
  setCookie(c, OAUTH_VERIFIER_COOKIE, verifier, cookieOptions);
  const url = createGoogleAuthorizationUrl({
    redirectUri: env.googleRedirectUri, state, verifier,
  });
  return c.redirect(url.toString());
});

googleAuthRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, OAUTH_STATE_COOKIE);
  const verifier = getCookie(c, OAUTH_VERIFIER_COOKIE);
  clearOAuthCookies(c);
  if (!code || !state || !savedState || !verifier || state !== savedState) {
    return c.redirect(oauthErrorRedirect());
  }

  try {
    const profile = await exchangeGoogleCode({
      code, redirectUri: env.googleRedirectUri, verifier,
    });
    const { user, outlet } = getGoogleOwner({
      sub: profile.sub!, email: profile.email!, name: profile.name, picture: profile.picture,
    });
    const session = createSession({
      userId: user.id, storeId: user.storeId, activeOutletId: outlet.id, role: "owner",
    });
    const headers = new Headers();
    setSessionCookie(headers, session.token, session.maxAgeSeconds);
    c.header("Set-Cookie", headers.get("Set-Cookie")!);
    const successUrl = new URL(env.googleSuccessUrl);
    successUrl.searchParams.set("provider", "google");
    return c.redirect(successUrl.toString());
  } catch (error) {
    log.error("Google OAuth failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(oauthErrorRedirect());
  }
});
