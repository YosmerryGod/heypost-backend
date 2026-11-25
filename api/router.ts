import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./authRouter";
import { employeeRouter } from "./employeeRouter";
import { posRouter } from "./posRouter";
import { storeRouter } from "./storeRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  store: storeRouter,
  employees: employeeRouter,
  pos: posRouter,
});

export type AppRouter = typeof appRouter;
