import { TRPCError } from "@trpc/server";

type Bucket = { failures: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function loginRateLimitKey(req: Request, identity: string) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || "local";
  return `${ip}:${identity}`;
}

export function assertLoginAllowed(key: string) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.delete(key);
    return;
  }
  if (bucket.failures >= 8) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Terlalu banyak percobaan login. Coba lagi dalam 15 menit.",
    });
  }
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const current = buckets.get(key);
  const bucket = current && current.resetAt > now
    ? current
    : { failures: 0, resetAt: now + 15 * 60 * 1000 };
  bucket.failures += 1;
  buckets.set(key, bucket);

  if (buckets.size > 5000) {
    for (const [entryKey, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(entryKey);
    }
  }
}

export function clearLoginFailures(key: string) {
  buckets.delete(key);
}
