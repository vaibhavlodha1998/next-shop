import "server-only";
import { cookies } from "next/headers";

export interface Session {
  userId: string;
  role: "customer" | "admin";
}

// Demo session lookup. A real app would verify a signed session token here.
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const userId = store.get("demo_user")?.value;
  if (!userId) return null;
  return { userId, role: store.get("demo_role")?.value === "admin" ? "admin" : "customer" };
}

export async function requireAdmin(): Promise<Session> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    throw new Error("Unauthorized");
  }
  return session;
}
