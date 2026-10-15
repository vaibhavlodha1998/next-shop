import "server-only";

// Data access layer. Only server code may import this module.
// Swap the in-memory store for a real database later; callers do not change.

export interface Product {
  id: string;
  name: string;
  pricePence: number;
  stock: number;
}

export type NewProduct = Omit<Product, "id">;

const products = new Map<string, Product>([
  ["p1", { id: "p1", name: "Desk lamp", pricePence: 2499, stock: 12 }],
  ["p2", { id: "p2", name: "Notebook", pricePence: 499, stock: 140 }],
  ["p3", { id: "p3", name: "Fountain pen", pricePence: 3999, stock: 0 }],
]);

export async function listProducts(): Promise<Product[]> {
  return [...products.values()];
}

export async function getProduct(id: string): Promise<Product | null> {
  return products.get(id) ?? null;
}

export async function createProduct(input: NewProduct): Promise<Product> {
  const product = { id: crypto.randomUUID(), ...input };
  products.set(product.id, product);
  return product;
}

export async function reserveStock(id: string, quantity: number): Promise<boolean> {
  const product = products.get(id);
  if (!product || product.stock < quantity) return false;
  product.stock -= quantity;
  return true;
}
