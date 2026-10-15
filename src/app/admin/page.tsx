import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listProducts } from "@/lib/products";

// The heading prerenders into the static shell; the session read streams in behind Suspense.
export default function AdminPage() {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Suspense fallback={<p className="mt-4">Loading...</p>}>
        <AdminSummary />
      </Suspense>
    </main>
  );
}

async function AdminSummary() {
  const session = await getSession();
  if (session?.role !== "admin") redirect("/");

  const products = await listProducts();
  const outOfStock = products.filter((p) => p.stock === 0);
  return (
    <p className="mt-4">
      {products.length} products, {outOfStock.length} out of stock.
    </p>
  );
}
