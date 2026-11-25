import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./authRouter";
import { employeeRouter } from "./employeeRouter";
import { expenseRouter } from "./expenseRouter";
import { posRouter } from "./posRouter";
import { storeRouter } from "./storeRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  store: storeRouter,
  employees: employeeRouter,
  expenses: expenseRouter,
  pos: posRouter,
});

export type AppRouter = typeof appRouter;
