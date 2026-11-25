import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { getPrincipalFromRequest } from "./auth/session";
import type { AuthPrincipal } from "./auth/types";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  auth?: AuthPrincipal;
};

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<TrpcContext> {
  return {
    req: opts.req,
    resHeaders: opts.resHeaders,
    auth: getPrincipalFromRequest(opts.req),
  };
}
