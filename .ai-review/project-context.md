# Project context

<!-- ai-review:generated 2026-10-15 at 4c4cfa7 -->
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

3 code files. No summary yet.
