"use client";

import { useState, useTransition } from "react";
import { addToCart } from "@/app/cart/actions";

export function AddToCartButton({ productId }: { productId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      <button
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await addToCart(productId, 1);
            setMessage(result.ok ? "Added to cart" : result.error);
          })
        }
      >
        {pending ? "Adding..." : "Add to cart"}
      </button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
