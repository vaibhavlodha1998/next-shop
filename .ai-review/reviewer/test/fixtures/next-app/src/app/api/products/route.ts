import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createProduct, listProducts } from "@/lib/products";

export async function GET() {
  const products = await listProducts();
  return NextResponse.json({ products });
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isNewProduct(body)) {
    return NextResponse.json({ error: "Expected { name, pricePence, stock }" }, { status: 400 });
  }

  const product = await createProduct(body);
  return NextResponse.json({ product }, { status: 201 });
}

function isNewProduct(v: unknown): v is { name: string; pricePence: number; stock: number } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    o.name.length > 0 &&
    Number.isInteger(o.pricePence) &&
    (o.pricePence as number) >= 0 &&
    Number.isInteger(o.stock) &&
    (o.stock as number) >= 0
  );
}
