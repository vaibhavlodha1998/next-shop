import Link from "next/link";
import { listProducts } from "@/lib/products";
import { formatPence } from "@/lib/money";

export const metadata = { title: "Products" };

export default async function ProductsPage() {
  const products = await listProducts();

  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">Products</h1>
      <ul className="divide-y">
        {products.map((p) => (
          <li key={p.id} className="flex justify-between py-3">
            <Link href={`/products/${p.id}`} className="underline">
              {p.name}
            </Link>
            <span>{formatPence(p.pricePence)}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
