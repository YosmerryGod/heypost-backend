import { z } from "zod";

export const PERMISSION_KEYS = [
  "pos.access",
  "history.daily.view",
  "invoice.edit",
  "expenses.daily.create",
  "expenses.daily.view",
  "menu.create",
  "menu.edit",
  "stock.edit",
  "reports.sales.view",
  "outlets.create",
  "employees.create",
  "receipt.settings",
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];
export const permissionsSchema = z.array(z.enum(PERMISSION_KEYS)).max(PERMISSION_KEYS.length);

export const DEFAULT_EMPLOYEE_PERMISSIONS: Record<"manager" | "kasir", PermissionKey[]> = {
  manager: [
    "pos.access",
    "history.daily.view",
    "expenses.daily.create",
    "expenses.daily.view",
    "menu.create",
    "menu.edit",
    "stock.edit",
    "reports.sales.view",
  ],
  kasir: ["pos.access", "history.daily.view"],
};

export function parsePermissions(value: string | null | undefined): PermissionKey[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const result = permissionsSchema.safeParse(parsed);
    return result.success ? [...new Set(result.data)] : [];
  } catch {
    return [];
  }
}
