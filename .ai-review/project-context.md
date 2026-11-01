# Project context

<!-- ai-review:generated 2026-11-01 at f823da1 -->
What the AI reviewer knows about this project. It reads this file from the target branch of every PR, next to the rules in AGENTS.md.
Correct anything wrong and add what a new teammate should know. Rerun `/ai-review analyze` after big structural changes.

## Overview

- Frameworks and libraries: Next.js 16.4.1, React 19.3.0, Tailwind CSS 4, server-only 0.0.1
- Languages: TypeScript (7), TypeScript (TSX) (6), JavaScript (1), CSS (1)
- Package manager / build: npm
- TypeScript with strict mode on
- Path aliases: @/* -> ./src/*
- Next.js 16.4.1: App Router in src/app/
- cacheComponents is ON: request-time data (cookies(), headers(), params, searchParams, uncached fetch) must be read inside <Suspense> or cached with "use cache"
- Route handlers (1): src/app/api/products/route.ts
- Server Action files ("use server"): src/app/cart/actions.ts
- Client components ("use client"): 1 (e.g. src/components/AddToCartButton.tsx)
- Server-only modules (import "server-only"): src/lib/auth.ts, src/lib/products.ts
- Proxy (formerly middleware): src/proxy.ts
- Tests: none found
- CI workflows: only ai-review
- Lint and format config: eslint.config.mjs

## Module: src/app (applies to: src/app/**)

7 code files. No summary yet.

## Module: src/components + src (applies to: src/components/**, src/*)

2 code files. No summary yet.

## Module: src/lib (applies to: src/lib/**)

**Purpose:** Provides core server‑side utilities for authentication, product data access, and currency formatting used throughout the application.

**Key files**
- `src/lib/auth.ts`: Session handling and admin authorization
- `src/lib/products.ts`: In‑memory product data store and CRUD operations
- `src/lib/money.ts`: Currency formatting helper

**Conventions**
- All server‑only modules import `"server-only"` at the top (e.g., `src/lib/auth.ts`, `src/lib/products.ts`).
- Async functions return `Promise<T>` and perform data access or side effects (e.g., `listProducts`, `getProduct`).
- In‑memory data is stored in a `Map<string, Product>` and accessed via `products.get(id)` or `products.set(id, product)` (evidence: `src/lib/products.ts`).
- New product IDs are generated with `crypto.randomUUID()` (evidence: `src/lib/products.ts`).
- Currency formatting uses `Intl.NumberFormat` with locale `en-GB` and currency `GBP` (evidence: `src/lib/money.ts`).
- Session data is read from cookies using `next/headers` and optional chaining to handle missing values (evidence: `src/lib/auth.ts`).

**When reviewing changes here**
- Verify that `auth.ts` continues to import `"server-only"` and that `getSession` correctly reads cookies.
- Ensure `requireAdmin` throws the same error message and does not expose session details.
- Confirm that `products.ts` does not expose the internal `Map` and that CRUD functions return the expected types.
- Check that `reserveStock` correctly updates stock only when sufficient quantity exists and returns a boolean.
- Validate that `createProduct` generates a unique UUID and stores the product in the map.
- Make sure `money.ts` still formats pence correctly and can be imported by client components without side effects.
