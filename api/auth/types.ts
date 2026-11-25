import type { Role } from "@db/schema";

export type AuthPrincipal = {
  sessionId: number;
  storeId: number;
  activeOutletId: number;
  role: Role;
  userId: number | null;
  employeeId: number | null;
  name: string;
  email: string | null;
};
