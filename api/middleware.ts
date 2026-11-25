import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { log } from "./lib/logger";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // G9: a procedure that throws never reaches app.onError — the tRPC fetch
  // adapter catches it and returns its own 500 JSON, so the Hono error handler
  // is bypassed entirely. That left the most common real failure (a mutation
  // 500ing) with NO structured record in app.log on the server side; it only
  // appeared if the caller happened to log it in its own catch. This hook is the
  // missing server-side safety net. INTERNAL_SERVER_ERROR only: a thrown
  // TRPCError like UNAUTHORIZED is a deliberate business answer, not a crash,
  // and logging those would drown the file.
  errorFormatter({ shape, error }) {
    if (error.code === "INTERNAL_SERVER_ERROR") {
      log.error("trpc procedure failed", {
        path: shape.data?.path,
        code: error.code,
        error: error.message,
        stack: error.stack,
      });
    }
    return shape;
  },
});

export const createRouter = t.router;
export const publicQuery = t.procedure;

export const authedQuery = t.procedure.use(({ ctx, next }) => {
  if (!ctx.auth) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Silakan login terlebih dahulu." });
  }
  return next({ ctx: { ...ctx, auth: ctx.auth } });
});

export const ownerQuery = authedQuery.use(({ ctx, next }) => {
  if (ctx.auth.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Fitur ini hanya untuk owner." });
  }
  return next();
});

export const managerQuery = authedQuery.use(({ ctx, next }) => {
  if (ctx.auth.role === "kasir") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Kasir tidak memiliki akses ke fitur ini." });
  }
  return next();
});
