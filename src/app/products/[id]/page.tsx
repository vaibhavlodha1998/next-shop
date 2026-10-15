import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getProduct } from "@/lib/products";
import { formatPence } from "@/lib/money";
import { AddToCartButton } from "@/components/AddToCartButton";

export default function ProductPage(props: PageProps<"/products/[id]">) {
  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <Suspense fallback={<p>Loading product...</p>}>
        <ProductDetails params={props.params} />
      </Suspense>
    </main>
  );
}

async function ProductDetails({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) notFound();

  return (
    <>
      <h1 className="text-2xl font-semibold">{product.name}</h1>
      <p className="my-4 text-lg">{formatPence(product.pricePence)}</p>
      {product.stock > 0 ? (
        <AddToCartButton productId={product.id} />
      ) : (
        <p className="text-zinc-500">Out of stock</p>
      )}
    </>
  );
}
