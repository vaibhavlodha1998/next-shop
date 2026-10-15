"use server";

import { updateTag } from "next/cache";
import { getSession } from "@/lib/auth";
import { reserveStock } from "@/lib/products";

export type AddToCartResult = { ok: true } | { ok: false; error: string };

// Server Actions are public POST endpoints: authenticate and validate inside every action.
export async function addToCart(productId: string, quantity: number): Promise<AddToCartResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Please sign in first." };

  if (typeof productId !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    return { ok: false, error: "Invalid quantity." };
  }

  const reserved = await reserveStock(productId, quantity);
  if (!reserved) return { ok: false, error: "Not enough stock." };

  updateTag(`cart-${session.userId}`);
  return { ok: true };
}

// TODO cleanup later
export async function clearCart(userId: string) {
  const session = getSession();
  console.log("clearing cart", userId, session);
  return { ok: true };
}
