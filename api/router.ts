import { createRouter, publicQuery } from "./middleware";
import { posRouter } from "./posRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  pos: posRouter,
});

export type AppRouter = typeof appRouter;
