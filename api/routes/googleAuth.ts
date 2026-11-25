import { createHash } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from "@contracts/auth";
import { findOrCreateGoogleOwner } from "../auth/owners";
import { randomToken } from "../auth/security";
import { createSession, setSessionCookie } from "../auth/session";
import { env } from "../lib/env";
import { log } from "../lib/logger";

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

googleAuthRoutes.get("/start", (c) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    return c.json({ error: "Login Google belum dikonfigurasi di server." }, 503);
  }

  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "Lax" as const,
    maxAge: 600,
  };
  setCookie(c, OAUTH_STATE_COOKIE, state, cookieOptions);
  setCookie(c, OAUTH_VERIFIER_COOKIE, verifier, cookieOptions);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", env.googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
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
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: env.googleRedirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) throw new Error("Google token exchange failed");
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw new Error("Google access token missing");

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileResponse.ok) throw new Error("Google profile request failed");
    const profile = await profileResponse.json() as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!profile.sub || !profile.email || profile.email_verified !== true) {
      throw new Error("Google email is missing or unverified");
    }

    const { user, outlet } = findOrCreateGoogleOwner({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name || profile.email.split("@")[0],
      avatarUrl: profile.picture,
    });
    const session = createSession({
      userId: user.id,
      storeId: user.storeId,
      activeOutletId: outlet.id,
      role: "owner",
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
