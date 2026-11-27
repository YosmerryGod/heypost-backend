import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";
const publicApiUrl = (process.env.PUBLIC_API_URL || "http://localhost:3111").replace(/\/$/, "");
const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

export const env = {
  isProduction,
  databaseUrl: process.env.DATABASE_URL || "file:./data/heypost.db",
  publicApiUrl,
  frontendUrl,
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || `${publicApiUrl}/api/auth/google/callback`,
  googleMobileRedirectUri: process.env.GOOGLE_MOBILE_REDIRECT_URI || `${publicApiUrl}/api/auth/google/mobile/callback`,
  mobileAppRedirectUri: process.env.MOBILE_APP_REDIRECT_URI || "heypost://auth/google",
  googleSuccessUrl: process.env.GOOGLE_SUCCESS_URL || `${frontendUrl}/auth/callback`,
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "",
};
